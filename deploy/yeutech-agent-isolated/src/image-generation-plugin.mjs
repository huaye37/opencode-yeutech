import { createHash } from "node:crypto";

const ALLOWED_SIZES = new Set(["auto", "1024x1024", "1024x1536", "1536x1024"]);
const ALLOWED_QUALITIES = new Set(["auto", "low", "medium", "high"]);
const CHAT_PROVIDER_TYPES = new Set(["gemini", "antigravity"]);
const OPENAI_IMAGE_PROVIDER_TYPES = new Set(["openai", "openai-image"]);
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
const DEFAULT_MAX_IMAGE_BYTES = 20 * 1024 * 1024;

export class ImageGenerationError extends Error {
  constructor(code, message, { status = 500, cause } = {}) {
    super(message, { cause });
    this.name = "ImageGenerationError";
    this.code = code;
    this.status = status;
  }
}

export function createImageGenerationPlugin({
  baseURL,
  token,
  fetchImpl = fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES,
  maxImageBytes = DEFAULT_MAX_IMAGE_BYTES,
  allowedImageHosts = [],
} = {}) {
  const endpoint = requireBaseURL(baseURL);
  const authorization = requireToken(token);
  const timeout = requirePositiveInteger(timeoutMs, "timeoutMs");
  const responseLimit = requirePositiveInteger(maxResponseBytes, "maxResponseBytes");
  const imageLimit = requirePositiveInteger(maxImageBytes, "maxImageBytes");
  const downloadHosts = new Set(allowedImageHosts.map((host) => requireSafeText(host, "allowedImageHost", 253).toLowerCase()));
  if (typeof fetchImpl !== "function") throw inputError("fetchImpl must be a function");

  async function listModels({ signal } = {}) {
    const payload = await requestJSON(new URL("model-capabilities", endpoint), {
      headers: { authorization },
      signal,
    }, { fetchImpl, timeout, responseLimit, operation: "catalog" });
    if (!payload || !Array.isArray(payload.data)) {
      throw new ImageGenerationError("IMAGE_CATALOG_INVALID", "Image model catalog has an invalid response shape", { status: 502 });
    }
    const seen = new Set();
    return payload.data.filter((model) => {
      if (!isEligibleImageModel(model) || seen.has(model.id)) return false;
      seen.add(model.id);
      return true;
    }).map((model) => ({
      id: model.id,
      name: typeof model.display_name === "string" && model.display_name.trim() ? model.display_name.trim() : model.id,
      providerType: normalizedProviderType(model),
    })).filter((model) => CHAT_PROVIDER_TYPES.has(model.providerType) || OPENAI_IMAGE_PROVIDER_TYPES.has(model.providerType))
      .sort((left, right) => left.id.localeCompare(right.id));
  }

  async function generate(input = {}) {
    const request = requireGenerationInput(input);
    const scoped = scopedSignal(request.signal, timeout);
    try {
      const models = await listModels({ signal: scoped.signal });
      const selected = request.model ? models.find((model) => model.id === request.model) : models[0];
      if (!selected) {
        throw new ImageGenerationError("IMAGE_MODEL_UNAVAILABLE", request.model
          ? `Image model is unavailable: ${request.model}`
          : "No ready image generation model is available", { status: 409 });
      }

      const headers = {
        authorization,
        "content-type": "application/json",
        accept: "application/json",
        ...(request.idempotencyKey ? { "idempotency-key": request.idempotencyKey } : {}),
      };
      const chat = CHAT_PROVIDER_TYPES.has(selected.providerType);
      const payload = chat ? {
        model: selected.id,
        messages: [{ role: "user", content: request.prompt }],
        stream: false,
        size: request.size,
        quality: request.quality,
      } : {
        model: selected.id,
        prompt: request.prompt,
        size: request.size,
        quality: request.quality,
        n: 1,
        response_format: "b64_json",
      };
      const response = await requestJSON(new URL(chat ? "chat/completions" : "images/generations", endpoint), {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        signal: scoped.signal,
      }, { fetchImpl, timeout, responseLimit, operation: "generation" });
      const image = chat ? chatImage(response) : openAIImage(response);
      const decoded = await decodeImage(image, { fetchImpl, signal: scoped.signal, timeout, imageLimit, downloadHosts });
      return {
        buffer: decoded.buffer,
        mimeType: decoded.mimeType,
        width: decoded.width,
        height: decoded.height,
        model: selected.id,
        usage: response?.usage ?? null,
        revisedPrompt: image.revisedPrompt ?? null,
        sha256: createHash("sha256").update(decoded.buffer).digest("hex"),
      };
    } finally {
      scoped.dispose();
    }
  }

  return Object.freeze({ listModels, generate });
}

