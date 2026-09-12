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
  createSession: (title) => request("/session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title, model: { providerID: "yeutech", id: "gpt-5.6-sol" } }),
  }),
  prompt: (sessionID, text) => request(`/session/${sessionID}/prompt_async`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: { providerID: "yeutech", modelID: "gpt-5.6-sol" },
      tools: {},
      parts: [{ type: "text", text }],
    }),
  }),
  abort: (sessionID) => request(`/session/${sessionID}/abort`, { method: "POST" }),
};
