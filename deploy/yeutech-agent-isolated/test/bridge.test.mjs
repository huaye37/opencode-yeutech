import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import http from "node:http";
import test from "node:test";
import { createGatewayBridge } from "../src/nas-gateway-bridge.mjs";

const TOKEN = "0123456789abcdef0123456789abcdef";

function fakeChild(responseChunks) {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killed = false;
  child.kill = () => { child.killed = true; };
  queueMicrotask(() => {
    for (const chunk of responseChunks) child.stdout.write(chunk);
    child.stdout.end();
    child.emit("close", 0);
  });
  return child;
}

async function withServer(run, options = {}) {
  const server = createGatewayBridge({ token: TOKEN, ...options });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("rejects anonymous access before spawning SSH", async () => {
  let spawned = false;
  await withServer(async (baseURL) => {
    const response = await fetch(`${baseURL}/v1/models`);
    assert.equal(response.status, 401);
    assert.equal(spawned, false);
  }, { spawnRequest: () => { spawned = true; } });
});

test("rejects routes outside the allowlist", async () => {
  await withServer(async (baseURL) => {
    const response = await fetch(`${baseURL}/v1/files`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(response.status, 404);
  });
});

test("streams an allowed upstream response", async () => {
  await withServer(async (baseURL) => {
    const response = await fetch(`${baseURL}/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-5.6-sol", stream: true, messages: [] }),
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "text/event-stream");
    assert.equal(await response.text(), "data: first\n\ndata: [DONE]\n\n");
  }, {
    spawnRequest: () => fakeChild([
      "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\n\r\n",
      "data: first\n\n",
      "data: [DONE]\n\n",
    ]),
  });
});

test("forwards to a loopback CLIProxyAPI without exposing its key in curl arguments", async () => {
  let authorization = "";
  let receivedBody = "";
  const upstream = await new Promise((resolve) => {
    const server = http.createServer(async (request, response) => {
      authorization = request.headers.authorization ?? "";
      for await (const chunk of request) receivedBody += chunk;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true }));
    });
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
  try {
    await withServer(async (baseURL) => {
      const response = await fetch(`${baseURL}/v1/chat/completions`, {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ model: "test-model", messages: [] }),
      });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { ok: true });
    }, {
      upstreamBaseURL: `http://127.0.0.1:${upstream.address().port}/v1`,
      upstreamToken: "local-upstream-secret",
    });
    assert.equal(authorization, "Bearer local-upstream-secret");
    assert.equal(JSON.parse(receivedBody).model, "test-model");
  } finally {
    await new Promise((resolve) => upstream.close(resolve));
  }
});

test("enforces request body limit", async () => {
  await withServer(async (baseURL) => {
    const response = await fetch(`${baseURL}/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ value: "too large" }),
    });
    assert.equal(response.status, 413);
  }, { bodyLimit: 4 });
});
