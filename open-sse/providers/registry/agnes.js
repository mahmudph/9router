export default {
  id: "agnes",
  priority: 120,
  alias: "agnes",
  aliases: [
    "agnes-ai",
  ],
  uiAlias: "agnes",
  display: {
    name: "Agnes AI",
    icon: "auto_awesome",
    color: "#7C3AED",
    textIcon: "AG",
    website: "https://agnes-ai.com",
    notice: {
      text: "OpenAI-compatible gateway from Agnes AI, offering free API credits on sign-up. Accepts a bearer token or an x-api-key header.",
      apiKeyUrl: "https://platform.agnes-ai.com",
    },
  },
  category: "freeTier",
  authType: "apikey",
  transport: {
    baseUrl: "https://apihub.agnes-ai.com/v1/chat/completions",
    validateUrl: "https://apihub.agnes-ai.com/v1/models",
  },
  // Seeds so the dashboard has something to show before a key is saved and
  // /v1/models answers with a usable list. The live catalogue at
  // apihub.agnes-ai.com/v1/models requires a token (401 "Token not provided"),
  // so these ids are a curated starting set rather than a verified dump —
  // passthroughModels below still accepts any id the account actually has.
  models: [
    { id: "agnes-2.5-flash", name: "Agnes 2.5 Flash" },
    { id: "agnes-2.5-pro", name: "Agnes 2.5 Pro" },
    { id: "agnes-2.5-pro-beta", name: "Agnes 2.5 Pro Beta" },
    { id: "agnes-3.0-flash", name: "Agnes 3.0 Flash" },
    // Image models are seeded for the same reason - /v1/models 401s without a
    // token, so there is no public image catalogue to dump.
    { id: "agnes-image-2.1-flash", name: "Agnes Image 2.1 Flash", kind: "image", capabilities: ["text2img"], params: ["n", "size", "response_format"] },
    { id: "agnes-image-2.0-flash", name: "Agnes Image 2.0 Flash", kind: "image", capabilities: ["text2img"], params: ["n", "size", "response_format"] },
  ],
  serviceKinds: [
    "llm",
    "image",
  ],
  imageConfig: {
    baseUrl: "https://apihub.agnes-ai.com/v1/images/generations",
  },
  passthroughModels: true,
};
