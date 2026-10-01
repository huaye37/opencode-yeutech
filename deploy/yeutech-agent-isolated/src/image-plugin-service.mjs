import { createHash, randomUUID } from "node:crypto";
import { createReadStream, readFileSync, realpathSync } from "node:fs";
import { lstat, mkdir, open, readFile, realpath, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { inspectImage } from "./image-generation-plugin.mjs";

const MIME_EXTENSIONS = new Map([["image/png", ".png"], ["image/jpeg", ".jpg"], ["image/webp", ".webp"]]);
const DEFAULT_BUSINESS_REPLAY_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_BUSINESS_REPLAY_MAX_BYTES = 20 * 1024 * 1024;

function safeId(value, label, maximum = 512) {
  const text = String(value || "").trim();
  if (!text || text.length > maximum || !/^[A-Za-z0-9._:-]+$/.test(text)) throw Object.assign(new Error(`${label} is invalid`), { statusCode: 400, code: "IMAGE_INPUT_INVALID" });
  return text;
}

function contained(boundary, candidate) {
  return candidate === boundary || candidate.startsWith(`${boundary}${path.sep}`);
}

function safeSegment(value) {
  const text = String(value || "").normalize("NFC").trim();
  if (!text || text === "." || text === ".." || text.includes("/") || text.includes("\\") || text.includes("\0") || text.startsWith(".")) {
    throw Object.assign(new Error("Image output space is invalid"), { statusCode: 400, code: "IMAGE_OUTPUT_INVALID" });
  }
  return text;
}

async function safeDirectory(root, relative, { create = false } = {}) {
  const rootReal = await realpath(root);
  const segments = String(relative || "").split("/").filter(Boolean).map(safeSegment);
  let current = rootReal;
  for (const segment of segments) {
    current = path.join(current, segment);
    if (create) await mkdir(current, { recursive: false, mode: 0o700 }).catch((error) => { if (error?.code !== "EEXIST") throw error; });
    const info = await lstat(current).catch(() => null);
    if (!info?.isDirectory() || info.isSymbolicLink()) throw Object.assign(new Error("Image output directory is unavailable"), { statusCode: 409, code: "IMAGE_OUTPUT_UNAVAILABLE" });
    const resolved = await realpath(current);
    if (!contained(rootReal, resolved)) throw Object.assign(new Error("Image output escapes the workspace"), { statusCode: 403, code: "IMAGE_OUTPUT_FORBIDDEN" });
    current = resolved;
  }
  return current;
}

function dateFolder(now) {
  const date = new Date(now);
  if (!Number.isFinite(date.valueOf())) throw new Error("Image clock is invalid");
  return date.toISOString().slice(0, 10);
}

export function createImagePluginService({
  databasePath,
  projectsRoot,
  provider,
  now = Date.now,
  businessReplayTtlMs = DEFAULT_BUSINESS_REPLAY_TTL_MS,
  businessReplayMaxBytes = DEFAULT_BUSINESS_REPLAY_MAX_BYTES,
} = {}) {
  if (!path.isAbsolute(databasePath || "")) throw new Error("Image plugin database path must be absolute");
  if (!path.isAbsolute(projectsRoot || "")) throw new Error("Image plugin projects root must be absolute");
  if (!provider || typeof provider.generate !== "function" || typeof provider.listModels !== "function") throw new Error("Image provider is required");
  if (!Number.isSafeInteger(businessReplayTtlMs) || businessReplayTtlMs <= 0) throw new Error("Business replay TTL must be a positive integer");
  if (!Number.isSafeInteger(businessReplayMaxBytes) || businessReplayMaxBytes <= 0) throw new Error("Business replay byte limit must be a positive integer");
  const database = new DatabaseSync(databasePath);
  database.exec(`
    PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS image_session_context (
      portal_user_id INTEGER NOT NULL,
      session_id TEXT NOT NULL,
      space_kind TEXT NOT NULL CHECK(space_kind IN ('project','standalone')),
      space_name TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (portal_user_id, session_id)
    );
    CREATE TABLE IF NOT EXISTS image_artifacts (
      id TEXT PRIMARY KEY,
      portal_user_id INTEGER NOT NULL,
      session_id TEXT NOT NULL,
      space_kind TEXT NOT NULL,
      space_name TEXT NOT NULL,
      relative_path TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      size INTEGER NOT NULL,
      width INTEGER,
      height INTEGER,
      sha256 TEXT NOT NULL,
      model TEXT NOT NULL,
      prompt TEXT NOT NULL,
      revised_prompt TEXT,
      usage_json TEXT,
      idempotency_key TEXT,
      created_at INTEGER NOT NULL,
      UNIQUE (portal_user_id, idempotency_key)
    );
    CREATE TABLE IF NOT EXISTS image_business_runs (
      id TEXT PRIMARY KEY,
      consumer TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      model TEXT NOT NULL,
      prompt TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      size INTEGER NOT NULL,
      width INTEGER,
      height INTEGER,
      sha256 TEXT NOT NULL,
      revised_prompt TEXT,
      usage_json TEXT,
      created_at INTEGER NOT NULL,
      UNIQUE (consumer, idempotency_key)
    );
  `);
  const contextColumns = new Set(database.prepare("PRAGMA table_info(image_session_context)").all().map((column) => column.name));
  if (!contextColumns.has("workspace_root")) database.exec("ALTER TABLE image_session_context ADD COLUMN workspace_root TEXT");
  const artifactColumns = new Set(database.prepare("PRAGMA table_info(image_artifacts)").all().map((column) => column.name));
  if (!artifactColumns.has("width")) database.exec("ALTER TABLE image_artifacts ADD COLUMN width INTEGER");
  if (!artifactColumns.has("height")) database.exec("ALTER TABLE image_artifacts ADD COLUMN height INTEGER");
  const businessColumns = new Set(database.prepare("PRAGMA table_info(image_business_runs)").all().map((column) => column.name));
  if (!businessColumns.has("width")) database.exec("ALTER TABLE image_business_runs ADD COLUMN width INTEGER");
  if (!businessColumns.has("height")) database.exec("ALTER TABLE image_business_runs ADD COLUMN height INTEGER");
  if (!businessColumns.has("response_blob")) database.exec("ALTER TABLE image_business_runs ADD COLUMN response_blob BLOB");
  if (!businessColumns.has("request_fingerprint")) database.exec("ALTER TABLE image_business_runs ADD COLUMN request_fingerprint TEXT");
  if (!businessColumns.has("expires_at")) database.exec("ALTER TABLE image_business_runs ADD COLUMN expires_at INTEGER");
  const saveContext = database.prepare(`INSERT INTO image_session_context
    (portal_user_id, session_id, space_kind, space_name, updated_at, workspace_root) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(portal_user_id, session_id) DO UPDATE SET space_kind=excluded.space_kind, space_name=excluded.space_name, updated_at=excluded.updated_at, workspace_root=excluded.workspace_root`);
  const getContext = database.prepare("SELECT * FROM image_session_context WHERE portal_user_id = ? AND session_id = ?");
  const getByKey = database.prepare("SELECT * FROM image_artifacts WHERE portal_user_id = ? AND idempotency_key = ?");
  const insertArtifact = database.prepare(`INSERT INTO image_artifacts
    (id, portal_user_id, session_id, space_kind, space_name, relative_path, mime_type, size, width, height, sha256, model, prompt, revised_prompt, usage_json, idempotency_key, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const listArtifacts = database.prepare("SELECT * FROM image_artifacts WHERE portal_user_id = ? AND session_id = ? ORDER BY created_at DESC, id DESC LIMIT ?");
  const getBusinessRun = database.prepare("SELECT * FROM image_business_runs WHERE consumer = ? AND idempotency_key = ?");
  const insertBusinessRun = database.prepare(`INSERT INTO image_business_runs
    (id, consumer, idempotency_key, model, prompt, mime_type, size, width, height, sha256, revised_prompt, usage_json, created_at, response_blob, request_fingerprint, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const deleteExpiredBusinessRuns = database.prepare("DELETE FROM image_business_runs WHERE expires_at IS NOT NULL AND expires_at <= ?");
  backfillImageDimensions(database, projectsRoot);
  const agentInFlight = new Map();
  const businessInFlight = new Map();
  deleteExpiredBusinessRuns.run(Number(now()));
  const cleanupTimer = setInterval(() => deleteExpiredBusinessRuns.run(Number(now())), Math.min(businessReplayTtlMs, 60 * 60 * 1_000));
  cleanupTimer.unref();

  const project = (row) => ({
    id: row.id, sessionId: row.session_id, space: row.space_kind === "project" ? { project: row.space_name } : { session: row.session_id },
    name: path.posix.basename(row.relative_path), path: row.relative_path, mimeType: row.mime_type, size: row.size,
    width: row.width ?? null, height: row.height ?? null,
    sha256: row.sha256, model: row.model, prompt: row.prompt, revisedPrompt: row.revised_prompt,
    usage: row.usage_json ? JSON.parse(row.usage_json) : null, createdAt: row.created_at,
  });

  const businessRequestFingerprint = (input) => createHash("sha256").update(JSON.stringify({
    prompt: String(input.prompt ?? "").trim(),
    model: input.model == null ? null : String(input.model),
    size: input.size == null ? "1024x1024" : String(input.size),
    quality: input.quality == null ? "auto" : String(input.quality),
  })).digest("hex");

  const businessResponse = (row) => ({
    id: row.id,
    model: row.model,
    mimeType: row.mime_type,
    size: row.size,
    width: row.width ?? null,
    height: row.height ?? null,
    sha256: row.sha256,
    revisedPrompt: row.revised_prompt,
    usage: row.usage_json ? JSON.parse(row.usage_json) : null,
    b64Json: Buffer.from(row.response_blob).toString("base64"),
  });

  function replayBusinessRun(row, fingerprint) {
    if (row.request_fingerprint && row.request_fingerprint !== fingerprint) {
      throw Object.assign(new Error("Idempotency key was used with a different request"), { statusCode: 409, code: "IMAGE_IDEMPOTENCY_CONFLICT" });
    }
    if (!row.response_blob || !row.request_fingerprint) {
      throw Object.assign(new Error("Legacy image response is unavailable for replay; use a new idempotency key"), { statusCode: 409, code: "IMAGE_IDEMPOTENCY_EXPIRED" });
    }
    return businessResponse(row);
  }

  async function generateAgent(input) {
    const portalUserId = Number(input.portalUserId);
    if (!Number.isSafeInteger(portalUserId) || portalUserId <= 0) throw Object.assign(new Error("Portal user is invalid"), { statusCode: 400, code: "IMAGE_INPUT_INVALID" });
    const sessionId = safeId(input.sessionId, "Session ID");
    const idempotencyKey = safeId(input.idempotencyKey || `${sessionId}:${randomUUID()}`, "Idempotency key");
    const existing = getByKey.get(portalUserId, idempotencyKey);
    if (existing) return project(existing);
    const flightKey = `${portalUserId}:${idempotencyKey}`;
    if (agentInFlight.has(flightKey)) return agentInFlight.get(flightKey);
    const task = (async () => {
      const context = getContext.get(portalUserId, sessionId);
      if (!context) throw Object.assign(new Error("Send a message in this session before generating an image"), { statusCode: 409, code: "IMAGE_SESSION_CONTEXT_MISSING" });
      const [workspace, boundary] = await Promise.all([realpath(String(context.workspace_root || "")), realpath(projectsRoot)]);
      if (!contained(boundary, workspace)) throw Object.assign(new Error("Agent workspace is outside the managed project root"), { statusCode: 403, code: "IMAGE_OUTPUT_FORBIDDEN" });
      const info = await stat(workspace).catch(() => null);
      if (!info?.isDirectory()) throw Object.assign(new Error("Agent workspace is unavailable"), { statusCode: 409, code: "IMAGE_OUTPUT_UNAVAILABLE" });
      // OpenCode scopes project sessions directly to the project directory,
      // while standalone sessions use the user's workspace root. Avoid
      // appending the project name twice when the tool context already points
      // at that project root.
      const base = context.space_kind === "project" && path.basename(workspace) === context.space_name
        ? workspace
        : await safeDirectory(workspace, context.space_kind === "project" ? context.space_name : "");
      const createdAt = Number(now());
      const folder = dateFolder(createdAt);
      const output = await safeDirectory(base, `产出/${folder}`, { create: true });
      const generated = await provider.generate({ prompt: input.prompt, model: input.model, size: input.size, quality: input.quality, idempotencyKey, signal: input.signal, consumer: "creator-api" });
      const extension = MIME_EXTENSIONS.get(generated.mimeType);
      if (!extension) throw Object.assign(new Error("Generated image format is unsupported"), { statusCode: 502, code: "IMAGE_RESPONSE_INVALID" });
      const id = `img_${randomUUID().replaceAll("-", "")}`;
      const filename = `${id}${extension}`;
      const temporary = path.join(output, `.${filename}.writing`);
      const target = path.join(output, filename);
      try {
        await writeFile(temporary, generated.buffer, { flag: "wx", mode: 0o600 });
        await rename(temporary, target);
      } finally {
        await rm(temporary, { force: true }).catch(() => undefined);
      }
      const relativePath = path.posix.join("产出", folder, filename);
      try {
        insertArtifact.run(id, portalUserId, sessionId, context.space_kind, context.space_name, relativePath, generated.mimeType, generated.buffer.length, generated.width, generated.height, generated.sha256, generated.model, String(input.prompt), generated.revisedPrompt ?? null, generated.usage ? JSON.stringify(generated.usage) : null, idempotencyKey, createdAt);
      } catch (error) {
        await unlink(target).catch(() => undefined);
        const duplicate = getByKey.get(portalUserId, idempotencyKey);
        if (duplicate) return project(duplicate);
        throw error;
      }
      return project({ id, portal_user_id: portalUserId, session_id: sessionId, space_kind: context.space_kind, space_name: context.space_name, relative_path: relativePath, mime_type: generated.mimeType, size: generated.buffer.length, width: generated.width, height: generated.height, sha256: generated.sha256, model: generated.model, prompt: String(input.prompt), revised_prompt: generated.revisedPrompt ?? null, usage_json: generated.usage ? JSON.stringify(generated.usage) : null, created_at: createdAt });
    })().finally(() => agentInFlight.delete(flightKey));
    agentInFlight.set(flightKey, task);
    return task;
  }

  async function generateBusiness(input) {
    const consumer = safeId(input.consumer, "Consumer", 120);
    const idempotencyKey = safeId(input.idempotencyKey || randomUUID(), "Idempotency key");
    const requestedAt = Number(now());
    deleteExpiredBusinessRuns.run(requestedAt);
    const fingerprint = businessRequestFingerprint(input);
    const previous = getBusinessRun.get(consumer, idempotencyKey);
    if (previous) return replayBusinessRun(previous, fingerprint);
    const flightKey = `${consumer}:${idempotencyKey}`;
    const pending = businessInFlight.get(flightKey);
    if (pending) {
      if (pending.fingerprint !== fingerprint) throw Object.assign(new Error("Idempotency key is in use by a different request"), { statusCode: 409, code: "IMAGE_IDEMPOTENCY_CONFLICT" });
      return pending.task;
    }
    const task = (async () => {
      const generated = await provider.generate({ prompt: input.prompt, model: input.model, size: input.size, quality: input.quality, idempotencyKey, signal: input.signal, consumer });
      if (!Buffer.isBuffer(generated.buffer) || generated.buffer.length > businessReplayMaxBytes) {
        throw Object.assign(new Error("Generated image exceeds the business replay limit"), { statusCode: 502, code: "IMAGE_RESPONSE_TOO_LARGE" });
      }
      const id = `img_${randomUUID().replaceAll("-", "")}`;
      const createdAt = Number(now());
      const expiresAt = createdAt + businessReplayTtlMs;
      try {
        insertBusinessRun.run(id, consumer, idempotencyKey, generated.model, String(input.prompt), generated.mimeType, generated.buffer.length, generated.width, generated.height, generated.sha256, generated.revisedPrompt ?? null, generated.usage ? JSON.stringify(generated.usage) : null, createdAt, generated.buffer, fingerprint, expiresAt);
      } catch (error) {
        const duplicate = getBusinessRun.get(consumer, idempotencyKey);
        if (duplicate) return replayBusinessRun(duplicate, fingerprint);
        throw error;
      }
      return { id, model: generated.model, mimeType: generated.mimeType, size: generated.buffer.length, width: generated.width, height: generated.height, sha256: generated.sha256, revisedPrompt: generated.revisedPrompt ?? null, usage: generated.usage ?? null, b64Json: generated.buffer.toString("base64") };
    })().finally(() => businessInFlight.delete(flightKey));
    businessInFlight.set(flightKey, { fingerprint, task });
    return task;
  }

  return Object.freeze({
    bindSession(portalUserId, sessionId, space, workspace) {
      const user = Number(portalUserId);
      if (!Number.isSafeInteger(user) || user <= 0) throw new Error("Portal user is invalid");
      const session = safeId(sessionId, "Session ID");
      const kind = space?.project ? "project" : "standalone";
      const name = kind === "project" ? safeSegment(space.project) : "独立会话";
      const root = path.resolve(String(workspace || ""));
      const boundary = path.resolve(projectsRoot);
      if (!path.isAbsolute(String(workspace || "")) || !contained(boundary, root)) throw Object.assign(new Error("Agent workspace is outside the managed project root"), { statusCode: 403, code: "IMAGE_OUTPUT_FORBIDDEN" });
      saveContext.run(user, session, kind, name, Number(now()), root);
      backfillImageDimensions(database, projectsRoot, { portalUserId: user, sessionId: session });
    },
    listModels: (input) => provider.listModels(input),
    generateAgent,
    generateBusiness,
    listAgentArtifacts(portalUserId, sessionId, limit = 20) {
      return listArtifacts.all(Number(portalUserId), safeId(sessionId, "Session ID"), Math.max(1, Math.min(100, Number(limit) || 20))).map(project);
    },
    close() { clearInterval(cleanupTimer); database.close(); },
  });
}

function backfillImageDimensions(database, projectsRoot, scope = null) {
  const updateArtifact = database.prepare("UPDATE image_artifacts SET width = ?, height = ? WHERE id = ? AND (width IS NULL OR height IS NULL)");
  const updateBusiness = database.prepare("UPDATE image_business_runs SET width = ?, height = ? WHERE id = ? AND (width IS NULL OR height IS NULL)");
  const boundary = realpathSync(projectsRoot);
  const scoped = Number.isSafeInteger(scope?.portalUserId) && scope?.sessionId;
  const artifacts = database.prepare(`SELECT a.id, a.relative_path, a.space_kind, a.space_name, a.mime_type, c.workspace_root
    FROM image_artifacts a LEFT JOIN image_session_context c ON c.portal_user_id = a.portal_user_id AND c.session_id = a.session_id
    WHERE (a.width IS NULL OR a.height IS NULL)${scoped ? " AND a.portal_user_id = ? AND a.session_id = ?" : ""} LIMIT 100`)
    .all(...(scoped ? [scope.portalUserId, scope.sessionId] : []));
  for (const row of artifacts) {
    try {
      const workspace = realpathSync(String(row.workspace_root || ""));
      if (!contained(boundary, workspace)) continue;
      const base = row.space_kind === "project" && path.basename(workspace) === row.space_name
        ? workspace
        : realpathSync(path.join(workspace, row.space_kind === "project" ? row.space_name : ""));
      if (!contained(boundary, base)) continue;
      const target = realpathSync(path.join(base, ...String(row.relative_path || "").split("/").filter(Boolean).map(safeSegment)));
      if (!contained(base, target)) continue;
      const metadata = inspectImage(readFileSync(target), row.mime_type);
      updateArtifact.run(metadata.width, metadata.height, row.id);
    } catch { /* Invalid or removed legacy artifacts remain readable without inferred dimensions. */ }
  }
  if (scoped) return;
  const businessRuns = database.prepare("SELECT id, mime_type, response_blob FROM image_business_runs WHERE (width IS NULL OR height IS NULL) AND response_blob IS NOT NULL LIMIT 100").all();
  for (const row of businessRuns) {
    try {
      const metadata = inspectImage(Buffer.from(row.response_blob), row.mime_type);
      updateBusiness.run(metadata.width, metadata.height, row.id);
    } catch { /* Legacy replay remains available even when its old bytes cannot be inspected. */ }
  }
}
