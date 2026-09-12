#!/usr/bin/env node
import { spawn } from "node:child_process";
import { timingSafeEqual } from "node:crypto";
import http from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_BODY_LIMIT = 2 * 1024 * 1024;
const ALLOWED_ROUTES = new Map([
  ["GET /v1/models", { method: "GET", path: "/v1/models" }],
  ["POST /v1/chat/completions", { method: "POST", path: "/v1/chat/completions" }],
]);
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

function authorized(header, token) {
  if (typeof header !== "string" || !header.startsWith("Bearer ")) return false;
  const supplied = Buffer.from(header.slice(7));
  const expected = Buffer.from(token);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
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

function remoteCurlCommand(route) {
  const input = route.method === "POST" ? "--data-binary @-" : "";
  return `set -eu
key=$(tr -d '\\r\\n' < /volume1/docker/yeutech-api-manager/secrets/api.key)
exec 3<<EOF
Authorization: Bearer $key
EOF
exec curl --silent --show-error --no-buffer --request ${route.method} --header @/dev/fd/3 --header 'Content-Type: application/json' --header 'Expect:' --dump-header - --output - ${input} http://127.0.0.1:18319${route.path}`;
}

export function spawnNasRequest(route, options = {}) {
  const target = options.sshTarget ?? "nas-local";
  if (!/^[A-Za-z0-9._-]+$/.test(target)) throw new Error("Invalid SSH target");
  return spawn(
    "ssh",
    ["-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", target, remoteCurlCommand(route)],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
}

function parseHeaderBlock(block) {
  const lines = block.toString("latin1").split("\r\n");
  const match = /^HTTP\/\S+\s+(\d{3})/.exec(lines.shift() ?? "");
  if (!match) throw new Error("NAS gateway returned an invalid HTTP status line");
  const headers = {};
  for (const line of lines) {
    const separator = line.indexOf(":");
    if (separator <= 0) continue;
    const name = line.slice(0, separator).trim().toLowerCase();
    if (!HOP_BY_HOP_HEADERS.has(name)) headers[name] = line.slice(separator + 1).trim();
  }
  return { statusCode: Number(match[1]), headers };
}

function proxyChild(child, response) {
  let pending = Buffer.alloc(0);
  let headersSent = false;
  let stderr = "";

  child.stderr.on("data", (chunk) => {
    if (stderr.length < 8192) stderr += chunk.toString("utf8", 0, 8192 - stderr.length);
  });

  child.stdout.on("data", (chunk) => {
    if (headersSent) {
      if (!response.write(chunk)) child.stdout.pause();
      return;
    }
    pending = Buffer.concat([pending, chunk]);
    const boundary = pending.indexOf("\r\n\r\n");
    if (boundary < 0) {
      if (pending.length > 64 * 1024) child.kill("SIGTERM");
      return;
    }
    try {
      const parsed = parseHeaderBlock(pending.subarray(0, boundary));
      response.writeHead(parsed.statusCode, parsed.headers);
      headersSent = true;
      const body = pending.subarray(boundary + 4);
      if (body.length > 0) response.write(body);
      pending = Buffer.alloc(0);
    } catch (error) {
      if (!response.headersSent) response.writeHead(502, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: error.message } }));
      child.kill("SIGTERM");
    }
  });
  response.on("drain", () => child.stdout.resume());

  child.on("error", (error) => {
    if (!response.headersSent) response.writeHead(502, { "content-type": "application/json" });
    if (!response.writableEnded) response.end(JSON.stringify({ error: { message: `NAS bridge transport failed: ${error.message}` } }));
  });
  child.on("close", (code) => {
    if (response.writableEnded) return;
    if (!headersSent) {
      response.writeHead(502, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: `NAS gateway transport exited with code ${code}${stderr ? `: ${stderr.trim()}` : ""}` } }));
      return;
    }
    response.end();
  });
}

export function createGatewayBridge(options) {
  const token = options.token;
  if (typeof token !== "string" || token.length < 24) {
    throw new Error("Bridge token must contain at least 24 characters");
  }
  const bodyLimit = options.bodyLimit ?? DEFAULT_BODY_LIMIT;
  const spawnRequest = options.spawnRequest ?? ((route) => spawnNasRequest(route, options));

  return http.createServer(async (request, response) => {
    response.setHeader("x-content-type-options", "nosniff");
    if (!authorized(request.headers.authorization, token)) {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "Unauthorized" } }));
      return;
    }

    const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    if (request.method === "GET" && pathname === "/health") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true }));
      return;
    }
    const route = ALLOWED_ROUTES.get(`${request.method} ${pathname}`);
    if (!route) {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "Route not allowed" } }));
      return;
    }

    try {
      const body = route.method === "POST" ? await readBody(request, bodyLimit) : Buffer.alloc(0);
      if (route.method === "POST") JSON.parse(body.toString("utf8"));
      const child = spawnRequest(route);
      proxyChild(child, response);
      child.stdin.end(body);
      const stopRemote = () => {
        if (!child.killed) child.kill("SIGTERM");
      };
      request.once("aborted", stopRemote);
      response.once("close", () => {
        if (!response.writableEnded) stopRemote();
      });
    } catch (error) {
      if (response.headersSent || response.writableEnded) return;
      response.writeHead(error.statusCode ?? 400, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: error.message } }));
    }
  });
}

async function main() {
  const host = process.env.YEUTECH_AGENT_BRIDGE_HOST ?? "127.0.0.1";
  if (host !== "127.0.0.1" && host !== "::1") throw new Error("Bridge may only bind to loopback");
  const port = Number(process.env.YEUTECH_AGENT_BRIDGE_PORT ?? 18132);
  const server = createGatewayBridge({
    token: process.env.YEUTECH_AGENT_BRIDGE_TOKEN,
    sshTarget: process.env.YEUTECH_NAS_SSH_TARGET ?? "nas-local",
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  process.stdout.write(`YEUTECH NAS bridge listening on http://${host}:${port}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