function isEligibleImageModel(model) {
  return model && isSafeModelID(model.id) &&
    model.available !== false && model.selectable === true && model.capability_status === "ready" &&
    Array.isArray(model.supported_workloads) && model.supported_workloads.includes("image_generation") &&
    Array.isArray(model.supported_input_modalities) && model.supported_input_modalities.includes("text") &&
    Array.isArray(model.supported_output_modalities) && model.supported_output_modalities.includes("image");
}

function normalizedProviderType(model) {
  const type = typeof model.type === "string" ? model.type.trim().toLowerCase() : "";
  if (type) return type;
  return typeof model.owned_by === "string" ? model.owned_by.trim().toLowerCase() : "";
}

function requireGenerationInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw inputError("generation input must be an object");
  const prompt = typeof input.prompt === "string" ? input.prompt.trim() : "";
  if (!prompt || prompt.length > 20_000) throw inputError("prompt must contain 1 to 20000 characters");
  const model = input.model === undefined ? null : requireSafeText(input.model, "model", 512);
  const size = input.size === undefined ? "1024x1024" : requireSafeText(input.size, "size", 32);
  const quality = input.quality === undefined ? "auto" : requireSafeText(input.quality, "quality", 32);
  if (!ALLOWED_SIZES.has(size)) throw inputError(`unsupported size: ${size}`);
  if (!ALLOWED_QUALITIES.has(quality)) throw inputError(`unsupported quality: ${quality}`);
  const idempotencyKey = input.idempotencyKey === undefined ? null : requireIdempotencyKey(input.idempotencyKey);
  if (input.signal !== undefined && !(input.signal instanceof AbortSignal)) throw inputError("signal must be an AbortSignal");
  return { prompt, model, size, quality, idempotencyKey, signal: input.signal };
}

async function requestJSON(url, init, { fetchImpl, timeout, responseLimit, operation }) {
  const scoped = scopedSignal(init.signal, timeout);
  try {
    const response = await fetchImpl(url, { ...init, signal: scoped.signal });
    const body = await readBounded(response.body, responseLimit, "IMAGE_RESPONSE_TOO_LARGE");
    if (!response.ok) {
      const detail = body.toString("utf8").slice(0, 500).replace(/\s+/g, " ").trim();
      throw new ImageGenerationError(operation === "catalog" ? "IMAGE_CATALOG_UNAVAILABLE" : "IMAGE_UPSTREAM_ERROR",
        `${operation === "catalog" ? "Image model catalog" : "Image generation"} request failed (${response.status})${detail ? `: ${detail}` : ""}`,
        { status: 502 });
    }
    try {
      return JSON.parse(body.toString("utf8"));
    } catch (cause) {
      throw new ImageGenerationError(operation === "catalog" ? "IMAGE_CATALOG_INVALID" : "IMAGE_RESPONSE_INVALID",
        `${operation === "catalog" ? "Image model catalog" : "Image generation"} returned invalid JSON`, { status: 502, cause });
    }
  } catch (error) {
    throw normalizeRequestError(error, init.signal, scoped.timeoutSignal, operation);
  } finally {
    scoped.dispose();
  }
}

async function decodeImage(image, { fetchImpl, signal, timeout, imageLimit, downloadHosts }) {
  if (typeof image.base64 === "string") {
    const buffer = decodeBase64(image.base64, imageLimit);
    return inspectImage(buffer, image.declaredMimeType);
  }
  if (typeof image.url !== "string") throw new ImageGenerationError("IMAGE_RESPONSE_INVALID", "Image response does not contain image data", { status: 502 });
  if (image.url.startsWith("data:")) {
    const match = /^data:([^;,]+);base64,([A-Za-z0-9+/=\s]+)$/.exec(image.url);
    if (!match) throw new ImageGenerationError("IMAGE_RESPONSE_INVALID", "Image response contains an invalid data URL", { status: 502 });
    const buffer = decodeBase64(match[2], imageLimit);
    return inspectImage(buffer, match[1]);
  }
  const parsed = parseImageURL(image.url);
  if (parsed.protocol !== "https:") throw new ImageGenerationError("IMAGE_RESPONSE_INVALID", "Image response URL must use HTTPS", { status: 502 });
  if (!downloadHosts.has(parsed.hostname.toLowerCase())) throw new ImageGenerationError("IMAGE_RESPONSE_INVALID", "Image response URL host is not allowed", { status: 502 });
  const scoped = scopedSignal(signal, timeout);
  try {
    const response = await fetchImpl(parsed, { headers: { accept: "image/png,image/jpeg,image/webp" }, redirect: "error", signal: scoped.signal });
    if (!response.ok) throw new ImageGenerationError("IMAGE_UPSTREAM_ERROR", `Image download failed (${response.status})`, { status: 502 });
    const buffer = await readBounded(response.body, imageLimit, "IMAGE_RESPONSE_TOO_LARGE");
    return inspectImage(buffer, response.headers.get("content-type"));
  } catch (error) {
    throw normalizeRequestError(error, signal, scoped.timeoutSignal, "generation");
  } finally {
    scoped.dispose();
  }
}

