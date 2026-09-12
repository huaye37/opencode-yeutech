#!/usr/bin/env node
import { timingSafeEqual } from "node:crypto";
import http from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_BODY_LIMIT = 4 * 1024 * 1024;
const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "content-length",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);
const STATIC_ROUTES = new Map([
  ["GET /global/health", true],
  ["GET /event", true],
  ["GET /session", true],
  ["POST /session", true],
  ["GET /session/status", true],
  ["GET /provider", true],
  ["GET /config/providers", true],
]);
const SESSION_ROUTES = [
  [/^\/session\/ses_[A-Za-z0-9]+$/, new Set(["GET", "PATCH", "DELETE"])],
  [/^\/session\/ses_[A-Za-z0-9]+\/message$/, new Set(["GET", "POST"])],
  [/^\/session\/ses_[A-Za-z0-9]+\/message\/msg_[A-Za-z0-9]+$/, new Set(["GET"])],
  [/^\/session\/ses_[A-Za-z0-9]+\/(?:children|diff|todo)$/, new Set(["GET"])],
  [/^\/session\/ses_[A-Za-z0-9]+\/(?:abort|fork|prompt_async|summarize)$/, new Set(["POST"])],
];

function authorized(header, token) {
  if (typeof header !== "string" || !header.startsWith("Bearer ")) return false;
  const supplied = Buffer.from(header.slice(7));
  const expected = Buffer.from(token);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function allowed(method, pathname) {
  if (STATIC_ROUTES.has(`${method} ${pathname}`)) return true;
  return SESSION_ROUTES.some(([pattern, methods]) => pattern.test(pathname) && methods.has(method));
}

async function readBody(request, limit) {
  const declared = Number(request.headers["content-length"] ?? 0);
  if (Number.isFinite(declared) && declared > limit) {
    const error = new Error("Request body is too large");
    error.statusCode = 413;
    throw error;
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) {
      const error = new Error("Request body is too large");
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function forwardHeaders(headers, authorization) {
  const forwarded = {};
  for (const [name, value] of Object.entries(headers)) {
    const normalized = name.toLowerCase();
    if (normalized === "authorization" || normalized === "host" || HOP_BY_HOP_HEADERS.has(normalized)) continue;
    if (value !== undefined) forwarded[normalized] = value;
  }
  forwarded.authorization = authorization;
  return forwarded;
}

function responseHeaders(headers) {
  const forwarded = {};
  for (const [name, value] of Object.entries(headers)) {
    if (!HOP_BY_HOP_HEADERS.has(name.toLowerCase()) && value !== undefined) forwarded[name] = value;
  }
  return forwarded;
}

export function createAgentBff(options) {
  if (typeof options.token !== "string" || options.token.length < 24) {
    throw new Error("BFF token must contain at least 24 characters");
  }
  if (!path.isAbsolute(options.workspace)) throw new Error("BFF workspace must be an absolute path");
  if (typeof options.upstreamUsername !== "string" || options.upstreamUsername.length === 0) {
    throw new Error("OpenCode username is required");
  }
  if (typeof options.upstreamPassword !== "string" || options.upstreamPassword.length < 24) {
    throw new Error("OpenCode password must contain at least 24 characters");
  }
  const upstream = new URL(options.upstreamURL ?? "http://127.0.0.1:18130");
  if (upstream.protocol !== "http:" || upstream.hostname !== "127.0.0.1") {
    throw new Error("BFF upstream must use loopback HTTP");
  }
  const upstreamAuthorization = `Basic ${Buffer.from(`${options.upstreamUsername}:${options.upstreamPassword}`).toString("base64")}`;
  const bodyLimit = options.bodyLimit ?? DEFAULT_BODY_LIMIT;

  return http.createServer(async (request, response) => {
    response.setHeader("x-content-type-options", "nosniff");
    if (!authorized(request.headers.authorization, options.token)) {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "Unauthorized" } }));
      return;
    }

    const incoming = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method === "GET" && incoming.pathname === "/health") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true, workspace: "sample" }));
      return;
    }
    if (!allowed(request.method ?? "", incoming.pathname)) {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "Route not allowed" } }));
      return;
    }

    try {
      const body = await readBody(request, bodyLimit);
      incoming.searchParams.delete("workspace");
      incoming.searchParams.delete("path");
      incoming.searchParams.delete("roots");
      incoming.searchParams.set("directory", options.workspace);
      const headers = forwardHeaders(request.headers, upstreamAuthorization);
      if (body.length > 0) headers["content-length"] = String(body.length);

      const upstreamRequest = http.request(new URL(`${incoming.pathname}${incoming.search}`, upstream), {
        method: request.method,
        headers,
      });
      upstreamRequest.on("response", (upstreamResponse) => {
        response.writeHead(upstreamResponse.statusCode ?? 502, responseHeaders(upstreamResponse.headers));
        upstreamResponse.pipe(response);
      });
      upstreamRequest.on("error", (error) => {
        if (response.headersSent || response.writableEnded) return;
        response.writeHead(502, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: `OpenCode transport failed: ${error.message}` } }));
      });
      response.once("close", () => {
        if (!response.writableEnded) upstreamRequest.destroy();
      });
      upstreamRequest.end(body);
    } catch (error) {
      if (response.headersSent || response.writableEnded) return;
      response.writeHead(error.statusCode ?? 400, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: error.message } }));
    }
  });
}

async function main() {
  const host = process.env.YEUTECH_AGENT_BFF_HOST ?? "127.0.0.1";
  if (host !== "127.0.0.1" && host !== "::1") throw new Error("BFF may only bind to loopback");
  const server = createAgentBff({
    token: process.env.YEUTECH_AGENT_BFF_TOKEN,
    workspace: process.env.YEUTECH_AGENT_WORKSPACE,
    upstreamURL: process.env.YEUTECH_OPENCODE_URL ?? "http://127.0.0.1:18130",
    upstreamUsername: process.env.OPENCODE_SERVER_USERNAME ?? "yeutech-agent",
    upstreamPassword: process.env.OPENCODE_SERVER_PASSWORD,
  });
  const port = Number(process.env.YEUTECH_AGENT_BFF_PORT ?? 18131);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  process.stdout.write(`YEUTECH Agent BFF listening on http://${host}:${port}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
