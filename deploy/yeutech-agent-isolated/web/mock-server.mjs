import http from "node:http";

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

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

const server = http.createServer(async (request, response) => {
  response.setHeader("content-type", "application/json");
  const incoming = new URL(request.url, "http://127.0.0.1");
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
    response.end("{}");
    return;
  }
  if (request.method === "GET" && incoming.pathname === "/config/providers") {
    response.end(JSON.stringify({
      providers: [{
        id: "yeutech",
        models: { "claude-haiku-4-5-20251001": { id: "claude-haiku-4-5-20251001", name: "Claude Haiku 4.5" } },
      }],
    }));
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
    response.writeHead(204);
    response.end();
    return;
  }
  if (request.method === "POST" && request.url.includes("/abort")) {
    response.end("true");
    return;
  }
  response.writeHead(404);
  response.end(JSON.stringify({ error: "Not found" }));
});

server.listen(18141, "127.0.0.1", () => process.stdout.write(`Mock Agent API listening on 127.0.0.1:18141 (${messageCount} messages)\n`));