function chatImage(response) {
  const message = response?.choices?.[0]?.message;
  const image = Array.isArray(message?.images) ? message.images[0] : null;
  return normalizeImageEntry(image, message?.revised_prompt ?? response?.revised_prompt);
}

function openAIImage(response) {
  const image = Array.isArray(response?.data) ? response.data[0] : null;
  return normalizeImageEntry(image, image?.revised_prompt ?? response?.revised_prompt);
}

function normalizeImageEntry(image, revisedPrompt) {
  if (!image || typeof image !== "object") throw new ImageGenerationError("IMAGE_RESPONSE_INVALID", "Image response does not contain an image", { status: 502 });
  const nestedURL = typeof image.image_url === "object" ? image.image_url?.url : image.image_url;
  return {
    base64: typeof image.b64_json === "string" ? image.b64_json : null,
    url: typeof nestedURL === "string" ? nestedURL : typeof image.url === "string" ? image.url : null,
    declaredMimeType: typeof image.mime_type === "string" ? image.mime_type : null,
    revisedPrompt: typeof revisedPrompt === "string" && revisedPrompt.trim() ? revisedPrompt : null,
  };
}

async function readBounded(stream, limit, code) {
  if (!stream) return Buffer.alloc(0);
  const chunks = [];
  let total = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.from(chunk);
    total += buffer.length;
    if (total > limit) throw new ImageGenerationError(code, `Response exceeds ${limit} bytes`, { status: 502 });
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, total);
}

function decodeBase64(value, limit) {
  const compact = value.replace(/\s+/g, "");
  if (!compact || !/^[A-Za-z0-9+/]*={0,2}$/.test(compact) || compact.length % 4 !== 0) {
    throw new ImageGenerationError("IMAGE_RESPONSE_INVALID", "Image response contains invalid base64", { status: 502 });
  }
  const estimated = Buffer.byteLength(compact, "base64");
  if (estimated > limit) throw new ImageGenerationError("IMAGE_RESPONSE_TOO_LARGE", `Image exceeds ${limit} bytes`, { status: 502 });
  const buffer = Buffer.from(compact, "base64");
  if (buffer.length > limit) throw new ImageGenerationError("IMAGE_RESPONSE_TOO_LARGE", `Image exceeds ${limit} bytes`, { status: 502 });
  return buffer;
}

function requireImageSignature(buffer, declaredMimeType) {
  const mimeType = buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    ? "image/png"
    : buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff
      ? "image/jpeg"
      : buffer.length >= 12 && buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP"
        ? "image/webp"
        : null;
  if (!mimeType) throw new ImageGenerationError("IMAGE_RESPONSE_INVALID", "Image response has an unsupported file signature", { status: 502 });
  const declared = typeof declaredMimeType === "string" ? declaredMimeType.split(";", 1)[0].trim().toLowerCase() : "";
  if (declared && declared !== "application/octet-stream" && declared !== mimeType) {
    throw new ImageGenerationError("IMAGE_RESPONSE_INVALID", `Image MIME type ${declared} does not match ${mimeType}`, { status: 502 });
  }
  return mimeType;
}

export function inspectImage(buffer, declaredMimeType) {
  if (!Buffer.isBuffer(buffer)) throw new ImageGenerationError("IMAGE_RESPONSE_INVALID", "Image response is not binary data", { status: 502 });
  const mimeType = requireImageSignature(buffer, declaredMimeType);
  const dimensions = mimeType === "image/png"
    ? pngDimensions(buffer)
    : mimeType === "image/jpeg"
      ? jpegDimensions(buffer)
      : webpDimensions(buffer);
  if (!dimensions || !validDimension(dimensions.width) || !validDimension(dimensions.height)) {
    throw new ImageGenerationError("IMAGE_RESPONSE_INVALID", "Image response does not contain valid dimensions", { status: 502 });
  }
  return { buffer, mimeType, ...dimensions };
}

