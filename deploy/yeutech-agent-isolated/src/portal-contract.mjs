export const PORTAL_CONTRACT_VERSION = "2026-09-13.4";

export function typedError(error, fallback = {}) {
  const statusCode = Number.isSafeInteger(error?.statusCode) ? error.statusCode : (fallback.statusCode ?? 400);
  const code = String(error?.code || fallback.code || (statusCode >= 500 ? "service_unavailable" : "request_rejected"));
  return {
    statusCode,
    body: {
      error: {
        code,
        message: String(error?.message || fallback.message || "Request failed"),
        retryable: error?.retryable ?? fallback.retryable ?? statusCode >= 500,
        scope: String(error?.scope || fallback.scope || "request"),
        recoveryAction: error?.recoveryAction ?? fallback.recoveryAction ?? null,
      },
      contractVersion: PORTAL_CONTRACT_VERSION,
    },
  };
}

export function portalError(message, options = {}) {
  return Object.assign(new Error(message), options);
}

function textOf(record) {
  return (record?.parts || []).filter((part) => part?.type === "text").map((part) => String(part.text || "")).join("");
}

function reasoningOf(record) {
  return (record?.parts || []).filter((part) => part?.type === "reasoning").map((part) => String(part.text || "")).join("").trim();
}

function assistantSegments(record) {
  if (record?.info?.role !== "assistant") return [];
  return (record?.parts || []).flatMap((part, index) => {
    if (!new Set(["text", "reasoning"]).has(part?.type)) return [];
    const text = String(part.text || "");
    if (!text.trim()) return [];
    return [{
      id: String(part.id || `${part.type}:${index}`),
      type: part.type,
      text,
      at: Number(part?.time?.start || record?.info?.time?.created || 0) || null,
      completedAt: Number(part?.time?.end || 0) || null,
    }];
  });
}

const ATTACHMENT_MARKER = "\n\n[已附加工作区文件]\n";
const ATTACHMENT_INSTRUCTION = "\n请仅在当前授权工作区内读取这些相对路径。";
const ATTACHMENT_ONLY_PROMPT = "请读取并处理已附加的文件。";
const CONTEXT_RECEIPT_PREFIX = /^\[YEUTECH Context Receipt\]\r?\n[\s\S]*?\r?\n\[\/YEUTECH Context Receipt\]\r?\n\r?\n/;

function visibleUserText(value) {
  return String(value || "").replace(CONTEXT_RECEIPT_PREFIX, "");
}

function messageContent(record) {
  const rawText = textOf(record);
  const raw = record?.info?.role === "user" ? visibleUserText(rawText) : rawText;
  if (record?.info?.role !== "user") return { text: raw, attachments: [] };
  const marker = raw.lastIndexOf(ATTACHMENT_MARKER);
  if (marker < 0 || !raw.endsWith(ATTACHMENT_INSTRUCTION)) return { text: raw, attachments: [] };
  const paths = raw.slice(marker + ATTACHMENT_MARKER.length, -ATTACHMENT_INSTRUCTION.length)
    .split("\n")
    .filter((line) => line.startsWith("- "))
    .map((line) => line.slice(2).trim())
    .filter(Boolean);
  if (!paths.length) return { text: raw, attachments: [] };
  const visibleText = raw.slice(0, marker).trim();
  return {
    text: visibleText === ATTACHMENT_ONLY_PROMPT ? "" : visibleText,
    attachments: paths.map((path) => ({ path, workspacePath: path, name: path.split("/").pop() || path })),
  };
}

function nonNegativeInteger(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : 0;
}

export function projectMessage(record, options = {}) {
  const content = messageContent(record);
  const assistant = record?.info?.role !== "user";
  const hasTool = (record?.parts || []).some((part) => part?.type === "tool");
  const emptySettledAssistant = assistant && options.runtimeSettled === true
    && !content.text.trim() && !hasTool && !record?.info?.error && !record?.info?.time?.completed;
  return {
    id: String(record?.info?.id || ""),
    sessionId: String(record?.info?.sessionID || record?.info?.sessionId || ""),
    role: record?.info?.role === "user" ? "user" : "assistant",
    text: content.text,
    reasoning: assistant ? reasoningOf(record) : "",
    segments: assistant ? assistantSegments(record) : [],
    attachments: content.attachments,
    createdAt: Number(record?.info?.time?.created || 0) || null,
    completedAt: Number(record?.info?.time?.completed || 0) || null,
    error: record?.info?.error ? {
      code: String(record.info.error?.data?.code || record.info.error?.name || "runtime_error"),
      message: String(record.info.error?.data?.message || record.info.error?.message || "Agent execution failed"),
    } : emptySettledAssistant ? {
      code: "empty_response",
      message: "模型调用已结束，但没有返回正文或工具结果。请换用当前可用模型后重试。",
    } : null,
  };
}

