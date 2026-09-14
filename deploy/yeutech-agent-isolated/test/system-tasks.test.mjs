import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createAgentBff } from "../src/agent-bff.mjs";

const IDENTITY_SECRET = "abcdef0123456789abcdef0123456789";
const PASSWORD = "opencode-test-password-0123456789";
const SYSTEM_TOKEN = "system-kaoyan-test-token-0123456789abcdef";

async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

async function close(server) {
  await new Promise((resolve) => server.close(resolve));
}

test("persists idempotent kaoyan tasks in one system session with SSE, stop, and resume", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "yeutech-system-tasks-"));
  const modelConfigPath = path.join(root, "opencode.json");
  await writeFile(modelConfigPath, JSON.stringify({ provider: { yeutech: { models: { "ready-model": {} } } } }));
  let prompts = 0;
  let aborts = 0;
  let sessions = 0;
  let assistantText = "feedback";
  let deferAssistant = false;
  const messages = new Map();
  const deferred = new Map();
  const upstream = http.createServer(async (request, response) => {
    const incoming = new URL(request.url, "http://127.0.0.1");
    assert.equal(incoming.searchParams.get("directory"), "/projects/system/kaoyan");
    if (request.method === "POST" && incoming.pathname === "/session") {
      sessions += 1;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ id: sessions === 1 ? "ses_system123" : `ses_system${123 + sessions - 1}` }));
      return;
    }
    if (request.method === "POST" && incoming.pathname.endsWith("/prompt_async")) {
      prompts += 1;
      const sessionID = incoming.pathname.split("/")[2];
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const current = messages.get(sessionID) ?? [];
      current.push({ info: { id: body.messageID, role: "user" }, parts: body.parts });
      const assistant = { info: { id: `msg_assistant_${prompts}`, role: "assistant", parentID: body.messageID, time: { completed: 1 } }, parts: [{ type: "text", text: assistantText }] };
      if (deferAssistant) deferred.set(sessionID, assistant);
      if (!deferAssistant) current.push(assistant);
      messages.set(sessionID, current);
      response.writeHead(204).end();
      return;
    }
    if (request.method === "POST" && incoming.pathname.endsWith("/abort")) {
      aborts += 1;
      response.writeHead(200, { "content-type": "application/json" }).end("true");
      return;
    }
    if (request.method === "GET" && incoming.pathname.endsWith("/message")) {
      const sessionID = incoming.pathname.split("/")[2];
      const current = messages.get(sessionID) ?? [];
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(current));
      if (deferred.has(sessionID)) { current.push(deferred.get(sessionID)); deferred.delete(sessionID); messages.set(sessionID, current); }
      return;
    }
    if (request.method === "GET" && incoming.pathname === "/session/status") {
      response.writeHead(200, { "content-type": "application/json" }).end("{}");
      return;
    }
    if (request.method === "GET" && incoming.pathname === "/event") {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end("data: system-event\n\n");
      return;
    }
    response.writeHead(404).end();
  });
  const catalog = http.createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end('{"data":[{"id":"ready-model","context_length":128000,"max_input_tokens":120000,"max_output_tokens":8000,"supported_input_modalities":["text"],"supported_output_modalities":["text"]},{"id":"new-model","context_length":0,"max_output_tokens":0,"selectable":false,"capability_status":"incomplete"}]}');
  });
  const upstreamURL = await listen(upstream);
  const modelCatalogURL = await listen(catalog);
  const bff = createAgentBff({
    identitySecret: IDENTITY_SECRET,
    users: [{ portalUserId: 3, username: "ryan", workspace: "/projects/ryan" }],
    upstreamURL,
    upstreamUsername: "yeutech-agent",
    upstreamPassword: PASSWORD,
    modelCatalogURL,
    modelCatalogToken: "catalog-token",
    modelConfigPath,
    systemToken: SYSTEM_TOKEN,
    systemWorkspace: "/projects/system/kaoyan",
    systemDatabasePath: path.join(root, "kaoyan-tasks.sqlite"),
    modelRuntimeStatePath: path.join(root, "model-runtime-state.json"),
  });
  const baseURL = await listen(bff);
  const headers = { authorization: `Bearer ${SYSTEM_TOKEN}`, "content-type": "application/json" };
  try {
    assert.equal((await fetch(`${baseURL}/api/system/tasks`, { method: "POST", body: "{}" })).status, 401);
    assert.equal((await fetch(`${baseURL}/api/system/models`)).status, 401);
    const systemModels = await fetch(`${baseURL}/api/system/models`, { headers }).then((response) => response.json());
    assert.deepEqual(systemModels.data.map(({ id, selectable, disabledReason }) => ({ id, selectable, disabledReason })), [
      { id: "new-model", selectable: false, disabledReason: "能力信息待补全" },
      { id: "ready-model", selectable: true, disabledReason: null },
    ]);
    const payload = { sessionKey: "grading:user-3", kind: "grading", modelId: "ready-model", prompt: "grade this", idempotencyKey: "submission-42" };
    const created = await Promise.all(Array.from({ length: 8 }, () => fetch(`${baseURL}/api/system/tasks`, { method: "POST", headers, body: JSON.stringify(payload) })));
    assert.deepEqual(created.map((response) => response.status), Array(8).fill(202));
    const createdTasks = await Promise.all(created.map((response) => response.json()));
    const task = createdTasks[0];
    assert.equal(new Set(createdTasks.map((item) => item.id)).size, 1);
    assert.match(task.id, /^task_[a-f0-9]{32}$/);
    assert.equal(task.sessionId, "ses_system123");
    assert.equal(task.status, "running");

    assert.equal(sessions, 1);
    assert.equal(prompts, 1);

    const result = await fetch(`${baseURL}/api/system/tasks/${task.id}`, { headers }).then((response) => response.json());
    assert.equal(result.status, "completed");
    assert.equal(result.messages.find((message) => message.info.role === "assistant").parts[0].text, "feedback");

    const events = await fetch(`${baseURL}/api/system/tasks/${task.id}/events`, { headers });
    assert.equal(events.headers.get("x-yeutech-session-id"), "ses_system123");
    assert.equal(await events.text(), "data: system-event\n\n");

    assert.equal((await fetch(`${baseURL}/api/system/tasks/${task.id}/stop`, { method: "POST", headers }).then((response) => response.json())).status, "completed");
    assert.equal(aborts, 0);
    assert.equal((await fetch(`${baseURL}/api/system/tasks/${task.id}/resume`, { method: "POST", headers, body: "{}" }).then((response) => response.json())).status, "running");
    assert.equal(prompts, 2);

    const overlapping = await fetch(`${baseURL}/api/system/tasks`, { method: "POST", headers, body: JSON.stringify({ ...payload, idempotencyKey: "submission-overlap" }) });
    assert.equal(overlapping.status, 409);
    assert.equal((await overlapping.json()).error.code, "system_session_busy");
    assert.equal((await fetch(`${baseURL}/api/system/tasks/${task.id}`, { headers }).then((response) => response.json())).status, "completed");

    assistantText = "";
    const emptyTask = await fetch(`${baseURL}/api/system/tasks`, { method: "POST", headers, body: JSON.stringify({ ...payload, idempotencyKey: "submission-empty" }) }).then((response) => response.json());
    const emptyResult = await fetch(`${baseURL}/api/system/tasks/${emptyTask.id}`, { headers }).then((response) => response.json());
    assert.equal(emptyResult.status, "failed");
    assert.match(emptyResult.error, /without assistant text or a valid tool result/);
    const quarantined = await fetch(`${baseURL}/api/system/models`, { headers }).then((response) => response.json());
    assert.equal(quarantined.data.find((model) => model.id === "ready-model").selectable, false);
    assert.match(quarantined.data.find((model) => model.id === "ready-model").disabledReason, /运行兼容性暂不可用/);
    assert.equal(quarantined.data.find((model) => model.id === "new-model").disabledReason, "能力信息待补全");
    assert.equal((await fetch(`${baseURL}/api/system/models/ready-model/clear-quarantine`, { method: "POST", headers })).status, 204);
    const cleared = await fetch(`${baseURL}/api/system/models`, { headers }).then((response) => response.json());
    assert.equal(cleared.data.find((model) => model.id === "ready-model").selectable, true);
    assistantText = "recovered";
    const recovery = await fetch(`${baseURL}/api/system/tasks`, { method: "POST", headers, body: JSON.stringify({ ...payload, sessionKey: "grading:recovery", idempotencyKey: "submission-recovery" }) }).then((response) => response.json());
    assert.equal((await fetch(`${baseURL}/api/system/tasks/${recovery.id}`, { headers }).then((response) => response.json())).status, "completed");
    const verified = await fetch(`${baseURL}/api/system/models`, { headers }).then((response) => response.json());
    assert.equal(verified.data.find((model) => model.id === "ready-model").runtimeCompatibility.status, "verified");

    deferAssistant = true;
    const delayed = await fetch(`${baseURL}/api/system/tasks`, { method: "POST", headers, body: JSON.stringify({ ...payload, sessionKey: "grading:delayed", idempotencyKey: "submission-delayed" }) }).then((response) => response.json());
    assert.equal((await fetch(`${baseURL}/api/system/tasks/${delayed.id}`, { headers }).then((response) => response.json())).status, "running");
    assert.equal((await fetch(`${baseURL}/api/system/tasks/${delayed.id}/stop`, { method: "POST", headers }).then((response) => response.json())).status, "stopped");
    assert.equal(aborts, 1);
    deferAssistant = false;
    assert.equal((await fetch(`${baseURL}/api/system/tasks/${delayed.id}/resume`, { method: "POST", headers, body: "{}" }).then((response) => response.json())).status, "running");
    assert.equal((await fetch(`${baseURL}/api/system/tasks/${delayed.id}`, { headers }).then((response) => response.json())).status, "completed");
  } finally {
    await close(bff);
    await close(upstream);
    await close(catalog);
    await rm(root, { recursive: true });
  }
});
