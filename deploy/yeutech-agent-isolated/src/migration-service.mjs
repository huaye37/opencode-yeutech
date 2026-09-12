#!/usr/bin/env node
import { DatabaseSync } from "node:sqlite";
import { readdirSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_LIMIT = 200;
const MAX_CONTEXT_CHARS = 24_000;

function json(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function textContent(value) {
  return (Array.isArray(value) ? value : [value])
    .map((item) => {
      if (typeof item === "string") return item;
      if (typeof item?.text === "string") return item.text;
      if (typeof item?.name === "string") return `文件：${item.name}`;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function historicalText(type, content) {
  const labels = {
    tool_summary: "[历史工具摘要·不会重新执行]",
    artifact: "[历史产物]",
    notice: "[迁移说明]",
  };
  return [labels[type], textContent(content) || "该历史事件没有可显示文本。"].filter(Boolean).join("\n");
}

function boundedLimit(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(200, Math.max(1, Math.floor(parsed))) : DEFAULT_LIMIT;
}

function migrationID(kind, id) {
  return `${kind}:${id}`;
}

function splitMigrationID(value) {
  const match = String(value).match(/^(portal|imported):([0-9a-f-]{36})$/i);
  return match ? { kind: match[1], id: match[2] } : null;
}

function publicProject(project, conversationCount) {
  return {
    id: project.id,
    name: project.name,
    owner: project.owner ?? `本地账号 ${project.userID}`,
    storage: project.storage ?? "历史快照",
    availableLocally: project.availableLocally !== false,
    conversationCount,
  };
}

export function createMigrationCatalog(databaseFile, projectsRoot) {
  if (!path.isAbsolute(databaseFile)) throw new Error("Migration database must be an absolute path");
  const database = new DatabaseSync(databaseFile, { readOnly: true });
  const linkedRuntimeIDs = new Set(database.prepare(`
    SELECT runtime_portal_thread_id AS id FROM codex_imported_threads
    WHERE runtime_portal_thread_id IS NOT NULL
  `).all().map((row) => String(row.id)));
  const projectRows = database.prepare("SELECT user_id, projects_json FROM portal_codex_project_snapshots").all();
  const fileProjects = projectsRoot && path.isAbsolute(projectsRoot) ? readdirSync(projectsRoot, { withFileTypes: true })
    .filter((owner) => owner.isDirectory() && owner.name !== "#recycle")
    .flatMap((owner) => readdirSync(path.join(projectsRoot, owner.name), { withFileTypes: true })
      .filter((project) => project.isDirectory() && project.name !== ".独立会话附件")
      .map((project) => ({ name: project.name, owner: owner.name }))) : [];
  const projects = projectRows.flatMap((row) => json(row.projects_json, []).map((project) => {
    const local = fileProjects.find((item) => item.name === String(project.name));
    return {
    id: String(project.id),
    name: String(project.name || "未命名项目"),
    userID: Number(row.user_id),
    storage: project.storage === "nas" ? "NAS 项目本地副本" : "历史快照",
    availableLocally: Boolean(local),
    ...(local ? { owner: `${local.owner} 目录` } : {}),
  };
  }));

  function listConversations() {
    const native = database.prepare(`
      SELECT thread.*, COUNT(message.id) AS message_count
      FROM portal_codex_threads thread
      LEFT JOIN portal_codex_messages message ON message.thread_id = thread.id
      GROUP BY thread.id ORDER BY thread.updated_at DESC
    `).all().filter((row) => !linkedRuntimeIDs.has(String(row.id))).map((row) => ({
      id: migrationID("portal", row.id),
      sourceThreadId: String(row.codex_thread_id),
      projectId: row.project_id ? String(row.project_id) : `standalone:${row.user_id}`,
      owner: `本地账号 ${row.user_id}`,
      title: String(row.title || "新会话"),
      messageCount: Number(row.message_count),
      updatedAt: Number(row.updated_at),
      archived: row.archived_at != null,
      canContinue: true,
      kind: "portal",
    }));
    const imported = database.prepare(`
      SELECT thread.*, job.project_name
      FROM codex_imported_threads thread
      JOIN codex_session_imports job ON job.id = thread.import_id
      ORDER BY thread.updated_at DESC
    `).all().map((row) => ({
      id: migrationID("imported", row.id),
      sourceThreadId: String(row.source_thread_id),
      projectId: String(row.project_id),
      owner: `本地账号 ${row.user_id}`,
      title: String(row.title || "新会话"),
      messageCount: Number(row.message_count) + runtimeMessageCount(row.runtime_portal_thread_id),
      updatedAt: Number(row.updated_at),
      archived: row.archived_at != null,
      canContinue: Boolean(String(row.context_markdown || "").trim()),
      kind: "imported",
    }));
    return [...native, ...imported].sort((left, right) => right.updatedAt - left.updatedAt);
  }

  function runtimeMessageCount(threadID) {
    if (!threadID) return 0;
    return Number(database.prepare("SELECT COUNT(*) AS count FROM portal_codex_messages WHERE thread_id = ?").get(threadID).count);
  }

  function listProjects() {
    const conversations = listConversations();
    const standalone = [...new Set(conversations.filter((item) => item.projectId.startsWith("standalone:")).map((item) => Number(item.projectId.slice(11))))]
      .map((userID) => ({ id: `standalone:${userID}`, name: "未归属项目", userID, storage: "历史会话", availableLocally: true }));
    const fileOnly = fileProjects.filter((local) => !projects.some((project) => project.name === local.name)).map((local) => ({
      id: `files:${Buffer.from(`${local.owner}/${local.name}`).toString("base64url")}`,
      name: local.name,
      owner: `${local.owner} 目录`,
      storage: "NAS 项目本地副本",
      availableLocally: true,
    }));
    const known = new Set([...projects, ...standalone].map((project) => project.id));
    const missing = conversations.filter((conversation) => !known.has(conversation.projectId))
      .filter((conversation, index, all) => all.findIndex((item) => item.projectId === conversation.projectId) === index)
      .map((conversation) => ({
        id: conversation.projectId,
        name: `未登记历史项目 · ${conversation.projectId.slice(-6)}`,
        owner: conversation.owner,
        storage: "历史快照",
        availableLocally: false,
      }));
    return [...projects, ...fileOnly, ...missing, ...standalone].map((project) => publicProject(
      project,
      conversations.filter((item) => item.projectId === project.id).length,
    )).filter((project) => project.conversationCount > 0 || !project.id.startsWith("standalone:"));
  }

  function getConversation(value) {
    const parsed = splitMigrationID(value);
    if (!parsed) return null;
    if (parsed.kind === "portal") {
      const row = database.prepare("SELECT * FROM portal_codex_threads WHERE id = ?").get(parsed.id);
      if (!row || linkedRuntimeIDs.has(String(row.id))) return null;
      return {
        id: value,
        sourceThreadId: String(row.codex_thread_id),
        projectId: row.project_id ? String(row.project_id) : `standalone:${row.user_id}`,
        title: String(row.title || "新会话"),
        contextMarkdown: "",
        kind: parsed.kind,
        row,
      };
    }
    const row = database.prepare("SELECT * FROM codex_imported_threads WHERE id = ?").get(parsed.id);
    return row ? {
      id: value,
      sourceThreadId: String(row.source_thread_id),
      projectId: String(row.project_id),
      title: String(row.title || "新会话"),
      contextMarkdown: String(row.context_markdown || ""),
      kind: parsed.kind,
      row,
    } : null;
  }

  function messages(value) {
    const conversation = getConversation(value);
    if (!conversation) return null;
    if (conversation.kind === "portal") {
      return database.prepare(`
        SELECT id, role, content, created_at FROM portal_codex_messages
        WHERE thread_id = ? ORDER BY sequence, created_at, id
      `).all(conversation.row.id).map((row, index) => ({
        id: `portal-${row.id}`,
        sequence: index + 1,
        role: row.role === "user" ? "user" : "assistant",
        text: String(row.content || ""),
        createdAt: Number(row.created_at),
        source: "历史工作台",
      }));
    }
    const historical = database.prepare(`
      SELECT id, role, event_type, content_json, source_created_at
      FROM codex_imported_messages WHERE imported_thread_id = ? ORDER BY sequence
    `).all(conversation.row.id).map((row, index) => ({
      id: `imported-${row.id}`,
      sequence: index + 1,
      role: row.role === "user" ? "user" : "assistant",
      text: historicalText(row.event_type, json(row.content_json, [])),
      createdAt: Number.isFinite(Date.parse(row.source_created_at || "")) ? Date.parse(row.source_created_at) : Number(conversation.row.updated_at),
      source: "迁移归档",
    }));
    if (!conversation.row.runtime_portal_thread_id) return historical;
    const runtime = database.prepare(`
      SELECT id, role, content, created_at FROM portal_codex_messages
      WHERE thread_id = ? ORDER BY sequence, created_at, id
    `).all(conversation.row.runtime_portal_thread_id).map((row, index) => ({
      id: `runtime-${row.id}`,
      sequence: historical.length + index + 1,
      role: row.role === "user" ? "user" : "assistant",
      text: String(row.content || ""),
      createdAt: Number(row.created_at),
      source: "迁移后续写",
      migrationBoundary: index === 0,
    }));
    return [...historical, ...runtime];
  }

  function page(value, before, limit) {
    const records = messages(value);
    if (!records) return null;
    const boundary = before ? Number(before) : Number.NaN;
    const eligible = Number.isFinite(boundary) ? records.filter((item) => item.sequence < boundary) : records;
    const start = Math.max(0, eligible.length - boundedLimit(limit));
    return { records: eligible.slice(start), cursor: start > 0 ? String(eligible[start].sequence) : null };
  }

  function continuationContext(value) {
    const conversation = getConversation(value);
    if (!conversation) return null;
    if (conversation.contextMarkdown.trim()) return conversation.contextMarkdown.trim().slice(0, MAX_CONTEXT_CHARS);
    const visible = messages(value).slice(-40).map((message) => `${message.role === "user" ? "用户" : "助手"}：${message.text}`).join("\n\n");
    return visible.slice(-MAX_CONTEXT_CHARS);
  }

  return { close: () => database.close(), getConversation, listConversations, listProjects, page, continuationContext };
}

async function upstreamRequest(options, pathname, requestOptions = {}) {
  const url = new URL(pathname, options.upstreamURL);
  url.searchParams.set("directory", options.workspace);
  const response = await fetch(url, {
    ...requestOptions,
    headers: {
      authorization: `Basic ${Buffer.from(`${options.upstreamUsername}:${options.upstreamPassword}`).toString("base64")}`,
      ...(requestOptions.body ? { "content-type": "application/json" } : {}),
    },
  });
  if (!response.ok) throw Object.assign(new Error((await response.text()) || `OpenCode HTTP ${response.status}`), { statusCode: 502 });
  if (response.status === 204) return null;
  return response.json();
}

async function readMappings(file) {
  return json(await readFile(file, "utf8").catch(() => "{}"), {});
}

async function saveMappings(file, mappings) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(mappings, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, file);
}

function migrationPrompt(conversation, context) {
  return [
    "[历史会话迁移上下文]",
    "这是从旧 Codex 工作台的本地只读备份继续出来的新 OpenCode 会话。旧任务 ID、隐藏指令、工具句柄、审批、登录态和运行中进程均未恢复。不要自动重放历史操作。",
    `旧会话：${conversation.title}`,
    `旧来源 ID：${conversation.sourceThreadId}`,
    "开始新工作前，请先读取当前项目规则，并把历史陈述与当前文件状态分开核对。",
    context,
  ].join("\n\n");
}

export function createMigrationService(options) {
  const catalog = options.catalog ?? createMigrationCatalog(options.databaseFile, options.projectsRoot);
  const allowedOrigin = options.allowedOrigin ?? "http://127.0.0.1:18140";
  return http.createServer(async (request, response) => {
    response.setHeader("x-content-type-options", "nosniff");
    response.setHeader("access-control-allow-origin", allowedOrigin);
    response.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
    response.setHeader("access-control-allow-headers", "content-type");
    response.setHeader("access-control-expose-headers", "x-next-cursor");
    if (request.method === "OPTIONS") {
      response.writeHead(204);
      response.end();
      return;
    }
    if (request.headers.origin !== allowedOrigin) {
      response.writeHead(403, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "Origin not allowed" } }));
      return;
    }
    const incoming = new URL(request.url ?? "/", "http://127.0.0.1");
    try {
      if (request.method === "GET" && incoming.pathname === "/health") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ ok: true, source: "local-read-only-snapshot" }));
        return;
      }
      if (request.method === "GET" && incoming.pathname === "/projects") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(catalog.listProjects()));
        return;
      }
      if (request.method === "GET" && incoming.pathname === "/conversations") {
        const projectID = incoming.searchParams.get("projectId");
        const mappings = await readMappings(options.mappingFile);
        const conversations = catalog.listConversations()
          .filter((item) => !projectID || item.projectId === projectID)
          .map((item) => ({
            ...item,
            runtimeSessionId: mappings[item.id]?.sessionID ?? null,
            resumedAt: mappings[item.id]?.createdAt ?? null,
          }));
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(conversations));
        return;
      }
      const match = incoming.pathname.match(/^\/conversations\/(portal|imported)%3A([0-9a-f-]{36})\/(messages|continue)$/i)
        ?? incoming.pathname.match(/^\/conversations\/(portal|imported):([0-9a-f-]{36})\/(messages|continue)$/i);
      if (match && request.method === "GET" && match[3] === "messages") {
        const page = catalog.page(`${match[1]}:${match[2]}`, incoming.searchParams.get("before"), incoming.searchParams.get("limit"));
        if (!page) throw Object.assign(new Error("历史会话不存在"), { statusCode: 404 });
        response.writeHead(200, { "content-type": "application/json", ...(page.cursor ? { "x-next-cursor": page.cursor } : {}) });
        response.end(JSON.stringify(page.records));
        return;
      }
      if (match && request.method === "POST" && match[3] === "continue") {
        const conversationID = `${match[1]}:${match[2]}`;
        const conversation = catalog.getConversation(conversationID);
        if (!conversation) throw Object.assign(new Error("历史会话不存在"), { statusCode: 404 });
        const mappings = await readMappings(options.mappingFile);
        const existing = mappings[conversationID];
        if (existing?.sessionID) {
          const active = await upstreamRequest(options, `/session/${existing.sessionID}`).catch(() => null);
          if (active) {
            response.writeHead(200, { "content-type": "application/json" });
            response.end(JSON.stringify({ session: active, reused: true, legacyConversationId: conversationID }));
            return;
          }
        }
        const session = await upstreamRequest(options, "/session", { method: "POST", body: JSON.stringify({ title: conversation.title }) });
        await upstreamRequest(options, `/session/${session.id}/prompt_async`, {
          method: "POST",
          body: JSON.stringify({ noReply: true, tools: {}, parts: [{ type: "text", text: migrationPrompt(conversation, catalog.continuationContext(conversationID)) }] }),
        });
        mappings[conversationID] = { sessionID: session.id, sourceThreadID: conversation.sourceThreadId, createdAt: Date.now() };
        await saveMappings(options.mappingFile, mappings);
        response.writeHead(201, { "content-type": "application/json" });
        response.end(JSON.stringify({ session, reused: false, legacyConversationId: conversationID }));
        return;
      }
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "Route not found" } }));
    } catch (error) {
      response.writeHead(error.statusCode ?? 500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: error.message } }));
    }
  });
}