function pngDimensions(buffer) {
  if (buffer.length < 24 || buffer.subarray(12, 16).toString("ascii") !== "IHDR") return null;
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

function jpegDimensions(buffer) {
  const startOfFrame = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
  let offset = 2;
  while (offset + 3 < buffer.length) {
    if (buffer[offset] !== 0xff) { offset += 1; continue; }
    while (offset < buffer.length && buffer[offset] === 0xff) offset += 1;
    const marker = buffer[offset++];
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) continue;
    if (marker === 0xda || marker === 0xd9 || offset + 2 > buffer.length) break;
    const length = buffer.readUInt16BE(offset);
    if (length < 2 || offset + length > buffer.length) break;
    if (startOfFrame.has(marker)) {
      if (length < 7) return null;
      return { width: buffer.readUInt16BE(offset + 5), height: buffer.readUInt16BE(offset + 3) };
    }
    offset += length;
  }
  return null;
}

function webpDimensions(buffer) {
  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const type = buffer.subarray(offset, offset + 4).toString("ascii");
    const length = buffer.readUInt32LE(offset + 4);
    const data = offset + 8;
    if (data + length > buffer.length) return null;
    if (type === "VP8X" && length >= 10) {
      return { width: 1 + readUInt24LE(buffer, data + 4), height: 1 + readUInt24LE(buffer, data + 7) };
    }
    if (type === "VP8 " && length >= 10 && buffer[data + 3] === 0x9d && buffer[data + 4] === 0x01 && buffer[data + 5] === 0x2a) {
      return { width: buffer.readUInt16LE(data + 6) & 0x3fff, height: buffer.readUInt16LE(data + 8) & 0x3fff };
    }
    if (type === "VP8L" && length >= 5 && buffer[data] === 0x2f) {
      return {
        width: 1 + buffer[data + 1] + ((buffer[data + 2] & 0x3f) << 8),
        height: 1 + (buffer[data + 2] >> 6) + (buffer[data + 3] << 2) + ((buffer[data + 4] & 0x0f) << 10),
      };
    }
    offset = data + length + (length % 2);
  }
  return null;
}

function readUInt24LE(buffer, offset) {
  return buffer[offset] | (buffer[offset + 1] << 8) | (buffer[offset + 2] << 16);
}

function validDimension(value) {
  return Number.isSafeInteger(value) && value > 0 && value <= 100_000;
}

function scopedSignal(signal, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException("Timed out", "TimeoutError")), timeoutMs);
  const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  return { signal: combined, timeoutSignal: controller.signal, dispose: () => clearTimeout(timer) };
}

function normalizeRequestError(error, userSignal, timeoutSignal, operation) {
  if (error instanceof ImageGenerationError) return error;
  if (userSignal?.aborted) {
    if (userSignal.reason?.name === "TimeoutError") {
      return new ImageGenerationError("IMAGE_TIMEOUT", `Image ${operation} timed out`, { status: 504, cause: error });
    }
    return new ImageGenerationError("IMAGE_CANCELLED", "Image generation was cancelled", { status: 499, cause: error });
  }
  if (timeoutSignal.aborted) return new ImageGenerationError("IMAGE_TIMEOUT", `Image ${operation} timed out`, { status: 504, cause: error });
  return new ImageGenerationError(operation === "catalog" ? "IMAGE_CATALOG_UNAVAILABLE" : "IMAGE_UPSTREAM_ERROR",
    `Image ${operation} request failed`, { status: 502, cause: error });
}

function parseImageURL(value) {
  try {
    return new URL(value);
  } catch (cause) {
    throw new ImageGenerationError("IMAGE_RESPONSE_INVALID", "Image response contains an invalid URL", { status: 502, cause });
  }
}

function isSafeModelID(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 512 && !/[\u0000-\u001f\u007f]/.test(value);
}

function requireBaseURL(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("protocol");
    return new URL(url.pathname.endsWith("/") ? url : `${url.toString()}/`);
  } catch {
    throw inputError("baseURL must be an HTTP(S) URL");
  }
}

function requireToken(value) {
  const token = typeof value === "string" ? value.trim() : "";
  if (!token || /[\u0000-\u001f\u007f]/.test(token)) throw inputError("token must be a non-empty credential");
  return `Bearer ${token}`;
}

function requireSafeText(value, field, maxLength) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text || text.length > maxLength || /[\u0000-\u001f\u007f]/.test(text)) throw inputError(`${field} is invalid`);
  return text;
}

function requireIdempotencyKey(value) {
  const key = requireSafeText(value, "idempotencyKey", 128);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(key)) throw inputError("idempotencyKey is invalid");
  return key;
}

function requirePositiveInteger(value, field) {
  if (!Number.isSafeInteger(value) || value <= 0) throw inputError(`${field} must be a positive safe integer`);
  return value;
}

function inputError(message) {
  return new ImageGenerationError("IMAGE_INPUT_INVALID", message, { status: 400 });
}
