// Agnes AI image adapter - OpenAI-compatible endpoint, but sizing is expressed
// as an aspect_ratio rather than fixed pixels (e.g. "16:9", not "1792x1024"),
// so the shared createOpenAIAdapter cannot be reused here.
import { sizeToAspectRatio } from "./_base.js";
import { PROVIDER_MEDIA } from "../../providers/index.js";

const imageCfg = () => PROVIDER_MEDIA["agnes"]?.imageConfig || {};

export default {
  buildUrl: () => imageCfg().baseUrl,

  buildHeaders: (creds) => {
    const headers = { "Content-Type": "application/json", ...(imageCfg().headers || {}) };
    const key = creds?.apiKey || creds?.accessToken;
    if (key) headers["Authorization"] = `Bearer ${key}`;
    return headers;
  },

  buildBody: (model, body) => {
    const { prompt, n = 1, response_format } = body;
    const req = { model, prompt, n, aspect_ratio: sizeToAspectRatio(body.size) };
    if (response_format) req.response_format = response_format;
    return req;
  },

  normalize: (responseBody) => responseBody, // already OpenAI-shaped
};