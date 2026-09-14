#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { indexPortalProjects, resolvePortalWorkspace } from "./workspace-identity.mjs";

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
    workspaceDirectory: project.workspaceDirectory || null,
    conversationCount,
  };
}

export function createMigrationCatalog(databaseFile, projectsRoot, selection = {}) {
  if (!path.isAbsolute(databaseFile)) throw new Error("Migration database must be an absolute path");
  const selectedUserID = Number.isInteger(selection.userID) && selection.userID > 0 ? selection.userID : null;
  const selectedOwnerDirectory = String(selection.ownerDirectory || "").trim();
  if (selectedUserID == null) throw new Error("Migration userID must be a positive integer");
  if (!selectedOwnerDirectory) throw new Error("Migration ownerDirectory is required");
  const database = new DatabaseSync(databaseFile, { readOnly: true });
  const linkedRuntimeIDs = new Set(database.prepare(`
    SELECT runtime_portal_thread_id AS id FROM codex_imported_threads
    WHERE runtime_portal_thread_id IS NOT NULL
  `).all().map((row) => String(row.id)));
  const projectRows = database.prepare("SELECT user_id, projects_json FROM portal_codex_project_snapshots WHERE user_id = ?").all(selectedUserID);
  const snapshotProjects = projectRows.flatMap((row) => json(row.projects_json, []).map((project) => ({ ...project, userID: Number(row.user_id) })));
  const ownerWorkspace = projectsRoot && path.isAbsolute(projectsRoot)
    ? resolvePortalWorkspace({ projectsRoot, portalUserId: selectedUserID, legacyWorkspace: path.join(projectsRoot, selectedOwnerDirectory), create: false })
    : null;
  const identity = ownerWorkspace ? indexPortalProjects(ownerWorkspace, snapshotProjects, selectedUserID) : null;
  const fileProjects = identity ? [...identity.projects.entries()].map(([id, folder]) => ({
    id,
    name: folder.name,
    workspaceDirectory: path.basename(folder.path),
    owner: path.basename(identity.owner),
  })) : [];
  const projects = snapshotProjects.map((project) => {
    const local = fileProjects.find((item) => item.id === String(project.id));
    return {
    id: String(project.id),
    name: String(project.name || "未命名项目"),
    userID: project.userID,
    storage: project.storage === "nas" ? "NAS 项目本地副本" : "历史快照",
    availableLocally: Boolean(local),
    ...(local ? { owner: `${local.owner} 目录`, workspaceDirectory: local.workspaceDirectory } : {}),
  };
  });

  function listConversations() {
    const native = database.prepare(`
      SELECT thread.*, COUNT(message.id) AS message_count
      FROM portal_codex_threads thread
      LEFT JOIN portal_codex_messages message ON message.thread_id = thread.id
      GROUP BY thread.id ORDER BY thread.updated_at DESC
    `).all().filter((row) => Number(row.user_id) === selectedUserID && !linkedRuntimeIDs.has(String(row.id))).map((row) => ({
      id: migrationID("portal", row.id),
      sourceThreadId: String(row.codex_thread_id),
      projectId: row.project_id ? String(row.project_id) : `standalone:${row.user_id}`,
      owner: `本地账号 ${row.user_id}`,
      title: String(row.title || "新会话"),
      model: String(row.model || ""),
      reasoningEffort: String(row.reasoning_effort || ""),
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
    `).all().filter((row) => Number(row.user_id) === selectedUserID).map((row) => ({
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
    const fileOnly = fileProjects.filter((local) => !projects.some((project) => project.id === local.id)).map((local) => ({
      id: local.id || `files:${Buffer.from(`${local.owner}/${local.name}`).toString("base64url")}`,
      name: local.name,
      workspaceDirectory: local.workspaceDirectory,
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
      if (!row || Number(row.user_id) !== selectedUserID || linkedRuntimeIDs.has(String(row.id))) return null;
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
    return row && Number(row.user_id) === selectedUserID ? {
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
  const worker = options.resolveWorker ? await options.resolveWorker() : options;
  const url = new URL(pathname, worker.upstreamURL);
  url.searchParams.set("directory", worker.workspace);
  let response;
  try {
    response = await fetch(url, {
      ...requestOptions,
      headers: {
        authorization: `Basic ${Buffer.from(`${options.upstreamUsername}:${options.upstreamPassword}`).toString("base64")}`,
        ...(requestOptions.body ? { "content-type": "application/json" } : {}),
      },
      signal: requestOptions.signal ?? AbortSignal.timeout(options.upstreamRequestTimeoutMs ?? 15_000),
    });
  } catch (cause) {
    const timedOut = cause?.name === "TimeoutError" || cause?.name === "AbortError";
    throw Object.assign(new Error(timedOut ? "OpenCode migration request timed out" : `OpenCode migration transport failed: ${cause?.message || "unknown error"}`), {
      statusCode: timedOut ? 504 : 502,
      code: timedOut ? "migration_upstream_timeout" : "migration_upstream_transport",
      retryable: true,
      cause,
    });
  }
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 500) || `OpenCode HTTP ${response.status}`;
    throw Object.assign(new Error(detail), {
      statusCode: response.status === 404 ? 404 : 502,
      code: response.status === 404 ? "migration_session_not_found" : "migration_upstream_response",
      retryable: response.status >= 500,
    });
  }
  if (response.status === 204) return null;
  return response.json();
}

async function readMappings(file) {
  return json(await readFile(file, "utf8").catch(() => "{}"), {});
}

async function saveMappings(file, mappings) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
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
  const catalog = options.catalog ?? createMigrationCatalog(options.databaseFile, options.projectsRoot, {
    userID: options.userID,
    ownerDirectory: options.ownerDirectory,
  });
  const allowedOrigin = options.allowedOrigin || null;
  const continuations = new Map();
  let mappingMutation = Promise.resolve();

  async function persistMapping(conversationID, mapping) {
    const operation = mappingMutation.then(async () => {
      const mappings = await readMappings(options.mappingFile);
      mappings[conversationID] = mapping;
      await saveMappings(options.mappingFile, mappings);
      return mapping;
    });
    mappingMutation = operation.then(() => undefined, () => undefined);
    return operation;
  }

  async function removeMapping(conversationID) {
    const operation = mappingMutation.then(async () => {
      const mappings = await readMappings(options.mappingFile);
      const existed = Boolean(mappings[conversationID]);
      mappings[conversationID] = { ...(mappings[conversationID] || {}), sessionID: null, hidden: true, deletedAt: Date.now() };
      await saveMappings(options.mappingFile, mappings);
      return existed;
    });
    mappingMutation = operation.then(() => undefined, () => undefined);
    return operation;
  }

  async function renameMapping(conversationID, displayTitle) {
    const title = String(displayTitle || "").normalize("NFC").trim().slice(0, 160);
    if (!title) throw Object.assign(new Error("会话名称不能为空"), { statusCode: 400, code: "migration_title_required", retryable: false });
    const operation = mappingMutation.then(async () => {
      const mappings = await readMappings(options.mappingFile);
      mappings[conversationID] = { ...(mappings[conversationID] || {}), displayTitle: title, updatedAt: Date.now() };
      await saveMappings(options.mappingFile, mappings);
      return mappings[conversationID];
    });
    mappingMutation = operation.then(() => undefined, () => undefined);
    return operation;
  }

  async function continueConversation(conversationID) {
    const conversation = catalog.getConversation(conversationID);
    if (!conversation) throw Object.assign(new Error("历史会话不存在"), { statusCode: 404, code: "migration_conversation_not_found", retryable: false });
    const mappings = await readMappings(options.mappingFile);
    const existing = mappings[conversationID];
    if (existing?.hidden) throw Object.assign(new Error("历史会话已删除"), { statusCode: 410, code: "migration_conversation_deleted", retryable: false });
    if (existing?.sessionID) {
      try {
        const active = await upstreamRequest(options, `/session/${existing.sessionID}`);
        return { statusCode: 200, body: { session: active, reused: true, legacyConversationId: conversationID } };
      } catch (error) {
        // Only an explicit upstream 404 proves the mapped session is gone. A
        // timeout, restart, or gateway failure must preserve the mapping so a
        // retry cannot fork one historical conversation into two sessions.
        if (error.statusCode !== 404) throw error;
      }
    }
    const session = await upstreamRequest(options, "/session", { method: "POST", body: JSON.stringify({ title: conversation.title }) });
    await upstreamRequest(options, `/session/${session.id}/prompt_async`, {
      method: "POST",
      body: JSON.stringify({ noReply: true, tools: {}, parts: [{ type: "text", text: migrationPrompt(conversation, catalog.continuationContext(conversationID)) }] }),
    });
    await persistMapping(conversationID, { sessionID: session.id, sourceThreadID: conversation.sourceThreadId, createdAt: Date.now() });
    return { statusCode: 201, body: { session, reused: false, legacyConversationId: conversationID } };
  }

  return http.createServer(async (request, response) => {
    response.setHeader("x-content-type-options", "nosniff");
    if (allowedOrigin) {
      response.setHeader("access-control-allow-origin", allowedOrigin);
      response.setHeader("access-control-allow-methods", "GET, POST, PATCH, DELETE, OPTIONS");
      response.setHeader("access-control-allow-headers", "content-type");
      response.setHeader("access-control-expose-headers", "x-next-cursor");
    }
    if (request.method === "OPTIONS") {
      response.writeHead(204);
      response.end();
      return;
    }
    if (allowedOrigin && request.headers.origin !== allowedOrigin) {
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
          .filter((item) => !mappings[item.id]?.hidden)
          .map((item) => ({
            ...item,
            title: mappings[item.id]?.displayTitle || item.title,
            runtimeSessionId: mappings[item.id]?.sessionID ?? null,
            resumedAt: mappings[item.id]?.createdAt ?? null,
          }));
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(conversations));
        return;
      }
      const match = incoming.pathname.match(/^\/conversations\/(portal|imported)%3A([0-9a-f-]{36})\/(messages|continue|mapping|metadata)$/i)
        ?? incoming.pathname.match(/^\/conversations\/(portal|imported):([0-9a-f-]{36})\/(messages|continue|mapping|metadata)$/i);
      if (match && request.method === "GET" && match[3] === "messages") {
        const page = catalog.page(`${match[1]}:${match[2]}`, incoming.searchParams.get("before"), incoming.searchParams.get("limit"));
        if (!page) throw Object.assign(new Error("历史会话不存在"), { statusCode: 404 });
        response.writeHead(200, { "content-type": "application/json", ...(page.cursor ? { "x-next-cursor": page.cursor } : {}) });
        response.end(JSON.stringify(page.records));
        return;
      }
      if (match && request.method === "POST" && match[3] === "continue") {
        const conversationID = `${match[1]}:${match[2]}`;
        const joined = continuations.has(conversationID);
        if (!joined) {
          const operation = continueConversation(conversationID);
          continuations.set(conversationID, operation);
          operation.finally(() => { if (continuations.get(conversationID) === operation) continuations.delete(conversationID); }).catch(() => undefined);
        }
        const result = await continuations.get(conversationID);
        response.writeHead(joined && result.statusCode === 201 ? 200 : result.statusCode, { "content-type": "application/json" });
        response.end(JSON.stringify(joined && result.statusCode === 201 ? { ...result.body, reused: true } : result.body));
        return;
      }
      if (match && request.method === "DELETE" && match[3] === "mapping") {
        const conversationID = `${match[1]}:${match[2]}`;
        if (!catalog.getConversation(conversationID)) throw Object.assign(new Error("历史会话不存在"), { statusCode: 404, code: "migration_conversation_not_found", retryable: false });
        const removed = await removeMapping(conversationID);
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ conversationId: conversationID, mappingRemoved: removed }));
        return;
      }
      if (match && request.method === "PATCH" && match[3] === "metadata") {
        const conversationID = `${match[1]}:${match[2]}`;
        if (!catalog.getConversation(conversationID)) throw Object.assign(new Error("历史会话不存在"), { statusCode: 404, code: "migration_conversation_not_found", retryable: false });
        const chunks = [];
        let size = 0;
        for await (const chunk of request) {
          size += chunk.length;
          if (size > 64 * 1024) throw Object.assign(new Error("请求内容过大"), { statusCode: 413, code: "migration_body_too_large", retryable: false });
          chunks.push(chunk);
        }
        const payload = json(Buffer.concat(chunks).toString("utf8") || "{}", {});
        const mapping = await renameMapping(conversationID, payload.title);
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ conversationId: conversationID, title: mapping.displayTitle }));
        return;
      }
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "Route not found" } }));
    } catch (error) {
      response.writeHead(error.statusCode ?? 500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { code: error.code || "migration_failed", message: error.message, retryable: Boolean(error.retryable) } }));
    }
  });
}

async function main() {
  const runtimeRoot = process.env.YEUTECH_AGENT_RUNTIME_ROOT ?? path.resolve(import.meta.dirname, "../.runtime");
  const passwordFile = process.env.OPENCODE_SERVER_PASSWORD_FILE ?? path.join(runtimeRoot, "secrets/opencode.password");
  const selectedUserID = Number(process.env.YEUTECH_MIGRATION_USER_ID ?? 3);
  if (!Number.isInteger(selectedUserID) || selectedUserID < 1) throw new Error("YEUTECH_MIGRATION_USER_ID must be a positive integer");
  const server = createMigrationService({
    databaseFile: process.env.YEUTECH_MIGRATION_DATABASE,
    projectsRoot: process.env.YEUTECH_MIGRATION_PROJECTS_ROOT,
    mappingFile: process.env.YEUTECH_MIGRATION_MAPPING_FILE ?? path.join(runtimeRoot, "migration/mappings.json"),
    workspace: process.env.YEUTECH_AGENT_WORKSPACE ?? path.join(runtimeRoot, "workspaces/sample"),
    upstreamURL: process.env.YEUTECH_OPENCODE_URL ?? "http://127.0.0.1:18130",
    upstreamUsername: process.env.OPENCODE_SERVER_USERNAME ?? "yeutech-agent",
    upstreamPassword: (process.env.OPENCODE_SERVER_PASSWORD ?? await readFile(passwordFile, "utf8")).trim(),
    allowedOrigin: process.env.YEUTECH_MIGRATION_ALLOWED_ORIGIN,
    userID: selectedUserID,
    ownerDirectory: process.env.YEUTECH_MIGRATION_OWNER_DIRECTORY ?? "ryan",
    resolveWorker: process.env.YEUTECH_SUPERVISOR_TOKEN ? async () => {
      const result = await fetch(new URL("/workers/ensure", process.env.YEUTECH_SUPERVISOR_URL ?? "http://127.0.0.1:18141"), {
        method: "POST",
        headers: { authorization: `Bearer ${process.env.YEUTECH_SUPERVISOR_TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ portalUserId: selectedUserID, username: process.env.YEUTECH_MIGRATION_OWNER_DIRECTORY ?? "ryan" }),
      });
      if (!result.ok) throw new Error(`Migration worker creation failed (${result.status})`);
      const worker = await result.json();
      return { workspace: worker.workspace, upstreamURL: worker.url };
    } : null,
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
