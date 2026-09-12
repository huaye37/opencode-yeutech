#!/usr/bin/env node
import { timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_BODY_LIMIT = 4 * 1024 * 1024;
const HOP_BY_HOP_HEADERS = new Set(["connection", "content-length", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade"]);
const STATIC_ROUTES = new Map([
  ["GET /global/health", true], ["GET /event", true], ["GET /session", true], ["POST /session", true],
  ["GET /session/status", true], ["GET /provider", true], ["GET /config/providers", true],
]);
const SESSION_ROUTES = [
  [/^\/session\/ses_[A-Za-z0-9]+$/, new Set(["GET", "PATCH", "DELETE"])],
  [/^\/session\/ses_[A-Za-z0-9]+\/message$/, new Set(["GET", "POST"])],
  [/^\/session\/ses_[A-Za-z0-9]+\/message\/msg_[A-Za-z0-9]+$/, new Set(["GET"])],
  [/^\/session\/ses_[A-Za-z0-9]+\/(?:children|diff|todo)$/, new Set(["GET"])],
  [/^\/session\/ses_[A-Za-z0-9]+\/(?:abort|fork|prompt_async|summarize)$/, new Set(["POST"])],
];
const MIME_TYPES = new Map([
  [".css", "text/css; charset=utf-8"], [".html", "text/html; charset=utf-8"], [".ico", "image/x-icon"],
  [".js", "text/javascript; charset=utf-8"], [".json", "application/json; charset=utf-8"], [".png", "image/png"],
  [".svg", "image/svg+xml"], [".woff2", "font/woff2"],
]);

function authorized(header, token) {
  if (!token) return true;
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
  if (Number.isFinite(declared) && declared > limit) throw Object.assign(new Error("Request body is too large"), { statusCode: 413 });
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error("Request body is too large"), { statusCode: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function forwardHeaders(headers, authorization) {
  const forwarded = {};
  for (const [name, value] of Object.entries(headers)) {
    const normalized = name.toLowerCase();
    if (normalized === "authorization" || normalized === "host" || normalized === "origin" || HOP_BY_HOP_HEADERS.has(normalized)) continue;
    if (value !== undefined) forwarded[normalized] = value;
  }
  if (authorization) forwarded.authorization = authorization;
  return forwarded;
}

function responseHeaders(headers) {
  return Object.fromEntries(Object.entries(headers).filter(([name, value]) => !HOP_BY_HOP_HEADERS.has(name.toLowerCase()) && value !== undefined));
}

async function proxy(request, response, options) {
  const incoming = new URL(request.url ?? "/", "http://127.0.0.1");
  const upstreamPath = incoming.pathname.slice(options.prefix.length) || "/";
  if (options.allow && !options.allow(request.method ?? "", upstreamPath)) {
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { message: "Route not allowed" } }));
    return;
  }
  const body = await readBody(request, options.bodyLimit);
  const upstreamURL = new URL(`${upstreamPath}${incoming.search}`, options.upstream);
  if (options.workspace) {
    upstreamURL.searchParams.delete("workspace");
    upstreamURL.searchParams.delete("path");
    upstreamURL.searchParams.delete("roots");
    upstreamURL.searchParams.set("directory", options.workspace);
  }
  const headers = forwardHeaders(request.headers, options.authorization);
  if (body.length > 0) headers["content-length"] = String(body.length);
  const upstreamRequest = http.request(upstreamURL, { method: request.method, headers });
  upstreamRequest.on("response", (upstreamResponse) => {
    response.writeHead(upstreamResponse.statusCode ?? 502, responseHeaders(upstreamResponse.headers));
    upstreamResponse.pipe(response);
  });
  upstreamRequest.on("error", (error) => {
    if (response.headersSent || response.writableEnded) return;
    response.writeHead(502, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { message: `Upstream transport failed: ${error.message}` } }));
  });
  response.once("close", () => { if (!response.writableEnded) upstreamRequest.destroy(); });
  upstreamRequest.end(body);
}

