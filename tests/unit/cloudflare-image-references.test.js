import { afterEach, describe, expect, it, vi } from "vitest";
import adapter from "../../open-sse/handlers/imageProviders/cloudflareAi.js";
import { handleImageGenerationCore } from "../../open-sse/handlers/imageGenerationCore.js";
import { GET as getModelInfo } from "../../src/app/api/v1/models/info/route.js";

const models = [
  "@cf/black-forest-labs/flux-2-dev",
  "@cf/black-forest-labs/flux-2-klein-4b",
  "@cf/black-forest-labs/flux-2-klein-9b",
];
const bytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64");
const dataUri = `data:image/png;base64,${bytes.toString("base64")}`;

afterEach(() => vi.unstubAllGlobals());

describe("Cloudflare FLUX.2 image references", () => {
  it.each(models)("sends a binary image part for %s", async (model) => {
    const form = await adapter.buildBody(model, { prompt: "Keep the subject", image: dataUri });
    const image = form.get("input_image_0");
    expect(image).toBeInstanceOf(Blob);
    expect(Buffer.from(await image.arrayBuffer())).toEqual(bytes);
    expect(form.get("prompt")).toBe("Keep the subject");
  });

  it.each(models)("advertises image references through model-info for %s", async (model) => {
    const response = await getModelInfo(new Request(`http://router.test/v1/models/info?${new URLSearchParams({ id: `cf/${model}`, kind: "image" })}`));
    expect(response.status).toBe(200);
    const info = await response.json();
    expect(info.params).toEqual(expect.arrayContaining(["image", "images", "size"]));
    expect(info.capabilities).toContain("edit");
  });

  it("preserves images array order and appends the singular image", async () => {
    const inputs = [dataUri, Buffer.from("second").toString("base64"), [3, 4, 5]];
    const form = await adapter.buildBody(models[2], { prompt: "Combine", images: inputs, image: [6, 7] });
    const expected = [bytes, Buffer.from("second"), Buffer.from([3, 4, 5]), Buffer.from([6, 7])];
    for (const [index, value] of expected.entries()) {
      expect(Buffer.from(await form.get(`input_image_${index}`).arrayBuffer())).toEqual(value);
    }
    expect(form.get("input_image_4")).toBeNull();
  });

  it("downloads URL references without sending provider credentials", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(bytes, { headers: { "Content-Type": "image/png" } }));
    vi.stubGlobal("fetch", fetchMock);
    const form = await adapter.buildBody(models[2], { prompt: "Edit", image: "https://example.com/reference.png" });
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith("https://example.com/reference.png");
    expect(Buffer.from(await form.get("input_image_0").arrayBuffer())).toEqual(bytes);
  });

  it("keeps prompt-only multipart requests and optional controls intact", async () => {
    const form = await adapter.buildBody(models[2], { prompt: "Landscape", size: "1024x768", seed: 0, guidance: 3 });
    expect([...form.keys()]).toEqual(["prompt", "width", "height", "guidance", "seed"]);
    expect(form.get("seed")).toBe("0");
    expect(form.get("width")).toBe("1024");
    expect(adapter.buildHeaders({ apiKey: "test-token" }, form)).not.toHaveProperty("Content-Type");
  });

  it.each([
    { images: "not-an-array" },
    { images: [null] },
    { image: {} },
    { image: "" },
    { image: [] },
  ])("rejects malformed references instead of silently dropping them: %j", async (references) => {
    await expect(adapter.buildBody(models[2], { prompt: "Edit", ...references })).rejects.toThrow(/image|reference/i);
  });

  it("rejects excess references before downloading or generating", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const result = await handleImageGenerationCore({
      body: { prompt: "Edit", images: Array(5).fill("https://example.com/reference.png") },
      modelInfo: { provider: "cloudflare-ai", model: models[2] },
      credentials: { apiKey: "test-token", providerSpecificData: { accountId: "account" } },
    });
    expect(result.success).toBe(false);
    expect(result.status).toBe(400);
    expect(result.error).toContain("4");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not submit generation when a reference download fails", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("missing", { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await handleImageGenerationCore({
      body: { prompt: "Edit", image: "https://example.com/missing.png" },
      modelInfo: { provider: "cloudflare-ai", model: models[2] },
      credentials: { apiKey: "test-token", providerSpecificData: { accountId: "account" } },
    });
    expect(result.success).toBe(false);
    expect(result.status).toBe(400);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe("https://example.com/missing.png");
  });

  it("sends image parts through the generation core and returns the generated image", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ success: true, result: { image: bytes.toString("base64") } }), { headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await handleImageGenerationCore({
      body: { prompt: "Make the background blue", images: [dataUri] },
      modelInfo: { provider: "cloudflare-ai", model: models[2] },
      credentials: { apiKey: "test-token", providerSpecificData: { accountId: "account" } },
    });
    expect(result.success).toBe(true);
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe(`https://api.cloudflare.com/client/v4/accounts/account/ai/run/${models[2]}`);
    expect(options.body.get("input_image_0")).toBeInstanceOf(Blob);
    expect(options.headers.Authorization).toBe("Bearer test-token");
    expect(options.headers).not.toHaveProperty("Content-Type");
    expect((await result.response.json()).data[0].b64_json).toBe(bytes.toString("base64"));
  });
});
