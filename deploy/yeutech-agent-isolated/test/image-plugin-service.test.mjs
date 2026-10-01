import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { createImagePluginService } from "../src/image-plugin-service.mjs";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");

test("binds a session to its project and persists an idempotent image artifact", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "image-plugin-service-"));
  const projects = path.join(root, "projects");
  const workspace = path.join(projects, "users", "3");
  await mkdir(path.join(workspace, "小说项目"), { recursive: true });
  let calls = 0;
  const service = createImagePluginService({
    databasePath: path.join(root, "control.sqlite"), projectsRoot: projects, now: () => Date.parse("2026-09-14T12:00:00Z"),
    provider: { listModels: async () => [{ id: "gemini-image" }], generate: async () => { calls += 1; return { buffer: PNG, mimeType: "image/png", width: 1, height: 1, model: "gemini-image", usage: { total_tokens: 1 }, revisedPrompt: null, sha256: createHash("sha256").update(PNG).digest("hex") }; } },
  });
  try {
    service.bindSession(3, "ses_image", { project: "小说项目" }, workspace);
    const first = await service.generateAgent({ portalUserId: 3, sessionId: "ses_image", workspace, prompt: "星空", idempotencyKey: "same-key" });
    const second = await service.generateAgent({ portalUserId: 3, sessionId: "ses_image", workspace, prompt: "星空", idempotencyKey: "same-key" });
    assert.equal(calls, 1);
    assert.equal(first.id, second.id);
    assert.equal(first.path, `产出/2026-09-14/${first.id}.png`);
    assert.deepEqual({ width: first.width, height: first.height }, { width: 1, height: 1 });
    assert.deepEqual(await readFile(path.join(workspace, "小说项目", first.path)), PNG);
    assert.equal(service.listAgentArtifacts(3, "ses_image")[0].sha256, createHash("sha256").update(PNG).digest("hex"));
  } finally { service.close(); await rm(root, { recursive: true }); }
});

test("writes project-session images when OpenCode already scopes the tool to the project directory", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "image-plugin-project-scope-"));
  const projects = path.join(root, "projects");
  const project = path.join(projects, "users", "3", "小说项目");
  await mkdir(project, { recursive: true });
  const service = createImagePluginService({
    databasePath: path.join(root, "control.sqlite"), projectsRoot: projects, now: () => Date.parse("2026-09-14T12:00:00Z"),
    provider: { listModels: async () => [{ id: "gemini-image" }], generate: async () => ({ buffer: PNG, mimeType: "image/png", width: 1, height: 1, model: "gemini-image", revisedPrompt: null, usage: null, sha256: createHash("sha256").update(PNG).digest("hex") }) },
  });
  try {
    service.bindSession(3, "ses_project_scope", { project: "小说项目" }, project);
    const artifact = await service.generateAgent({ portalUserId: 3, sessionId: "ses_project_scope", workspace: project, prompt: "星空", idempotencyKey: "project-scope" });
    assert.deepEqual(await readFile(path.join(project, artifact.path)), PNG);
  } finally { service.close(); await rm(root, { recursive: true }); }
});

test("rejects an output workspace outside the managed project root", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "image-plugin-boundary-"));
  const projects = path.join(root, "projects");
  await mkdir(projects);
  const service = createImagePluginService({ databasePath: path.join(root, "control.sqlite"), projectsRoot: projects, provider: { listModels: async () => [], generate: async () => assert.fail("provider must not run") } });
  try {
    assert.throws(() => service.bindSession(3, "ses_escape", { session: "ses_escape" }, root), (error) => error.code === "IMAGE_OUTPUT_FORBIDDEN");
  } finally { service.close(); await rm(root, { recursive: true }); }
});

