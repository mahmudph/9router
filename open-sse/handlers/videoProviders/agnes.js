// Agnes AI video jobs.
//
// Agnes does not speak the default xAI shape on either leg, so both directions
// are translated:
//   create → POST {baseUrl}/videos  { model, mode, prompt, size, ... } → { video_id }
//   poll   → GET  {pollUrl}?video_id=…&model_name=…               → { status, url }
//
// The poll endpoint needs the model name, but the poll leg only carries the job
// id returned at create time, so { model, videoId } is base64url-encoded into
// that id — the same trick vertex.js uses for its operation name. GET
// /v1/videos/{id} therefore stays a flat path while both values survive.
const JSON_WEB_API_RE = /^[A-Za-z0-9._-]+$/;

// Bounds the encoded id so a hostile client cannot force a large base64 decode.
const MAX_JOB_ID_LENGTH = 1024;

function encodeJobId(model, videoId) {
  return Buffer.from(JSON.stringify({ model, videoId }), "utf8").toString("base64url");
}

function decodeJobId(id) {
  const raw = String(id ?? "");
  // Buffer.from(x, "base64url") silently drops invalid characters rather than
  // throwing, so only ids that re-encode byte-for-byte are accepted.
  if (!raw || raw.length > MAX_JOB_ID_LENGTH || !/^[A-Za-z0-9_-]+$/.test(raw)) return null;
  const decoded = Buffer.from(raw, "base64url").toString("utf8");
  if (Buffer.from(decoded, "utf8").toString("base64url") !== raw) return null;
  let parsed;
  try {
    parsed = JSON.parse(decoded);
  } catch {
    return null;
  }
  const { model, videoId } = parsed ?? {};
  // Both values are echoed back into the upstream query string, so neither may
  // carry URL syntax, traversal, or a host-changing prefix.
  if (typeof model !== "string" || !JSON_WEB_API_RE.test(model)) return null;
  if (typeof videoId !== "string" || !JSON_WEB_API_RE.test(videoId)) return null;
  return { model, videoId };
}

const jsonHeaders = (token) => ({
  Accept: "application/json",
  "Content-Type": "application/json",
  ...(token ? { Authorization: `Bearer ${token}` } : {}),
});

// Fields Agnes accepts on a text-to-video create. Anything else is dropped
// rather than forwarded: it rejects unknown keys outright
// ("invalid_request: resolution is not an allowed request field"), so passing
// the caller's body through verbatim turns any generic field the dashboard or
// an SDK adds into a hard 4xx. Keyframe/reference fields are deliberately not
// listed — that mode is not wired up yet.
const AGNES_TEXT_FIELDS = ["model", "mode", "prompt", "seconds", "size", "aspect_ratio", "n"];

// The dashboard and the OpenAI-ish video contract use generic field names that
// Agnes spells differently. Renaming here keeps the public surface uniform and
// stops a mismatched name from being silently ignored (render comes back at the
// default) or rejected outright (invalid_request). `size` is a string tier
// ("720P"), so only `seconds` is coerced to a number.
const AGNES_FIELD_ALIASES = { duration: "seconds", resolution: "size" };
const AGNES_NUMERIC_FIELDS = new Set(["seconds", "n"]);

function toAgnesBody(body) {
  const payload = { mode: body.mode || "text" };
  for (const field of AGNES_TEXT_FIELDS) {
    if (field === "mode") continue;
    const value = body[field];
    if (value === undefined || value === null || value === "") continue;
    if (AGNES_NUMERIC_FIELDS.has(field)) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) payload[field] = parsed;
    } else {
      payload[field] = value;
    }
  }
  for (const [generic, agnesField] of Object.entries(AGNES_FIELD_ALIASES)) {
    const value = body[generic];
    if (value === undefined || value === null || value === "") continue;
    const parsed = Number(value);
    if (AGNES_NUMERIC_FIELDS.has(agnesField)) {
      if (Number.isFinite(parsed)) payload[agnesField] = parsed;
    } else if (typeof value === "string") {
      payload[agnesField] = value;
    }
  }
  return payload;
}

