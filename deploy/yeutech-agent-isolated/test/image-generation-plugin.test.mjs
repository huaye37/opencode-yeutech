import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import http from "node:http";
import test from "node:test";
import { createImageGenerationPlugin, ImageGenerationError, inspectImage } from "../src/image-generation-plugin.mjs";

const PNG = pngHeader(1264, 848);
const JPEG = jpegHeader(1536, 1024);
const WEBP = webpExtendedHeader(640, 960);

test("selects only ready image workloads from the authenticated capability catalog", async () => {
  const requests = [];
  const server = await startServer(async (request, response) => {
    requests.push({ path: request.url, authorization: request.headers.authorization });
    sendJSON(response, { object: "list", data: [
      capability("gemini-image", "antigravity"),
      capability("openai-image", "openai"),
      { ...capability("offline", "openai"), available: false },
      { ...capability("incomplete", "openai"), capability_status: "incomplete", selectable: false },
      { ...capability("chat", "openai"), supported_workloads: ["conversation"], supported_output_modalities: ["text"] },
      { ...capability("no-text-input", "openai"), supported_input_modalities: ["image"] },
    ] });
  });
  try {
    const plugin = createImageGenerationPlugin({ baseURL: `${server.url}/v1`, token: "catalog-secret" });
    assert.deepEqual(await plugin.listModels(), [
      { id: "gemini-image", name: "gemini-image", providerType: "antigravity" },
      { id: "openai-image", name: "openai-image", providerType: "openai" },
    ]);
    assert.deepEqual(requests, [{ path: "/v1/model-capabilities", authorization: "Bearer catalog-secret" }]);
  } finally {
    await server.close();
  }
});

test("adapts Gemini image responses from chat completions and normalizes PNG output", async () => {
  const requests = [];
  const server = await startServer(async (request, response) => {
    if (request.url === "/v1/model-capabilities") return sendJSON(response, { data: [capability("gemini-image", "antigravity")] });
    requests.push({ path: request.url, headers: request.headers, body: await readJSON(request) });
    sendJSON(response, {
      choices: [{ message: { images: [{ image_url: { url: `data:image/png;base64,${PNG.toString("base64")}` } }], revised_prompt: "refined" } }],
      usage: { prompt_tokens: 12, total_tokens: 20 },
    });
  });
  try {
    const result = await createImageGenerationPlugin({ baseURL: `${server.url}/v1/`, token: "secret" }).generate({
      prompt: "  paint a quiet harbor  ", model: "gemini-image", size: "1536x1024", quality: "high", idempotencyKey: "job:42",
    });
    assert.equal(requests[0].path, "/v1/chat/completions");
    assert.equal(requests[0].headers["idempotency-key"], "job:42");
    assert.deepEqual(requests[0].body, {
      model: "gemini-image",
      messages: [{ role: "user", content: "paint a quiet harbor" }],
      stream: false,
      size: "1536x1024",
      quality: "high",
    });
    assert.deepEqual(result, {
      buffer: PNG,
      mimeType: "image/png",
      width: 1264,
      height: 848,
      model: "gemini-image",
      usage: { prompt_tokens: 12, total_tokens: 20 },
      revisedPrompt: "refined",
      sha256: createHash("sha256").update(PNG).digest("hex"),
    });
  } finally {
    await server.close();
  }
});

test("adapts OpenAI image generations and normalizes JPEG output", async () => {
  const requests = [];
  const server = await startServer(async (request, response) => {
    if (request.url === "/v1/model-capabilities") return sendJSON(response, { data: [capability("gpt-image", "openai")] });
    requests.push({ path: request.url, body: await readJSON(request) });
    sendJSON(response, { data: [{ b64_json: JPEG.toString("base64"), revised_prompt: "safer prompt" }], usage: { total_tokens: 7 } });
  });
  try {
    const result = await createImageGenerationPlugin({ baseURL: `${server.url}/v1`, token: "secret" }).generate({ prompt: "portrait", model: "gpt-image" });
    assert.equal(requests[0].path, "/v1/images/generations");
    assert.deepEqual(requests[0].body, {
      model: "gpt-image", prompt: "portrait", size: "1024x1024", quality: "auto", n: 1, response_format: "b64_json",
    });
    assert.deepEqual(result.buffer, JPEG);
    assert.equal(result.mimeType, "image/jpeg");
    assert.deepEqual({ width: result.width, height: result.height }, { width: 1536, height: 1024 });
    assert.equal(result.revisedPrompt, "safer prompt");
  } finally {
    await server.close();
  }
});