test("persists and replays a business response for the same request without regenerating", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "image-plugin-business-replay-"));
  const projects = path.join(root, "projects");
  await mkdir(projects);
  let calls = 0;
  const options = {
    databasePath: path.join(root, "control.sqlite"), projectsRoot: projects,
    provider: { listModels: async () => [], generate: async () => { calls += 1; return { buffer: PNG, mimeType: "image/png", width: 1, height: 1, model: "gemini-image", usage: { total_tokens: 2 }, revisedPrompt: "night sky", sha256: createHash("sha256").update(PNG).digest("hex") }; } },
  };
  let service = createImagePluginService(options);
  try {
    const input = { consumer: "portal", prompt: "starry sky", model: "gemini-image", size: "1024x1024", quality: "auto", idempotencyKey: "business-key" };
    const first = await service.generateBusiness(input);
    service.close();
    service = createImagePluginService(options);
    const replayed = await service.generateBusiness({ ...input, prompt: "  starry sky  ", quality: undefined });
    assert.equal(calls, 1);
    assert.deepEqual(replayed, first);
    assert.deepEqual({ width: replayed.width, height: replayed.height }, { width: 1, height: 1 });
    assert.deepEqual(Buffer.from(replayed.b64Json, "base64"), PNG);
  } finally { service.close(); await rm(root, { recursive: true }); }
});

test("coalesces concurrent business retries and rejects key reuse with different input", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "image-plugin-business-flight-"));
  const projects = path.join(root, "projects");
  await mkdir(projects);
  let calls = 0;
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  const service = createImagePluginService({
    databasePath: path.join(root, "control.sqlite"), projectsRoot: projects,
    provider: { listModels: async () => [], generate: async () => { calls += 1; await blocked; return { buffer: PNG, mimeType: "image/png", width: 1, height: 1, model: "gemini-image", sha256: createHash("sha256").update(PNG).digest("hex") }; } },
  });
  try {
    const input = { consumer: "portal", prompt: "same", idempotencyKey: "shared-key" };
    const first = service.generateBusiness(input);
    const second = service.generateBusiness(input);
    await assert.rejects(service.generateBusiness({ ...input, prompt: "different" }), (error) => error.code === "IMAGE_IDEMPOTENCY_CONFLICT" && error.statusCode === 409);
    release();
    const [a, b] = await Promise.all([first, second]);
    assert.equal(calls, 1);
    assert.deepEqual(a, b);
    await assert.rejects(service.generateBusiness({ ...input, quality: "high" }), (error) => error.code === "IMAGE_IDEMPOTENCY_CONFLICT");
  } finally { release(); service.close(); await rm(root, { recursive: true }); }
});

test("bounds persisted business responses and expires replay records", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "image-plugin-business-limits-"));
  const projects = path.join(root, "projects");
  await mkdir(projects);
  let clock = 1000;
  let calls = 0;
  let oversized = false;
  const service = createImagePluginService({
    databasePath: path.join(root, "control.sqlite"), projectsRoot: projects, now: () => clock,
    businessReplayTtlMs: 100, businessReplayMaxBytes: PNG.length,
    provider: { listModels: async () => [], generate: async () => { calls += 1; const buffer = oversized ? Buffer.concat([PNG, Buffer.from([0])]) : PNG; return { buffer, mimeType: "image/png", width: 1, height: 1, model: "gemini-image", sha256: createHash("sha256").update(buffer).digest("hex") }; } },
  });
  try {
    const input = { consumer: "portal", prompt: "same", idempotencyKey: "expiring-key" };
    const first = await service.generateBusiness(input);
    clock = 1099;
    assert.equal((await service.generateBusiness(input)).id, first.id);
    clock = 1100;
    assert.notEqual((await service.generateBusiness(input)).id, first.id);
    assert.equal(calls, 2);
    oversized = true;
    await assert.rejects(service.generateBusiness({ consumer: "portal", prompt: "large", idempotencyKey: "large-key" }), (error) => error.code === "IMAGE_RESPONSE_TOO_LARGE");
    oversized = false;
    await service.generateBusiness({ consumer: "portal", prompt: "large", idempotencyKey: "large-key" });
    assert.equal(calls, 4);
  } finally { service.close(); await rm(root, { recursive: true }); }
});