// Poll payload → the {id, request_id, status, video} contract clients poll for.
function fromAgnesResult(json, jobId) {
  if (!json || typeof json !== "object") return json;

  const status = String(json.status ?? json.state ?? "").toLowerCase();
  const url = json.url || json.metadata?.url || json.video?.url || null;
  const failed = status === "failed" || status === "error" || status === "cancelled";
  const done = status === "completed" || status === "success" || status === "done" || status === "succeeded";

  let mapped = "pending";
  if (failed) mapped = "failed";
  else if (done) mapped = "completed";
  else if (status === "processing" || status === "running" || status === "in_progress") mapped = "processing";

  const out = { id: jobId, request_id: jobId, status: mapped };
  if (json.progress != null) out.progress = json.progress;
  if (failed) {
    out.error = json.error ?? { message: json.message || "Video generation failed" };
  }
  if (done) {
    const video = url ? { url, mime_type: json.mime_type || "video/mp4" } : null;
    out.video = video;
    out.videos = video ? [video] : [];
  }
  return out;
}

export default {
  buildRequest({ config, action, requestId, rawBody, contentType, token }) {
    const base = (config.baseUrl || "").replace(/\/$/, "");

    // ── poll ──
    if (requestId) {
      const job = decodeJobId(requestId);
      // No bare-video_id fallback: the create leg always packs a validated model
      // into the id, and accepting any undecodable string as a raw id would let
      // a crafted payload reach the upstream query string unvalidated.
      if (!job) return { error: "Invalid Agnes video job id" };
      const pollBase = (config.pollUrl || "https://apihub.agnes-ai.com/agnesapi").replace(/\/$/, "");
      const query = new URLSearchParams({ video_id: job.videoId, model_name: job.model });
      return { method: "GET", url: `${pollBase}?${query.toString()}`, headers: jsonHeaders(token) };
    }

    // ── create ──
    // ponytail: Agnes has no edits/extensions endpoint; keyframe and reference
    // modes are expressed through the generations body instead.
    if (action !== "generations") {
      return { error: `Agnes video supports 'generations' only (got '${action}')` };
    }
    if (contentType && !contentType.includes("application/json")) {
      return { error: "Agnes video requires an application/json body" };
    }

    let body;
    try {
      body = JSON.parse(typeof rawBody === "string" ? rawBody : rawBody.toString("utf8"));
    } catch {
      return { error: "Invalid JSON body" };
    }
    if (!body.model) return { error: "Agnes video requires a model (e.g. agnes/agnes-video-2.5-flash)" };
    if (!JSON_WEB_API_RE.test(body.model)) return { error: "Invalid Agnes video model id" };
    if (!body.prompt) return { error: "Agnes video requires a prompt" };

    return {
      method: "POST",
      // No "/generations" suffix — Agnes mounts the collection at /videos.
      url: `${base}/videos`,
      headers: jsonHeaders(token),
      body: JSON.stringify(toAgnesBody(body)),
    };
  },

  transformResponse(json, ctx = {}) {
    // Poll leg: the upstream body carries no id, so the caller's job id is the
    // only identity available — keep it so clients can correlate the two legs.
    if (ctx.requestId) return fromAgnesResult(json, ctx.requestId);

    // Create leg returns the bare video_id. Pack the model alongside it so the
    // poll leg can rebuild the model_name query parameter — the create body is
    // the only place the model is still available.
    if (json && typeof json.video_id === "string" && !json.id && !json.request_id) {
      let model = null;
      try {
        const sent = JSON.parse(typeof ctx.rawBody === "string" ? ctx.rawBody : "");
        if (typeof sent?.model === "string" && JSON_WEB_API_RE.test(sent.model)) model = sent.model;
      } catch {
        // Fall through: an unparseable create body still yields a pollable id.
      }
      if (model) {
        const id = encodeJobId(model, json.video_id);
        return { id, request_id: id, status: "pending" };
      }
      return { id: json.video_id, request_id: json.video_id, status: "pending" };
    }
    return fromAgnesResult(json, json?.id || json?.request_id);
  },
};