test("downloads HTTPS image URLs with a bounded response and validates WebP", async () => {
  const calls = [];
  const plugin = createImageGenerationPlugin({
    baseURL: "https://proxy.test/v1",
    token: "secret",
    allowedImageHosts: ["assets.test"],
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init });
      if (String(url).endsWith("/model-capabilities")) return jsonResponse({ data: [capability("gpt-image", "openai")] });
      if (String(url).endsWith("/images/generations")) return jsonResponse({ data: [{ url: "https://assets.test/image.webp" }] });
      return new Response(WEBP, { headers: { "content-type": "image/webp" } });
    },
  });
  const result = await plugin.generate({ prompt: "webp" });
  assert.equal(calls[2].url, "https://assets.test/image.webp");
  assert.equal(result.mimeType, "image/webp");
  assert.deepEqual({ width: result.width, height: result.height }, { width: 640, height: 960 });
  assert.deepEqual(result.buffer, WEBP);
});

test("reads actual PNG, JPEG, and WebP dimensions from the encoded image", () => {
  assert.deepEqual(stripBuffer(inspectImage(pngHeader(2048, 1152), "image/png")), { mimeType: "image/png", width: 2048, height: 1152 });
  assert.deepEqual(stripBuffer(inspectImage(jpegHeader(1264, 848), "image/jpeg")), { mimeType: "image/jpeg", width: 1264, height: 848 });
  assert.deepEqual(stripBuffer(inspectImage(webpExtendedHeader(768, 512), "image/webp")), { mimeType: "image/webp", width: 768, height: 512 });
});

test("rejects remote image URLs unless the host is explicitly trusted", async () => {
  const plugin = createImageGenerationPlugin({
    baseURL: "https://proxy.test/v1",
    token: "secret",
    fetchImpl: async (url) => String(url).endsWith("/model-capabilities")
      ? jsonResponse({ data: [capability("gpt-image", "openai")] })
      : jsonResponse({ data: [{ url: "https://127.0.0.1/private.png" }] }),
  });
  await assert.rejects(plugin.generate({ prompt: "private" }), errorCode("IMAGE_RESPONSE_INVALID"));
});

test("rejects invalid inputs before contacting the catalog", async () => {
  let calls = 0;
  const plugin = createImageGenerationPlugin({
    baseURL: "http://proxy.test/v1",
    token: "secret",
    fetchImpl: async () => { calls += 1; throw new Error("must not run"); },
  });
  for (const input of [
    {},
    { prompt: "x", size: "2048x2048" },
    { prompt: "x", quality: "ultra" },
    { prompt: "x", model: "bad\nmodel" },
    { prompt: "x", idempotencyKey: "bad key" },
  ]) {
    await assert.rejects(plugin.generate(input), errorCode("IMAGE_INPUT_INVALID"));
  }
  assert.equal(calls, 0);
});

test("fails closed for unavailable models, invalid signatures, and oversized images", async (t) => {
  await t.test("unavailable", async () => {
    const plugin = createImageGenerationPlugin({
      baseURL: "http://proxy.test/v1", token: "secret",
      fetchImpl: async () => jsonResponse({ data: [{ ...capability("image", "openai"), selectable: false }] }),
    });
    await assert.rejects(plugin.generate({ prompt: "x", model: "image" }), errorCode("IMAGE_MODEL_UNAVAILABLE"));
  });
  await t.test("signature", async () => {
    const plugin = scriptedPlugin(Buffer.from("not-an-image"));
    await assert.rejects(plugin.generate({ prompt: "x" }), errorCode("IMAGE_RESPONSE_INVALID"));
  });
  await t.test("size", async () => {
    const plugin = scriptedPlugin(PNG, { maxImageBytes: 4 });
    await assert.rejects(plugin.generate({ prompt: "x" }), errorCode("IMAGE_RESPONSE_TOO_LARGE"));
  });
});

