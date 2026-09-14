const base = "/api/agent";
const migrationBase = "/api/migration";
const PASSIVE_REQUEST_TIMEOUT_MS = 10_000;

async function fetchWithTimeout(url, options = {}, timeoutMs = PASSIVE_REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const externalSignal = options.signal;
  const abort = () => controller.abort(externalSignal?.reason);
  if (externalSignal?.aborted) abort();
  else externalSignal?.addEventListener("abort", abort, { once: true });
  const timer = window.setTimeout(() => controller.abort(new DOMException("请求超时", "TimeoutError")), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (cause) {
    if (controller.signal.aborted && !externalSignal?.aborted) {
      throw Object.assign(new Error("读取超时，可稍后刷新重试。"), { code: "request_timeout", retryable: true });
    }
    throw cause;
  } finally {
    window.clearTimeout(timer);
    externalSignal?.removeEventListener("abort", abort);
  }
}

async function apiError(response) {
  const payload = await response.json().catch(() => null);
  const error = new Error(payload?.error?.message || `HTTP ${response.status}`);
  error.code = payload?.error?.code || "http_error";
  error.retryable = Boolean(payload?.error?.retryable);
  error.scope = payload?.error?.scope || "request";
  error.recoveryAction = payload?.error?.recoveryAction || null;
  return error;
}

async function request(path, options, remainingWorkerRetries = 60) {
  const response = await fetch(`${base}${path}`, options);
  const retryAfter = Number(response.headers.get("retry-after"));
  if (response.status === 503 && Number.isFinite(retryAfter) && retryAfter > 0 && remainingWorkerRetries > 0) {
    // A cold worker has not received this request yet. Retrying the same body is
    // therefore safe and preserves a prompt already cleared from the composer.
    await new Promise((resolve) => window.setTimeout(resolve, Math.min(retryAfter, 5) * 1_000));
    return request(path, options, remainingWorkerRetries - 1);
  }
  if (!response.ok) throw await apiError(response);
  if (response.status === 204) return null;
  return response.json();
}

async function requestMessages(sessionID, before) {
  const query = new URLSearchParams({ limit: "10" });
  if (before) query.set("before", before);
  const response = await fetch(`${base}/session/${sessionID}/message?${query}`);
  if (!response.ok) throw await apiError(response);
  return { records: await response.json(), cursor: response.headers.get("x-next-cursor") };
}

export const agentApi = {
  models: () => fetch("/api/models").then(async (response) => {
    if (!response.ok) throw await apiError(response);
    return response.json();
  }),
  sessions: () => request("/session"),
  messages: requestMessages,
  providers: () => request("/config/providers"),
  status: () => request("/session/status"),
  permissions: () => request("/permission"),
  replyPermission: (requestID, reply) => request(`/permission/${requestID}/reply`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ reply }),
  }),
  events: () => new EventSource(`${base}/event`),
  createSession: (title) => request("/session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title }),
  }),
  prompt: (sessionID, text, modelID, attachments = [], context = {}) => request(`/session/${sessionID}/prompt_async`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: { providerID: "yeutech", modelID },
      yeutech: {
        workload: context.workload || "general-agent",
        project: context.project || null,
        paths: attachments.map((item) => item.path).filter(Boolean),
      },
      tools: {},
      parts: [{
        type: "text",
        text: attachments.length
          ? `${text.trim() || "请读取并处理已附加的文件。"}\n\n[已附加工作区文件]\n${attachments.map((item) => `- ${item.workspacePath || item.path}`).join("\n")}\n请仅在当前授权工作区内读取这些相对路径。`
          : text,
      }],
    }),
  }),
  abort: (sessionID) => request(`/session/${sessionID}/abort`, { method: "POST" }),
  summarize: (sessionID) => request(`/session/${sessionID}/summarize`, { method: "POST" }),
};

async function workbenchRequest(path, options) {
  const readOnly = !options?.method || options.method === "GET";
  const response = await (readOnly ? fetchWithTimeout(`/api/workbench${path}`, options) : fetch(`/api/workbench${path}`, options));
  if (!response.ok) throw await apiError(response);
  return response.status === 204 ? null : response.json();
}