function toolResult(part, messageId, options = {}) {
  const value = part?.state?.output ?? part?.output ?? part?.result;
  if (value === undefined) return null;
  const serialized = typeof value === "string" ? value : JSON.stringify(value);
  const limit = options.inlineToolResultLimit ?? 2_000;
  if (serialized.length <= limit) return { inline: serialized, length: serialized.length, truncated: false };
  const partId = String(part.id || options.partIndex || 0);
  return {
    preview: serialized.slice(0, Math.min(400, limit)), length: serialized.length, truncated: true,
    reference: `/api/workbench/sessions/${encodeURIComponent(options.sessionId || "")}/tool-results/${encodeURIComponent(messageId)}/${encodeURIComponent(partId)}`,
  };
}

function toolError(part) {
  const source = part?.state?.error ?? part?.error;
  if (!source) return null;
  if (typeof source === "string") return { code: "tool_error", message: source.slice(0, 1_000) };
  return {
    code: String(source?.data?.code || source?.code || source?.name || "tool_error").slice(0, 120),
    message: String(source?.data?.message || source?.message || "Tool execution failed").slice(0, 1_000),
  };
}

function toolInput(part, options = {}) {
  const value = part?.state?.input ?? part?.input;
  if (value === undefined) return { input: null, inputPreview: "", inputTruncated: false };
  const serialized = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  const limit = options.inlineToolInputLimit ?? 4_000;
  return {
    input: serialized.length <= limit && value && typeof value === "object" ? value : null,
    inputPreview: serialized.slice(0, limit),
    inputTruncated: serialized.length > limit,
  };
}

export function projectActivity(records, children = [], options = {}) {
  const events = [];
  for (const record of records || []) {
    const message = projectMessage(record);
    events.push({ id: `message:${message.id}`, type: "message", at: message.createdAt, message });
    for (const [index, part] of (record?.parts || []).entries()) {
      if (part?.type !== "tool") continue;
      const projectedInput = toolInput(part, options);
      events.push({
        id: `tool:${message.id}:${part.id || index}`,
        type: "tool",
        at: Number(part?.time?.start || message.createdAt || 0) || null,
        tool: String(part.tool || part.name || "tool"),
        title: String(part?.state?.title || ""),
        status: String(part?.state?.status || "unknown"),
        durationMs: part?.time?.end && part?.time?.start ? Number(part.time.end) - Number(part.time.start) : null,
        ...projectedInput,
        result: toolResult(part, message.id, { ...options, sessionId: message.sessionId, partIndex: index }),
        error: toolError(part),
      });
    }
  }
  for (const child of children || []) events.push({
    id: `subagent:${child.id}`,
    type: "subagent",
    at: Number(child?.time?.created || 0) || null,
    session: { id: String(child.id), title: String(child.title || "子任务"), status: child.status?.type || child.status || "unknown" },
  });
  return events.sort((left, right) => Number(left.at || 0) - Number(right.at || 0));
}

export function projectChildTree(children = []) {
  const nodes = new Map((children || []).map((child) => [String(child.id), {
    id: String(child.id), parentId: String(child.parentID || child.parentId || ""), title: String(child.title || "子任务"),
    status: projectedStatus(child.status), createdAt: Number(child?.time?.created || 0) || null, children: [],
  }]));
  const roots = [];
  for (const node of nodes.values()) {
    const parent = nodes.get(node.parentId);
    if (parent) parent.children.push(node); else roots.push(node);
  }
  return roots;
}

export function projectTrajectory(records, children = [], options = {}) {
  return projectActivity(records, children, options).map((item, index) => ({ ...item, ordinal: index + 1 }));
}

export function projectStats(records, children = []) {
  const assistants = (records || []).filter((record) => record?.info?.role === "assistant");
  const sum = (field) => {
    const values = assistants.map((record) => record?.info?.tokens?.[field]);
    return assistants.length > 0 && values.every((value) => value !== null && value !== undefined && Number.isFinite(Number(value)))
      ? values.reduce((total, value) => total + Number(value), 0)
      : null;
  };
  const toolCalls = assistants.reduce((total, record) => total + (record.parts || []).filter((part) => part?.type === "tool").length, 0);
  const durations = assistants.map((record) => record?.info?.time?.completed && record?.info?.time?.created ? Number(record.info.time.completed) - Number(record.info.time.created) : null);
  const costs = assistants.map((record) => record?.info?.cost).filter((cost) => cost !== null && cost !== undefined && cost !== "" && Number.isFinite(Number(cost))).map(Number);
  return {
    turns: (records || []).filter((record) => record?.info?.role === "user").length,
    assistantMessages: assistants.length,
    toolCalls,
    subagents: (children || []).length,
    tokens: { input: sum("input"), output: sum("output"), reasoning: sum("reasoning"), cacheRead: sum("cache_read"), cacheWrite: sum("cache_write") },
    // A partial monetary total is more misleading than an explicit unknown.
    // Zero remains a valid known value when every assistant record reports it.
    cost: assistants.length > 0 && costs.length === assistants.length ? costs.reduce((total, value) => total + value, 0) : null,
    durationMs: assistants.length > 0 && durations.every((value) => Number.isFinite(value)) ? durations.reduce((total, value) => total + value, 0) : null,
    coverage: {
      assistantMessages: assistants.length,
      tokenReports: assistants.filter((record) => record?.info?.tokens && typeof record.info.tokens === "object").length,
      durationReports: durations.filter((value) => Number.isFinite(value)).length,
      costReports: costs.length,
    },
  };
}

