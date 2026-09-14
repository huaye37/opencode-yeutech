import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createAgentBff } from "../src/agent-bff.mjs";
import { createSystemTaskStore } from "../src/system-task-store.mjs";

const SECRET = "recovery-secret-0123456789abcdef012345";
const PASSWORD = "recovery-password-0123456789";
const TOKEN = "recovery-system-token-0123456789abcdef";

async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

async function close(server) {
  await new Promise((resolve) => server.close(resolve));
}

test("recovers an interrupted submitting task after BFF restart and releases capacity", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "system-task-recovery-"));
  const databasePath = path.join(root, "tasks.sqlite");
  const modelConfigPath = path.join(root, "opencode.json");
  await writeFile(modelConfigPath, JSON.stringify({ provider: { yeutech: { models: { ready: {} } } } }));
  const store = createSystemTaskStore(databasePath);
  store.saveSession("crashed", "ses_crashed");
  const crashed = store.reserve({
    id: "task_11111111111111111111111111111111",
    idempotencyKey: "crashed",
    sessionKey: "crashed",
    runtimeSessionID: "ses_crashed",
    kind: "grading",
    modelID: "ready",
    prompt: "old",
    promptMessageID: "msg_crashed",
    status: "submitting",
  }, 1).task;
  store.close();
  let sessions = 0;
  const worker = http.createServer(async (request, response) => {
    const incoming = new URL(request.url, "http://127.0.0.1");
    if (request.method === "GET" && incoming.pathname === "/session/status") return response.writeHead(200, { "content-type": "application/json" }).end("{}");
    if (request.method === "GET" && incoming.pathname.endsWith("/message")) return response.writeHead(200, { "content-type": "application/json" }).end("[]");
    if (request.method === "POST" && incoming.pathname === "/session") {
      sessions += 1;
      return response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ id: `ses_new${sessions}` }));
    }
    if (request.method === "POST" && incoming.pathname.endsWith("/prompt_async")) return response.writeHead(204).end();
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
    modelConfigPath,
    systemToken: TOKEN,
    systemWorkspace: "/projects/system",
    systemDatabasePath: databasePath,
    maxConcurrentPerWorker: 1,
    submissionRecoveryGraceMs: 0,
  });
  const baseURL = await listen(bff);
  const headers = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };
  try {
    const recovered = await fetch(`${baseURL}/api/system/tasks/${crashed.id}`, { headers }).then((response) => response.json());
    assert.equal(recovered.status, "failed");
    assert.equal(recovered.errorCode, "system_task_submission_interrupted");
    assert.match(recovered.error, /submission was interrupted/);
    const next = await fetch(`${baseURL}/api/system/tasks`, {
      method: "POST",
      headers,
      body: JSON.stringify({ sessionKey: "next", modelId: "ready", prompt: "continue", idempotencyKey: "next" }),
    });
    assert.equal(next.status, 202);
    const nextTask = await next.json();
    assert.equal(nextTask.status, "running");
    const lost = await fetch(`${baseURL}/api/system/tasks/${nextTask.id}`, { headers }).then((response) => response.json());
    assert.equal(lost.status, "failed");
    assert.equal(lost.errorCode, "system_task_runtime_lost");
    assert.match(lost.error, /runtime state was lost/);
    const afterLost = await fetch(`${baseURL}/api/system/tasks`, {
      method: "POST",
      headers,
      body: JSON.stringify({ sessionKey: "after-lost", modelId: "ready", prompt: "continue again", idempotencyKey: "after-lost" }),
    });
    assert.equal(afterLost.status, 202);
  } finally {
    await close(bff);
    await close(worker);
    await close(catalog);
    await rm(root, { recursive: true });
  }
});

test("an in-flight result read cannot complete an older attempt after resume", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "system-task-result-race-"));
  const databasePath = path.join(root, "tasks.sqlite");
  const modelConfigPath = path.join(root, "opencode.json");
  await writeFile(modelConfigPath, JSON.stringify({ provider: { yeutech: { models: { ready: {} } } } }));
  const store = createSystemTaskStore(databasePath);
  store.saveSession("race", "ses_race");
  const task = store.reserve({
    id: "task_22222222222222222222222222222222",
    idempotencyKey: "race",
    sessionKey: "race",
    runtimeSessionID: "ses_race",
    kind: "grading",
    modelID: "ready",
    prompt: "old",
    promptMessageID: "msg_old",
    status: "submitting",
  }, 1).task;
  store.updateAttemptStatus(task.id, "msg_old", "running");
  store.close();
  let statusReads = 0;
  let releaseOldStatus;
  let oldStatusStarted;
  const oldStatusGate = new Promise((resolve) => { oldStatusStarted = resolve; });
  const worker = http.createServer(async (request, response) => {
    const incoming = new URL(request.url, "http://127.0.0.1");
    if (request.method === "GET" && incoming.pathname === "/session/status") {
      statusReads += 1;
      if (statusReads === 1) {
        oldStatusStarted();
        await new Promise((resolve) => { releaseOldStatus = resolve; });
      }
      return response.writeHead(200, { "content-type": "application/json" }).end("{}");
    }
    if (request.method === "GET" && incoming.pathname.endsWith("/message")) {
      return response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify([{ info: { id: "msg_answer_old", role: "assistant", parentID: "msg_old", time: { completed: 1 } }, parts: [{ type: "text", text: "old answer" }] }]));
    }
    if (request.method === "POST" && incoming.pathname.endsWith("/abort")) return response.writeHead(200, { "content-type": "application/json" }).end("true");
    if (request.method === "POST" && incoming.pathname.endsWith("/prompt_async")) return response.writeHead(204).end();
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
    modelConfigPath,
    systemToken: TOKEN,
    systemWorkspace: "/projects/system",
    systemDatabasePath: databasePath,
    maxConcurrentPerWorker: 1,
  });
  const baseURL = await listen(bff);
  const headers = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };
  try {
    const staleRead = fetch(`${baseURL}/api/system/tasks/${task.id}`, { headers }).then((response) => response.json());
    await oldStatusGate;
    assert.equal((await fetch(`${baseURL}/api/system/tasks/${task.id}/stop`, { method: "POST", headers }).then((response) => response.json())).status, "stopped");
    assert.equal((await fetch(`${baseURL}/api/system/tasks/${task.id}/resume`, { method: "POST", headers, body: JSON.stringify({ prompt: "new" }) }).then((response) => response.json())).status, "running");
    releaseOldStatus();
    assert.equal((await staleRead).status, "running");
    assert.equal((await fetch(`${baseURL}/api/system/tasks/${task.id}`, { headers }).then((response) => response.json())).status, "running");
  } finally {
    releaseOldStatus?.();
    await close(bff);
    await close(worker);
    await close(catalog);
    await rm(root, { recursive: true });
  }
});