test("returns stable upstream, timeout, and cancellation errors", async (t) => {
  await t.test("upstream", async () => {
    const plugin = createImageGenerationPlugin({
      baseURL: "http://proxy.test/v1", token: "secret",
      fetchImpl: async () => new Response("provider down", { status: 503 }),
    });
    await assert.rejects(plugin.listModels(), errorCode("IMAGE_CATALOG_UNAVAILABLE"));
  });
  await t.test("timeout", async () => {
    const plugin = createImageGenerationPlugin({
      baseURL: "http://proxy.test/v1", token: "secret", timeoutMs: 5,
      fetchImpl: (_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true })),
    });
    await assert.rejects(plugin.listModels(), errorCode("IMAGE_TIMEOUT"));
  });
  await t.test("cancel", async () => {
    const controller = new AbortController();
    const plugin = createImageGenerationPlugin({
      baseURL: "http://proxy.test/v1", token: "secret",
      fetchImpl: (_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true })),
    });
    const pending = plugin.listModels({ signal: controller.signal });
    controller.abort();
    await assert.rejects(pending, errorCode("IMAGE_CANCELLED"));
  });
});

function scriptedPlugin(image, options = {}) {
  let call = 0;
  return createImageGenerationPlugin({
    baseURL: "http://proxy.test/v1",
    token: "secret",
    ...options,
    fetchImpl: async () => {
      call += 1;
      if (call === 1) return jsonResponse({ data: [capability("image", "openai")] });
      return jsonResponse({ data: [{ b64_json: image.toString("base64") }] });
    },
  });
}

function capability(id, type) {
  return {
    id,
    type,
    available: true,
    selectable: true,
    capability_status: "ready",
    supported_workloads: ["image_generation"],
    supported_input_modalities: ["text"],
    supported_output_modalities: ["image"],
  };
}

function errorCode(code) {
  return (error) => error instanceof ImageGenerationError && error.code === code;
}

function jsonResponse(body, init = {}) {
  return new Response(JSON.stringify(body), { ...init, headers: { "content-type": "application/json", ...init.headers } });
}

function sendJSON(response, body, status = 200) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

function pngHeader(width, height) {
  const buffer = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer);
  buffer.writeUInt32BE(13, 8);
  buffer.write("IHDR", 12, "ascii");
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  return buffer;
}

function jpegHeader(width, height) {
  const buffer = Buffer.alloc(23);
  Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08]).copy(buffer);
  buffer.writeUInt16BE(height, 7);
  buffer.writeUInt16BE(width, 9);
  buffer[11] = 3;
  Buffer.from([1, 0x11, 0, 2, 0x11, 0, 3, 0x11, 0, 0xff, 0xd9]).copy(buffer, 12);
  return buffer;
}

function webpExtendedHeader(width, height) {
  const buffer = Buffer.alloc(30);
  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(22, 4);
  buffer.write("WEBPVP8X", 8, "ascii");
  buffer.writeUInt32LE(10, 16);
  writeUInt24LE(buffer, width - 1, 24);
  writeUInt24LE(buffer, height - 1, 27);
  return buffer;
}

function writeUInt24LE(buffer, value, offset) {
  buffer[offset] = value & 0xff;
  buffer[offset + 1] = (value >> 8) & 0xff;
  buffer[offset + 2] = (value >> 16) & 0xff;
}

function stripBuffer(result) {
  const { buffer: _buffer, ...metadata } = result;
  return metadata;
}

async function readJSON(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function startServer(handler) {
  const server = http.createServer((request, response) => void handler(request, response));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