function fileSpaceQuery(space, extra = {}) {
  const source = space?.session ? { session: space.session } : { project: space?.project };
  return new URLSearchParams({ ...source, ...extra });
}

function uploadFile(space, file, options = {}) {
  const query = fileSpaceQuery(space, options.directory === undefined ? {} : { directory: options.directory });
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open("POST", `/api/workbench/attachments?${query}`);
    request.responseType = "json";
    request.setRequestHeader("x-yeutech-filename", encodeURIComponent(file.name));
    request.setRequestHeader("content-type", file.type || "application/octet-stream");
    let lastProgressAt = 0;
    request.upload.onprogress = (event) => {
      const now = performance.now();
      if (now - lastProgressAt < 100 && event.loaded < file.size) return;
      lastProgressAt = now;
      options.onProgress?.(event.loaded, event.lengthComputable ? event.total : file.size);
    };
    request.onerror = () => reject(new Error("上传连接中断，可以重试。"));
    request.onabort = () => reject(Object.assign(new Error("已取消上传。"), { name: "AbortError" }));
    request.onload = () => {
      const payload = request.response;
      if (request.status < 200 || request.status >= 300) {
        reject(Object.assign(new Error(payload?.error?.message || `HTTP ${request.status}`), {
          code: payload?.error?.code || "http_error",
          retryable: Boolean(payload?.error?.retryable),
        }));
        return;
      }
      options.onProgress?.(file.size, file.size);
      resolve(payload.data);
    };
    if (options.signal) {
      if (options.signal.aborted) { request.abort(); return; }
      options.signal.addEventListener("abort", () => request.abort(), { once: true });
    }
    request.send(file);
  });
}

