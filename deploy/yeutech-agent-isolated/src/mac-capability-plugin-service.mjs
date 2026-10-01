import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, realpath, stat } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const CAPABILITIES = new Set(["document:ocr", "media:inspect"]);
const MAX_INPUT_BYTES = 8 * 1024 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

function failure(message, statusCode, code) { return Object.assign(new Error(message), { statusCode, code }); }
function safeId(value, label) {
  const text = String(value || "").trim();
  if (!text || text.length > 512 || !/^[A-Za-z0-9._:-]+$/.test(text)) throw failure(`${label} is invalid`, 400, "MAC_INPUT_INVALID");
  return text;
}
function contained(root, candidate) { return candidate === root || candidate.startsWith(`${root}${path.sep}`); }

export function createSshMacCapabilityExecutor({ host, identityFile, knownHostsFile, timeoutMs = 30 * 60 * 1000 } = {}) {
  const configured = Boolean(host && identityFile && knownHostsFile);
  return Object.freeze({
    ready: configured,
    async execute({ runId, capability, sourcePath, filename, size, sha256, signal }) {
      if (!configured) throw failure("Mac capability dispatcher is not configured", 503, "MAC_RUNTIME_UNAVAILABLE");
      const child = spawn("ssh", ["-T", "-o", "BatchMode=yes", "-o", "IdentitiesOnly=yes", "-o", `UserKnownHostsFile=${knownHostsFile}`, "-o", "StrictHostKeyChecking=yes", "-i", identityFile, host], { stdio: ["pipe", "pipe", "pipe"] });
      const chunks = []; let outputBytes = 0; let stderr = "";
      const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs); timer.unref?.();
      const abort = () => child.kill("SIGTERM");
      signal?.addEventListener("abort", abort, { once: true });
      child.stdout.on("data", (chunk) => { outputBytes += chunk.length; if (outputBytes > MAX_OUTPUT_BYTES) child.kill("SIGTERM"); else chunks.push(chunk); });
      child.stderr.on("data", (chunk) => { if (stderr.length < 8192) stderr += chunk.toString("utf8").slice(0, 8192 - stderr.length); });
      const completed = new Promise((resolve, reject) => child.once("error", reject).once("close", (code) => code === 0 ? resolve() : reject(failure(signal?.aborted ? "Mac capability run was cancelled" : `Mac capability dispatcher failed (${code}): ${stderr.trim()}`, signal?.aborted ? 499 : 502, signal?.aborted ? "MAC_RUN_CANCELLED" : "MAC_EXECUTOR_FAILED"))));
      child.stdin.write(`${JSON.stringify({ version: 1, runId, capability, filename, size, sha256 })}\n`);
      const source = createReadStream(sourcePath);
      source.on("error", (error) => child.stdin.destroy(error));
      source.pipe(child.stdin);
      try { await completed; } finally { clearTimeout(timer); signal?.removeEventListener("abort", abort); source.destroy(); }
      if (outputBytes > MAX_OUTPUT_BYTES) throw failure("Mac capability output exceeded the limit", 502, "MAC_OUTPUT_TOO_LARGE");
      const raw = Buffer.concat(chunks).toString("utf8").trim();
      try { return JSON.parse(raw); } catch { throw failure("Mac capability returned invalid JSON", 502, "MAC_RESPONSE_INVALID"); }
    },
  });
}

