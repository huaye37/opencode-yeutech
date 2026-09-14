import http from "node:http";
import { createHash, randomUUID } from "node:crypto";

const sessions = [{ id: "ses_mock_history", title: "长会话性能验证", model: { modelID: "claude-haiku-4-5-20251001" } }];
const messageCount = Number(process.env.YEUTECH_MOCK_MESSAGE_COUNT ?? 2);
const messages = Array.from({ length: messageCount }, (_, index) => ({
  info: {
    id: `msg_mock_${index + 1}`,
    role: index % 2 === 0 ? "user" : "assistant",
    time: { created: 1789300000000 + index, completed: 1789300000000 + index },
  },
  parts: [{ type: "text", text: `${index % 2 === 0 ? "历史测试用户消息" : "历史测试助手回复"} ${String(index + 1).padStart(4, "0")}` }],
}));
let permissions = [{ id: "per_mock_bash", sessionID: "ses_mock_history", permission: "bash", patterns: ["printf 'approved' > notes.md"], metadata: {}, always: [] }];
let sessionState = { type: "busy", message: "正在执行 Mock 任务" };
const eventClients = new Set();
const projectionClients = new Set();
const goals = [];
const mockUploads = [];

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}

function stableHash(value) {
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

function projectedMessages() {
  return messages.map((item) => ({ id: item.info.id, sessionId: "ses_mock_history", role: item.info.role, text: item.parts[0].text, createdAt: item.info.time.created, completedAt: item.info.time.completed }));
}

function trajectory() {
  return projectedMessages().map((message, index) => ({ id: `message:${message.id}`, type: "message", at: message.createdAt, message, ordinal: index + 1 }));
}

function childTree() {
  return [{ id: "ses_child", parentId: "", title: "附件流程检查", status: "completed", createdAt: 1789300000500, children: [] }];
}

function snapshot(sessionID = "ses_mock_history") {
  const projected = projectedMessages();
  const projectedTrajectory = trajectory();
  return {
    session: { id: sessionID, title: "项目执行验证", status: sessionState },
    messages: projected,
    permissions,
    children: [{ id: "ses_child", title: "附件流程检查" }],
    childTree: childTree(),
    plan: [{ id: "plan_1", content: "验证项目文件", status: "completed" }],
    outline: [{ id: "turn_1", turn: 1, title: "完成工作台验收" }],
    activity: projectedTrajectory,
    trajectory: projectedTrajectory,
    stats: { turns: 1, toolCalls: 1, subagents: 1, tokens: { input: 120, output: 80, reasoning: 20 }, cost: null, durationMs: 650 },
    context: { workload: "agent-code", messageCount: messages.length, sources: ["session-messages", "runtime-tools", "workspace-files"] },
    graph: { nodes: [{ id: sessionID, type: "session", label: "项目执行验证", status: sessionState ? "busy" : "idle" }], edges: [] },
    evidence: { state: "generation-settled", checks: [{ type: "generation", passed: true }, { type: "diff", passed: false }, { type: "test", passed: false }] },
  };
}

function writeNamedEvent(client, name, payload, id) {
  if (id) client.write(`id: ${id}\n`);
  client.write(`event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`);
}

function durableProjection(sessionID) {
  const current = snapshot(sessionID);
  const values = [
    { type: "session.state", data: current.session },
    ...current.messages.map((message) => ({ type: "message.upsert", data: message })),
    ...current.trajectory.map((item) => ({ type: "trajectory.upsert", data: item })),
    { type: "projection.meta", data: { permissions: current.permissions, childTree: current.childTree, plan: current.plan, outline: current.outline, stats: current.stats, context: current.context, graph: current.graph, evidence: current.evidence } },
  ];
  return values.map((value, index) => ({ cursor: index + 1, ...value }));
}

function broadcastProjection(name, payload, sessionID = "ses_mock_history") {
  for (const client of projectionClients) if (client.sessionID === sessionID) writeNamedEvent(client.response, name, payload);
}

function broadcast(payload) {
  for (const client of eventClients) client.write(`data: ${JSON.stringify(payload)}\n\n`);
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

const server = http.createServer(async (request, response) => {
  const incoming = new URL(request.url, "http://127.0.0.1");
  if (request.method === "GET" && incoming.pathname === "/event") {
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    response.write(": connected\n\n");
    eventClients.add(response);
    request.once("close", () => eventClients.delete(response));
    return;
  }
  const projectionRoute = incoming.pathname.match(/^\/api\/workbench\/sessions\/([^/]+)\/events$/);
  if (request.method === "GET" && projectionRoute) {
    const sessionID = decodeURIComponent(projectionRoute[1]);
    const requestedCursor = Number(request.headers["last-event-id"] || incoming.searchParams.get("cursor") || 0);
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform", connection: "keep-alive" });
    for (const event of durableProjection(sessionID)) if (event.cursor > requestedCursor) writeNamedEvent(response, "durable", event, event.cursor);
    writeNamedEvent(response, "ready", { cursor: durableProjection(sessionID).at(-1)?.cursor || 0, contractVersion: "mock-2026-09-13" });
    const client = { response, sessionID };
    projectionClients.add(client);
    request.once("close", () => projectionClients.delete(client));
    return;
  }
  response.setHeader("content-type", "application/json");
  if (request.method === "GET" && incoming.pathname === "/api/workbench/bootstrap") {
    response.end(JSON.stringify({
      sessions,
      states: sessionState ? { ses_mock_history: sessionState } : {},
      permissions,
      models: [
        { id: "claude-haiku-4-5-20251001", name: "Claude Haiku 4.5", selectable: true, limit: { context: 200000 } },
        { id: "new-model-preview", name: "New model preview", selectable: false, disabledReason: "能力信息待补全" },
      ],
      defaultModel: { id: "claude-haiku-4-5-20251001" },
      reload: { status: "ready" },
    }));
    return;
  }
  if (request.method === "GET" && incoming.pathname === "/api/workbench/profiles") {
    response.end(JSON.stringify({ data: [
      { id: "general-agent", name: "通用 Agent", policy: { context: "balanced", failover: "before-dispatch-only" }, evidence: ["generation", "result"] },
      { id: "agent-code", name: "代码与发布", policy: { context: "workspace-grounded", failover: "before-dispatch-only" }, evidence: ["generation", "diff", "test"] },
      { id: "novel-writing", name: "小说创作", policy: { context: "long-form-continuity", failover: "before-dispatch-only" }, evidence: ["generation", "candidate", "context-pack"] },
    ] }));
    return;
  }
  if (request.method === "GET" && incoming.pathname === "/api/workbench/skills") {
    response.end(JSON.stringify({ data: [
      { name: "workspace-files", description: "在授权项目中读取文件", source: "OpenCode worker", available: true },
      { name: "browser-check", description: "前端真实流程验证", source: "YEUTECH", available: true },
    ] }));
    return;
  }
  if (request.method === "GET" && incoming.pathname === "/api/workbench/control") {
    const workload = incoming.searchParams.get("workload") || "general-agent";
    response.end(JSON.stringify({
      contractVersion: "mock-2026-09-13",
      workload,
      models: [{ id: "claude-haiku-4-5-20251001", eligibility: { eligible: true, reasons: [] } }],
      runtimeBudget: { totalMemoryMb: 16_384, reservedMemoryMb: 6_144, systemWorkerMb: 500, interactiveWorkerMb: 500, usableMemoryMb: 9_740, maxInteractiveWorkers: 19, requestedInteractiveWorkers: 1, withinBudget: true, overflowWorkers: 0 },
    }));
    return;
  }
  if (request.method === "GET" && incoming.pathname === "/api/workbench/goals") {
    const scope = incoming.searchParams.get("scope") || "workspace";
    response.end(JSON.stringify({ contractVersion: "mock-2026-09-13", data: goals.filter((goal) => goal.scopeKey === scope) }));
    return;
  }
  if (request.method === "POST" && incoming.pathname === "/api/workbench/goals") {
    const body = await readJson(request);
    const now = new Date().toISOString();
    const goal = { id: `goal_${randomUUID().replaceAll("-", "")}`, scopeKey: body.scopeKey || "workspace", objective: String(body.objective || ""), phase: body.phase || "delivery", status: body.status || "active", revision: 1, createdAt: now, updatedAt: now };
    goals.unshift(goal);
    response.writeHead(201, { "content-type": "application/json" });
    response.end(JSON.stringify({ contractVersion: "mock-2026-09-13", data: goal }));
    return;
  }
  const goalRoute = incoming.pathname.match(/^\/api\/workbench\/goals\/(goal_[a-f0-9]{32})$/);
  if (request.method === "PATCH" && goalRoute) {
    const body = await readJson(request);
    const index = goals.findIndex((goal) => goal.id === goalRoute[1]);
    if (index < 0) { response.writeHead(404).end(JSON.stringify({ error: { message: "Goal was not found" } })); return; }
    if (Number(body.revision) !== goals[index].revision) { response.writeHead(409).end(JSON.stringify({ error: { message: "Goal changed since it was read" } })); return; }
    goals[index] = { ...goals[index], ...body, id: goals[index].id, scopeKey: goals[index].scopeKey, revision: goals[index].revision + 1, updatedAt: new Date().toISOString() };
    response.end(JSON.stringify({ contractVersion: "mock-2026-09-13", data: goals[index] }));
    return;
  }
  if (request.method === "POST" && incoming.pathname === "/api/workbench/context-packs") {
    const body = await readJson(request);
    const paths = [...new Set((body.paths || []).map(String))].sort();
    const sources = paths.map((sourcePath) => ({ path: sourcePath, version: "mock-v1", kind: "project-file", hash: stableHash({ project: body.project, path: sourcePath }) }));
    const pack = { schema: "verified-files-v1", projectId: String(body.project || "mock-project"), revision: 1, sources };
    response.writeHead(201, { "content-type": "application/json" });
    response.end(JSON.stringify({ contractVersion: "mock-2026-09-13", data: { ...pack, hash: stableHash(pack) } }));
    return;
  }
  if (request.method === "POST" && incoming.pathname === "/api/workbench/replays") {
    const body = await readJson(request);
    const lowerBetter = new Set(["ttftMs", "durationMs", "tokens", "cost"]);
    const keys = new Set([...Object.keys(body.baseline?.metrics || {}), ...Object.keys(body.candidate?.metrics || {})]);
    const metrics = {};
    for (const key of keys) {
      const baseline = Number(body.baseline?.metrics?.[key]);
      const candidate = Number(body.candidate?.metrics?.[key]);
      if (!Number.isFinite(baseline) || !Number.isFinite(candidate)) continue;
      const delta = candidate - baseline;
      metrics[key] = { baseline, candidate, delta, improved: lowerBetter.has(key) ? delta < 0 : delta > 0 };
    }
    response.end(JSON.stringify({ contractVersion: "mock-2026-09-13", data: { baselineId: body.baseline?.id || null, candidateId: body.candidate?.id || null, metrics } }));
    return;
  }
  const snapshotRoute = incoming.pathname.match(/^\/api\/workbench\/sessions\/([^/]+)\/snapshot$/);
  if (request.method === "GET" && snapshotRoute) {
    response.end(JSON.stringify(snapshot(decodeURIComponent(snapshotRoute[1]))));
    return;
  }
  const toolResultRoute = incoming.pathname.match(/^\/api\/workbench\/sessions\/([^/]+)\/tool-results\/([^/]+)\/([^/]+)$/);
  if (request.method === "GET" && toolResultRoute) {
    response.end(JSON.stringify({ contractVersion: "mock-2026-09-13", data: { value: `Mock tool result for ${decodeURIComponent(toolResultRoute[2])}/${decodeURIComponent(toolResultRoute[3])}` } }));
    return;
  }
  if (request.method === "GET" && incoming.pathname === "/api/workbench/sessions/ses_mock_history/graph") {
    response.end(JSON.stringify({ data: { nodes: [{ id: "ses_mock_history", type: "session", label: "项目执行验证", status: sessionState ? "busy" : "idle" }, { id: "plan_1", type: "plan", label: "验证项目文件", status: "completed" }], edges: [{ from: "ses_mock_history", to: "plan_1" }] } }));
    return;
  }
  if (request.method === "GET" && incoming.pathname === "/api/workbench/files") {
    const directory = incoming.searchParams.get("path") || "";
    const entries = directory
      ? [{ name: "第一章.txt", path: "草稿/第一章.txt", type: "file", size: 36, mimeType: "text/plain", preview: { kind: "text", eligible: true, maxBytes: 2_097_152 } }]
      : [{ name: "草稿", path: "草稿", type: "directory" }, { name: "设定.md", path: "设定.md", type: "file", size: 48, mimeType: "text/markdown", preview: { kind: "markdown", eligible: true, maxBytes: 2_097_152 } }, { name: "原始素材.zip", path: "原始素材.zip", type: "file", size: 4_096, mimeType: "application/octet-stream", preview: { kind: "download", eligible: false, maxBytes: 0 } }];
    entries.push(...mockUploads.filter((item) => item.directory === directory).map((item) => ({ name: item.name, path: item.path, type: "file", size: item.size, mimeType: item.type, preview: { kind: "download", eligible: false, maxBytes: 0 } })));
    response.end(JSON.stringify({ data: { project: incoming.searchParams.get("project"), session: incoming.searchParams.get("session"), workspacePrefix: incoming.searchParams.has("session") ? "独立会话" : "小说创作", path: directory, hiddenCount: 1, entries } }));
    return;
  }
  if (request.method === "GET" && incoming.pathname === "/api/workbench/file") {
    if (incoming.searchParams.get("download") === "1") response.setHeader("content-disposition", "attachment");
    response.setHeader("content-type", "text/plain; charset=utf-8");
    response.setHeader("x-yeutech-original-content-type", "text/plain");
    response.setHeader("x-yeutech-preview-kind", "text");
    response.end("这是受控项目工作区中的文件预览内容。\n可以安全附加到当前对话。");
    return;
  }
  if (request.method === "POST" && incoming.pathname === "/api/workbench/attachments") {
    let size = 0;
    for await (const chunk of request) size += chunk.length;
    let name;
    try { name = decodeURIComponent(String(request.headers["x-yeutech-filename"] || "attachment.txt")); } catch { name = "attachment.txt"; }
    const directory = incoming.searchParams.has("directory") ? incoming.searchParams.get("directory") || "" : "附件";
    const path = [directory, name].filter(Boolean).join("/");
    mockUploads.push({ name, path, directory, size, type: request.headers["content-type"] || "application/octet-stream" });
    response.writeHead(201, { "content-type": "application/json" });
    response.end(JSON.stringify({ data: { name, path, workspacePath: `小说创作/${path}`, type: request.headers["content-type"] || "application/octet-stream", size, uploaded: true } }));
    return;
  }
  if (request.method === "GET" && incoming.pathname === "/api/migration/projects") {
    response.end(JSON.stringify([{ id: "project-mock", name: "小说创作", workspaceDirectory: "小说创作", availableLocally: true, conversationCount: 1 }]));
    return;
  }
  if (request.method === "GET" && incoming.pathname === "/api/migration/conversations") {
    response.end(JSON.stringify([{ id: "ses_mock_history", projectId: "project-mock", title: "项目执行验证", runtimeSessionId: "ses_mock_history", updatedAt: Date.now() }]));
    return;
  }
  if (request.method === "GET" && incoming.pathname === "/api/models") {
    response.end(JSON.stringify({ data: [
      { id: "claude-haiku-4-5-20251001", name: "Claude Haiku 4.5", selectable: true, disabledReason: null, limit: { context: 200000, input: 180000, output: 20000 } },
      { id: "new-model-preview", name: "New model preview", selectable: false, disabledReason: "能力信息待补全", limit: null },
    ] }));
    return;
  }
  if (request.method === "GET" && incoming.pathname === "/session") {
    response.end(JSON.stringify(sessions));
    return;
  }
  if (request.method === "GET" && incoming.pathname === "/session/ses_mock_history/message") {
    const limit = Number(incoming.searchParams.get("limit") ?? messages.length);
    const end = Number(incoming.searchParams.get("before") ?? messages.length);
    const start = Math.max(0, end - limit);
    if (start > 0) response.setHeader("x-next-cursor", String(start));
    response.end(JSON.stringify(messages.slice(start, end)));
    return;
  }
  if (request.method === "GET" && incoming.pathname === "/session/status") {
    response.end(JSON.stringify(sessionState ? { ses_mock_history: sessionState } : {}));
    return;
  }
  if (request.method === "GET" && incoming.pathname === "/permission") {
    response.end(JSON.stringify(permissions));
    return;
  }
  if (request.method === "POST" && incoming.pathname === "/permission/per_mock_bash/reply") {
    const body = await readJson(request);
    if (!new Set(["once", "reject"]).has(body.reply)) { response.writeHead(400).end(JSON.stringify({ error: "invalid reply" })); return; }
    permissions = [];
    broadcast({ type: "permission.replied", properties: { sessionID: "ses_mock_history", requestID: "per_mock_bash", reply: body.reply } });
    response.end("true");
    return;
  }
  if (request.method === "POST" && request.url === "/session") {
    const body = await readJson(request);
    const session = { id: `ses_mock_${Date.now()}`, title: body.title || "新会话" };
    sessions.unshift(session);
    response.end(JSON.stringify(session));
    return;
  }
  if (request.method === "POST" && request.url.includes("/prompt_async")) {
    sessionState = { type: "busy", message: "正在执行 Mock 任务" };
    broadcast({ type: "session.status", properties: { sessionID: "ses_mock_history", status: sessionState } });
    broadcastProjection("ephemeral", { cursor: durableProjection("ses_mock_history").length, data: { type: "message.part.updated", properties: { sessionID: "ses_mock_history", part: { type: "text", messageID: "msg_mock_stream", delta: "Mock 流式输出" } } } });
    response.writeHead(204);
    response.end();
    return;
  }
  if (request.method === "POST" && request.url.includes("/abort")) {
    sessionState = null;
    broadcast({ type: "session.idle", properties: { sessionID: "ses_mock_history" } });
    broadcastProjection("ephemeral", { cursor: durableProjection("ses_mock_history").length, data: { type: "session.idle", properties: { sessionID: "ses_mock_history" } } });
    response.end("true");
    return;
  }
  if (request.method === "POST" && request.url.includes("/summarize")) {
    response.end("true");
    return;
  }
  response.writeHead(404);
  response.end(JSON.stringify({ error: "Not found" }));
});

server.listen(18141, "127.0.0.1", () => process.stdout.write(`Mock Agent API listening on 127.0.0.1:18141 (${messageCount} messages)\n`));
