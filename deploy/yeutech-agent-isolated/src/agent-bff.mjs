#!/usr/bin/env node
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import http from "node:http";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { fetchModelCatalog, selectDefaultModel } from "./model-catalog.mjs";
import { createSystemTaskStore } from "./system-task-store.mjs";
import { extendActivityLease, releaseActivityLease, reserveActivityLease } from "./activity-lease.mjs";
import { buildContextPack, compareReplay, evaluateEvidence, modelEligibility, runtimeBudget, WORKLOAD_PROFILES } from "./control-plane.mjs";
import { createGoalStore } from "./goal-store.mjs";
import { createWorkspaceFiles } from "./workspace-files.mjs";
import { PORTAL_CONTRACT_VERSION, portalError, projectSessionPages, typedError } from "./portal-contract.mjs";
import { createProjectionEventStore } from "./projection-event-store.mjs";
import { createReplayStore } from "./replay-store.mjs";
import { auditReplayTrajectory, buildReplayPrompt } from "./replay-policy.mjs";
import { createProjectPreferenceStore } from "./project-preference-store.mjs";

const DEFAULT_BODY_LIMIT = 4 * 1024 * 1024;
const HOP_BY_HOP_HEADERS = new Set(["connection", "content-length", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade"]);
const STATIC_ROUTES = new Map([
  ["GET /global/health", true], ["GET /event", true], ["GET /session", true], ["POST /session", true],
  ["GET /session/status", true], ["GET /provider", true], ["GET /config/providers", true],
  ["GET /permission", true],
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

function secureEqual(supplied, expected) {
  const suppliedBuffer = Buffer.from(supplied);
  const expectedBuffer = Buffer.from(expected);
  return suppliedBuffer.length === expectedBuffer.length && timingSafeEqual(suppliedBuffer, expectedBuffer);
}

function authenticateIdentity(header, secret, nowSeconds = Math.floor(Date.now() / 1000)) {
  if (typeof header !== "string") return { statusCode: 401, message: "Portal identity is required" };
  const separator = header.lastIndexOf(".");
  if (separator <= 0 || separator === header.length - 1) return { statusCode: 401, message: "Portal identity is invalid" };
  const payloadSegment = header.slice(0, separator);
  const suppliedSignature = header.slice(separator + 1);
  const expectedSignature = createHmac("sha256", secret).update(payloadSegment).digest("base64url");
  if (!secureEqual(suppliedSignature, expectedSignature)) return { statusCode: 401, message: "Portal identity is invalid" };
  let payload;
  try {
    payload = JSON.parse(Buffer.from(payloadSegment, "base64url").toString("utf8"));
  } catch {
    return { statusCode: 401, message: "Portal identity is invalid" };
  }
  const userId = Number(payload?.sub);
  const expiresAt = Number(payload?.exp);
  if (!Number.isSafeInteger(userId) || userId <= 0 || !Number.isSafeInteger(expiresAt)) {
    return { statusCode: 401, message: "Portal identity is invalid" };
  }
  if (expiresAt < nowSeconds) return { statusCode: 401, message: "Portal identity has expired" };
  const username = String(payload?.username || "");
  if (!/^[a-zA-Z0-9._-]{1,80}$/.test(username)) return { statusCode: 401, message: "Portal identity is invalid" };
  return { user: { portalUserId: userId, username }, payload };
}

function allowed(method, pathname) {
  if (STATIC_ROUTES.has(`${method} ${pathname}`)) return true;
  if (method === "POST" && /^\/permission\/per_[A-Za-z0-9]+\/reply$/.test(pathname)) return true;
  return SESSION_ROUTES.some(([pattern, methods]) => pattern.test(pathname) && methods.has(method));
}

async function readBody(request, limit, timeoutMs = 15_000) {
  const declared = Number(request.headers["content-length"] ?? 0);
  if (Number.isFinite(declared) && declared > limit) throw Object.assign(new Error("Request body is too large"), { statusCode: 413 });
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      request.off("data", onData);
      request.off("end", onEnd);
      request.off("aborted", onAborted);
      request.off("error", onError);
    };
    const finish = (error, body) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) {
        request.resume();
        reject(error);
      } else resolve(body);
    };
    const onData = (chunk) => {
      size += chunk.length;
      if (size > limit) finish(Object.assign(new Error("Request body is too large"), { statusCode: 413 }));
      else chunks.push(chunk);
    };
    const onEnd = () => finish(null, Buffer.concat(chunks));
    const onAborted = () => finish(Object.assign(new Error("Request body was interrupted"), { statusCode: 400 }));
    const onError = (error) => finish(error);
    const timer = setTimeout(() => finish(Object.assign(new Error("Request body timed out"), { statusCode: 408 })), timeoutMs);
    timer.unref?.();
    request.on("data", onData);
    request.once("end", onEnd);
    request.once("aborted", onAborted);
    request.once("error", onError);
  });
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

function respondError(response, error, headers = {}) {
  const projected = typedError(error);
  response.writeHead(projected.statusCode, { "content-type": "application/json", ...headers });
  response.end(JSON.stringify(projected.body));
}

