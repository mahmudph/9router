/**
 * Unit tests for the Agnes AI video adapter.
 *
 * Covers:
 *  - registry wiring (videoConfig, video serviceKind, video-kind models)
 *  - create: POST to {baseUrl}/videos (no /generations), body defaults mode:"text"
 *  - job id packing: { model, videoId } round-trips base64url so the poll leg can
 *    rebuild the model_name query parameter
 *  - poll: GET {pollUrl}?video_id=…&model_name=…
 *  - response mapping: video_id → id, pending/processing/completed/failed
 *  - hostile job ids are rejected before any fetch, and the model id / video id
 *    decoded out of a job id cannot inject query syntax into the upstream URL
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { handleVideoProxyCore, getVideoConfig } from "open-sse/handlers/videoCore.js";
import { PROVIDER_MEDIA, PROVIDER_MODELS } from "open-sse/providers/index.js";

const originalFetch = global.fetch;
const jsonResponse = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const CREATE_BODY = JSON.stringify({ model: "agnes-video-2.5-flash", prompt: "A paper boat at night" });

// Same packing the adapter does on the create response.
const JOB_ID = Buffer.from(
  JSON.stringify({ model: "agnes-video-2.5-flash", videoId: "vid_abc123" }),
  "utf8"
).toString("base64url");

const create = (rawBody = CREATE_BODY) =>
  handleVideoProxyCore({
    provider: "agnes",
    action: "generations",
    rawBody,
    contentType: "application/json",
    credentials: { apiKey: "sk-test" },
    log: null,
  });

const poll = (requestId) =>
  handleVideoProxyCore({
    provider: "agnes",
    requestId,
    credentials: { apiKey: "sk-test" },
    log: null,
  });

describe("agnes video registry wiring", () => {
  it("exposes videoConfig + the video service kind", () => {
    expect(getVideoConfig("agnes").baseUrl).toBe("https://apihub.agnes-ai.com/v1");
    expect(getVideoConfig("agnes").pollUrl).toBe("https://apihub.agnes-ai.com/agnesapi");
    expect(PROVIDER_MEDIA.agnes.serviceKinds).toContain("video");
  });

  it("registers the two text-to-video models as video kind", () => {
    const video = PROVIDER_MODELS.agnes.filter((m) => m.kind === "video").map((m) => m.id);
    expect(video).toEqual(["agnes-video-2.5", "agnes-video-2.5-flash"]);
  });
});

describe("agnes video create", () => {
  beforeEach(() => { global.fetch = vi.fn(); });
  afterEach(() => { global.fetch = originalFetch; });

  it("POSTs to {baseUrl}/videos without a /generations suffix", async () => {
    global.fetch.mockResolvedValueOnce(jsonResponse({ video_id: "vid_abc123" }));

    const result = await create();

    expect(result.success).toBe(true);
    const [url, init] = global.fetch.mock.calls[0];
    expect(url).toBe("https://apihub.agnes-ai.com/v1/videos");
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe("Bearer sk-test");
    expect(JSON.parse(init.body)).toMatchObject({
      model: "agnes-video-2.5-flash",
      prompt: "A paper boat at night",
      mode: "text",
    });
  });

  it("packs the model into the returned job id so the poll leg can rebuild it", async () => {
    global.fetch.mockResolvedValueOnce(jsonResponse({ video_id: "vid_abc123" }));

    const body = await (await create()).response.json();

    expect(body.status).toBe("pending");
    expect(body.id).toBe(body.request_id);
    const decoded = JSON.parse(Buffer.from(body.id, "base64url").toString("utf8"));
    expect(decoded).toEqual({ model: "agnes-video-2.5-flash", videoId: "vid_abc123" });
  });

  it("renames duration -> seconds and resolution -> size", async () => {
    // Agnes spells these differently: `seconds` (4-12) and `size` ("720P").
    // Forwarding the generic names is either ignored (silent default) or
    // rejected outright ("resolution is not an allowed request field").
    global.fetch.mockResolvedValueOnce(jsonResponse({ video_id: "vid_1" }));

    await create(JSON.stringify({
      model: "agnes-video-2.5-flash",
      prompt: "boat",
      duration: 8,
      resolution: "720P",
      aspect_ratio: "16:9",
    }));

    const body = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(body.seconds).toBe(8);
    expect(body.size).toBe("720P");
    expect(body.aspect_ratio).toBe("16:9");
    expect(body).not.toHaveProperty("duration");
    expect(body).not.toHaveProperty("resolution");
  });

  it("drops fields Agnes rejects instead of forwarding them", async () => {
    // Agnes 4xxes on any unknown key, so the body is allowlisted rather than
    // passed through — otherwise a generic field the dashboard adds breaks it.
    global.fetch.mockResolvedValueOnce(jsonResponse({ video_id: "vid_1" }));

    await create(JSON.stringify({
      model: "agnes-video-2.5-flash",
      prompt: "boat",
      n: 2,
      negative_prompt: "blurry",
      seed: 7,
      image: "https://example.com/ref.png",
      watty: "x",
    }));

    const body = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(body).toEqual({ model: "agnes-video-2.5-flash", mode: "text", prompt: "boat", n: 2 });
  });

  it("omits duration entirely when unset so Agnes applies its own default", async () => {
    global.fetch.mockResolvedValueOnce(jsonResponse({ video_id: "vid_1" }));

    await create(JSON.stringify({ model: "agnes-video-2.5-flash", prompt: "boat" }));

    const body = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(body).not.toHaveProperty("seconds");
  });

  it("rejects a non-generations action and a non-JSON body without fetching", async () => {
    const edited = await handleVideoProxyCore({
      provider: "agnes", action: "edits", rawBody: CREATE_BODY,
      contentType: "application/json", credentials: { apiKey: "sk-test" }, log: null,
    });
    expect(edited.status).toBe(400);
    expect(edited.error).toContain("generations");

    const multipart = await handleVideoProxyCore({
      provider: "agnes", action: "generations", rawBody: Buffer.from("x"),
      contentType: "multipart/form-data", credentials: { apiKey: "sk-test" }, log: null,
    });
    expect(multipart.status).toBe(400);

    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("rejects a model id carrying URL syntax and one with no prompt", async () => {
    const traversal = await create(JSON.stringify({ model: "../../evil", prompt: "x" }));
    expect(traversal.status).toBe(400);
    expect(traversal.error).toContain("model id");

    const noPrompt = await create(JSON.stringify({ model: "agnes-video-2.5-flash" }));
    expect(noPrompt.status).toBe(400);
    expect(noPrompt.error).toContain("prompt");

    expect(global.fetch).not.toHaveBeenCalled();
  });
});

describe("agnes video poll", () => {
  beforeEach(() => { global.fetch = vi.fn(); });
  afterEach(() => { global.fetch = originalFetch; });

  it("GETs the poll endpoint with video_id and model_name", async () => {
    global.fetch.mockResolvedValueOnce(jsonResponse({ status: "processing", progress: 40 }));

    const result = await poll(JOB_ID);

    expect(result.success).toBe(true);
    const [url, init] = global.fetch.mock.calls[0];
    expect(url).toBe(
      "https://apihub.agnes-ai.com/agnesapi?video_id=vid_abc123&model_name=agnes-video-2.5-flash"
    );
    expect(init.method).toBe("GET");
    expect(init.body).toBeUndefined();

    const body = await result.response.json();
    expect(body).toMatchObject({ id: JOB_ID, request_id: JOB_ID, status: "processing", progress: 40 });
  });

  it("maps a completed job onto the { status, video } contract", async () => {
    global.fetch.mockResolvedValueOnce(jsonResponse({ status: "completed", url: "https://cdn.test/v.mp4" }));

    const body = await (await poll(JOB_ID)).response.json();

    expect(body.status).toBe("completed");
    expect(body.video).toEqual({ url: "https://cdn.test/v.mp4", mime_type: "video/mp4" });
    expect(body.videos).toHaveLength(1);
  });

  it("reads the result url from metadata.url when present", async () => {
    global.fetch.mockResolvedValueOnce(
      jsonResponse({ status: "completed", metadata: { url: "https://cdn.test/meta.mp4" } })
    );

    const body = await (await poll(JOB_ID)).response.json();
    expect(body.video.url).toBe("https://cdn.test/meta.mp4");
  });

  it("preserves the upstream error on a failed job", async () => {
    global.fetch.mockResolvedValueOnce(
      jsonResponse({ status: "failed", error: { code: "content_policy", message: "blocked" } })
    );

    const body = await (await poll(JOB_ID)).response.json();
    expect(body.status).toBe("failed");
    expect(body.error).toEqual({ code: "content_policy", message: "blocked" });
  });

  it("rejects a bare video_id rather than forwarding it unvalidated", async () => {
    // The create leg always packs a model into the id, so an undecodable id is
    // never legitimate and must not reach the upstream query string.
    const result = await poll("vid_abc123");

    expect(result.status).toBe(400);
    expect(result.error).toContain("job id");
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("rejects hostile job ids before any fetch", async () => {
    const hostile = [
      "../../evil",
      "!!!not-base64!!!",
      `${JOB_ID}=`,
      `${JOB_ID}\n`,
      Buffer.from(JSON.stringify({ model: "a&b=c", videoId: "x" }), "utf8").toString("base64url"),
      Buffer.from(JSON.stringify({ model: "ok", videoId: "x&y=z" }), "utf8").toString("base64url"),
      Buffer.from(JSON.stringify({ model: "../../evil", videoId: "x" }), "utf8").toString("base64url"),
    ];

    for (const id of hostile) {
      const result = await poll(id);
      expect(result.status, id).toBe(400);
      expect(result.error).toContain("job id");
    }
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
