const base = "/api/agent";

async function request(path, options) {
  const response = await fetch(`${base}${path}`, options);
  if (!response.ok) throw new Error((await response.text()) || `HTTP ${response.status}`);
  if (response.status === 204) return null;
  return response.json();
}

export const agentApi = {
  sessions: () => request("/session"),
  messages: (sessionID) => request(`/session/${sessionID}/message`),
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
