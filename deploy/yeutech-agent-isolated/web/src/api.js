const base = "/api/agent";

async function request(path, options) {
  const response = await fetch(`${base}${path}`, options);
  if (!response.ok) throw new Error((await response.text()) || `HTTP ${response.status}`);
  if (response.status === 204) return null;
  return response.json();
}

async function requestMessages(sessionID, before) {
  const query = new URLSearchParams({ limit: "200" });
  if (before) query.set("before", before);
  const response = await fetch(`${base}/session/${sessionID}/message?${query}`);
  if (!response.ok) throw new Error((await response.text()) || `HTTP ${response.status}`);
  return { records: await response.json(), cursor: response.headers.get("x-next-cursor") };
}

export const agentApi = {
  sessions: () => request("/session"),
  messages: requestMessages,
  providers: () => request("/config/providers"),
  status: () => request("/session/status"),
  createSession: (title) => request("/session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title }),
  }),
  prompt: (sessionID, text, modelID) => request(`/session/${sessionID}/prompt_async`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: { providerID: "yeutech", modelID }, tools: {}, parts: [{ type: "text", text }] }),
  }),
  abort: (sessionID) => request(`/session/${sessionID}/abort`, { method: "POST" }),
};