test("migrates deployed image tables and persists actual dimensions", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "image-plugin-dimension-migration-"));
  const projects = path.join(root, "projects");
  const workspace = path.join(projects, "users", "9", "测试项目");
  const databasePath = path.join(root, "control.sqlite");
  await mkdir(workspace, { recursive: true });
  const legacy = new DatabaseSync(databasePath);
  legacy.exec(`
    CREATE TABLE image_session_context (portal_user_id INTEGER NOT NULL, session_id TEXT NOT NULL, space_kind TEXT NOT NULL, space_name TEXT NOT NULL, updated_at INTEGER NOT NULL, workspace_root TEXT, PRIMARY KEY (portal_user_id, session_id));
    CREATE TABLE image_artifacts (id TEXT PRIMARY KEY, portal_user_id INTEGER NOT NULL, session_id TEXT NOT NULL, space_kind TEXT NOT NULL, space_name TEXT NOT NULL, relative_path TEXT NOT NULL, mime_type TEXT NOT NULL, size INTEGER NOT NULL, sha256 TEXT NOT NULL, model TEXT NOT NULL, prompt TEXT NOT NULL, revised_prompt TEXT, usage_json TEXT, idempotency_key TEXT, created_at INTEGER NOT NULL, UNIQUE (portal_user_id, idempotency_key));
    CREATE TABLE image_business_runs (id TEXT PRIMARY KEY, consumer TEXT NOT NULL, idempotency_key TEXT NOT NULL, model TEXT NOT NULL, prompt TEXT NOT NULL, mime_type TEXT NOT NULL, size INTEGER NOT NULL, sha256 TEXT NOT NULL, revised_prompt TEXT, usage_json TEXT, created_at INTEGER NOT NULL, response_blob BLOB, request_fingerprint TEXT, expires_at INTEGER, UNIQUE (consumer, idempotency_key));
  `);
  await mkdir(path.join(workspace, "产出", "2026-09-14"), { recursive: true });
  await writeFile(path.join(workspace, "产出", "2026-09-14", "legacy.png"), PNG);
  legacy.prepare("INSERT INTO image_session_context VALUES (?, ?, ?, ?, ?, ?)").run(9, "ses_legacy", "project", "测试项目", 1, workspace);
  legacy.prepare("INSERT INTO image_artifacts VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run("img_legacy", 9, "ses_legacy", "project", "测试项目", "产出/2026-09-14/legacy.png", "image/png", PNG.length, createHash("sha256").update(PNG).digest("hex"), "gemini-image", "旧图", null, null, "legacy-key", 1);
  legacy.close();
  const generated = { buffer: PNG, mimeType: "image/png", width: 1, height: 1, model: "gemini-image", sha256: createHash("sha256").update(PNG).digest("hex") };
  let service = createImagePluginService({ databasePath, projectsRoot: projects, provider: { listModels: async () => [], generate: async () => generated } });
  try {
    assert.deepEqual({ width: service.listAgentArtifacts(9, "ses_legacy")[0].width, height: service.listAgentArtifacts(9, "ses_legacy")[0].height }, { width: 1, height: 1 });
    service.bindSession(9, "ses_migration", { project: "测试项目" }, workspace);
    const artifact = await service.generateAgent({ portalUserId: 9, sessionId: "ses_migration", prompt: "迁移", idempotencyKey: "agent-migration" });
    const business = await service.generateBusiness({ consumer: "migration-test", prompt: "迁移", idempotencyKey: "business-migration" });
    assert.deepEqual({ width: artifact.width, height: artifact.height }, { width: 1, height: 1 });
    assert.deepEqual({ width: business.width, height: business.height }, { width: 1, height: 1 });
    service.close();
    service = createImagePluginService({ databasePath, projectsRoot: projects, provider: { listModels: async () => [], generate: async () => assert.fail("replay must not regenerate") } });
    assert.deepEqual({ width: service.listAgentArtifacts(9, "ses_migration")[0].width, height: service.listAgentArtifacts(9, "ses_migration")[0].height }, { width: 1, height: 1 });
    const replayed = await service.generateBusiness({ consumer: "migration-test", prompt: "迁移", idempotencyKey: "business-migration" });
    assert.deepEqual({ width: replayed.width, height: replayed.height }, { width: 1, height: 1 });
  } finally { service.close(); await rm(root, { recursive: true }); }
});