export const workbenchApi = {
  bootstrap: () => workbenchRequest("/bootstrap"),
  profiles: () => workbenchRequest("/profiles"),
  skills: () => workbenchRequest("/skills"),
  control: (workload = "general-agent") => workbenchRequest(`/control?workload=${encodeURIComponent(workload)}`),
  projects: () => workbenchRequest("/projects"),
  createProject: (name) => workbenchRequest("/projects", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name }) }),
  registerProject: (name) => workbenchRequest("/projects/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name }) }),
  renameProject: (projectID, name) => workbenchRequest(`/projects/${encodeURIComponent(projectID)}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ name }) }),
  removeProject: (projectID) => workbenchRequest(`/projects/${encodeURIComponent(projectID)}`, { method: "DELETE" }),
  createProjectSession: (project, title = "新会话") => workbenchRequest("/project-sessions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ project, title }) }),
  renameSession: (sessionID, title) => workbenchRequest(`/sessions/${encodeURIComponent(sessionID)}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ title }) }),
  deleteSession: (sessionID) => workbenchRequest(`/sessions/${encodeURIComponent(sessionID)}`, { method: "DELETE" }),
  forkSession: (sessionID, messageId) => workbenchRequest(`/sessions/${encodeURIComponent(sessionID)}/fork`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(messageId ? { messageId } : {}) }),
  diff: (sessionID, messageId) => workbenchRequest(`/sessions/${encodeURIComponent(sessionID)}/diff${messageId ? `?messageId=${encodeURIComponent(messageId)}` : ""}`),
  goals: (scope = "workspace") => workbenchRequest(`/goals?scope=${encodeURIComponent(scope)}`),
  createGoal: (payload) => workbenchRequest("/goals", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) }),
  updateGoal: (goalID, payload) => workbenchRequest(`/goals/${goalID}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) }),
  createContextPack: (payload) => workbenchRequest("/context-packs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) }),
  compareReplay: (baseline, candidate) => workbenchRequest("/replays", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ baseline, candidate }) }),
  executeReplay: (sessionId, modelId, workload = "general-agent") => workbenchRequest("/replays/execute", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionId, modelId, workload }) }),
  replay: (replayID) => workbenchRequest(`/replays/${replayID}`),
  messages: (sessionID, before) => workbenchRequest(`/sessions/${sessionID}/messages?${new URLSearchParams({ limit: "10", ...(before ? { before } : {}) })}`),
  snapshot: (sessionID, workload = "general-agent") => workbenchRequest(`/sessions/${sessionID}/snapshot?workload=${encodeURIComponent(workload)}`),
  outline: (sessionID) => workbenchRequest(`/sessions/${sessionID}/outline`),
  activity: (sessionID) => workbenchRequest(`/sessions/${sessionID}/activity`),
  trajectory: (sessionID) => workbenchRequest(`/sessions/${sessionID}/trajectory`),
  children: (sessionID) => workbenchRequest(`/sessions/${sessionID}/children`),
  stats: (sessionID) => workbenchRequest(`/sessions/${sessionID}/stats`),
  context: (sessionID, workload = "general-agent") => workbenchRequest(`/sessions/${sessionID}/context?workload=${encodeURIComponent(workload)}`),
  graph: (sessionID) => workbenchRequest(`/sessions/${sessionID}/graph`),
  events: (sessionID, cursor = 0, workload = "general-agent") => new EventSource(`/api/workbench/sessions/${sessionID}/events?${new URLSearchParams({ cursor: String(cursor || 0), workload })}`),
  toolResult: (reference) => fetch(reference).then(async (response) => { if (!response.ok) throw await apiError(response); return (await response.json()).data; }),
  files: async (space, directory = "", showHidden = false) => (await workbenchRequest(`/files?${fileSpaceQuery(space, { path: directory, showHidden: showHidden ? "1" : "0" })}`)).data,
  fileUrl: (space, filePath, download = false, showHidden = false) => `/api/workbench/file?${fileSpaceQuery(space, { path: filePath, download: download ? "1" : "0", showHidden: showHidden ? "1" : "0" })}`,
  file: async (space, filePath, showHidden = false) => {
    const response = await fetch(`/api/workbench/file?${fileSpaceQuery(space, { path: filePath, showHidden: showHidden ? "1" : "0" })}`);
    if (!response.ok) throw await apiError(response);
    return {
      blob: await response.blob(),
      type: response.headers.get("content-type") || "application/octet-stream",
      originalType: response.headers.get("x-yeutech-original-content-type") || response.headers.get("content-type") || "application/octet-stream",
      previewKind: response.headers.get("x-yeutech-preview-kind") || null,
    };
  },
  uploadAttachment: (space, file, options = {}) => uploadFile(space, file, options),
  uploadProjectFile: (space, directory, file, options = {}) => uploadFile(space, file, { ...options, directory }),
  deleteAttachment: async (space, filePath) => (await workbenchRequest(`/attachments?${fileSpaceQuery(space, { path: filePath })}`, { method: "DELETE" })).data,
};

async function migrationRequest(path, options) {
  const readOnly = !options?.method || options.method === "GET";
  const response = await (readOnly ? fetchWithTimeout(`${migrationBase}${path}`, options) : fetch(`${migrationBase}${path}`, options));
  if (!response.ok) {
    const payload = await response.json().catch(() => null);
    throw new Error(payload?.error?.message || `历史数据服务 HTTP ${response.status}`);
  }
  return response.status === 204 ? null : response.json();
}

export const migrationApi = {
  projects: () => migrationRequest("/projects"),
  conversations: () => migrationRequest("/conversations"),
  messages: async (conversationID, before) => {
    const query = new URLSearchParams({ limit: "10" });
    if (before) query.set("before", before);
    const response = await fetchWithTimeout(`${migrationBase}/conversations/${encodeURIComponent(conversationID)}/messages?${query}`);
    if (!response.ok) throw new Error((await response.text()) || `历史数据服务 HTTP ${response.status}`);
    return { records: await response.json(), cursor: response.headers.get("x-next-cursor") };
  },
  continue: (conversationID) => migrationRequest(`/conversations/${encodeURIComponent(conversationID)}/continue`, { method: "POST" }),
  rename: (conversationID, title) => migrationRequest(`/conversations/${encodeURIComponent(conversationID)}/metadata`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ title }) }),
  detach: (conversationID) => migrationRequest(`/conversations/${encodeURIComponent(conversationID)}/mapping`, { method: "DELETE" }),
};