export function createMacCapabilityPluginService({ databasePath, projectsRoot, executor, now = Date.now, maxInputBytes = MAX_INPUT_BYTES } = {}) {
  if (!path.isAbsolute(databasePath || "") || !path.isAbsolute(projectsRoot || "")) throw new Error("Mac capability paths must be absolute");
  if (!executor || typeof executor.execute !== "function") throw new Error("Mac capability executor is required");
  const database = new DatabaseSync(databasePath);
  database.exec(`CREATE TABLE IF NOT EXISTS mac_capability_context (portal_user_id INTEGER NOT NULL, session_id TEXT NOT NULL, workspace_root TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY(portal_user_id,session_id));
    CREATE TABLE IF NOT EXISTS mac_capability_runs (id TEXT PRIMARY KEY, portal_user_id INTEGER NOT NULL, session_id TEXT NOT NULL, message_id TEXT, capability TEXT NOT NULL, relative_path TEXT NOT NULL, idempotency_key TEXT NOT NULL, request_fingerprint TEXT NOT NULL, status TEXT NOT NULL, result_json TEXT, error_json TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE(portal_user_id,idempotency_key));`);
  const saveContext = database.prepare("INSERT INTO mac_capability_context VALUES(?,?,?,?) ON CONFLICT(portal_user_id,session_id) DO UPDATE SET workspace_root=excluded.workspace_root,updated_at=excluded.updated_at");
  const getContext = database.prepare("SELECT workspace_root FROM mac_capability_context WHERE portal_user_id=? AND session_id=?");
  const getKey = database.prepare("SELECT * FROM mac_capability_runs WHERE portal_user_id=? AND idempotency_key=?");
  const insert = database.prepare("INSERT INTO mac_capability_runs VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)");
  const update = database.prepare("UPDATE mac_capability_runs SET status=?,result_json=?,error_json=?,updated_at=? WHERE id=?");
  const inFlight = new Map();
  const present = (row) => ({ id: row.id, sessionId: row.session_id, messageId: row.message_id, capability: row.capability, path: row.relative_path, status: row.status, result: row.result_json ? JSON.parse(row.result_json) : null, error: row.error_json ? JSON.parse(row.error_json) : null, createdAt: row.created_at, updatedAt: row.updated_at });
  async function run(input) {
    const portalUserId = Number(input.portalUserId);
    if (!Number.isSafeInteger(portalUserId) || portalUserId <= 0) throw failure("Portal user is invalid", 400, "MAC_INPUT_INVALID");
    const sessionId = safeId(input.sessionId, "Session ID"); const messageId = input.messageId ? safeId(input.messageId, "Message ID") : null;
    const capability = String(input.capability || ""); if (!CAPABILITIES.has(capability)) throw failure("Mac capability is not allowed", 400, "MAC_CAPABILITY_FORBIDDEN");
    const relativePath = String(input.path || "").normalize("NFC");
    if (!relativePath || path.isAbsolute(relativePath) || relativePath.includes("\0")) throw failure("Workspace path is invalid", 400, "MAC_PATH_INVALID");
    const idempotencyKey = safeId(input.idempotencyKey || `${sessionId}:${randomUUID()}`, "Idempotency key");
    const fingerprint = createHash("sha256").update(JSON.stringify({ sessionId, messageId, capability, relativePath })).digest("hex");
    const previous = getKey.get(portalUserId, idempotencyKey);
    if (previous) { if (previous.request_fingerprint !== fingerprint) throw failure("Idempotency key conflicts with another request", 409, "MAC_IDEMPOTENCY_CONFLICT"); return present(previous); }
    const context = getContext.get(portalUserId, sessionId); if (!context) throw failure("Session workspace context is unavailable", 409, "MAC_SESSION_CONTEXT_MISSING");
    const [boundary, workspace] = await Promise.all([realpath(projectsRoot), realpath(context.workspace_root)]);
    if (!contained(boundary, workspace)) throw failure("Workspace is outside the managed project root", 403, "MAC_PATH_FORBIDDEN");
    const candidate = path.resolve(workspace, relativePath); if (!contained(workspace, candidate)) throw failure("Workspace path escapes its root", 403, "MAC_PATH_FORBIDDEN");
    const [sourcePath, linkInfo] = await Promise.all([realpath(candidate), lstat(candidate)]);
    if (linkInfo.isSymbolicLink() || !contained(workspace, sourcePath)) throw failure("Workspace path is not an allowed regular file", 403, "MAC_PATH_FORBIDDEN");
    const info = await stat(sourcePath); if (!info.isFile() || info.size > maxInputBytes) throw failure("Workspace file is invalid or too large", 413, "MAC_INPUT_TOO_LARGE");
    const sha256 = await new Promise((resolve, reject) => { const hash = createHash("sha256"); createReadStream(sourcePath).on("data", (chunk) => hash.update(chunk)).once("error", reject).once("end", () => resolve(hash.digest("hex"))); });
    const id = `mac_${randomUUID().replaceAll("-", "")}`; const createdAt = Number(now());
    insert.run(id, portalUserId, sessionId, messageId, capability, relativePath, idempotencyKey, fingerprint, "queued", null, null, createdAt, createdAt);
    const task = (async () => { update.run("running", null, null, Number(now()), id); try { const result = await executor.execute({ runId: id, capability, sourcePath, filename: path.basename(sourcePath), size: info.size, sha256, signal: input.signal }); update.run("completed", JSON.stringify(result), null, Number(now()), id); } catch (error) { update.run(input.signal?.aborted ? "cancelled" : "failed", null, JSON.stringify({ code: error.code || "MAC_EXECUTOR_FAILED", message: error.message }), Number(now()), id); } return present(getKey.get(portalUserId, idempotencyKey)); })().finally(() => inFlight.delete(id));
    inFlight.set(id, { task, controller: input.controller }); return task;
  }
  return Object.freeze({ ready: Boolean(executor.ready ?? true), bindSession(portalUserId, sessionId, workspace) { saveContext.run(Number(portalUserId), safeId(sessionId, "Session ID"), path.resolve(workspace), Number(now())); }, run, get(portalUserId, id) { const row = database.prepare("SELECT * FROM mac_capability_runs WHERE portal_user_id=? AND id=?").get(Number(portalUserId), safeId(id, "Run ID")); return row ? present(row) : null; }, cancel(portalUserId, id) { const row = database.prepare("SELECT * FROM mac_capability_runs WHERE portal_user_id=? AND id=?").get(Number(portalUserId), safeId(id, "Run ID")); if (!row) return null; inFlight.get(id)?.controller?.abort(); return present(getKey.get(Number(portalUserId), row.idempotency_key)); }, close() { for (const item of inFlight.values()) item.controller?.abort(); database.close(); } });
}
