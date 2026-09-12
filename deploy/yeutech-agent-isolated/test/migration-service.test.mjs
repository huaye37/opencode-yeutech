import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createMigrationCatalog, createMigrationService } from "../src/migration-service.mjs";

const ORIGIN = "http://127.0.0.1:18140";
const PASSWORD = "opencode-test-password-0123456789";

async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

async function close(server) {
  await new Promise((resolve) => server.close(resolve));
}

async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "yeutech-migration-test-"));
  const databaseFile = path.join(directory, "codex.sqlite");
  const database = new DatabaseSync(databaseFile);
  database.exec(`
    CREATE TABLE portal_codex_project_snapshots (user_id INTEGER PRIMARY KEY, projects_json TEXT NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE portal_codex_threads (id TEXT PRIMARY KEY, user_id INTEGER, codex_thread_id TEXT NOT NULL, project_id TEXT, title TEXT, updated_at INTEGER, archived_at INTEGER);
    CREATE TABLE portal_codex_messages (id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, sequence INTEGER NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE codex_session_imports (id TEXT PRIMARY KEY, project_name TEXT NOT NULL);
    CREATE TABLE codex_imported_threads (id TEXT PRIMARY KEY, import_id TEXT NOT NULL, user_id INTEGER, project_id TEXT NOT NULL, source_thread_id TEXT NOT NULL, title TEXT NOT NULL, context_markdown TEXT NOT NULL, message_count INTEGER NOT NULL, runtime_portal_thread_id TEXT, updated_at INTEGER NOT NULL, archived_at INTEGER);
    CREATE TABLE codex_imported_messages (id TEXT PRIMARY KEY, imported_thread_id TEXT NOT NULL, role TEXT, event_type TEXT, content_json TEXT NOT NULL, source_created_at TEXT, sequence INTEGER NOT NULL);
  `);
  database.prepare("INSERT INTO portal_codex_project_snapshots VALUES (?, ?, ?)").run(3, JSON.stringify([{ id: "project-one", name: "项目一", storage: "nas" }]), 1);
  database.prepare("INSERT INTO portal_codex_project_snapshots VALUES (?, ?, ?)").run(4, JSON.stringify([{ id: "project-other", name: "其他用户项目", storage: "nas" }]), 1);
  database.prepare("INSERT INTO portal_codex_threads VALUES (?, ?, ?, ?, ?, ?, ?)").run("11111111-1111-1111-1111-111111111111", 3, "legacy-thread", "project-one", "旧会话", 20, null);
  database.prepare("INSERT INTO portal_codex_threads VALUES (?, ?, ?, ?, ?, ?, ?)").run("44444444-4444-4444-4444-444444444444", 4, "other-thread", "project-other", "其他用户会话", 20, null);
  database.prepare("INSERT INTO portal_codex_threads VALUES (?, ?, ?, ?, ?, ?, ?)").run("00000000-0000-0000-0000-000000000000", null, "orphan-thread", null, "无用户会话", 20, null);
  database.prepare("INSERT INTO portal_codex_messages VALUES (?, ?, ?, ?, ?, ?)").run("message-1", "11111111-1111-1111-1111-111111111111", "user", "历史问题", 1, 10);
  database.prepare("INSERT INTO portal_codex_messages VALUES (?, ?, ?, ?, ?, ?)").run("message-2", "11111111-1111-1111-1111-111111111111", "assistant", "历史回答", 2, 20);
  database.close();
  const projectsRoot = path.join(directory, "projects");
  await Promise.all([
    mkdir(path.join(projectsRoot, "ryan", "项目一"), { recursive: true }),
    mkdir(path.join(projectsRoot, "ryan", "@eaDir"), { recursive: true }),
    mkdir(path.join(projectsRoot, "other", "其他目录项目"), { recursive: true }),
    mkdir(path.join(projectsRoot, "orphan", "无用户目录项目"), { recursive: true }),
  ]);
  return { databaseFile, directory, projectsRoot };
}

test("reads projects and paged visible history from the SQLite copy", async () => {
  const item = await fixture();
  const catalog = createMigrationCatalog(item.databaseFile, item.projectsRoot, { userID: 3, ownerDirectory: "ryan" });
  try {
    assert.deepEqual(catalog.listProjects(), [{
      id: "project-one",
      name: "项目一",
      owner: "ryan 目录",
      storage: "NAS 项目本地副本",
      availableLocally: true,
      conversationCount: 1,
    }]);
    const conversation = catalog.listConversations()[0];
    assert.equal(catalog.listConversations().length, 1);
    assert.equal(conversation.id, "portal:11111111-1111-1111-1111-111111111111");
    assert.deepEqual(catalog.page(conversation.id, null, 1), {
      records: [{ id: "portal-message-2", sequence: 2, role: "assistant", text: "历史回答", createdAt: 20, source: "历史工作台" }],
      cursor: "2",
    });
  } finally {
    catalog.close();
    await rm(item.directory, { recursive: true });
  }
});

test("requires an explicit user and owner directory for every migration catalog", async () => {
  const item = await fixture();
  try {
    assert.throws(() => createMigrationCatalog(item.databaseFile, item.projectsRoot), /userID/);
    assert.throws(() => createMigrationCatalog(item.databaseFile, item.projectsRoot, { userID: 3 }), /ownerDirectory/);
  } finally {
    await rm(item.directory, { recursive: true });
  }
});

test("blocks foreign origins and creates a mapped OpenCode continuation without model execution", async () => {
  const item = await fixture();
  const upstreamRequests = [];
  const upstream = http.createServer(async (request, response) => {
    const body = await new Promise((resolve) => {
      const chunks = [];
      request.on("data", (chunk) => chunks.push(chunk));
      request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    });
    upstreamRequests.push({ url: request.url, method: request.method, body: body ? JSON.parse(body) : null });
    if (request.method === "POST" && request.url.startsWith("/session?")) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ id: "ses_new", title: "旧会话" }));
      return;
    }
    response.writeHead(204);
    response.end();
  });
  const upstreamURL = await listen(upstream);
  const migration = createMigrationService({
    databaseFile: item.databaseFile,
    mappingFile: path.join(item.directory, "mappings.json"),
    workspace: "/bounded/project",
    upstreamURL,
    upstreamUsername: "yeutech-agent",
    upstreamPassword: PASSWORD,
    allowedOrigin: ORIGIN,
    userID: 3,
    ownerDirectory: "ryan",
  });
  const baseURL = await listen(migration);
  try {
    assert.equal((await fetch(`${baseURL}/projects`, { headers: { origin: "http://evil.invalid" } })).status, 403);
    const response = await fetch(`${baseURL}/conversations/portal%3A11111111-1111-1111-1111-111111111111/continue`, {
      method: "POST",
      headers: { origin: ORIGIN },
    });
    assert.equal(response.status, 201);
    assert.equal((await response.json()).session.id, "ses_new");
    assert.equal(upstreamRequests.length, 2);
    assert.equal(upstreamRequests[1].body.noReply, true);
    assert.match(upstreamRequests[1].body.parts[0].text, /历史问题/);
    assert.equal(JSON.parse(await readFile(path.join(item.directory, "mappings.json"), "utf8"))["portal:11111111-1111-1111-1111-111111111111"].sessionID, "ses_new");
    const conversations = await fetch(`${baseURL}/conversations`, { headers: { origin: ORIGIN } }).then((value) => value.json());
    assert.equal(conversations[0].runtimeSessionId, "ses_new");
    assert.equal(typeof conversations[0].resumedAt, "number");
  } finally {
    await close(migration);
    await close(upstream);
    await rm(item.directory, { recursive: true });
  }
});
