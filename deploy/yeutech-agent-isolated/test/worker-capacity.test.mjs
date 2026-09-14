import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createAgentBff } from "../src/agent-bff.mjs";

const SECRET = "capacity-secret-0123456789abcdef012345";
const PASSWORD = "capacity-password-0123456789";
const TOKEN = "capacity-system-token-0123456789abcdef";

async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

async function close(server) {
  await new Promise((resolve) => server.close(resolve));
}

async function fixture(t, capacityHandler) {
  const root = await mkdtemp(path.join(os.tmpdir(), "worker-capacity-"));
  const config = path.join(root, "opencode.json");
  await writeFile(config, JSON.stringify({ provider: { yeutech: { models: { ready: {} } } } }));
  const worker = http.createServer((request, response) => {
    const incoming = new URL(request.url, "http://127.0.0.1");
    if (incoming.pathname === "/session/status") return capacityHandler(request, response);
    response.writeHead(404).end();
  });
  const catalog = http.createServer((_request, response) => response.writeHead(200, { "content-type": "application/json" }).end('{"data":[{"id":"ready","context_length":128000,"max_input_tokens":120000,"max_output_tokens":8000,"supported_input_modalities":["text"],"supported_output_modalities":["text"]}]}'));
  const workerURL = await listen(worker);
  const catalogURL = await listen(catalog);
  const bff = createAgentBff({
    identitySecret: SECRET,
    users: [],
    upstreamURL: workerURL,
    upstreamUsername: "agent",
    upstreamPassword: PASSWORD,
    modelCatalogURL: catalogURL,
    modelCatalogToken: "token",
    modelConfigPath: config,
    systemToken: TOKEN,
    systemWorkspace: "/projects/system",
    systemDatabasePath: path.join(root, "tasks.sqlite"),
    capacityRequestTimeoutMs: 40,
  });
  const baseURL = await listen(bff);
  t.after(async () => { await close(bff); await close(worker); await close(catalog); await rm(root, { recursive: true }); });
  return async () => {
    const response = await fetch(`${baseURL}/api/system/tasks`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ sessionKey: "capacity", modelId: "ready", prompt: "test" }),
    });
    return { status: response.status, body: await response.json() };
  };
}

test("types a hanging capacity response body as a timeout", async (t) => {
  const submit = await fixture(t, (_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.flushHeaders();
  });
  const result = await submit();
  assert.equal(result.status, 504);
  assert.deepEqual({ code: result.body.error.code, scope: result.body.error.scope, retryable: result.body.error.retryable, recoveryAction: result.body.error.recoveryAction }, { code: "worker_capacity_timeout", scope: "worker-capacity", retryable: true, recoveryAction: "retry" });
});

test("types non-success and invalid capacity responses", async (t) => {
  await t.test("non-success", async (t) => {
    const submit = await fixture(t, (_request, response) => response.writeHead(503).end("busy"));
    const result = await submit();
    assert.equal(result.status, 503);
    assert.equal(result.body.error.code, "worker_capacity_response");
  });
  await t.test("invalid JSON", async (t) => {
    const submit = await fixture(t, (_request, response) => response.writeHead(200, { "content-type": "application/json" }).end("not-json"));
    const result = await submit();
    assert.equal(result.status, 502);
    assert.equal(result.body.error.code, "worker_capacity_response");
  });
  await t.test("transport failure", async (t) => {
    const submit = await fixture(t, (request) => request.socket.destroy());
    const result = await submit();
    assert.equal(result.status, 502);
    assert.equal(result.body.error.code, "worker_capacity_transport");
    assert.equal(result.body.error.scope, "worker-capacity");
  });
});