async function serveStatic(response, webRoot, pathname) {
  const relative = decodeURIComponent(pathname) === "/" ? "index.html" : decodeURIComponent(pathname).replace(/^\/+/, "");
  const candidate = path.resolve(webRoot, relative);
  if (!candidate.startsWith(`${path.resolve(webRoot)}${path.sep}`)) return false;
  const info = await stat(candidate).catch(() => null);
  const file = info?.isFile() ? candidate : path.join(webRoot, "index.html");
  if (!(await stat(file).catch(() => null))?.isFile()) return false;
  response.writeHead(200, {
    "content-type": MIME_TYPES.get(path.extname(file).toLowerCase()) ?? "application/octet-stream",
    "cache-control": path.basename(file) === "index.html" ? "no-cache" : "public, max-age=31536000, immutable",
  });
  createReadStream(file).pipe(response);
  return true;
}

export function createAgentBff(options) {
  if (options.token && options.token.length < 24) throw new Error("BFF token must contain at least 24 characters");
  if (!path.isAbsolute(options.workspace)) throw new Error("BFF workspace must be an absolute path");
  if (typeof options.upstreamUsername !== "string" || options.upstreamUsername.length === 0) throw new Error("OpenCode username is required");
  if (typeof options.upstreamPassword !== "string" || options.upstreamPassword.length < 24) throw new Error("OpenCode password must contain at least 24 characters");
  const upstream = new URL(options.upstreamURL ?? "http://127.0.0.1:18130");
  const migration = new URL(options.migrationURL ?? "http://127.0.0.1:18142");
  if (upstream.protocol !== "http:" || upstream.hostname !== "127.0.0.1") throw new Error("BFF upstream must use loopback HTTP");
  if (migration.protocol !== "http:" || migration.hostname !== "127.0.0.1") throw new Error("Migration upstream must use loopback HTTP");
  const authorization = `Basic ${Buffer.from(`${options.upstreamUsername}:${options.upstreamPassword}`).toString("base64")}`;
  const bodyLimit = options.bodyLimit ?? DEFAULT_BODY_LIMIT;

  return http.createServer(async (request, response) => {
    response.setHeader("x-content-type-options", "nosniff");
    const incoming = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method === "GET" && incoming.pathname === "/health") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true, workspace: options.workspace }));
      return;
    }
    try {
      if (incoming.pathname === "/api/agent" || incoming.pathname.startsWith("/api/agent/")) {
        if (!authorized(request.headers.authorization, options.token)) {
          response.writeHead(401, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: { message: "Unauthorized" } }));
          return;
        }
        await proxy(request, response, { prefix: "/api/agent", upstream, authorization, workspace: options.workspace, allow: allowed, bodyLimit });
        return;
      }
      if (incoming.pathname === "/api/migration" || incoming.pathname.startsWith("/api/migration/")) {
        await proxy(request, response, { prefix: "/api/migration", upstream: migration, bodyLimit });
        return;
      }
      if ((request.method === "GET" || request.method === "HEAD") && options.webRoot && await serveStatic(response, options.webRoot, incoming.pathname)) return;
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "Route not found" } }));
    } catch (error) {
      if (response.headersSent || response.writableEnded) return;
      response.writeHead(error.statusCode ?? 400, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: error.message } }));
    }
  });
}

async function main() {
  const server = createAgentBff({
    token: process.env.YEUTECH_AGENT_BFF_TOKEN || null,
    workspace: process.env.YEUTECH_AGENT_WORKSPACE,
    upstreamURL: process.env.YEUTECH_OPENCODE_URL ?? "http://127.0.0.1:18130",
    migrationURL: process.env.YEUTECH_MIGRATION_URL ?? "http://127.0.0.1:18142",
    upstreamUsername: process.env.OPENCODE_SERVER_USERNAME ?? "yeutech-agent",
    upstreamPassword: process.env.OPENCODE_SERVER_PASSWORD,
    webRoot: process.env.YEUTECH_AGENT_WEB_ROOT ?? path.resolve(import.meta.dirname, "../web/dist"),
  });
  const host = process.env.YEUTECH_AGENT_BFF_HOST ?? "0.0.0.0";
  const port = Number(process.env.YEUTECH_AGENT_BFF_PORT ?? 18140);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  process.stdout.write(`YEUTECH Agent Workbench listening on http://${host}:${port}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