async function main() {
  const runtimeRoot = process.env.YEUTECH_AGENT_RUNTIME_ROOT ?? path.resolve(import.meta.dirname, "../.runtime");
  const passwordFile = process.env.OPENCODE_SERVER_PASSWORD_FILE ?? path.join(runtimeRoot, "secrets/opencode.password");
  const server = createMigrationService({
    databaseFile: process.env.YEUTECH_MIGRATION_DATABASE,
    projectsRoot: process.env.YEUTECH_MIGRATION_PROJECTS_ROOT,
    mappingFile: process.env.YEUTECH_MIGRATION_MAPPING_FILE ?? path.join(runtimeRoot, "migration/mappings.json"),
    workspace: process.env.YEUTECH_AGENT_WORKSPACE ?? path.join(runtimeRoot, "workspaces/sample"),
    upstreamURL: process.env.YEUTECH_OPENCODE_URL ?? "http://127.0.0.1:18130",
    upstreamUsername: process.env.OPENCODE_SERVER_USERNAME ?? "yeutech-agent",
    upstreamPassword: (process.env.OPENCODE_SERVER_PASSWORD ?? await readFile(passwordFile, "utf8")).trim(),
    allowedOrigin: process.env.YEUTECH_MIGRATION_ALLOWED_ORIGIN ?? "http://127.0.0.1:18140",
  });
  const port = Number(process.env.YEUTECH_MIGRATION_PORT ?? 18142);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  process.stdout.write(`YEUTECH migration service listening on http://127.0.0.1:${port}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