async function proxy(request, response, options) {
  const incoming = new URL(request.url ?? "/", "http://127.0.0.1");
  const upstreamPath = (options.upstreamPath ?? incoming.pathname.slice(options.prefix.length)) || "/";
  if (options.allow && !options.allow(request.method ?? "", upstreamPath)) {
    respondError(response, portalError("Route not allowed", { statusCode: 404, code: "route_not_allowed", retryable: false, scope: "route" }));
    return;
  }
  const body = options.body ?? await readBody(request, options.bodyLimit);
  const upstreamURL = new URL(`${upstreamPath}${incoming.search}`, options.upstream);
  if (options.workspace) {
    upstreamURL.searchParams.delete("workspace");
    upstreamURL.searchParams.delete("path");
    upstreamURL.searchParams.delete("roots");
    upstreamURL.searchParams.set("directory", options.workspace);
  }
  const headers = forwardHeaders(request.headers, options.authorization);
  if (body.length > 0) headers["content-length"] = String(body.length);
  return new Promise((resolve) => {
    const upstreamRequest = http.request(upstreamURL, { method: request.method, headers });
    upstreamRequest.on("response", async (upstreamResponse) => {
      const statusCode = upstreamResponse.statusCode ?? 502;
      if (statusCode >= 200 && statusCode < 300) {
        try { await options.onSuccess?.({ statusCode }); }
        catch (error) {
          upstreamResponse.resume();
          respondError(response, portalError(`Post-request activity update failed: ${error.message}`, { statusCode: 503, code: "activity_lease_update_failed", retryable: true, scope: "worker", recoveryAction: "retry", cause: error }));
          resolve({ ok: false, statusCode: 503 });
          return;
        }
        response.writeHead(statusCode, responseHeaders(upstreamResponse.headers));
        upstreamResponse.pipe(response);
        upstreamResponse.once("end", () => resolve({ ok: true, statusCode }));
        upstreamResponse.once("error", () => Promise.resolve(options.onFailure?.({ statusCode })).catch(() => undefined).finally(() => resolve({ ok: false, statusCode })));
        return;
      }
      const chunks = [];
      let size = 0;
      upstreamResponse.on("data", (chunk) => {
        if (size < 64 * 1024) chunks.push(chunk.subarray(0, 64 * 1024 - size));
        size += chunk.length;
      });
      upstreamResponse.once("end", () => {
        const detail = Buffer.concat(chunks).toString("utf8").slice(0, 500);
        const exactSessionRead = request.method === "GET" && /^\/session\/ses_[A-Za-z0-9]+$/.test(upstreamPath);
        const notFound = statusCode === 404;
        Promise.resolve(options.onFailure?.({ statusCode })).catch(() => undefined).finally(() => {
          respondError(response, portalError(`Agent worker request failed (${statusCode}): ${detail}`, {
            statusCode: statusCode >= 500 ? 502 : statusCode,
            code: notFound ? (exactSessionRead ? "session_not_found" : "worker_route_not_found") : "worker_response",
            retryable: statusCode >= 500,
            scope: exactSessionRead ? "session" : "worker",
            recoveryAction: statusCode >= 500 ? "retry" : null,
          }));
          resolve({ ok: false, statusCode });
        });
      });
      upstreamResponse.once("error", (error) => {
        if (!response.headersSent && !response.writableEnded) {
          respondError(response, portalError(`Upstream response failed: ${error.message}`, { statusCode: 502, code: "upstream_transport", retryable: true, scope: "worker", recoveryAction: "retry" }));
        }
        resolve({ ok: false, statusCode });
      });
    });
    upstreamRequest.on("error", (error) => {
      const timedOut = error.code === "ETIMEDOUT";
      Promise.resolve(options.onFailure?.({ statusCode: timedOut ? 504 : 502 })).catch(() => undefined).finally(() => {
        if (!response.headersSent && !response.writableEnded) {
          const projected = typedError(portalError(timedOut ? "Agent worker request timed out" : `Upstream transport failed: ${error.message}`, { statusCode: timedOut ? 504 : 502, code: timedOut ? "worker_timeout" : "upstream_transport", retryable: true, scope: "worker", recoveryAction: "retry" }));
          response.writeHead(projected.statusCode, { "content-type": "application/json" });
          response.end(JSON.stringify(projected.body));
        }
        resolve({ ok: false, statusCode: timedOut ? 504 : 502 });
      });
    });
    if (!(request.method === "GET" && upstreamPath === "/event")) {
      upstreamRequest.setTimeout(options.timeoutMs ?? 15_000, () => upstreamRequest.destroy(Object.assign(new Error("Agent worker request timed out"), { code: "ETIMEDOUT" })));
    }
    response.once("close", () => { if (!response.writableEnded) upstreamRequest.destroy(); resolve({ ok: false, statusCode: 499 }); });
    upstreamRequest.end(body);
  });
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
  if (typeof options.identitySecret !== "string" || options.identitySecret.length < 32) throw new Error("Portal identity secret must contain at least 32 characters");
  const users = new Map((options.users ?? []).map((user) => {
    const portalUserId = Number(user.portalUserId);
    const workspace = String(user.workspace || "");
    if (!Number.isSafeInteger(portalUserId) || portalUserId <= 0) throw new Error("Agent portal user ID is invalid");
    if (!/^[a-zA-Z0-9._-]{1,80}$/.test(String(user.username || ""))) throw new Error("Agent username is invalid");
    if (!path.isAbsolute(workspace)) throw new Error("Agent workspace must be an absolute path");
    return [portalUserId, { ...user, portalUserId, username: String(user.username), workspace, upstream: user.workerURL ? new URL(user.workerURL) : null, modelConfigPath: user.modelConfigPath, modelReloadStatePath: user.modelReloadStatePath }];
  }));
  if (users.size !== (options.users ?? []).length) throw new Error("Agent portal user mappings must be unique");
  if (typeof options.upstreamUsername !== "string" || options.upstreamUsername.length === 0) throw new Error("OpenCode username is required");
  if (typeof options.upstreamPassword !== "string" || options.upstreamPassword.length < 24) throw new Error("OpenCode password must contain at least 24 characters");
  const upstream = new URL(options.upstreamURL ?? "http://127.0.0.1:18130");
  const migration = new URL(options.migrationURL ?? "http://127.0.0.1:18142");
  if (upstream.protocol !== "http:" || upstream.hostname !== "127.0.0.1") throw new Error("BFF upstream must use loopback HTTP");
  if (migration.protocol !== "http:" || migration.hostname !== "127.0.0.1") throw new Error("Migration upstream must use loopback HTTP");
  for (const user of users.values()) if (user.upstream && (user.upstream.protocol !== "http:" || user.upstream.hostname !== "127.0.0.1")) throw new Error("User worker must use loopback HTTP");
  const systemUpstream = options.systemUpstreamURL ? new URL(options.systemUpstreamURL) : upstream;
  if (systemUpstream.protocol !== "http:" || systemUpstream.hostname !== "127.0.0.1") throw new Error("System worker must use loopback HTTP");
  const authorization = `Basic ${Buffer.from(`${options.upstreamUsername}:${options.upstreamPassword}`).toString("base64")}`;
  const bodyLimit = options.bodyLimit ?? DEFAULT_BODY_LIMIT;
  const modelCatalogURL = options.modelCatalogURL ? new URL(options.modelCatalogURL) : null;
  const modelCatalogToken = options.modelCatalogToken;
  const modelCatalogCacheMs = options.modelCatalogCacheMs ?? 5_000;
  const maxConcurrentPerWorker = options.maxConcurrentPerWorker ?? 2;
  let modelCatalogCache = null;
  let modelCatalogExpiresAt = 0;
  let modelCatalogRequest = null;
  const migrationUserId = Number(options.migrationUserId ?? 3);
  let runtimeStateMutation = Promise.resolve();
  const admissions = new Map();

  async function withAdmission(key, operation) {
    const previous = admissions.get(key) ?? Promise.resolve();
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const tail = previous.then(() => gate);
    admissions.set(key, tail);
    await previous;
    try { return await operation(); }
    finally {
      release();
      if (admissions.get(key) === tail) admissions.delete(key);
    }
  }

  async function workerRequest(worker, pathname, { method = "GET", body, directory = worker.workspace, timeoutMs = options.upstreamRequestTimeoutMs ?? 15_000, includeResponse = false } = {}) {
    const target = new URL(pathname, worker.upstream);
    target.searchParams.set("directory", directory);
    const headers = { authorization };
    if (body !== undefined) headers["content-type"] = "application/json";
    const sessionRead = method === "GET" && /^\/session\/ses_[A-Za-z0-9]+$/.test(target.pathname);
    const attempts = sessionRead ? 3 : 1;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      let result;
      try {
        result = await fetch(target, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
      } catch (cause) {
        const timedOut = cause?.name === "TimeoutError" || cause?.name === "AbortError";
        throw portalError(timedOut ? "Agent worker request timed out" : `Agent worker transport failed: ${cause?.message || "unknown error"}`, { statusCode: timedOut ? 504 : 502, code: timedOut ? "worker_timeout" : "worker_transport", retryable: true, scope: "worker", recoveryAction: "retry", cause });
      }
      if (result.ok) {
        let data = null;
        try { data = result.status === 204 ? null : await result.json(); }
        catch (cause) { throw portalError("Agent worker returned invalid JSON", { statusCode: 502, code: "worker_invalid_response", retryable: true, scope: "worker", recoveryAction: "retry", cause }); }
        return includeResponse ? { data, headers: result.headers, statusCode: result.status } : data;
      }
      if (result.status === 404 && attempt < attempts) {
        await new Promise((resolve) => setTimeout(resolve, attempt * 75));
        continue;
      }
      const detail = (await result.text()).slice(0, 500);
      const notFound = result.status === 404;
      throw portalError(`Agent worker request failed (${result.status}): ${detail}`, {
        statusCode: notFound ? 404 : 502,
        code: notFound ? (sessionRead ? "session_not_found" : "worker_route_not_found") : "worker_response",
        retryable: result.status >= 500,
        scope: sessionRead ? "session" : "worker",
        recoveryAction: result.status >= 500 ? "retry" : null,
      });
    }
  }

  async function projectionMessagePages(worker, sessionID, directory = worker.workspace) {
    const pages = [];
    const seenCursors = new Set();
    let before = null;
    for (;;) {
      const query = new URLSearchParams({ limit: String(options.projectionPageSize ?? 200) });
      if (before) query.set("before", before);
      const page = await workerRequest(worker, `/session/${sessionID}/message?${query}`, { includeResponse: true, directory });
      if (!Array.isArray(page.data)) throw portalError("Agent worker returned an invalid message page", { statusCode: 502, code: "worker_invalid_response", retryable: true, scope: "session", recoveryAction: "retry" });
      pages.push(page.data);
      const cursor = page.headers.get("x-next-cursor");
      if (!cursor) return { pages, complete: true, nextCursor: null };
      if (seenCursors.has(cursor)) throw portalError("Agent worker repeated a message cursor", { statusCode: 502, code: "worker_invalid_pagination", retryable: true, scope: "session", recoveryAction: "retry" });
      seenCursors.add(cursor);
      before = cursor;
    }
  }

  async function runtimeStates() {
    if (!options.modelRuntimeStatePath) return {};
    return JSON.parse(await readFile(options.modelRuntimeStatePath, "utf8").catch(() => "{}"));
  }

  async function updateRuntimeState(modelID, value) {
    if (!options.modelRuntimeStatePath) return;
    const operation = runtimeStateMutation.then(async () => {
      const states = await runtimeStates();
      if (value) states[modelID] = value;
      if (!value) delete states[modelID];
      await mkdir(path.dirname(options.modelRuntimeStatePath), { recursive: true });
      const temporary = `${options.modelRuntimeStatePath}.tmp.${process.pid}.${Date.now()}`;
      await writeFile(temporary, `${JSON.stringify(states, null, 2)}\n`, { mode: 0o600 });
      await rename(temporary, options.modelRuntimeStatePath);
    });
    runtimeStateMutation = operation.then(() => undefined, () => undefined);
    await operation;
  }

  function runtimeScope(workload = "general-agent") {
    return [options.modelRouteID ?? "cliproxy", options.credentialGeneration ?? "current", "openai-compatible", workload].join("|");
  }

  const runtimeStateKey = (modelID, workload) => `${runtimeScope(workload)}|${modelID}`;

  async function ensureWorker(identity) {
    if (options.ensureWorker) {
      const worker = await options.ensureWorker(identity);
      return { ...worker, portalUserId: identity.portalUserId };
    }
    const mapped = users.get(identity.portalUserId);
    if (!mapped || mapped.username !== identity.username) throw Object.assign(new Error("This portal user is not enabled for Agent"), { statusCode: 403 });
    return { ...mapped, portalUserId: identity.portalUserId, upstream: mapped.upstream || upstream };
  }

  async function inspectWorker(identity) {
    if (options.inspectWorker) {
      const worker = await options.inspectWorker(identity);
      return worker ? { ...worker, portalUserId: identity.portalUserId } : null;
    }
    const mapped = users.get(identity.portalUserId);
    if (!mapped || mapped.username !== identity.username) return null;
    return { ...mapped, portalUserId: identity.portalUserId, upstream: mapped.upstream || upstream, active: true };
  }

  function passiveSessions(worker) {
    const databasePath = worker?.databasePath || (worker?.root ? path.join(worker.root, "xdg", "data", "opencode", "opencode.db") : "");
    if (!databasePath) return [];
    let database;
    try {
      database = new DatabaseSync(databasePath, { readOnly: true });
      return database.prepare(`SELECT id, directory, title, model, time_created, time_updated
        FROM session WHERE parent_id IS NULL AND time_archived IS NULL ORDER BY time_updated DESC`).all().map((row) => {
        let model = null;
        try { model = row.model ? JSON.parse(row.model) : null; } catch { model = null; }
        return { id: row.id, directory: row.directory, title: row.title, model, time: { created: row.time_created, updated: row.time_updated } };
      });
    } catch { return []; }
    finally { database?.close(); }
  }

  async function models() {
    if (!modelCatalogURL || !modelCatalogToken) throw Object.assign(new Error("Model capability catalog is not configured"), { statusCode: 503 });
    if (modelCatalogCache && Date.now() < modelCatalogExpiresAt) return modelCatalogCache;
    if (!modelCatalogRequest) {
      modelCatalogRequest = fetchModelCatalog({ baseURL: modelCatalogURL, token: modelCatalogToken, timeoutMs: options.modelCatalogTimeoutMs ?? 5_000 })
        .then((catalog) => {
          modelCatalogCache = catalog;
          modelCatalogExpiresAt = Date.now() + modelCatalogCacheMs;
          return catalog;
        })
        .catch((cause) => {
          throw portalError(`Model capability catalog is unavailable: ${cause?.message || "unknown error"}`, { statusCode: 503, code: "model_catalog_unavailable", retryable: true, scope: "model-catalog", recoveryAction: "retry", cause });
        })
        .finally(() => { modelCatalogRequest = null; });
    }
    // Once a validated catalog exists, an expired entry remains safe to serve
    // while one bounded refresh runs in the background. A temporarily stalled
    // catalog must not stall the workbench bootstrap or discard known-safe
    // model bounds.
    if (modelCatalogCache) {
      modelCatalogRequest.catch(() => undefined);
      return modelCatalogCache;
    }
    return modelCatalogRequest;
  }

  async function executableModels(configPath = options.modelConfigPath, workload = "general-agent") {
    const catalog = await models();
    const states = await runtimeStates();
    const runtimeCatalog = catalog.map((model) => {
      const state = states[runtimeStateKey(model.id, workload)];
      if (!state) return { ...model, runtimeCompatibility: { status: "untested" } };
      const retry = Number(state.retryAfter || 0) <= Date.now();
      if (state.status === "quarantined" && !retry) return { ...model, selectable: false, disabledReason: `运行兼容性暂不可用：${state.reason}`, runtimeCompatibility: state };
      return { ...model, runtimeCompatibility: state.status === "quarantined" ? { ...state, status: "reprobe" } : state };
    });
    if (!configPath) return runtimeCatalog;
    const config = JSON.parse(await readFile(configPath, "utf8"));
    const configured = new Set(Object.keys(config?.provider?.yeutech?.models ?? {}));
    return runtimeCatalog.map((model) => model.selectable && !configured.has(model.id)
      ? { ...model, selectable: false, disabledReason: "等待 Agent 安全加载" }
      : model);
  }

  async function recordRuntimeOutcome(snapshot, workload = "general-agent") {
    const modelID = snapshot?.context?.model;
    if (!modelID || !options.modelRuntimeStatePath) return;
    const assistants = (snapshot.messages || []).filter((message) => message.role === "assistant");
    const latest = assistants.at(-1);
    if (!latest?.completedAt) return;
    const hasUsefulResult = Boolean(String(latest.text || "").trim()) || (snapshot.trajectory || []).some((item) => item.type === "tool" && item.status === "completed");
    const key = runtimeStateKey(modelID, workload);
    if (hasUsefulResult && !latest.error) {
      await updateRuntimeState(key, { status: "verified", scope: runtimeScope(workload), failureCount: 0, verifiedAt: new Date().toISOString() });
      return;
    }
    const previous = (await runtimeStates())[key] || {};
    const failureCount = Number(previous.failureCount || 0) + 1;
    const threshold = Number(options.modelQuarantineThreshold ?? 3);
    await updateRuntimeState(key, {
      status: failureCount >= threshold ? "quarantined" : "degraded",
      scope: runtimeScope(workload), failureCount,
      reason: latest.error?.code || "empty_result",
      failedAt: new Date().toISOString(),
      retryAfter: failureCount >= threshold ? Date.now() + (options.modelQuarantineMs ?? 3_600_000) : null,
    });
  }

  function replayMetrics(snapshot) {
    const stats = snapshot?.stats || {};
    const completedTools = (snapshot?.trajectory || []).filter((item) => item.type === "tool" && item.status === "completed").length;
    const metrics = { toolSuccess: completedTools };
    if (Number.isFinite(stats.durationMs)) metrics.durationMs = stats.durationMs;
    if (Number.isFinite(stats.tokens?.input) && Number.isFinite(stats.tokens?.output)) metrics.tokens = stats.tokens.input + stats.tokens.output;
    if (Number.isFinite(stats.cost)) metrics.cost = stats.cost;
    return metrics;
  }

  async function executeReplay(worker, portalUserId, run, prompt) {
    try {
      await mkdir(run.directory, { recursive: true });
      const replaySession = await workerRequest(worker, "/session", { method: "POST", directory: run.directory, body: { title: `安全回放 · ${run.sourceSessionId}` } });
      replayStore.update(run.id, portalUserId, "running", { replaySessionId: replaySession.id });
      const discoveredToolIds = await workerRequest(worker, "/experimental/tool/ids", { directory: run.directory });
      if (!Array.isArray(discoveredToolIds)) throw portalError("Replay tool catalog is unavailable", { statusCode: 502, code: "replay_tool_catalog_invalid", retryable: true, scope: "replay", recoveryAction: "retry" });
      const { body, policy } = buildReplayPrompt({ modelId: run.modelId, prompt, sourceSessionId: run.sourceSessionId, discoveredToolIds });
      await workerRequest(worker, `/session/${replaySession.id}/prompt_async`, {
        method: "POST", directory: run.directory, body,
      });
      const deadline = Date.now() + Number(options.replayTimeoutMs ?? 120_000);
      let snapshot;
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, Number(options.replayPollMs ?? 1_000)));
        snapshot = await sessionProjection(worker, replaySession.id, run.workload, run.directory);
        if (!snapshot.session.status) break;
      }
      if (!snapshot || snapshot.session.status) throw portalError("Replay execution timed out", { statusCode: 504, code: "replay_timeout", retryable: true, scope: "replay", recoveryAction: "retry" });
      const policyAudit = auditReplayTrajectory(snapshot.trajectory);
      if (!policyAudit.compliant) throw portalError("Replay attempted a tool outside the read-only policy", { statusCode: 409, code: "replay_policy_violation", retryable: false, scope: "replay", policyAudit });
      const comparison = compareReplay(run.baseline, { id: replaySession.id, metrics: replayMetrics(snapshot) });
      replayStore.update(run.id, portalUserId, "completed", { replaySessionId: replaySession.id, result: { ...comparison, kind: "isolated-executed-replay", executedReplay: true, persisted: true, policy, policyAudit } });
    } catch (error) {
      replayStore.update(run.id, portalUserId, "failed", { error: typedError(error).body.error });
    } finally {
      if (worker.activityLeaseFile) await releaseActivityLease(worker, { sessionId: run.id, reasons: ["replay-lab"] }).catch(() => undefined);
    }
  }

  const systemEnabled = Boolean(options.systemToken || options.systemWorkspace || options.systemDatabasePath);
  if (systemEnabled && (typeof options.systemToken !== "string" || options.systemToken.length < 32)) throw new Error("System service token must contain at least 32 characters");
  if (systemEnabled && !path.isAbsolute(options.systemWorkspace || "")) throw new Error("System workspace must be an absolute path");
  if (systemEnabled && !path.isAbsolute(options.systemDatabasePath || "")) throw new Error("System task database must be an absolute path");
  const systemStore = systemEnabled ? createSystemTaskStore(options.systemDatabasePath) : null;
  const goalStore = options.controlPlaneDatabasePath ? createGoalStore(options.controlPlaneDatabasePath) : null;
  const projectionStore = (options.projectionDatabasePath || options.controlPlaneDatabasePath)
    ? createProjectionEventStore(options.projectionDatabasePath || options.controlPlaneDatabasePath) : null;
  const replayStore = options.controlPlaneDatabasePath ? createReplayStore(options.controlPlaneDatabasePath) : null;
  const projectPreferenceStore = options.controlPlaneDatabasePath ? createProjectPreferenceStore(options.controlPlaneDatabasePath) : null;
  const workspaceFileStores = new Map();
  const replayTasks = new Set();
  const systemWorkerLease = options.systemActivityLeaseFile ? { id: "system-kaoyan", activityLeaseFile: options.systemActivityLeaseFile } : null;

  async function workspaceFiles(worker) {
    const key = String(worker.workspace);
    if (!workspaceFileStores.has(key)) workspaceFileStores.set(key, createWorkspaceFiles(key, {
      attachmentLimit: options.attachmentLimit,
      fileReadLimit: options.fileReadLimit,
      portalUserId: worker.portalUserId,
    }));
    return workspaceFileStores.get(key);
  }

  async function visibleProjects(worker) {
    const files = await workspaceFiles(worker);
    const preferences = new Map((projectPreferenceStore?.list(worker.portalUserId) || []).map((item) => [item.projectId, item]));
    return (await files.projects()).map((project) => {
      const preference = project.id ? preferences.get(project.id) : null;
      return {
        ...project,
        name: preference?.displayName || project.name,
        registered: Boolean(project.registered && !preference?.hidden),
        removed: Boolean(project.registered && preference?.hidden),
      };
    });
  }

  async function sessionProjection(worker, sessionID, workload = "general-agent", directory = worker.workspace) {
    const [session, messagePages, states, permissions, children, todos] = await Promise.all([
      workerRequest(worker, `/session/${sessionID}`, { directory }), projectionMessagePages(worker, sessionID, directory), workerRequest(worker, "/session/status", { directory }), workerRequest(worker, "/permission", { directory }),
      workerRequest(worker, `/session/${sessionID}/children`, { directory }), workerRequest(worker, `/session/${sessionID}/todo`, { directory }),
    ]);
    const sessionState = states?.[sessionID] || null;
    const projection = projectSessionPages(session, messagePages.pages, {
      pageOrder: "newest-first", complete: messagePages.complete, nextCursor: messagePages.nextCursor,
      sessionState, children: children || [], todos: todos || [], context: { workload },
      inlineToolResultLimit: options.inlineToolResultLimit,
    });
    return {
      contractVersion: PORTAL_CONTRACT_VERSION,
      session: { id: session.id, title: session.title || "新会话", status: sessionState },
      messages: projection.messages, permissions: (permissions || []).filter((item) => item.sessionID === sessionID), children: children || [], childTree: projection.childTree, plan: todos || [],
      outline: projection.outline, activity: projection.activity, trajectory: projection.trajectory, stats: projection.stats, context: projection.context, coverage: projection.coverage,
      graph: projection.graph,
      // A completed assistant message proves only that generation settled. It
      // does not prove that files changed, tests passed, deployment succeeded,
      // or a user accepted the result.
      evidence: evaluateEvidence(workload, projection.messages.some((message) => message.role === "assistant" && message.completedAt && message.text)
        ? [{ type: "generation", status: "passed", reference: `session:${sessionID}` }] : []),
    };
  }

  function recordProjection(portalUserId, sessionID, snapshot) {
    if (!projectionStore) return [];
    const appended = [];
    const add = (key, type, data) => {
      const result = projectionStore.append(portalUserId, sessionID, key, type, data);
      if (result.inserted) appended.push({ cursor: result.cursor, type, data });
    };
    add("session", "session.state", snapshot.session);
    for (const message of snapshot.messages) add(`message:${message.id}`, "message.upsert", message);
    for (const item of snapshot.trajectory) add(`trajectory:${item.id}`, "trajectory.upsert", item);
    const stableContext = { ...snapshot.context };
    delete stableContext.generatedAt;
    add("projection", "projection.meta", {
      permissions: snapshot.permissions, childTree: snapshot.childTree, plan: snapshot.plan, outline: snapshot.outline,
      stats: snapshot.stats, context: stableContext, coverage: snapshot.coverage, graph: snapshot.graph, evidence: snapshot.evidence,
    });
    return appended;
  }

  function writeSse(response, event, payload, id) {
    if (id) response.write(`id: ${id}\n`);
    response.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
  }

  async function streamProjectionEvents(request, response, identity, worker, sessionID, workload) {
    if (!projectionStore) throw portalError("Projection event store is not configured", { statusCode: 503, code: "projection_store_unavailable", retryable: true, scope: "projection" });
    const requestedCursor = Number(request.headers["last-event-id"] || new URL(request.url, "http://127.0.0.1").searchParams.get("cursor") || 0);
    const initial = await sessionProjection(worker, sessionID, workload);
    recordProjection(identity.user.portalUserId, sessionID, initial);
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform", connection: "keep-alive", "x-accel-buffering": "no" });
    // Drain every durable page before announcing the current cursor. A fixed
    // 500-row replay would otherwise strand older reconnecting clients behind
    // a cursor they can never reach.
    for (const event of projectionStore.replayAll(identity.user.portalUserId, sessionID, requestedCursor)) writeSse(response, "durable", event, event.cursor);
    writeSse(response, "ready", { cursor: projectionStore.latestCursor(identity.user.portalUserId, sessionID), contractVersion: PORTAL_CONTRACT_VERSION });

    const upstreamURL = new URL("/event", worker.upstream);
    upstreamURL.searchParams.set("directory", worker.workspace);
    const upstreamRequest = http.request(upstreamURL, { method: "GET", headers: { authorization, accept: "text/event-stream" } });
    let buffer = "";
    let syncing = Promise.resolve();
    const terminal = (payload) => {
      const type = String(payload?.type || "");
      const state = payload?.properties?.status?.type || payload?.properties?.status || payload?.properties?.state?.type;
      return type === "session.idle" || type === "session.completed" || type === "session.error" || (type === "session.status" && new Set(["idle", "completed", "error"]).has(state)) || (type === "message.updated" && payload?.properties?.info?.time?.completed);
    };
    upstreamRequest.on("response", (upstreamResponse) => {
      if ((upstreamResponse.statusCode || 500) >= 300) { writeSse(response, "error", { code: "worker_response", status: upstreamResponse.statusCode }); response.end(); return; }
      upstreamResponse.on("data", (chunk) => {
        buffer += chunk.toString("utf8");
        for (;;) {
          const boundary = buffer.indexOf("\n\n");
          if (boundary < 0) break;
          const block = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
          const data = block.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
          if (!data) continue;
          let payload; try { payload = JSON.parse(data); } catch { payload = { raw: data }; }
          const eventSessionID = payload?.properties?.sessionID || payload?.properties?.part?.sessionID || payload?.properties?.info?.sessionID;
          if (eventSessionID && eventSessionID !== sessionID) continue;
          writeSse(response, "ephemeral", { cursor: projectionStore.latestCursor(identity.user.portalUserId, sessionID), data: payload });
          if (terminal(payload)) syncing = syncing.then(async () => {
            const snapshot = await sessionProjection(worker, sessionID, workload);
            if (worker.activityLeaseFile) {
              if (snapshot.session.status) await extendActivityLease(worker, { sessionId: sessionID, reasons: ["portal-prompt"], durationMs: options.activityLeaseMs });
              else await releaseActivityLease(worker, { sessionId: sessionID, reasons: ["portal-prompt"] });
            }
            await recordRuntimeOutcome(snapshot, workload);
            for (const event of recordProjection(identity.user.portalUserId, sessionID, snapshot)) writeSse(response, "durable", event, event.cursor);
          }).catch((error) => writeSse(response, "projection-error", typedError(error).body));
        }
      });
      upstreamResponse.once("end", () => response.end());
      upstreamResponse.once("error", () => response.end());
    });
    upstreamRequest.once("error", (error) => { writeSse(response, "projection-error", typedError(portalError(error.message, { statusCode: 502, code: "worker_transport", retryable: true })).body); response.end(); });
    request.once("close", () => upstreamRequest.destroy());
    response.once("close", () => upstreamRequest.destroy());
    upstreamRequest.end();
  }

  function systemAuthorized(header) {
    return typeof header === "string" && header.startsWith("Bearer ") && secureEqual(header.slice(7), options.systemToken || "");
  }

  function publicTask(task) {
    return task && {
      id: task.id,
      sessionKey: task.session_key,
      sessionId: task.runtime_session_id,
      kind: task.kind,
      modelId: task.model_id,
      status: task.status,
      error: task.error,
      errorCode: task.error_code || null,
      createdAt: task.created_at,
      updatedAt: task.updated_at,
    };
  }

  async function openCodeRequest(pathname, { method = "GET", body, timeoutMs = options.systemRequestTimeoutMs ?? 15_000 } = {}) {
    const target = new URL(pathname, systemUpstream);
    target.searchParams.set("directory", options.systemWorkspace);
    const headers = { authorization };
    if (body !== undefined) headers["content-type"] = "application/json";
    let result;
    try {
      result = await fetch(target, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
    } catch (cause) {
      const timedOut = cause?.name === "TimeoutError" || cause?.name === "AbortError";
      throw portalError(timedOut ? "OpenCode system request timed out" : `OpenCode system transport failed: ${cause?.message || "unknown error"}`, { statusCode: timedOut ? 504 : 502, code: timedOut ? "system_worker_timeout" : "system_worker_transport", retryable: true, scope: "system-worker", recoveryAction: "retry", cause });
    }
    if (!result.ok) {
      const detail = (await result.text()).slice(0, 500);
      throw portalError(`OpenCode system request failed (${result.status}): ${detail}`, { statusCode: 502, code: "system_worker_response", retryable: true, scope: "system-worker", recoveryAction: "retry" });
    }
    return result.status === 204 ? null : result.json();
  }

  async function requireSystemModel(modelID) {
    const capability = (await executableModels(options.systemModelConfigPath, "kaoyan-system")).find((model) => model.id === modelID);
    if (!capability?.selectable || !capability.limit?.context) {
      throw Object.assign(new Error(capability?.disabledReason || "Requested model is not in the safe capability catalog"), { statusCode: 409 });
    }
  }

  async function requireWorkerCapacity(workerUpstream, workspace) {
    const target = new URL("/session/status", workerUpstream);
    target.searchParams.set("directory", workspace);
    const timeoutMs = options.capacityRequestTimeoutMs ?? options.upstreamRequestTimeoutMs ?? 15_000;
    const deadline = Date.now() + timeoutMs;
    const timeoutError = () => portalError("Worker capacity request timed out", { statusCode: 504, code: "worker_capacity_timeout", retryable: true, scope: "worker-capacity", recoveryAction: "retry" });
    const bounded = async (operation) => {
      const remaining = Math.max(0, deadline - Date.now());
      let timer;
      try {
        return await Promise.race([
          Promise.resolve().then(operation),
          new Promise((_, reject) => { timer = setTimeout(() => reject(timeoutError()), remaining); }),
        ]);
      } finally { clearTimeout(timer); }
    };
    let result;
    try {
      result = await bounded(() => fetch(target, { headers: { authorization }, signal: AbortSignal.timeout(timeoutMs) }));
    } catch (cause) {
      if (cause?.code === "worker_capacity_timeout" || cause?.name === "TimeoutError" || cause?.name === "AbortError") throw timeoutError();
      throw portalError(`Worker capacity transport failed: ${cause?.message || "unknown error"}`, { statusCode: 502, code: "worker_capacity_transport", retryable: true, scope: "worker-capacity", recoveryAction: "retry", cause });
    }
    if (!result?.ok) throw portalError(`Worker capacity response failed (${result?.status || "unknown"})`, { statusCode: 503, code: "worker_capacity_response", retryable: true, scope: "worker-capacity", recoveryAction: "retry" });
    let statuses;
    try { statuses = await bounded(() => result.json()); }
    catch (cause) {
      if (cause?.code === "worker_capacity_timeout" || cause?.name === "TimeoutError" || cause?.name === "AbortError") throw timeoutError();
      throw portalError("Worker capacity response was invalid", { statusCode: 502, code: "worker_capacity_response", retryable: true, scope: "worker-capacity", recoveryAction: "retry", cause });
    }
    if (!statuses || typeof statuses !== "object" || Array.isArray(statuses)) throw portalError("Worker capacity response was invalid", { statusCode: 502, code: "worker_capacity_response", retryable: true, scope: "worker-capacity", recoveryAction: "retry" });
    const active = Object.keys(statuses).length;
    if (active >= maxConcurrentPerWorker) throw Object.assign(new Error(`Worker concurrency limit reached (${maxConcurrentPerWorker})`), { statusCode: 429 });
  }

  async function submitSystemTask(payload) {
    const sessionKey = String(payload?.sessionKey || "");
    const kind = String(payload?.kind || "assistant");
    const modelID = String(payload?.modelId || "");
    const prompt = String(payload?.prompt || "").trim();
    const idempotencyKey = payload?.idempotencyKey ? String(payload.idempotencyKey) : "";
    if (!/^[A-Za-z0-9:._-]{1,120}$/.test(sessionKey)) throw Object.assign(new Error("sessionKey is invalid"), { statusCode: 400 });
    if (!/^(assistant|grading|explanation)$/.test(kind)) throw Object.assign(new Error("kind is invalid"), { statusCode: 400 });
    if (!prompt || prompt.length > 200_000) throw Object.assign(new Error("prompt is required and must be at most 200000 characters"), { statusCode: 400 });
    if (idempotencyKey && !/^[A-Za-z0-9:._-]{1,160}$/.test(idempotencyKey)) throw Object.assign(new Error("idempotencyKey is invalid"), { statusCode: 400 });
    return withAdmission("system-kaoyan", async () => {
      const existing = systemStore.idempotent(idempotencyKey);
      if (existing) return existing;
      await requireSystemModel(modelID);
      await requireWorkerCapacity(systemUpstream, options.systemWorkspace);
      let session = systemStore.session(sessionKey);
      if (!session) {
        const created = await openCodeRequest("/session", { method: "POST", body: { title: `考研系统 · ${sessionKey}` } });
        systemStore.saveSession(sessionKey, created.id);
        session = systemStore.session(sessionKey);
      }
      const reservation = systemStore.reserve({
        id: `task_${randomUUID().replaceAll("-", "")}`,
        idempotencyKey,
        sessionKey,
        runtimeSessionID: session.runtime_session_id,
        kind,
        modelID,
        prompt,
        promptMessageID: `msg_${randomUUID().replaceAll("-", "")}`,
        status: "submitting",
      }, maxConcurrentPerWorker);
      if (reservation.duplicate) return reservation.task;
      if (reservation.capacityReached) throw portalError(`Worker concurrency limit reached (${maxConcurrentPerWorker})`, { statusCode: 429, code: "worker_capacity", retryable: true, scope: "system-worker", recoveryAction: "retry_later" });
      if (reservation.sessionBusy) throw portalError("This system session already has an active task", { statusCode: 409, code: "system_session_busy", retryable: true, scope: "system-task", recoveryAction: "retry_later" });
      const task = reservation.task;
      try {
        if (systemWorkerLease) await extendActivityLease(systemWorkerLease, { sessionId: session.runtime_session_id, reasons: ["system-task"], durationMs: options.activityLeaseMs });
        await openCodeRequest(`/session/${session.runtime_session_id}/prompt_async`, {
          method: "POST",
          body: { messageID: task.prompt_message_id, model: { providerID: "yeutech", modelID }, tools: {}, parts: [{ type: "text", text: prompt }] },
        });
        return systemStore.updateAttemptStatus(task.id, task.prompt_message_id, "running");
      } catch (error) {
        systemStore.updateAttemptStatus(task.id, task.prompt_message_id, "failed", error.message, error.code || "system_task_submission_failed");
        if (systemWorkerLease) await releaseActivityLease(systemWorkerLease, { sessionId: session.runtime_session_id, reasons: ["system-task"] });
        throw error;
      }
    });
  }

  async function systemTaskResult(task) {
    const attempt = systemStore.task(task.id);
    const [records, statuses] = await Promise.all([
      openCodeRequest(`/session/${attempt.runtime_session_id}/message`),
      openCodeRequest("/session/status"),
    ]);
    let current = systemStore.task(task.id);
    if (new Set(["submitting", "running"]).has(attempt.status) && statuses?.[attempt.runtime_session_id]) {
      current = systemStore.updateAttemptStatus(attempt.id, attempt.prompt_message_id, "running");
      if (systemWorkerLease) await extendActivityLease(systemWorkerLease, { sessionId: attempt.runtime_session_id, reasons: ["system-task"], durationMs: options.activityLeaseMs });
    } else if (new Set(["submitting", "running"]).has(attempt.status)) {
      const assistant = records?.findLast?.((record) => record?.info?.role === "assistant" && record.info?.parentID === attempt.prompt_message_id && record.info?.time?.completed);
      const attemptRecorded = records?.some?.((record) => record?.info?.id === attempt.prompt_message_id || record?.info?.parentID === attempt.prompt_message_id);
      const text = assistant?.parts?.filter((part) => part?.type === "text").map((part) => String(part.text || "")).join("").trim();
      const toolResult = assistant?.parts?.some((part) => part?.type === "tool" && part.state?.status === "completed" && part.state?.output !== undefined && part.state?.output !== "");
      if (assistant && (text || toolResult)) current = systemStore.updateAttemptStatus(attempt.id, attempt.prompt_message_id, "completed");
      if (assistant && (text || toolResult) && current.prompt_message_id === attempt.prompt_message_id && current.status === "completed") await updateRuntimeState(runtimeStateKey(attempt.model_id, "kaoyan-system"), { status: "verified", scope: runtimeScope("kaoyan-system"), verifiedAt: new Date().toISOString() });
      if (assistant && !text && !toolResult) {
        const reason = "Model completed without assistant text or a valid tool result";
        current = systemStore.updateAttemptStatus(attempt.id, attempt.prompt_message_id, "failed", reason, "system_task_empty_result");
        if (current.prompt_message_id === attempt.prompt_message_id && current.status === "failed") await updateRuntimeState(runtimeStateKey(attempt.model_id, "kaoyan-system"), { status: "quarantined", scope: runtimeScope("kaoyan-system"), reason, failedAt: new Date().toISOString(), retryAfter: Date.now() + (options.modelQuarantineMs ?? 3_600_000) });
      } else if (!attemptRecorded && Date.now() - Number(attempt.updated_at) >= (options.submissionRecoveryGraceMs ?? 30_000)) {
        const interruptedSubmission = attempt.status === "submitting";
        const reason = interruptedSubmission
          ? "System task submission was interrupted before OpenCode accepted the prompt"
          : "System task runtime state was lost before a result was recorded";
        current = systemStore.updateAttemptStatus(attempt.id, attempt.prompt_message_id, "failed", reason, interruptedSubmission ? "system_task_submission_interrupted" : "system_task_runtime_lost");
      }
    }
    if (!new Set(["submitting", "running"]).has(current.status) && systemWorkerLease) await releaseActivityLease(systemWorkerLease, { sessionId: attempt.runtime_session_id, reasons: ["system-task", "system-task-resume"] });
    return { ...publicTask(current), messages: records || [] };
  }

  const server = http.createServer(async (request, response) => {
    response.setHeader("x-content-type-options", "nosniff");
    const incoming = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method === "GET" && incoming.pathname === "/health") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true, workerMode: options.ensureWorker ? "dynamic" : "static-test" }));
      return;
    }
    try {
      if (incoming.pathname.startsWith("/api/system/")) {
        if (!systemStore) {
          respondError(response, portalError("System tasks are not configured", { statusCode: 404, code: "system_tasks_disabled", retryable: false, scope: "system" }));
          return;
        }
        if (!systemAuthorized(request.headers.authorization)) {
          respondError(response, portalError("System service authorization is required", { statusCode: 401, code: "system_authorization_required", retryable: false, scope: "identity" }));
          return;
        }
        if (request.method === "POST" && incoming.pathname === "/api/system/tasks") {
          const payload = JSON.parse((await readBody(request, bodyLimit)).toString("utf8") || "{}");
          const task = await submitSystemTask(payload);
          response.writeHead(202, { "content-type": "application/json" });
          response.end(JSON.stringify(publicTask(task)));
          return;
        }
        if (request.method === "GET" && incoming.pathname === "/api/system/models") {
          const catalog = await executableModels(options.systemModelConfigPath, "kaoyan-system");
          const reload = options.systemModelReloadStatePath ? JSON.parse(await readFile(options.systemModelReloadStatePath, "utf8").catch(() => "{\"status\":\"unknown\"}")) : { status: "unknown" };
          response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
          response.end(JSON.stringify({ data: catalog, defaultModel: selectDefaultModel(catalog, options.defaultModel), reload, contractVersion: PORTAL_CONTRACT_VERSION }));
          return;
        }
        const clearModel = incoming.pathname.match(/^\/api\/system\/models\/([^/]+)\/clear-quarantine$/);
        if (request.method === "POST" && clearModel) {
          await updateRuntimeState(runtimeStateKey(decodeURIComponent(clearModel[1]), "kaoyan-system"), null);
          response.writeHead(204).end();
          return;
        }
        const match = incoming.pathname.match(/^\/api\/system\/tasks\/(task_[a-f0-9]{32})(?:\/(events|stop|resume))?$/);
        const task = match && systemStore.task(match[1]);
        if (!task) {
          respondError(response, portalError("System task was not found", { statusCode: 404, code: "system_task_not_found", retryable: false, scope: "system-task" }));
          return;
        }
        const action = match[2];
        if (request.method === "GET" && !action) {
          response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
          response.end(JSON.stringify(await systemTaskResult(task)));
          return;
        }
        if (request.method === "GET" && action === "events") {
          response.setHeader("x-yeutech-task-id", task.id);
          response.setHeader("x-yeutech-session-id", task.runtime_session_id);
          await proxy(request, response, { prefix: incoming.pathname, upstreamPath: "/event", upstream: systemUpstream, authorization, workspace: options.systemWorkspace, bodyLimit });
          return;
        }
        if (request.method === "POST" && action === "stop") {
          const stopped = await withAdmission("system-kaoyan", async () => {
            const current = systemStore.task(task.id);
            if (!new Set(["submitting", "running"]).has(current.status)) return current;
            await openCodeRequest(`/session/${current.runtime_session_id}/abort`, { method: "POST" });
            const result = systemStore.update(current.id, "stopped");
            if (systemWorkerLease) await releaseActivityLease(systemWorkerLease, { sessionId: current.runtime_session_id, reasons: ["system-task", "system-task-resume"] });
            return result;
          });
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify(publicTask(stopped)));
          return;
        }
        if (request.method === "POST" && action === "resume") {
          const payload = JSON.parse((await readBody(request, bodyLimit)).toString("utf8") || "{}");
          const modelID = String(payload.modelId || task.model_id);
          const prompt = String(payload.prompt || task.prompt).trim();
          const resumed = await withAdmission("system-kaoyan", async () => {
            await requireSystemModel(modelID);
            await requireWorkerCapacity(systemUpstream, options.systemWorkspace);
            const promptMessageID = `msg_${randomUUID().replaceAll("-", "")}`;
            const reservation = systemStore.reserveResume(task.id, promptMessageID, modelID, prompt, maxConcurrentPerWorker);
            if (reservation.alreadyActive) return reservation.task;
            if (reservation.capacityReached) throw portalError(`Worker concurrency limit reached (${maxConcurrentPerWorker})`, { statusCode: 429, code: "worker_capacity", retryable: true, scope: "system-worker", recoveryAction: "retry_later" });
            if (reservation.sessionBusy) throw portalError("This system session already has an active task", { statusCode: 409, code: "system_session_busy", retryable: true, scope: "system-task", recoveryAction: "retry_later" });
            try {
              if (systemWorkerLease) await extendActivityLease(systemWorkerLease, { sessionId: task.runtime_session_id, reasons: ["system-task-resume"], durationMs: options.activityLeaseMs });
              await openCodeRequest(`/session/${task.runtime_session_id}/prompt_async`, {
                method: "POST",
                body: { messageID: promptMessageID, model: { providerID: "yeutech", modelID }, tools: {}, parts: [{ type: "text", text: prompt }] },
              });
              return systemStore.updateAttemptStatus(task.id, promptMessageID, "running");
            } catch (error) {
              systemStore.updateAttemptStatus(task.id, promptMessageID, "failed", error.message, error.code || "system_task_submission_failed");
              if (systemWorkerLease) await releaseActivityLease(systemWorkerLease, { sessionId: task.runtime_session_id, reasons: ["system-task-resume"] });
              throw error;
            }
          });
          response.writeHead(202, { "content-type": "application/json" });
          response.end(JSON.stringify(publicTask(resumed)));
          return;
        }
        respondError(response, portalError("Method not allowed", { statusCode: 405, code: "method_not_allowed", retryable: false, scope: "route" }));
        return;
      }
      const identity = authenticateIdentity(request.headers["x-yeutech-agent-identity"], options.identitySecret);
      if (!identity.user) {
        respondError(response, portalError(identity.message, { statusCode: identity.statusCode, code: "portal_identity_invalid", retryable: false, scope: "identity", recoveryAction: "sign_in" }));
        return;
      }
      // The authenticated workbench shell and its assets are passive reads.
      // Serve them before worker routing so opening or refreshing the page never
      // starts a user's OpenCode process.
      if (!incoming.pathname.startsWith("/api/") && (request.method === "GET" || request.method === "HEAD") && options.webRoot && await serveStatic(response, options.webRoot, incoming.pathname)) return;
      if (incoming.pathname === "/api/migration" || incoming.pathname.startsWith("/api/migration/")) {
        if (identity.user.portalUserId !== migrationUserId) {
          if (request.method === "GET" && ["/api/migration/projects", "/api/migration/conversations"].includes(incoming.pathname)) {
            response.writeHead(200, { "content-type": "application/json" });
            response.end("[]");
            return;
          }
          respondError(response, portalError("Historical migration data is not enabled for this user", { statusCode: 403, code: "migration_forbidden", retryable: false, scope: "migration" }));
          return;
        }
        await proxy(request, response, { prefix: "/api/migration", upstream: migration, bodyLimit });
        return;
      }
      const passiveMessagesRoute = incoming.pathname.match(/^\/api\/workbench\/sessions\/(ses_[A-Za-z0-9]+)\/messages$/);
      if (request.method === "GET" && passiveMessagesRoute) {
        if (!projectionStore) throw portalError("Projection history is unavailable", { statusCode: 503, code: "projection_store_unavailable", retryable: true, scope: "projection" });
        const page = projectionStore.messages(identity.user.portalUserId, passiveMessagesRoute[1], incoming.searchParams.get("before"), incoming.searchParams.get("limit") || 10);
        response.writeHead(200, { "content-type": "application/json", "cache-control": "private, no-store" });
        response.end(JSON.stringify({ contractVersion: PORTAL_CONTRACT_VERSION, ...page }));
        return;
      }
      if (incoming.pathname === "/api/workbench/bootstrap" && request.method === "GET") {
        const dormantWorker = await inspectWorker(identity.user);
        const catalog = await executableModels(dormantWorker?.modelConfigPath);
        const projects = dormantWorker?.workspace ? await visibleProjects(dormantWorker) : [];
        const sessions = passiveSessions(dormantWorker);
        const projectedSessions = sessions.map((session) => {
          const directory = path.resolve(String(session.directory || dormantWorker.workspace));
          const project = projects.find((item) => path.resolve(dormantWorker.workspace, item.workspaceDirectory) === directory);
          const { directory: _privateDirectory, ...publicSession } = session;
          return { ...publicSession, projectId: project?.id || null, projectDirectory: project?.workspaceDirectory || null };
        });
        const reload = dormantWorker?.modelReloadStatePath
          ? JSON.parse(await readFile(dormantWorker.modelReloadStatePath, "utf8").catch(() => "{\"status\":\"sleeping\"}"))
          : { status: "sleeping" };
        response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
        response.end(JSON.stringify({ contractVersion: PORTAL_CONTRACT_VERSION, sessions: projectedSessions, states: {}, permissions: [], models: catalog, projects, defaultModel: selectDefaultModel(catalog, options.defaultModel), reload, workerActive: Boolean(dormantWorker?.active) }));
        return;
      }
      const workspaceOnlyRequest = incoming.pathname === "/api/models"
        || /^\/api\/workbench\/(?:projects(?:\/register|\/[A-Za-z0-9_-]+)?|files?|attachments)$/.test(incoming.pathname);
      const passiveControlRequest = incoming.pathname === "/api/workbench/profiles"
        || incoming.pathname === "/api/workbench/control"
        || incoming.pathname === "/api/workbench/skills"
        || incoming.pathname === "/api/workbench/context-packs"
        || incoming.pathname === "/api/workbench/replays"
        || /^\/api\/workbench\/replays\/replay_[a-f0-9]{32}$/.test(incoming.pathname)
        || incoming.pathname === "/api/workbench/goals"
        || /^\/api\/workbench\/goals\/goal_[a-f0-9]{32}$/.test(incoming.pathname);
      const worker = workspaceOnlyRequest || passiveControlRequest ? await inspectWorker(identity.user) : await ensureWorker(identity.user);
      if (!worker?.workspace || !worker?.upstream) throw Object.assign(new Error("Agent worker is unavailable"), { statusCode: 503 });
      if (request.method === "GET" && incoming.pathname === "/api/models") {
        const catalog = await executableModels(worker.modelConfigPath);
        const defaultModel = selectDefaultModel(catalog, options.defaultModel);
        const reload = worker.modelReloadStatePath
          ? JSON.parse(await readFile(worker.modelReloadStatePath, "utf8").catch(() => "{\"status\":\"unknown\"}"))
          : { status: "unknown" };
        response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
        response.end(JSON.stringify({ data: catalog, defaultModel, reload, contractVersion: PORTAL_CONTRACT_VERSION }));
        return;
      }
      if (incoming.pathname === "/api/workbench/runtime-bootstrap" && request.method === "GET") {
        const files = await workspaceFiles(worker);
        const [sessions, states, permissions, catalog, projects] = await Promise.all([
          workerRequest(worker, "/session"), workerRequest(worker, "/session/status"), workerRequest(worker, "/permission"), executableModels(worker.modelConfigPath), visibleProjects(worker),
        ]);
        const reload = worker.modelReloadStatePath ? JSON.parse(await readFile(worker.modelReloadStatePath, "utf8").catch(() => "{\"status\":\"unknown\"}")) : { status: "unknown" };
        const projectedSessions = sessions.map((session) => {
          const directory = path.resolve(String(session.directory || worker.workspace));
          const project = projects.find((item) => path.resolve(worker.workspace, item.workspaceDirectory) === directory);
          const { directory: _privateDirectory, ...publicSession } = session;
          return { ...publicSession, projectId: project?.id || null, projectDirectory: project?.workspaceDirectory || null };
        });
        response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
        response.end(JSON.stringify({ contractVersion: PORTAL_CONTRACT_VERSION, sessions: projectedSessions, states, permissions, models: catalog, projects, defaultModel: selectDefaultModel(catalog, options.defaultModel), reload }));
        return;
      }
      if (incoming.pathname === "/api/workbench/projects" && request.method === "GET") {
        const files = await workspaceFiles(worker);
        const projects = await visibleProjects(worker);
        response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
        response.end(JSON.stringify({ contractVersion: PORTAL_CONTRACT_VERSION, data: projects }));
        return;
      }
      if (incoming.pathname === "/api/workbench/projects" && request.method === "POST") {
        const payload = JSON.parse((await readBody(request, bodyLimit)).toString("utf8") || "{}");
        const files = await workspaceFiles(worker);
        const project = await files.createProject(payload.name);
        response.writeHead(201, { "content-type": "application/json", "cache-control": "no-store" });
        response.end(JSON.stringify({ contractVersion: PORTAL_CONTRACT_VERSION, data: project }));
        return;
      }
      if (incoming.pathname === "/api/workbench/projects/register" && request.method === "POST") {
        const payload = JSON.parse((await readBody(request, bodyLimit)).toString("utf8") || "{}");
        const files = await workspaceFiles(worker);
        const project = await files.registerProject(payload.name);
        const preference = projectPreferenceStore?.setHidden(identity.user.portalUserId, project.id, false);
        response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
        response.end(JSON.stringify({ contractVersion: PORTAL_CONTRACT_VERSION, data: { ...project, name: preference?.displayName || project.name } }));
        return;
      }
      const projectMutationRoute = incoming.pathname.match(/^\/api\/workbench\/projects\/([^/]+)$/);
      if (projectMutationRoute && new Set(["PATCH", "DELETE"]).has(request.method)) {
        const projectId = decodeURIComponent(projectMutationRoute[1]);
        const files = await workspaceFiles(worker);
        const project = (await files.projects()).find((item) => item.id === projectId && item.registered);
        if (!project) throw portalError("Registered project was not found", { statusCode: 404, code: "project_not_found", retryable: false, scope: "project" });
        if (!projectPreferenceStore) throw portalError("Project preferences are unavailable", { statusCode: 503, code: "project_preferences_unavailable", retryable: true, scope: "project" });
        const preference = request.method === "PATCH"
          ? projectPreferenceStore.rename(identity.user.portalUserId, projectId, JSON.parse((await readBody(request, bodyLimit)).toString("utf8") || "{}").name)
          : projectPreferenceStore.setHidden(identity.user.portalUserId, projectId, true);
        response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
        response.end(JSON.stringify({ contractVersion: PORTAL_CONTRACT_VERSION, data: { ...project, name: preference.displayName || project.name, registered: !preference.hidden, removed: preference.hidden } }));
        return;
      }
      if (incoming.pathname === "/api/workbench/project-sessions" && request.method === "POST") {
        const payload = JSON.parse((await readBody(request, bodyLimit)).toString("utf8") || "{}");
        const files = await workspaceFiles(worker);
        const projectDirectory = await files.projectRoot(payload.project);
        const title = String(payload.title || "新会话").trim().slice(0, 160) || "新会话";
        const session = await workerRequest(worker, "/session", { method: "POST", body: { title }, directory: projectDirectory });
        response.writeHead(201, { "content-type": "application/json", "cache-control": "no-store" });
        response.end(JSON.stringify({ contractVersion: PORTAL_CONTRACT_VERSION, data: { ...session, project: payload.project } }));
        return;
      }
      const sessionMutationRoute = incoming.pathname.match(/^\/api\/workbench\/sessions\/(ses_[A-Za-z0-9]+)$/);
      if (sessionMutationRoute && request.method === "PATCH") {
        const payload = JSON.parse((await readBody(request, bodyLimit)).toString("utf8") || "{}");
        const title = String(payload.title || "").trim().slice(0, 160);
        if (!title) throw portalError("Session title is required", { statusCode: 400, code: "session_title_required", retryable: false, scope: "session" });
        const session = await workerRequest(worker, `/session/${sessionMutationRoute[1]}`, { method: "PATCH", body: { title } });
        response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
        response.end(JSON.stringify({ contractVersion: PORTAL_CONTRACT_VERSION, data: session }));
        return;
      }
      if (sessionMutationRoute && request.method === "DELETE") {
        await workerRequest(worker, `/session/${sessionMutationRoute[1]}`, { method: "DELETE" });
        response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
        response.end(JSON.stringify({ contractVersion: PORTAL_CONTRACT_VERSION, data: { id: sessionMutationRoute[1], deleted: true } }));
        return;
      }
      const sessionForkRoute = incoming.pathname.match(/^\/api\/workbench\/sessions\/(ses_[A-Za-z0-9]+)\/fork$/);
      if (sessionForkRoute && request.method === "POST") {
        const payload = JSON.parse((await readBody(request, bodyLimit)).toString("utf8") || "{}");
        const body = {};
        const messageID = String(payload.messageId || "").trim();
        if (messageID) {
          if (!/^msg_[A-Za-z0-9]+$/.test(messageID)) throw portalError("Fork message is invalid", { statusCode: 400, code: "fork_message_invalid", retryable: false, scope: "session" });
          body.messageID = messageID;
        }
        const session = await workerRequest(worker, `/session/${sessionForkRoute[1]}/fork`, { method: "POST", body });
        response.writeHead(201, { "content-type": "application/json", "cache-control": "no-store" });
        response.end(JSON.stringify({ contractVersion: PORTAL_CONTRACT_VERSION, data: session }));
        return;
      }
      const sessionDiffRoute = incoming.pathname.match(/^\/api\/workbench\/sessions\/(ses_[A-Za-z0-9]+)\/diff$/);
      if (sessionDiffRoute && request.method === "GET") {
        const messageID = String(incoming.searchParams.get("messageId") || "").trim();
        if (messageID && !/^msg_[A-Za-z0-9]+$/.test(messageID)) throw portalError("Diff message is invalid", { statusCode: 400, code: "diff_message_invalid", retryable: false, scope: "session" });
        const suffix = messageID ? `?messageID=${encodeURIComponent(messageID)}` : "";
        const diff = await workerRequest(worker, `/session/${sessionDiffRoute[1]}/diff${suffix}`);
        response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
        response.end(JSON.stringify({ contractVersion: PORTAL_CONTRACT_VERSION, data: Array.isArray(diff) ? diff : [] }));
        return;
      }
      if (incoming.pathname === "/api/workbench/profiles" && request.method === "GET") {
        response.writeHead(200, { "content-type": "application/json", "cache-control": "private, max-age=60" });
        response.end(JSON.stringify({ contractVersion: PORTAL_CONTRACT_VERSION, data: WORKLOAD_PROFILES }));
        return;
      }
      if (incoming.pathname === "/api/workbench/control" && request.method === "GET") {
        const workload = incoming.searchParams.get("workload") || "general-agent";
        const catalog = await executableModels(worker.modelConfigPath, workload);
        response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
        response.end(JSON.stringify({
          contractVersion: PORTAL_CONTRACT_VERSION,
          workload,
          models: catalog.map((model) => ({ ...model, eligibility: modelEligibility(model, workload) })),
          runtimeBudget: runtimeBudget({
            requestedInteractiveWorkers: Number(options.requestedInteractiveWorkers ?? (worker.active ? 1 : 0)),
            totalMemoryMb: options.totalMemoryMb,
            reservedMemoryMb: options.reservedMemoryMb,
            systemWorkerMb: options.systemWorkerMb,
            interactiveWorkerMb: options.interactiveWorkerMb,
          }),
        }));
        return;
      }
      if (incoming.pathname === "/api/workbench/context-packs" && request.method === "POST") {
        const payload = JSON.parse((await readBody(request, bodyLimit)).toString("utf8") || "{}");
        const files = await workspaceFiles(worker);
        const availableProjects = await files.projects();
        const project = availableProjects.find((item) => item.name === payload.project && item.registered);
        if (!project) throw portalError("Registered project was not found", { statusCode: 404, code: "project_not_found", retryable: false, scope: "project" });
        const sources = await files.sourceReferences(project.name, payload.paths);
        const contextPack = buildContextPack({ projectId: project.id, revision: Date.now(), sources, schema: "verified-files-v1" });
        response.writeHead(201, { "content-type": "application/json", "cache-control": "no-store" });
        response.end(JSON.stringify({ contractVersion: PORTAL_CONTRACT_VERSION, data: contextPack }));
        return;
      }
      if (incoming.pathname === "/api/workbench/replays" && request.method === "POST") {
        const payload = JSON.parse((await readBody(request, bodyLimit)).toString("utf8") || "{}");
        response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
        response.end(JSON.stringify({ contractVersion: PORTAL_CONTRACT_VERSION, data: compareReplay(payload.baseline, payload.candidate) }));
        return;
      }
      if (incoming.pathname === "/api/workbench/replays/execute" && request.method === "POST") {
        if (!replayStore) throw portalError("Replay store is not configured", { statusCode: 503, code: "replay_store_unavailable", retryable: true, scope: "replay" });
        const payload = JSON.parse((await readBody(request, bodyLimit)).toString("utf8") || "{}");
        const sourceSessionId = String(payload.sessionId || "");
        const modelId = String(payload.modelId || "");
        const workload = String(payload.workload || "general-agent");
        if (!/^ses_[A-Za-z0-9]+$/.test(sourceSessionId)) throw portalError("Replay source session is invalid", { statusCode: 400, code: "replay_source_invalid", retryable: false, scope: "replay" });
        const capability = (await executableModels(worker.modelConfigPath, workload)).find((model) => model.id === modelId);
        if (!capability?.selectable) throw portalError(capability?.disabledReason || "Replay model is unavailable", { statusCode: 409, code: "replay_model_unavailable", retryable: false, scope: "replay" });
        const source = await sessionProjection(worker, sourceSessionId, workload);
        const prompt = [...source.messages].reverse().find((message) => message.role === "user")?.text?.trim();
        if (!prompt) throw portalError("Replay source has no user prompt", { statusCode: 409, code: "replay_prompt_missing", retryable: false, scope: "replay" });
        const id = `replay_${randomUUID().replaceAll("-", "")}`;
        const directory = path.join(worker.workspace, ".yeutech-replay-lab", id);
        await requireWorkerCapacity(worker.upstream, worker.workspace);
        if (worker.activityLeaseFile) {
          const reservation = await reserveActivityLease(worker, { sessionId: id, reasons: ["replay-lab"], durationMs: options.replayTimeoutMs ?? 120_000, maxActive: maxConcurrentPerWorker });
          if (!reservation.reserved) throw portalError("Replay capacity is currently unavailable", { statusCode: reservation.sessionBusy ? 409 : 429, code: "replay_capacity", retryable: true, scope: "replay", recoveryAction: "retry_later" });
        }
        const value = { id, portalUserId: identity.user.portalUserId, sourceSessionId, directory, modelId, workload, baseline: { id: sourceSessionId, metrics: replayMetrics(source) } };
        const run = replayStore.create(value);
        const task = executeReplay(worker, identity.user.portalUserId, { ...run, directory }, prompt).finally(() => replayTasks.delete(task));
        replayTasks.add(task);
        response.writeHead(202, { "content-type": "application/json", "cache-control": "no-store" });
        response.end(JSON.stringify({ contractVersion: PORTAL_CONTRACT_VERSION, data: run }));
        return;
      }
      const replayRoute = incoming.pathname.match(/^\/api\/workbench\/replays\/(replay_[a-f0-9]{32})$/);
      if (replayRoute && request.method === "GET") {
        if (!replayStore) throw portalError("Replay store is not configured", { statusCode: 503, code: "replay_store_unavailable", retryable: true, scope: "replay" });
        const run = replayStore.get(replayRoute[1], identity.user.portalUserId);
        if (!run) throw portalError("Replay run was not found", { statusCode: 404, code: "replay_not_found", retryable: false, scope: "replay" });
        response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
        response.end(JSON.stringify({ contractVersion: PORTAL_CONTRACT_VERSION, data: run }));
        return;
      }
      if (incoming.pathname === "/api/workbench/goals" && request.method === "GET") {
        if (!goalStore) throw portalError("Goal store is not configured", { statusCode: 503, code: "goal_store_unavailable", retryable: true, scope: "goal" });
        const scopeKey = incoming.searchParams.get("scope") || "workspace";
        response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
        response.end(JSON.stringify({ contractVersion: PORTAL_CONTRACT_VERSION, data: goalStore.list(identity.user.portalUserId, scopeKey) }));
        return;
      }
      if (incoming.pathname === "/api/workbench/goals" && request.method === "POST") {
        if (!goalStore) throw portalError("Goal store is not configured", { statusCode: 503, code: "goal_store_unavailable", retryable: true, scope: "goal" });
        const payload = JSON.parse((await readBody(request, bodyLimit)).toString("utf8") || "{}");
        const goal = goalStore.create(identity.user.portalUserId, payload);
        response.writeHead(201, { "content-type": "application/json", "cache-control": "no-store" });
        response.end(JSON.stringify({ contractVersion: PORTAL_CONTRACT_VERSION, data: goal }));
        return;
      }
      const goalRoute = incoming.pathname.match(/^\/api\/workbench\/goals\/(goal_[a-f0-9]{32})$/);
      if (goalRoute && request.method === "PATCH") {
        if (!goalStore) throw portalError("Goal store is not configured", { statusCode: 503, code: "goal_store_unavailable", retryable: true, scope: "goal" });
        const payload = JSON.parse((await readBody(request, bodyLimit)).toString("utf8") || "{}");
        const result = goalStore.update(identity.user.portalUserId, goalRoute[1], payload);
        if (result.missing) throw portalError("Goal was not found", { statusCode: 404, code: "goal_not_found", retryable: false, scope: "goal" });
        if (result.conflict) throw portalError("Goal changed since it was read", { statusCode: 409, code: "goal_revision_conflict", retryable: true, scope: "goal", recoveryAction: "refresh" });
        response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
        response.end(JSON.stringify({ contractVersion: PORTAL_CONTRACT_VERSION, data: result.goal }));
        return;
      }
      if (incoming.pathname === "/api/workbench/files" && request.method === "GET") {
        const files = await workspaceFiles(worker);
        const space = incoming.searchParams.has("session") ? { session: incoming.searchParams.get("session") } : { project: incoming.searchParams.get("project") };
        const listing = await files.list(space, incoming.searchParams.get("path") || "", { showHidden: incoming.searchParams.get("showHidden") === "1" });
        response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
        response.end(JSON.stringify({ contractVersion: PORTAL_CONTRACT_VERSION, data: listing }));
        return;
      }
      if (incoming.pathname === "/api/workbench/file" && request.method === "GET") {
        const files = await workspaceFiles(worker);
        const space = incoming.searchParams.has("session") ? { session: incoming.searchParams.get("session") } : { project: incoming.searchParams.get("project") };
        const download = incoming.searchParams.get("download") === "1";
        const file = await files.file(space, incoming.searchParams.get("path"), { download, showHidden: incoming.searchParams.get("showHidden") === "1" });
        response.writeHead(200, {
          "content-type": file.type,
          "content-length": String(file.size),
          "content-disposition": download ? `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}` : file.contentDisposition,
          "x-yeutech-original-content-type": file.originalType,
          "x-yeutech-preview-kind": file.preview.kind,
          "cache-control": "private, no-store",
          "content-security-policy": "sandbox; default-src 'none'",
        });
        file.stream.pipe(response);
        return;
      }
      if (incoming.pathname === "/api/workbench/attachments" && request.method === "POST") {
        const files = await workspaceFiles(worker);
        const space = incoming.searchParams.has("session") ? { session: incoming.searchParams.get("session") } : { project: incoming.searchParams.get("project") };
        let filename;
        try { filename = decodeURIComponent(String(request.headers["x-yeutech-filename"] || "")); } catch { filename = ""; }
        const artifact = await files.upload(space, request, {
          filename,
          type: request.headers["content-type"],
          length: request.headers["content-length"],
          directory: incoming.searchParams.has("directory") ? incoming.searchParams.get("directory") : null,
        });
        response.writeHead(201, { "content-type": "application/json", "cache-control": "no-store" });
        response.end(JSON.stringify({ contractVersion: PORTAL_CONTRACT_VERSION, data: { ...artifact, reference: { type: "file", path: artifact.workspacePath } } }));
        return;
      }
      if (incoming.pathname === "/api/workbench/attachments" && request.method === "DELETE") {
        const files = await workspaceFiles(worker);
        const space = incoming.searchParams.has("session") ? { session: incoming.searchParams.get("session") } : { project: incoming.searchParams.get("project") };
        const result = await files.removeUpload(space, incoming.searchParams.get("path"));
        response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
        response.end(JSON.stringify({ contractVersion: PORTAL_CONTRACT_VERSION, data: result }));
        return;
      }
      if (incoming.pathname === "/api/workbench/skills" && request.method === "GET") {
        let skills = [];
        let reported = false;
        if (worker.active) {
          try {
            skills = await workerRequest(worker, "/skill");
            reported = true;
          } catch (error) {
            if (error.statusCode !== 404) throw error;
          }
        }
        const values = Array.isArray(skills) ? skills : Object.values(skills || {});
        response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
        response.end(JSON.stringify({ contractVersion: PORTAL_CONTRACT_VERSION, reported, workerActive: Boolean(worker.active), data: values.map((skill) => ({ name: String(skill.name || skill.id || "skill"), description: String(skill.description || ""), source: String(skill.location || skill.path || "OpenCode worker"), available: skill.available !== false })) }));
        return;
      }
      const projectionEvents = incoming.pathname.match(/^\/api\/workbench\/sessions\/(ses_[A-Za-z0-9]+)\/events$/);
      if (request.method === "GET" && projectionEvents) {
        await streamProjectionEvents(request, response, identity, worker, projectionEvents[1], incoming.searchParams.get("workload") || "general-agent");
        return;
      }
      const toolResultRoute = incoming.pathname.match(/^\/api\/workbench\/sessions\/(ses_[A-Za-z0-9]+)\/tool-results\/(msg_[A-Za-z0-9]+)\/([^/]+)$/);
      if (request.method === "GET" && toolResultRoute) {
        const [, sessionID, messageID, partID] = toolResultRoute;
        const message = await workerRequest(worker, `/session/${sessionID}/message/${messageID}`);
        const part = (message?.parts || []).find((item, index) => String(item.id || index) === decodeURIComponent(partID));
        if (!part || part.type !== "tool") throw portalError("Tool result was not found", { statusCode: 404, code: "tool_result_not_found", retryable: false, scope: "trajectory" });
        const value = part?.state?.output ?? part?.output ?? part?.result;
        const serialized = typeof value === "string" ? value : JSON.stringify(value ?? null);
        if (Buffer.byteLength(serialized) > (options.toolResultReadLimit ?? 2 * 1024 * 1024)) throw portalError("Tool result exceeds the read limit", { statusCode: 413, code: "tool_result_too_large", retryable: false, scope: "trajectory" });
        response.writeHead(200, { "content-type": "application/json", "cache-control": "private, no-store" });
        response.end(JSON.stringify({ contractVersion: PORTAL_CONTRACT_VERSION, data: { sessionId: sessionID, messageId: messageID, partId: decodeURIComponent(partID), value } }));
        return;
      }
      const projectedSession = incoming.pathname.match(/^\/api\/workbench\/sessions\/(ses_[A-Za-z0-9]+)\/(snapshot|outline|activity|trajectory|children|stats|context|graph)$/);
      if (request.method === "GET" && projectedSession) {
        const [, sessionID, view] = projectedSession;
        const snapshot = await sessionProjection(worker, sessionID, incoming.searchParams.get("workload") || "general-agent");
        const sessionState = snapshot.session.status;
        if (worker.activityLeaseFile) {
          if (sessionState) await extendActivityLease(worker, { sessionId: sessionID, reasons: ["portal-prompt"], durationMs: options.activityLeaseMs });
          else await releaseActivityLease(worker, { sessionId: sessionID, reasons: ["portal-prompt"] });
        }
        recordProjection(identity.user.portalUserId, sessionID, snapshot);
        const body = view === "snapshot" ? snapshot : view === "graph"
          ? { contractVersion: PORTAL_CONTRACT_VERSION, data: snapshot.graph, coverage: snapshot.coverage }
          : { contractVersion: PORTAL_CONTRACT_VERSION, data: view === "children" ? snapshot.childTree : snapshot[view], coverage: snapshot.coverage };
        response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
        response.end(JSON.stringify(body));
        return;
      }
      if (incoming.pathname === "/api/agent" || incoming.pathname.startsWith("/api/agent/")) {
        const isPrompt = request.method === "POST" && /^\/api\/agent\/session\/ses_[A-Za-z0-9]+\/prompt_async$/.test(incoming.pathname);
        const isAbort = request.method === "POST" && /^\/api\/agent\/session\/ses_[A-Za-z0-9]+\/abort$/.test(incoming.pathname);
        const isPermissionReply = request.method === "POST" && /^\/api\/agent\/permission\/per_[A-Za-z0-9]+\/reply$/.test(incoming.pathname);
        let body;
        if (isPrompt) {
          body = await readBody(request, bodyLimit);
          let requestedModel;
          let promptPayload;
          try {
            promptPayload = JSON.parse(body.toString("utf8"));
            requestedModel = promptPayload?.model?.modelID;
          } catch {
            throw Object.assign(new Error("Prompt body must be valid JSON"), { statusCode: 400 });
          }
          const workload = String(promptPayload?.yeutech?.workload || "general-agent");
          const capability = (await executableModels(worker.modelConfigPath, workload)).find((model) => model.id === requestedModel);
          if (!capability?.selectable || !capability.limit?.context) {
            throw Object.assign(new Error(capability?.disabledReason || "Requested model is not in the safe capability catalog"), { statusCode: 409 });
          }
          const projectName = promptPayload?.yeutech?.project;
          const sourcePaths = Array.isArray(promptPayload?.yeutech?.paths) ? promptPayload.yeutech.paths : [];
          delete promptPayload.yeutech;
          if (projectName && sourcePaths.length) {
            const files = await workspaceFiles(worker);
            const projects = await files.projects();
            const project = projects.find((item) => item.name === projectName && item.registered);
            if (!project) throw portalError("Registered project was not found", { statusCode: 404, code: "project_not_found", retryable: false, scope: "project" });
            const sources = await files.sourceReferences(project.name, sourcePaths);
            const receipt = { ...buildContextPack({ projectId: project.id, revision: Date.now(), sources, schema: "verified-files-v1" }), appliedToExecution: true, persisted: Boolean(projectionStore) };
            const references = receipt.sources.map((source) => `${source.path}@${source.version}`).join(",");
            const contextText = `[YEUTECH Context Receipt]\nhash=${receipt.hash}\nproject=${receipt.projectId}\nsources=${references}\n[/YEUTECH Context Receipt]\n\n`;
            const textPart = (promptPayload.parts || []).find((part) => part?.type === "text");
            if (textPart) textPart.text = `${contextText}${String(textPart.text || "")}`;
            if (projectionStore) projectionStore.append(identity.user.portalUserId, incoming.pathname.split("/")[4], `context-receipt:${receipt.hash}`, "context.receipt", receipt);
          }
          body = Buffer.from(JSON.stringify(promptPayload));
        }
        if (isPermissionReply) {
          body = await readBody(request, bodyLimit);
          let reply;
          try { reply = JSON.parse(body.toString("utf8"))?.reply; } catch { throw Object.assign(new Error("Permission response must be valid JSON"), { statusCode: 400 }); }
          if (!new Set(["once", "reject"]).has(reply)) throw Object.assign(new Error("Only allow_once or reject is supported"), { statusCode: 400 });
          body = Buffer.from(JSON.stringify({ reply }));
        }
        if (isPrompt) {
          const sessionID = incoming.pathname.split("/")[4];
          await withAdmission(worker.id || String(identity.user.portalUserId), async () => {
            await requireWorkerCapacity(worker.upstream, worker.workspace);
            if (worker.activityLeaseFile) {
              const reservation = await reserveActivityLease(worker, { sessionId: sessionID, reasons: ["portal-prompt"], durationMs: options.activityLeaseMs, maxActive: maxConcurrentPerWorker });
              if (reservation.sessionBusy) throw portalError("This session already has an active prompt", { statusCode: 409, code: "session_busy", retryable: true, scope: "session", recoveryAction: "retry_later" });
              if (reservation.capacityReached) throw portalError(`Worker concurrency limit reached (${maxConcurrentPerWorker})`, { statusCode: 429, code: "worker_capacity", retryable: true, scope: "worker", recoveryAction: "retry_later" });
            }
            await proxy(request, response, {
              prefix: "/api/agent", upstream: worker.upstream, authorization, workspace: worker.workspace, allow: allowed, bodyLimit, body, timeoutMs: options.upstreamRequestTimeoutMs,
              onFailure: worker.activityLeaseFile ? () => releaseActivityLease(worker, { sessionId: sessionID, reasons: ["portal-prompt"] }) : undefined,
            });
          });
          return;
        }
        await proxy(request, response, {
          prefix: "/api/agent", upstream: worker.upstream, authorization, workspace: worker.workspace, allow: allowed, bodyLimit, body, timeoutMs: options.upstreamRequestTimeoutMs,
          onSuccess: isAbort && worker.activityLeaseFile ? () => releaseActivityLease(worker, { sessionId: incoming.pathname.split("/")[4], reasons: ["portal-prompt"] }) : undefined,
        });
        return;
      }
      respondError(response, portalError("Route not found", { statusCode: 404, code: "route_not_found", retryable: false, scope: "route" }));
    } catch (error) {
      if (response.headersSent || response.writableEnded) return;
      const headers = { "content-type": "application/json" };
      if (Number.isSafeInteger(error.retryAfter) && error.retryAfter > 0) headers["retry-after"] = String(error.retryAfter);
      const projected = typedError(error);
      response.writeHead(projected.statusCode, headers);
      response.end(JSON.stringify(projected.body));
    }
  });
  server.once("close", () => {
    systemStore?.close(); goalStore?.close(); projectionStore?.close(); projectPreferenceStore?.close();
    if (replayTasks.size) void Promise.allSettled([...replayTasks]).then(() => replayStore?.close());
    else replayStore?.close();
  });
  return server;
}