export function projectOutline(records, options = {}) {
  const priorTurnCount = nonNegativeInteger(options.priorTurnCount);
  return (records || []).filter((record) => record?.info?.role === "user").map((record, index) => ({
    id: String(record.info.id || `turn-${priorTurnCount + index + 1}`),
    turn: priorTurnCount + index + 1,
    title: messageContent(record).text.trim().replace(/\s+/g, " ").slice(0, 120) || `第 ${priorTurnCount + index + 1} 轮`,
    createdAt: Number(record?.info?.time?.created || 0) || null,
  }));
}

export function contextReceipt(session, records, options = {}) {
  const latest = (records || []).at(-1);
  const sources = new Set((options.sources || []).filter((source) => typeof source === "string" && source));
  if ((records || []).length > 0) sources.add("session-messages");
  if ((records || []).some((record) => (record?.parts || []).some((part) => part?.type === "tool"))) sources.add("runtime-tools");
  if (options.workspaceFiles === true || Number(options.workspaceFiles) > 0) sources.add("workspace-files");
  const metadata = options.metadata && typeof options.metadata === "object" && !Array.isArray(options.metadata)
    ? { ...options.metadata }
    : {};
  return {
    sessionId: String(session?.id || ""),
    workspace: options.workspaceLabel || "current-user-workspace",
    model: latest?.info?.modelID || session?.model?.modelID || null,
    provider: latest?.info?.providerID || session?.model?.providerID || null,
    workload: options.workload || "general-agent",
    sources: [...sources],
    messageCount: (records || []).length,
    generatedAt: new Date().toISOString(),
    metadata,
  };
}

function projectedStatus(value) {
  if (typeof value === "string" && value) return value;
  return value?.type || value?.status || "unknown";
}

export function workGraph(session, records, children = [], todos = [], options = {}) {
  const nodes = [{ id: `session:${session.id}`, type: "session", label: session.title || "会话", status: projectedStatus(options.sessionState ?? session.status) }];
  const edges = [];
  for (const item of projectActivity(records, children, options)) {
    nodes.push({ id: item.id, type: item.type, label: item.type === "tool" ? item.tool : item.type, status: item.status || item.session?.status || "recorded" });
    edges.push({ from: `session:${session.id}`, to: item.id, relation: item.type === "subagent" ? "spawned" : "contains" });
  }
  for (const [index, todo] of (todos || []).entries()) {
    const id = `todo:${index}`;
    nodes.push({ id, type: "plan", label: String(todo.content || todo.title || `步骤 ${index + 1}`), status: String(todo.status || "pending") });
    edges.push({ from: `session:${session.id}`, to: id, relation: "plans" });
  }
  return {
    kind: "derived-session-map",
    authoritativeDependencies: false,
    description: "Derived from Worker-visible messages, tools, plans, and child sessions.",
    nodes,
    edges,
  };
}

/**
 * Merge cursor pages without changing the existing record/projector shapes.
 * Pages must be supplied oldest-to-newest, or set pageOrder to newest-first
 * when appending pages in the order returned by a backwards cursor walk.
 */
export function mergeProjectionRecordPages(pages = [], options = {}) {
  const orderedPages = options.pageOrder === "newest-first" ? [...pages].reverse() : pages;
  const records = [];
  const seen = new Set();
  for (const page of orderedPages) {
    for (const record of Array.isArray(page) ? page : (page?.records || [])) {
      const id = String(record?.info?.id || "");
      if (id && seen.has(id)) continue;
      if (id) seen.add(id);
      records.push(record);
    }
  }
  return records;
}

/**
 * Build a projection across all pages fetched by the caller. coverage.complete
 * prevents a bounded window from being presented as a full-session aggregate;
 * priorTurnCount keeps turn ordinals stable for deliberately partial windows.
 */
export function projectSessionPages(session, pages, options = {}) {
  const records = mergeProjectionRecordPages(pages, { pageOrder: options.pageOrder });
  const children = options.children || [];
  const todos = options.todos || [];
  const priorTurnCount = nonNegativeInteger(options.priorTurnCount);
  return {
    messages: records.map((record) => projectMessage(record, { runtimeSettled: options.sessionState === null })),
    outline: projectOutline(records, { priorTurnCount }),
    activity: projectActivity(records, children, options),
    trajectory: projectTrajectory(records, children, options),
    childTree: projectChildTree(children),
    stats: projectStats(records, children),
    context: contextReceipt(session, records, options.context),
    graph: workGraph(session, records, children, todos, { sessionState: options.sessionState }),
    coverage: {
      complete: options.complete === true,
      recordCount: records.length,
      priorTurnCount,
      nextCursor: options.nextCursor || null,
    },
  };
}
