import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { createAgentBff } from "../src/agent-bff.mjs";

const TOKEN = "abcdef0123456789abcdef0123456789";
const PASSWORD = "opencode-test-password-0123456789";
const WORKSPACE = "/bounded/sample-workspace";

async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

async function close(server) {
  await new Promise((resolve) => server.close(resolve));
}

async function withBff(upstreamHandler, run, options = {}) {
  const upstream = http.createServer(upstreamHandler);
  const upstreamURL = await listen(upstream);
  const bff = createAgentBff({
    token: TOKEN,
    workspace: WORKSPACE,
    upstreamURL,
    upstreamUsername: "yeutech-agent",
    upstreamPassword: PASSWORD,
    ...options,
  });
  const baseURL = await listen(bff);
  try {
    await run(baseURL);
  } finally {
    await close(bff);
    await close(upstream);
  }
}

test("rejects anonymous requests before reaching OpenCode", async () => {
  let hits = 0;
  await withBff(() => { hits += 1; }, async (baseURL) => {
    const response = await fetch(`${baseURL}/session`);
    assert.equal(response.status, 401);
    assert.equal(hits, 0);
  });
});

test("blocks OpenCode shell routes", async () => {
  let hits = 0;
  await withBff(() => { hits += 1; }, async (baseURL) => {
    const response = await fetch(`${baseURL}/session/ses_abc123/shell`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(response.status, 404);
    assert.equal(hits, 0);
  });
});

test("replaces caller directory and injects OpenCode Basic auth", async () => {
  await withBff((request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    assert.equal(url.searchParams.get("directory"), WORKSPACE);
    assert.equal(url.searchParams.has("workspace"), false);
    assert.equal(url.searchParams.has("path"), false);
    assert.equal(request.headers.authorization, `Basic ${Buffer.from(`yeutech-agent:${PASSWORD}`).toString("base64")}`);
    response.writeHead(200, { "content-type": "application/json" });
    response.end("[]");
  }, async (baseURL) => {
    const response = await fetch(`${baseURL}/session?directory=/tmp/escape&workspace=bad&path=/`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), []);
  });
});

test("streams OpenCode SSE responses", async () => {
  await withBff((_request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write("data: first\n\n");
    response.end("data: second\n\n");
  }, async (baseURL) => {
    const response = await fetch(`${baseURL}/event`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(response.headers.get("content-type"), "text/event-stream");
    assert.equal(await response.text(), "data: first\n\ndata: second\n\n");
  });
});

test("enforces the BFF request body limit", async () => {
  await withBff(() => {}, async (baseURL) => {
    const response = await fetch(`${baseURL}/session`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ title: "too large" }),
    });
    assert.equal(response.status, 413);
  }, { bodyLimit: 4 });
});

test("rejects incomplete upstream credentials at startup", () => {
  assert.throws(() => createAgentBff({
    token: TOKEN,
    workspace: WORKSPACE,
    upstreamURL: "http://127.0.0.1:18130",
    upstreamUsername: "yeutech-agent",
    upstreamPassword: "short",
  }), /password must contain at least 24 characters/);
});