async function main() {
  const server = createAgentBff({
    identitySecret: process.env.YEUTECH_AGENT_IDENTITY_SECRET,
    inspectWorker: async (identity) => {
      const result = await fetch(new URL("/workers/prepare", process.env.YEUTECH_SUPERVISOR_URL ?? "http://127.0.0.1:18141"), {
        method: "POST",
        headers: { authorization: `Bearer ${process.env.YEUTECH_SUPERVISOR_TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify(identity),
        signal: AbortSignal.timeout(2_000),
      }).catch(() => null);
      if (!result?.ok) return null;
      const worker = await result.json();
      return worker ? { id: worker.id, workspace: worker.workspace, root: worker.root, upstream: new URL(worker.url), modelConfigPath: worker.configFile, modelReloadStatePath: worker.stateFile, activityLeaseFile: worker.activityLeaseFile, active: Boolean(worker.active) } : null;
    },
    ensureWorker: async (identity) => {
      const result = await fetch(new URL("/workers/ensure", process.env.YEUTECH_SUPERVISOR_URL ?? "http://127.0.0.1:18141"), {
        method: "POST",
        headers: { authorization: `Bearer ${process.env.YEUTECH_SUPERVISOR_TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify(identity),
        signal: AbortSignal.timeout(Number(process.env.YEUTECH_SUPERVISOR_ENSURE_TIMEOUT_MS ?? 7_000)),
      }).catch((cause) => { throw Object.assign(new Error("Agent worker supervisor timed out"), { statusCode: 503, retryAfter: 2, cause }); });
      if (!result.ok) {
        const retryAfter = Number(result.headers.get("retry-after") ?? 2);
        const payload = await result.json().catch(() => null);
        throw Object.assign(new Error(payload?.error?.message || `Agent worker creation failed (${result.status})`), { statusCode: 503, code: payload?.error?.code || "worker_unavailable", retryAfter: Number.isSafeInteger(retryAfter) && retryAfter > 0 ? retryAfter : 2 });
      }
      const worker = await result.json();
      return { id: worker.id, workspace: worker.workspace, upstream: new URL(worker.url), modelConfigPath: worker.configFile, modelReloadStatePath: worker.stateFile, activityLeaseFile: worker.activityLeaseFile };
    },
    upstreamURL: process.env.YEUTECH_OPENCODE_URL ?? "http://127.0.0.1:18130",
    migrationURL: process.env.YEUTECH_MIGRATION_URL ?? "http://127.0.0.1:18142",
    upstreamUsername: process.env.OPENCODE_SERVER_USERNAME ?? "yeutech-agent",
    upstreamPassword: process.env.OPENCODE_SERVER_PASSWORD,
    modelCatalogURL: process.env.YEUTECH_CLI_PROXY_URL,
    modelCatalogToken: process.env.YEUTECH_CLI_PROXY_KEY,
    defaultModel: process.env.YEUTECH_DEFAULT_MODEL,
    modelRouteID: process.env.YEUTECH_MODEL_ROUTE_ID,
    credentialGeneration: process.env.YEUTECH_CREDENTIAL_GENERATION,
    modelConfigPath: process.env.OPENCODE_CONFIG_OUTPUT,
    modelReloadStatePath: process.env.YEUTECH_MODEL_RELOAD_STATE_FILE,
    systemToken: process.env.YEUTECH_SYSTEM_SERVICE_TOKEN,
    systemWorkspace: process.env.YEUTECH_SYSTEM_WORKSPACE,
    systemDatabasePath: process.env.YEUTECH_SYSTEM_TASK_DATABASE,
    systemUpstreamURL: process.env.YEUTECH_SYSTEM_OPENCODE_URL,
    systemModelConfigPath: process.env.YEUTECH_SYSTEM_MODEL_CONFIG,
    systemModelReloadStatePath: process.env.YEUTECH_SYSTEM_MODEL_RELOAD_STATE,
    systemActivityLeaseFile: process.env.YEUTECH_SYSTEM_ACTIVITY_LEASE_FILE,
    modelRuntimeStatePath: process.env.YEUTECH_MODEL_RUNTIME_STATE ?? "/runtime/system/model-runtime-state.json",
    controlPlaneDatabasePath: process.env.YEUTECH_CONTROL_PLANE_DATABASE ?? "/runtime/control/control-plane.sqlite",
    maxConcurrentPerWorker: Number(process.env.YEUTECH_MAX_CONCURRENT_PER_WORKER ?? 2),
    migrationUserId: Number(process.env.YEUTECH_MIGRATION_USER_ID ?? 3),
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
