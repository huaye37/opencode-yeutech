import http from "node:http";

const sessions = [{ id: "ses_demo", title: "修复登录状态" }];

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

const server = http.createServer(async (request, response) => {
  response.setHeader("content-type", "application/json");
  if (request.method === "GET" && request.url.startsWith("/session")) {
    response.end(JSON.stringify(sessions));
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

server.listen(18141, "127.0.0.1", () => process.stdout.write("Mock Agent API listening on 127.0.0.1:18141\n"));
