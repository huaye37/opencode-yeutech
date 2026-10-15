export const SELECTED_STORAGE_KEY = "yeutech-agent-workbench:selected:v2";
export const SIDEBAR_WIDTH_STORAGE_KEY = "yeutech-agent-workbench:sidebar-width:v1";
export const FILE_PANEL_WIDTH_STORAGE_KEY = "yeutech-agent-workbench:file-panel-width:v1";
export const FILE_PANEL_STATE_STORAGE_KEY = "yeutech-agent-workbench:file-panel-state:v1";
export const STANDALONE_EXPANDED_STORAGE_KEY = "yeutech-agent-workbench:standalone-expanded:v1";
export const PERMISSION_MODE_STORAGE_KEY = "yeutech-agent-workbench:permission-mode:v1";
export const SIDEBAR_MIN_WIDTH = 220;
export const SIDEBAR_MAX_WIDTH = 420;
export const FILE_PANEL_MIN_WIDTH = 360;
export const CONVERSATION_MIN_WIDTH = 620;
export function clamp(value, min, max) {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

export function storedWidth(key, fallback, min, max) {
  try {
    const value = Number(window.localStorage.getItem(key));
    return Number.isFinite(value) && value > 0 ? clamp(value, min, max) : fallback;
  } catch { return fallback; }
}

export function storeWidth(key, value) {
  try { window.localStorage.setItem(key, String(Math.round(value))); }
  catch { /* Panel width persistence is optional. */ }
}

export function storedBoolean(key, fallback) {
  try {
    const value = window.localStorage.getItem(key);
    return value === null ? fallback : value === "true";
  } catch { return fallback; }
}

export function storedFilePanelState(sessionId) {
  try {
    const value = JSON.parse(window.localStorage.getItem(FILE_PANEL_STATE_STORAGE_KEY) || "null");
    if (!value?.open || value.sessionId !== sessionId) return { open: false, projectId: "", path: "" };
    return { open: true, projectId: String(value.projectId || ""), path: String(value.path || "") };
  } catch { return { open: false, projectId: "", path: "" }; }
}

export function storeFilePanelState(value) {
  try { window.localStorage.setItem(FILE_PANEL_STATE_STORAGE_KEY, JSON.stringify(value)); }
  catch { /* File-panel restoration is optional. */ }
}

export function storedProjectionCursor(key) {
  try { return Math.max(0, Number(window.localStorage.getItem(key)) || 0); }
  catch { return 0; }
}

export function storeProjectionCursor(key, value) {
  const cursor = Number(value);
  if (!Number.isSafeInteger(cursor) || cursor < 0) return;
  try { window.localStorage.setItem(key, String(cursor)); }
  catch { /* Durable replay also works from cursor zero when storage is unavailable. */ }
}

export function timestampPermissions(incoming, current = []) {
  const prior = new Map(current.map((request) => [request.id, request.createdAt]));
  const now = Date.now();
  return (incoming || []).map((request, index) => ({ ...request, createdAt: prior.get(request.id) || request.createdAt || request.time?.created || now + index }));
}

export function isImmediateProjectionEvent(payload) {
  const type = String(payload?.type || "");
  const state = payload?.properties?.status?.type || payload?.properties?.status || payload?.properties?.state?.type;
  return type === "session.idle" || type === "session.completed" || type === "session.error"
    || (type === "session.status" && new Set(["idle", "completed", "error"]).has(state))
    || (type === "message.updated" && Boolean(payload?.properties?.info?.time?.completed));
}

export function isSettledSessionEvent(payload) {
  const type = String(payload?.type || "");
  const state = payload?.properties?.status?.type || payload?.properties?.status || payload?.properties?.state?.type;
  return type === "session.idle" || type === "session.completed" || type === "session.error"
    || (type === "session.status" && new Set(["idle", "completed", "error"]).has(state));
}

export function runtimeEventError(payload) {
  if (String(payload?.type || "") !== "session.error") return null;
  const source = payload?.properties?.error || payload?.properties || {};
  const message = source?.data?.message || source?.message || "Agent 执行失败";
  if (/content exists risk/i.test(message)) return "当前模型不能处理这段会话内容。模型原始返回：Content Exists Risk（内容风险）。这表示该模型拒绝了当前上下文，可以更换模型，或新建会话、整理长对话后重试。";
  return message;
}

export function ephemeralTool(part, messageID, previous) {
  const source = part?.state?.error ?? part?.error;
  const error = !source ? null : typeof source === "string"
    ? { code: "tool_error", message: source.slice(0, 1_000) }
    : {
        code: String(source?.data?.code || source?.code || source?.name || "tool_error").slice(0, 120),
        message: String(source?.data?.message || source?.message || "工具执行失败").slice(0, 1_000),
      };
  const value = part?.state?.output ?? part?.output ?? part?.result;
  const serialized = value === undefined ? "" : typeof value === "string" ? value : JSON.stringify(value);
  const input = part?.state?.input ?? part?.input;
  const serializedInput = input === undefined ? "" : typeof input === "string" ? input : JSON.stringify(input, null, 2);
  return {
    ...previous,
    id: `tool:${messageID}:${part.id || "live"}`,
    type: "tool",
    tool: String(part.tool || part.name || "tool"),
    title: String(part?.state?.title || previous?.title || ""),
    status: String(part?.state?.status || "unknown"),
    at: Number(part?.time?.start || previous?.at || Date.now()),
    input: serializedInput.length <= 4_000 && input && typeof input === "object" ? input : previous?.input || null,
    inputPreview: serializedInput ? serializedInput.slice(0, 4_000) : previous?.inputPreview || "",
    inputTruncated: serializedInput ? serializedInput.length > 4_000 : Boolean(previous?.inputTruncated),
    result: serialized ? { inline: serialized.slice(0, 400), length: serialized.length, truncated: serialized.length > 400 } : null,
    error,
  };
}

export function isHistoricalConversation(id) {
  return String(id || "").startsWith("portal:") || String(id || "").startsWith("imported:");
}

export function storedSelectionContext() {
  try {
    const value = window.localStorage.getItem(SELECTED_STORAGE_KEY) || "";
    if (!value) return { scope: "", projectId: "", sessionId: "" };
    if (!value.startsWith("{")) return { scope: "session", projectId: "", sessionId: value };
    const parsed = JSON.parse(value);
    return {
      scope: parsed?.scope === "project" ? "project" : "session",
      projectId: String(parsed?.projectId || ""),
      sessionId: String(parsed?.sessionId || ""),
    };
  } catch { return { scope: "", projectId: "", sessionId: "" }; }
}

export function storedSelection() {
  return storedSelectionContext().sessionId;
}

export function storeSelection(value) {
  try { window.localStorage.setItem(SELECTED_STORAGE_KEY, JSON.stringify(value)); }
  catch { /* Selection persistence is optional. */ }
}

export function isDirectAttachment(value) {
  const normalized = String(value || "").replaceAll("\\", "/");
  return normalized.startsWith("附件/") && !normalized.slice("附件/".length).includes("/");
}

export function attachmentIdentity(item) {
  return `${item?.ownerSessionID || ""}:${item?.workspacePath || `${fileSpaceKey(item?.space)}:${item?.path || ""}`}`;
}

export function attachmentFileIdentity(item) {
  return item?.workspacePath || `${fileSpaceKey(item?.space)}:${item?.path || ""}`;
}

export function sessionFileScope(session) {
  return session?.fileScope || session?.id;
}

export function fileSpaceFor(session, project) {
  return project
    ? { project: project.workspaceDirectory || project.name, label: project.name }
    : { session: sessionFileScope(session), label: "独立会话文件" };
}

export function fileSpaceKey(space) {
  return space?.session ? "standalone" : `project:${space?.project || ""}`;
}

export function workspacePathFor(space, filePath) {
  return space?.project ? `${space.project}/${filePath}` : `独立会话/${filePath}`;
}

export function readableStatus(state) {
  if (!state) return "";
  const code = state.error?.code || state.code;
  if (code === "auth_unavailable") return "CLIProxyAPI 已连通，但当前模型账号授权已失效。";
  return state.message || "Agent 正在执行";
}

