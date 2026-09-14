import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createAgentBff } from "../src/agent-bff.mjs";
import { readActivityLease, reserveActivityLease } from "../src/activity-lease.mjs";
import { createProjectionEventStore } from "../src/projection-event-store.mjs";

const IDENTITY_SECRET = "abcdef0123456789abcdef0123456789";
const PASSWORD = "opencode-test-password-0123456789";
const WORKSPACE = "/bounded/sample-workspace";

function signedIdentity(value) {
  const payload = Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${payload}.${createHmac("sha256", IDENTITY_SECRET).update(payload).digest("base64url")}`;
}

function identity(user = { sub: 3, username: "ryan" }, expiresAt = Math.floor(Date.now() / 1000) + 60) {
  return signedIdentity({ ...user, role: "member", exp: expiresAt });
}

function identityHeaders(value = identity()) {
  return { "x-yeutech-agent-identity": value };
}

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
    identitySecret: IDENTITY_SECRET,
    users: [{ portalUserId: 3, username: "ryan", workspace: WORKSPACE, migrationAccess: true }],
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

test("rejects anonymous API, migration, and static requests before reaching an upstream", async () => {
  let hits = 0;
  await withBff(() => { hits += 1; }, async (baseURL) => {
    const response = await fetch(`${baseURL}/api/agent/session`);
    assert.equal(response.status, 401);
    assert.equal((await fetch(`${baseURL}/api/migration/projects`)).status, 401);
    assert.equal((await fetch(baseURL)).status, 401);
    assert.equal(hits, 0);
  });
});

test("rejects forged, expired, and unmapped portal identities", async () => {
  await withBff(() => {}, async (baseURL) => {
    assert.equal((await fetch(baseURL, { headers: identityHeaders(`${identity()}x`) })).status, 401);
    assert.equal((await fetch(baseURL, { headers: identityHeaders(identity(undefined, 1)) })).status, 401);
    assert.equal((await fetch(baseURL, { headers: identityHeaders(signedIdentity({ sub: 3, username: "ryan" })) })).status, 401);
    assert.equal((await fetch(baseURL, { headers: identityHeaders(signedIdentity({ sub: 3, username: "ryan", exp: "invalid" })) })).status, 401);
    assert.equal((await fetch(baseURL, { headers: identityHeaders(identity({ sub: 0, username: "ryan" })) })).status, 401);
    assert.equal((await fetch(baseURL, { headers: identityHeaders(identity({ sub: 1, username: "lucian" })) })).status, 403);
  });
});

test("returns bounded worker-starting failures with Retry-After before forwarding a prompt", async () => {
  let upstreamHits = 0;
  await withBff(() => { upstreamHits += 1; }, async (baseURL) => {
    const response = await fetch(`${baseURL}/api/agent/session/ses_wait/prompt_async`, {
      method: "POST",
      headers: { ...identityHeaders(), "content-type": "application/json" },
      body: JSON.stringify({ model: { providerID: "yeutech", modelID: "ready" }, parts: [{ type: "text", text: "keep me" }] }),
    });
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("retry-after"), "2");
    assert.equal((await response.json()).error.code, "worker_starting");
    assert.equal(upstreamHits, 0);
  }, {
    ensureWorker: async () => { throw Object.assign(new Error("Agent worker is still starting"), { statusCode: 503, code: "worker_starting", retryAfter: 2 }); },
  });
});

test("loads the passive workbench and migration history without starting a portal worker", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-passive-bootstrap-"));
  const workspace = path.join(root, "workspace");
  await mkdir(workspace);
  const catalog = http.createServer((_request, response) => response.writeHead(200, { "content-type": "application/json" }).end('{"data":[{"id":"ready","context_length":128000,"max_input_tokens":120000,"max_output_tokens":8000,"supported_input_modalities":["text"],"supported_output_modalities":["text"]}]}'));
  const migration = http.createServer((_request, response) => response.writeHead(200, { "content-type": "application/json" }).end("[]"));
  const catalogURL = await listen(catalog);
  const migrationURL = await listen(migration);
  const controlPlaneDatabasePath = path.join(root, "control.sqlite");
  const projections = createProjectionEventStore(controlPlaneDatabasePath);
  projections.append(3, "ses_passive", "message:msg_user", "message.upsert", { id: "msg_user", role: "user", text: "passive question", createdAt: 1 });
  projections.append(3, "ses_passive", "message:msg_assistant", "message.upsert", { id: "msg_assistant", role: "assistant", text: "passive answer", createdAt: 2 });
  projections.close();
  let workerStarts = 0;
  try {
    await withBff(() => { throw new Error("passive bootstrap reached OpenCode"); }, async (baseURL) => {
      const bootstrap = await fetch(`${baseURL}/api/workbench/bootstrap`, { headers: identityHeaders() });
      assert.equal(bootstrap.status, 200);
      assert.equal((await bootstrap.json()).models[0].id, "ready");
      assert.equal((await fetch(`${baseURL}/api/migration/projects`, { headers: identityHeaders() })).status, 200);
      const passive = await fetch(`${baseURL}/api/workbench/sessions/ses_passive/messages?limit=10`, { headers: identityHeaders() }).then((response) => response.json());
      assert.deepEqual(passive.records.map((message) => message.text), ["passive question", "passive answer"]);
      assert.equal((await fetch(`${baseURL}/api/workbench/profiles`, { headers: identityHeaders() })).status, 200);
      const control = await fetch(`${baseURL}/api/workbench/control`, { headers: identityHeaders() }).then((response) => response.json());
      assert.equal(control.runtimeBudget.requestedInteractiveWorkers, 0);
      const skills = await fetch(`${baseURL}/api/workbench/skills`, { headers: identityHeaders() }).then((response) => response.json());
      assert.deepEqual({ reported: skills.reported, workerActive: skills.workerActive, data: skills.data }, { reported: false, workerActive: false, data: [] });
      assert.equal((await fetch(`${baseURL}/api/workbench/goals`, { headers: identityHeaders() })).status, 200);
      assert.equal((await fetch(`${baseURL}/api/workbench/replays`, { method: "POST", headers: { ...identityHeaders(), "content-type": "application/json" }, body: "{}" })).status, 200);
      assert.equal(workerStarts, 0);
    }, {
      migrationURL,
      modelCatalogURL: catalogURL,
      modelCatalogToken: "token",
      inspectWorker: async () => ({ workspace, root, upstream: new URL("http://127.0.0.1:18199"), active: false }),
      ensureWorker: async () => { workerStarts += 1; throw new Error("worker should remain asleep"); },
      controlPlaneDatabasePath,
    });
  } finally {
    await close(catalog); await close(migration); await rm(root, { recursive: true });
  }
});

test("does not fall back to ensureWorker for a passive request", async () => {
  let workerStarts = 0;
  await withBff(() => { throw new Error("passive request reached OpenCode"); }, async (baseURL) => {
    const response = await fetch(`${baseURL}/api/workbench/profiles`, { headers: identityHeaders() });
    assert.equal(response.status, 503);
    assert.equal(workerStarts, 0);
  }, {
    users: [],
    ensureWorker: async () => { workerStarts += 1; throw new Error("worker should remain asleep"); },
  });
});

test("reports an active worker without a skill endpoint as unreported and disables caching", async () => {
  await withBff((_request, response) => response.writeHead(404).end(), async (baseURL) => {
    const response = await fetch(`${baseURL}/api/workbench/skills`, { headers: identityHeaders() });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(await response.json().then(({ reported, workerActive, data }) => ({ reported, workerActive, data })), {
      reported: false,
      workerActive: true,
      data: [],
    });
  });
});

test("blocks OpenCode shell routes", async () => {
  let hits = 0;
  await withBff(() => { hits += 1; }, async (baseURL) => {
    const response = await fetch(`${baseURL}/api/agent/session/ses_abc123/shell`, {
      method: "POST",
      headers: identityHeaders(),
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
    assert.equal(url.searchParams.get("limit"), "200");
    assert.equal(url.searchParams.get("before"), "cursor-1");
    assert.equal(request.headers.authorization, `Basic ${Buffer.from(`yeutech-agent:${PASSWORD}`).toString("base64")}`);
    response.writeHead(200, { "content-type": "application/json", "x-next-cursor": "cursor-2" });
    response.end("[]");
  }, async (baseURL) => {
    const response = await fetch(`${baseURL}/api/agent/session?directory=/tmp/escape&workspace=bad&path=/&limit=200&before=cursor-1`, {
      headers: identityHeaders(),
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-next-cursor"), "cursor-2");
    assert.deepEqual(await response.json(), []);
  });
});

test("maps each authorized portal user to an isolated workspace", async () => {
  const seenDirectories = [];
  await withBff((request, response) => {
    seenDirectories.push(new URL(request.url, "http://127.0.0.1").searchParams.get("directory"));
    response.writeHead(200, { "content-type": "application/json" });
    response.end("[]");
  }, async (baseURL) => {
    const lucian = identity({ sub: 1, username: "lucian" });
    assert.equal((await fetch(`${baseURL}/api/agent/session`, { headers: identityHeaders(lucian) })).status, 200);
    assert.equal((await fetch(`${baseURL}/api/agent/session`, { headers: identityHeaders() })).status, 200);
    assert.deepEqual(seenDirectories, ["/projects/lucian", WORKSPACE]);
  }, {
    users: [
      { portalUserId: 1, username: "lucian", workspace: "/projects/lucian" },
      { portalUserId: 3, username: "ryan", workspace: WORKSPACE },
    ],
  });
});

test("dynamically resolves any portal-signed immutable user ID without a static allowlist", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "yeutech-dynamic-user-"));
  const workspace = path.join(directory, "847");
  await mkdir(workspace);
  const upstream = http.createServer((request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ directory: new URL(request.url, "http://127.0.0.1").searchParams.get("directory") }));
  });
  const upstreamURL = await listen(upstream);
  const calls = [];
  const resolveWorker = async (principal) => {
    calls.push(principal);
    return { workspace, upstream: new URL(upstreamURL) };
  };
  const bff = createAgentBff({
    identitySecret: IDENTITY_SECRET,
    inspectWorker: resolveWorker,
    ensureWorker: resolveWorker,
    upstreamUsername: "yeutech-agent",
    upstreamPassword: PASSWORD,
  });
  const baseURL = await listen(bff);
  try {
    const signed = identity({ sub: 847, username: "future-user" });
    const result = await fetch(`${baseURL}/api/agent/session?directory=/tmp/escape`, { headers: identityHeaders(signed) });
    assert.equal(result.status, 200);
    assert.equal((await result.json()).directory, workspace);
    const created = await fetch(`${baseURL}/api/workbench/projects`, {
      method: "POST",
      headers: { ...identityHeaders(signed), "content-type": "application/json" },
      body: JSON.stringify({ name: "新项目" }),
    });
    assert.equal(created.status, 201);
    assert.equal((await created.json()).data.name, "新项目");
    assert.deepEqual(calls, [
      { portalUserId: 847, username: "future-user" },
      { portalUserId: 847, username: "future-user" },
    ]);
  } finally { await close(bff); await close(upstream); await rm(directory, { recursive: true }); }
});

test("recovers a projected session from a transient post-restart 404", async () => {
  let sessionReads = 0;
  await withBff((request, response) => {
    const incoming = new URL(request.url, "http://127.0.0.1");
    if (incoming.pathname === "/session/ses_recovered") {
      sessionReads += 1;
      if (sessionReads === 1) {
        response.writeHead(404, { "content-type": "application/json" }).end('{"error":"not found"}');
        return;
      }
      response.writeHead(200, { "content-type": "application/json" }).end('{"id":"ses_recovered","title":"Recovered"}');
      return;
    }
    const payload = incoming.pathname === "/session/status" ? "{}" : "[]";
    response.writeHead(200, { "content-type": "application/json" }).end(payload);
  }, async (baseURL) => {
    const response = await fetch(`${baseURL}/api/workbench/sessions/ses_recovered/snapshot`, { headers: identityHeaders() });
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.session.id, "ses_recovered");
    assert.equal(payload.session.title, "Recovered");
    assert.equal(sessionReads, 2);
  });
});

test("exposes typed session rename, delete, fork, and diff workbench operations", async () => {
  const seen = [];
  await withBff(async (request, response) => {
    const incoming = new URL(request.url, "http://127.0.0.1");
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const text = Buffer.concat(chunks).toString("utf8");
    seen.push({ method: request.method, pathname: incoming.pathname, messageID: incoming.searchParams.get("messageID"), body: text ? JSON.parse(text) : null });
    response.setHeader("content-type", "application/json");
    if (request.method === "PATCH") return response.end('{"id":"ses_manage","title":"新标题"}');
    if (request.method === "DELETE") return response.writeHead(204).end();
    if (incoming.pathname.endsWith("/fork")) return response.end('{"id":"ses_forked","title":"分支"}');
    if (incoming.pathname.endsWith("/diff")) return response.end('[{"file":"README.md","before":"a","after":"b"}]');
    response.writeHead(404).end('{}');
  }, async (baseURL) => {
    const headers = { ...identityHeaders(), "content-type": "application/json" };
    const renamed = await fetch(`${baseURL}/api/workbench/sessions/ses_manage`, { method: "PATCH", headers, body: JSON.stringify({ title: "新标题" }) });
    assert.equal(renamed.status, 200);
    assert.equal((await renamed.json()).data.title, "新标题");
    const forked = await fetch(`${baseURL}/api/workbench/sessions/ses_manage/fork`, { method: "POST", headers, body: JSON.stringify({ messageId: "msg_turn1" }) });
    assert.equal(forked.status, 201);
    assert.equal((await forked.json()).data.id, "ses_forked");
    const diff = await fetch(`${baseURL}/api/workbench/sessions/ses_manage/diff?messageId=msg_turn1`, { headers: identityHeaders() });
    assert.equal(diff.status, 200);
    assert.equal((await diff.json()).data[0].file, "README.md");
    const deleted = await fetch(`${baseURL}/api/workbench/sessions/ses_manage`, { method: "DELETE", headers: identityHeaders() });
    assert.equal(deleted.status, 200);
    assert.equal((await deleted.json()).data.deleted, true);
    const invalid = await fetch(`${baseURL}/api/workbench/sessions/ses_manage/fork`, { method: "POST", headers, body: JSON.stringify({ messageId: "../../bad" }) });
    assert.equal(invalid.status, 400);
    assert.equal((await invalid.json()).error.code, "fork_message_invalid");
  });
  assert.deepEqual(seen, [
    { method: "PATCH", pathname: "/session/ses_manage", messageID: null, body: { title: "新标题" } },
    { method: "POST", pathname: "/session/ses_manage/fork", messageID: null, body: { messageID: "msg_turn1" } },
    { method: "GET", pathname: "/session/ses_manage/diff", messageID: "msg_turn1", body: null },
    { method: "DELETE", pathname: "/session/ses_manage", messageID: null, body: null },
  ]);
});

test("does not mislabel a missing worker capability route as a missing session", async () => {
  await withBff((request, response) => {
    const incoming = new URL(request.url, "http://127.0.0.1");
    if (incoming.pathname === "/permission") {
      response.writeHead(404, { "content-type": "application/json" }).end('{"error":"missing route"}');
      return;
    }
    if (incoming.pathname === "/session/ses_existing") {
      response.writeHead(200, { "content-type": "application/json" }).end('{"id":"ses_existing","title":"Existing"}');
      return;
    }
    const payload = incoming.pathname === "/session/status" ? "{}" : "[]";
    response.writeHead(200, { "content-type": "application/json" }).end(payload);
  }, async (baseURL) => {
    const response = await fetch(`${baseURL}/api/workbench/sessions/ses_existing/snapshot`, { headers: identityHeaders() });
    assert.equal(response.status, 404);
    assert.equal((await response.json()).error.code, "worker_route_not_found");
  });
});

test("does not mislabel a missing session subresource route as a missing session", async () => {
  await withBff((request, response) => {
    const incoming = new URL(request.url, "http://127.0.0.1");
    if (incoming.pathname === "/session/ses_existing/children") {
      response.writeHead(404, { "content-type": "application/json" }).end('{"error":"missing route"}');
      return;
    }
    if (incoming.pathname === "/session/ses_existing") {
      response.writeHead(200, { "content-type": "application/json" }).end('{"id":"ses_existing","title":"Existing"}');
      return;
    }
    const payload = incoming.pathname === "/session/status" ? "{}" : "[]";
    response.writeHead(200, { "content-type": "application/json" }).end(payload);
  }, async (baseURL) => {
    const response = await fetch(`${baseURL}/api/agent/session/ses_existing/children`, { headers: identityHeaders() });
    assert.equal(response.status, 404);
    assert.equal((await response.json()).error.code, "worker_route_not_found");
  });
});

test("projects every message page with real session state, context, and complete coverage", async () => {
  const pageRequests = [];
  await withBff((request, response) => {
    const incoming = new URL(request.url, "http://127.0.0.1");
    if (incoming.pathname === "/session/ses_long/message") {
      const before = incoming.searchParams.get("before");
      pageRequests.push(before);
      const records = before === "older-page"
        ? [
            { info: { id: "msg_1", role: "user", time: { created: 1 } }, parts: [{ type: "text", text: "first" }] },
            { info: { id: "msg_2", role: "assistant", providerID: "yeutech", modelID: "model-a", time: { created: 2, completed: 3 }, tokens: { input: 2, output: 1 }, cost: 0 }, parts: [{ type: "text", text: "second" }] },
          ]
        : [
            { info: { id: "msg_3", role: "user", time: { created: 4 } }, parts: [{ type: "text", text: "third" }] },
            { info: { id: "msg_4", role: "assistant", providerID: "yeutech", modelID: "model-b", time: { created: 5, completed: 8 }, tokens: { input: 4, output: 2 }, cost: 0 }, parts: [{ type: "tool", tool: "read", state: { status: "completed" } }, { type: "text", text: "fourth" }] },
          ];
      response.writeHead(200, { "content-type": "application/json", ...(before ? {} : { "x-next-cursor": "older-page" }) }).end(JSON.stringify(records));
      return;
    }
    if (incoming.pathname === "/session/ses_long") {
      response.writeHead(200, { "content-type": "application/json" }).end('{"id":"ses_long","title":"Long"}');
      return;
    }
    if (incoming.pathname === "/session/status") {
      response.writeHead(200, { "content-type": "application/json" }).end('{"ses_long":{"type":"busy"}}');
      return;
    }
    if (incoming.pathname === "/session/ses_long/children") {
      response.writeHead(200, { "content-type": "application/json" }).end('[{"id":"ses_child","title":"Child"}]');
      return;
    }
    if (incoming.pathname === "/session/ses_long/todo") {
      response.writeHead(200, { "content-type": "application/json" }).end('[{"content":"Verify","status":"pending"}]');
      return;
    }
    response.writeHead(200, { "content-type": "application/json" }).end("[]");
  }, async (baseURL) => {
    const snapshotResponse = await fetch(`${baseURL}/api/workbench/sessions/ses_long/snapshot`, { headers: identityHeaders() });
    assert.equal(snapshotResponse.status, 200);
    const snapshot = await snapshotResponse.json();
    assert.deepEqual(snapshot.messages.map((message) => message.id), ["msg_1", "msg_2", "msg_3", "msg_4"]);
    assert.deepEqual(snapshot.coverage, { complete: true, recordCount: 4, priorTurnCount: 0, nextCursor: null });
    assert.deepEqual(snapshot.session.status, { type: "busy" });
    assert.equal(snapshot.stats.turns, 2);
    assert.equal(snapshot.stats.toolCalls, 1);
    assert.equal(snapshot.context.messageCount, 4);
    assert.equal(snapshot.context.model, "model-b");
    assert.deepEqual(snapshot.context.sources, ["session-messages", "runtime-tools"]);

    const graphResponse = await fetch(`${baseURL}/api/workbench/sessions/ses_long/graph`, { headers: identityHeaders() });
    const graph = await graphResponse.json();
    assert.equal(graph.data.nodes[0].status, "busy");
    assert.equal(graph.coverage.complete, true);
    assert.deepEqual(pageRequests, [null, "older-page", null, "older-page"]);
  }, { projectionPageSize: 2 });
});

test("heartbeats and releases portal prompt activity from snapshots and aborts", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "portal-activity-lease-"));
  const leaseFile = path.join(root, "activity.json");
  const modelConfigPath = path.join(root, "opencode.json");
  await writeFile(modelConfigPath, JSON.stringify({ provider: { yeutech: { models: { ready: {} } } } }));
  let busy = false;
  let failPrompt = false;
  const catalog = http.createServer((_request, response) => response.writeHead(200, { "content-type": "application/json" }).end('{"data":[{"id":"ready","context_length":128000,"max_input_tokens":120000,"max_output_tokens":8000,"supported_input_modalities":["text"],"supported_output_modalities":["text"]}]}'));
  const catalogURL = await listen(catalog);
  try {
    await withBff((request, response) => {
      const incoming = new URL(request.url, "http://127.0.0.1");
      if (incoming.pathname === "/session/status") return response.writeHead(200, { "content-type": "application/json" }).end(busy ? '{"ses_lease":{"type":"busy"}}' : "{}");
      if (request.method === "POST" && incoming.pathname.endsWith("/prompt_async")) return failPrompt ? response.writeHead(500).end("failed") : response.writeHead(204).end();
      if (request.method === "POST" && incoming.pathname.endsWith("/abort")) return response.writeHead(200, { "content-type": "application/json" }).end("true");
      if (incoming.pathname === "/session/ses_lease") return response.writeHead(200, { "content-type": "application/json" }).end('{"id":"ses_lease"}');
      response.writeHead(200, { "content-type": "application/json" }).end("[]");
    }, async (baseURL) => {
      const prompt = () => fetch(`${baseURL}/api/agent/session/ses_lease/prompt_async`, { method: "POST", headers: { ...identityHeaders(), "content-type": "application/json" }, body: JSON.stringify({ model: { providerID: "yeutech", modelID: "ready" }, parts: [] }) });
      busy = true;
      assert.equal((await prompt()).status, 204);
      assert.deepEqual((await readActivityLease({ activityLeaseFile: leaseFile })).sessionIds, ["ses_lease"]);
      assert.equal((await fetch(`${baseURL}/api/workbench/sessions/ses_lease/snapshot`, { headers: identityHeaders() })).status, 200);
      assert.ok(await readActivityLease({ activityLeaseFile: leaseFile }));
      busy = false;
      assert.equal((await fetch(`${baseURL}/api/workbench/sessions/ses_lease/snapshot`, { headers: identityHeaders() })).status, 200);
      assert.equal(await readActivityLease({ activityLeaseFile: leaseFile }), null);
      busy = true;
      assert.equal((await prompt()).status, 204);
      assert.equal((await fetch(`${baseURL}/api/agent/session/ses_lease/abort`, { method: "POST", headers: identityHeaders() })).status, 200);
      assert.equal(await readActivityLease({ activityLeaseFile: leaseFile }), null);
      busy = false;
      failPrompt = true;
      assert.equal((await prompt()).status, 502);
      assert.equal(await readActivityLease({ activityLeaseFile: leaseFile }), null);
    }, {
      users: [{ portalUserId: 3, username: "ryan", workspace: WORKSPACE, activityLeaseFile: leaseFile }],
      modelCatalogURL: catalogURL,
      modelCatalogToken: "token",
      modelConfigPath,
      activityLeaseMs: 5_000,
    });
  } finally { await close(catalog); await rm(root, { recursive: true }); }
});

test("fails projection when children or todo returns a server error instead of fabricating empty data", async () => {
  for (const failingPath of ["children", "todo"]) {
    await withBff((request, response) => {
      const incoming = new URL(request.url, "http://127.0.0.1");
      if (incoming.pathname === `/session/ses_existing/${failingPath}`) {
        response.writeHead(500, { "content-type": "text/plain" }).end("temporary failure");
        return;
      }
      if (incoming.pathname === "/session/ses_existing") response.writeHead(200, { "content-type": "application/json" }).end('{"id":"ses_existing"}');
      else if (incoming.pathname === "/session/status") response.writeHead(200, { "content-type": "application/json" }).end("{}");
      else response.writeHead(200, { "content-type": "application/json" }).end("[]");
    }, async (baseURL) => {
      const response = await fetch(`${baseURL}/api/workbench/sessions/ses_existing/snapshot`, { headers: identityHeaders() });
      const payload = await response.json();
      assert.equal(response.status, 502);
      assert.equal(payload.error.code, "worker_response");
      assert.equal(payload.error.retryable, true);
    });
  }
});

test("classifies projection timeout separately from worker transport failure", async () => {
  for (const scenario of [
    { name: "timeout", expectedStatus: 504, expectedCode: "worker_timeout", fail: () => {} },
    { name: "transport", expectedStatus: 502, expectedCode: "worker_transport", fail: (request) => request.socket.destroy() },
  ]) {
    await withBff((request, response) => {
      const incoming = new URL(request.url, "http://127.0.0.1");
      if (incoming.pathname === "/session/ses_existing/children") {
        scenario.fail(request, response);
        return;
      }
      if (incoming.pathname === "/session/ses_existing") response.writeHead(200, { "content-type": "application/json" }).end('{"id":"ses_existing"}');
      else if (incoming.pathname === "/session/status") response.writeHead(200, { "content-type": "application/json" }).end("{}");
      else response.writeHead(200, { "content-type": "application/json" }).end("[]");
    }, async (baseURL) => {
      const response = await fetch(`${baseURL}/api/workbench/sessions/ses_existing/snapshot`, { headers: identityHeaders() });
      const payload = await response.json();
      assert.equal(response.status, scenario.expectedStatus, scenario.name);
      assert.equal(payload.error.code, scenario.expectedCode, scenario.name);
    }, { upstreamRequestTimeoutMs: 20 });
  }
});

test("projects raw non-2xx worker responses as typed errors while preserving successful SSE", async () => {
  await withBff((request, response) => {
    const incoming = new URL(request.url, "http://127.0.0.1");
    if (incoming.pathname === "/event") {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write("data: first\n\n");
      setTimeout(() => response.end("data: second\n\n"), 35);
      return;
    }
    response.writeHead(409, { "content-type": "application/json" }).end('{"error":"busy"}');
  }, async (baseURL) => {
    const failed = await fetch(`${baseURL}/api/agent/session/ses_existing/abort`, { method: "POST", headers: identityHeaders() });
    const payload = await failed.json();
    assert.equal(failed.status, 409);
    assert.equal(payload.error.code, "worker_response");
    assert.equal(payload.error.scope, "worker");
    assert.equal(typeof payload.contractVersion, "string");

    const stream = await fetch(`${baseURL}/api/agent/event`, { headers: identityHeaders() });
    assert.equal(stream.status, 200);
    assert.equal(await stream.text(), "data: first\n\ndata: second\n\n");
  }, { upstreamRequestTimeoutMs: 10 });
});

test("lists and answers only the signed user's pending permissions and modifies only its temporary workspace", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-permission-"));
  const target = path.join(root, "user-3", "draft.md");
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, "before");
  const pending = new Map([[3, [{ id: "per_user3", sessionID: "ses_owner", permission: "bash", patterns: ["printf approved > draft.md"], metadata: {} }]], [1, []]]);
  const servers = new Map();
  for (const userID of [1, 3]) {
    const server = http.createServer(async (request, response) => {
      const incoming = new URL(request.url, "http://127.0.0.1");
      if (request.method === "GET" && incoming.pathname === "/permission") {
        response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(pending.get(userID)));
        return;
      }
      if (request.method === "POST" && incoming.pathname === "/permission/per_user3/reply" && userID === 3) {
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (body.reply === "once") await writeFile(target, "approved");
        pending.set(3, []);
        response.writeHead(200, { "content-type": "application/json" }).end("true");
        return;
      }
      response.writeHead(404, { "content-type": "application/json" }).end("{}");
    });
    servers.set(userID, { server, url: await listen(server) });
  }
  const bff = createAgentBff({
    identitySecret: IDENTITY_SECRET,
    ensureWorker: async (principal) => ({ workspace: path.join(root, `user-${principal.portalUserId}`), upstream: new URL(servers.get(principal.portalUserId).url) }),
    upstreamUsername: "yeutech-agent",
    upstreamPassword: PASSWORD,
  });
  const baseURL = await listen(bff);
  try {
    const ownerHeaders = { ...identityHeaders(), "content-type": "application/json" };
    const otherHeaders = { ...identityHeaders(identity({ sub: 1, username: "lucian" })), "content-type": "application/json" };
    assert.deepEqual(await fetch(`${baseURL}/api/agent/permission`, { headers: ownerHeaders }).then((response) => response.json()), pending.get(3));
    assert.equal((await fetch(`${baseURL}/api/agent/permission/per_user3/reply`, { method: "POST", headers: otherHeaders, body: JSON.stringify({ reply: "once" }) })).status, 404);
    assert.equal(await readFile(target, "utf8"), "before");
    assert.equal((await fetch(`${baseURL}/api/agent/permission/per_user3/reply`, { method: "POST", headers: ownerHeaders, body: JSON.stringify({ reply: "always" }) })).status, 400);
    assert.equal((await fetch(`${baseURL}/api/agent/permission/per_user3/reply`, { method: "POST", headers: ownerHeaders, body: JSON.stringify({ reply: "once", injected: true }) })).status, 200);
    assert.equal(await readFile(target, "utf8"), "approved");
    assert.deepEqual(await fetch(`${baseURL}/api/agent/permission`, { headers: ownerHeaders }).then((response) => response.json()), []);
  } finally {
    await close(bff);
    await Promise.all([...servers.values()].map((item) => close(item.server)));
    await rm(root, { recursive: true });
  }
});

test("keeps Ryan migration history hidden from other authorized users", async () => {
  let migrationHits = 0;
  const migration = http.createServer((_request, response) => {
    migrationHits += 1;
    response.writeHead(200, { "content-type": "application/json" });
    response.end('[{"id":"ryan-project"}]');
  });
  const migrationURL = await listen(migration);
  try {
    await withBff((_request, response) => response.end(), async (baseURL) => {
      const lucianHeaders = identityHeaders(identity({ sub: 1, username: "lucian" }));
      assert.deepEqual(await fetch(`${baseURL}/api/migration/projects`, { headers: lucianHeaders }).then((response) => response.json()), []);
      assert.equal((await fetch(`${baseURL}/api/migration/conversations/ryan-thread`, { headers: lucianHeaders })).status, 403);
      assert.equal(migrationHits, 0);
      assert.deepEqual(await fetch(`${baseURL}/api/migration/projects`, { headers: identityHeaders() }).then((response) => response.json()), [{ id: "ryan-project" }]);
      assert.equal(migrationHits, 1);
    }, {
      migrationURL,
      users: [
        { portalUserId: 1, username: "lucian", workspace: "/projects/lucian" },
        { portalUserId: 3, username: "ryan", workspace: WORKSPACE, migrationAccess: true },
      ],
    });
  } finally {
    await close(migration);
  }
});

test("streams OpenCode SSE responses", async () => {
  await withBff((_request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write("data: first\n\n");
    response.end("data: second\n\n");
  }, async (baseURL) => {
    const response = await fetch(`${baseURL}/api/agent/event`, {
      headers: identityHeaders(),
    });
    assert.equal(response.headers.get("content-type"), "text/event-stream");
    assert.equal(await response.text(), "data: first\n\ndata: second\n\n");
  });
});

test("enforces the BFF request body limit", async () => {
  await withBff(() => {}, async (baseURL) => {
    const response = await fetch(`${baseURL}/api/agent/session`, {
      method: "POST",
      headers: { ...identityHeaders(), "content-type": "application/json" },
      body: JSON.stringify({ title: "too large" }),
    });
    assert.equal(response.status, 413);
  }, { bodyLimit: 4 });
});

test("exposes safe model capabilities and blocks incomplete models before OpenCode", async () => {
  let upstreamHits = 0;
  let forwardedPrompt = null;
  const configRoot = await mkdtemp(path.join(os.tmpdir(), "yeutech-agent-models-"));
  const workspace = path.join(configRoot, "workspace");
  const project = path.join(workspace, "Project");
  await mkdir(project, { recursive: true });
  await writeFile(path.join(project, "source.txt"), "authoritative");
  await writeFile(path.join(project, ".yeutech-project.json"), JSON.stringify({ version: 1, projectId: "project-id", portalUserId: 3 }));
  const modelConfigPath = path.join(configRoot, "opencode.json");
  await writeFile(modelConfigPath, JSON.stringify({ provider: { yeutech: { models: { "ready-model": {} } } } }));
  const catalog = http.createServer((request, response) => {
    assert.equal(request.url, "/v1/model-capabilities");
    assert.equal(request.headers.authorization, "Bearer catalog-secret");
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ data: [
      { id: "ready-model", display_name: "Ready model", context_length: 128000, max_input_tokens: 120000, max_output_tokens: 8000, supported_input_modalities: ["text"], supported_output_modalities: ["text"] },
      { id: "late-model", display_name: "Late model", context_length: 128000, max_input_tokens: 120000, max_output_tokens: 8000, supported_input_modalities: ["text"], supported_output_modalities: ["text"] },
      { id: "new-model", display_name: "New model", context_length: 0, max_output_tokens: 0, selectable: false, capability_status: "incomplete" },
    ] }));
  });
  const modelCatalogURL = await listen(catalog);
  try {
    await withBff((request, response) => {
      if (new URL(request.url, "http://127.0.0.1").pathname === "/session/status") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end("{}");
        return;
      }
      upstreamHits += 1;
      const chunks = [];
      request.on("data", (chunk) => chunks.push(chunk));
      request.on("end", () => {
        forwardedPrompt = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        response.writeHead(204);
        response.end();
      });
    }, async (baseURL) => {
      const modelResponse = await fetch(`${baseURL}/api/models`, { headers: identityHeaders() });
      assert.equal(modelResponse.headers.get("cache-control"), "no-store");
      const modelPayload = await modelResponse.json();
      assert.deepEqual(modelPayload.data.map(({ id, selectable, disabledReason }) => ({ id, selectable, disabledReason })), [
        { id: "late-model", selectable: false, disabledReason: "等待 Agent 安全加载" },
        { id: "new-model", selectable: false, disabledReason: "能力信息待补全" },
        { id: "ready-model", selectable: true, disabledReason: null },
      ]);

      const incomplete = await fetch(`${baseURL}/api/agent/session/ses_abc123/prompt_async`, {
        method: "POST",
        headers: { ...identityHeaders(), "content-type": "application/json" },
        body: JSON.stringify({ model: { providerID: "yeutech", modelID: "new-model" }, parts: [] }),
      });
      assert.equal(incomplete.status, 409);
      assert.match(await incomplete.text(), /能力信息待补全/);
      assert.equal(upstreamHits, 0);

      const notLoaded = await fetch(`${baseURL}/api/agent/session/ses_abc123/prompt_async`, {
        method: "POST",
        headers: { ...identityHeaders(), "content-type": "application/json" },
        body: JSON.stringify({ model: { providerID: "yeutech", modelID: "late-model" }, parts: [] }),
      });
      assert.equal(notLoaded.status, 409);
      assert.match(await notLoaded.text(), /等待 Agent 安全加载/);
      assert.equal(upstreamHits, 0);

      const ready = await fetch(`${baseURL}/api/agent/session/ses_abc123/prompt_async`, {
        method: "POST",
        headers: { ...identityHeaders(), "content-type": "application/json" },
        body: JSON.stringify({ model: { providerID: "yeutech", modelID: "ready-model" }, yeutech: { workload: "general-agent", project: "Project", paths: ["source.txt"] }, parts: [{ type: "text", text: "use source" }] }),
      });
      assert.equal(ready.status, 204);
      assert.equal(upstreamHits, 1);
      assert.equal("yeutech" in forwardedPrompt, false);
      assert.match(forwardedPrompt.parts[0].text, /YEUTECH Context Receipt/);
      assert.match(forwardedPrompt.parts[0].text, /source\.txt@/);
    }, { users: [{ portalUserId: 3, username: "ryan", workspace }], modelCatalogURL, modelCatalogToken: "catalog-secret", modelConfigPath, controlPlaneDatabasePath: path.join(configRoot, "control.sqlite") });
  } finally {
    await close(catalog);
    await rm(configRoot, { recursive: true });
  }
});

test("serves the last validated model catalog while a bounded refresh is stalled", async () => {
  let requests = 0;
  const catalog = http.createServer((_request, response) => {
    requests += 1;
    if (requests > 1) return;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ data: [{ id: "ready-model", context_length: 128000, max_input_tokens: 120000, max_output_tokens: 8000, supported_input_modalities: ["text"], supported_output_modalities: ["text"] }] }));
  });
  const modelCatalogURL = await listen(catalog);
  try {
    await withBff(() => {}, async (baseURL) => {
      const first = await fetch(`${baseURL}/api/models`, { headers: identityHeaders() });
      assert.equal(first.status, 200);
      const startedAt = Date.now();
      const stale = await fetch(`${baseURL}/api/models`, { headers: identityHeaders() });
      assert.equal(stale.status, 200);
      assert.equal((await stale.json()).data[0].id, "ready-model");
      assert.ok(Date.now() - startedAt < 100);
      await new Promise((resolve) => setTimeout(resolve, 30));
      assert.equal(requests, 2);
    }, { modelCatalogURL, modelCatalogToken: "catalog-secret", modelCatalogCacheMs: 0, modelCatalogTimeoutMs: 10 });
  } finally {
    catalog.closeAllConnections();
    await close(catalog);
  }
});

test("rejects incomplete upstream credentials at startup", () => {
  assert.throws(() => createAgentBff({
    identitySecret: IDENTITY_SECRET,
    users: [{ portalUserId: 3, username: "ryan", workspace: WORKSPACE }],
    upstreamURL: "http://127.0.0.1:18130",
    upstreamUsername: "yeutech-agent",
    upstreamPassword: "short",
  }), /password must contain at least 24 characters/);
});

test("serves tenant-scoped project files, uploads, and durable goals", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "yeutech-bff-control-"));
  const workspace = path.join(directory, "workspace");
  const project = path.join(workspace, "小说创作");
  await mkdir(project, { recursive: true });
  await mkdir(path.join(project, "草稿"));
  await writeFile(path.join(project, "README.md"), "# 权威项目");
  await writeFile(path.join(project, ".env.example"), "SAFE=true");
  await writeFile(path.join(project, ".DS_Store"), "noise");
  await writeFile(path.join(project, ".yeutech-project.json"), JSON.stringify({ version: 1, projectId: "novel", portalUserId: 3 }));
  try {
    await withBff((_request, response) => response.writeHead(200, { "content-type": "application/json" }).end("[]"), async (baseURL) => {
      const headers = identityHeaders();
      const createdProjectResponse = await fetch(`${baseURL}/api/workbench/projects`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ name: "Agent工作台" }),
      });
      assert.equal(createdProjectResponse.status, 201);
      assert.equal((await createdProjectResponse.json()).data.name, "Agent工作台");
      const duplicateProjectResponse = await fetch(`${baseURL}/api/workbench/projects`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ name: "Agent工作台" }),
        signal: AbortSignal.timeout(1_000),
      });
      assert.equal(duplicateProjectResponse.status, 409);
      assert.equal((await duplicateProjectResponse.json()).error.code, "project_exists");

      const listing = await fetch(`${baseURL}/api/workbench/files?project=${encodeURIComponent("小说创作")}`, { headers });
      assert.equal(listing.status, 200);
      const listedEntries = (await listing.json()).data.entries;
      assert.deepEqual(listedEntries.map((entry) => entry.name), ["草稿", "README.md"]);
      assert.equal(listedEntries.find((entry) => entry.name === "README.md").preview.kind, "markdown");
      const hiddenDenied = await fetch(`${baseURL}/api/workbench/file?project=${encodeURIComponent("小说创作")}&path=${encodeURIComponent(".env.example")}&download=1`, { headers });
      assert.equal(hiddenDenied.status, 403);
      const systemDenied = await fetch(`${baseURL}/api/workbench/file?project=${encodeURIComponent("小说创作")}&path=${encodeURIComponent(".DS_Store")}&download=1&showHidden=1`, { headers });
      assert.equal(systemDenied.status, 403);
      const hiddenAllowed = await fetch(`${baseURL}/api/workbench/file?project=${encodeURIComponent("小说创作")}&path=${encodeURIComponent(".env.example")}&download=1&showHidden=1`, { headers });
      assert.equal(await hiddenAllowed.text(), "SAFE=true");
      await writeFile(path.join(project, "preview.html"), "<script>top.location='https://evil.invalid'</script><h1>source</h1>");
      const activePreview = await fetch(`${baseURL}/api/workbench/file?project=${encodeURIComponent("小说创作")}&path=preview.html`, { headers });
      assert.equal(activePreview.headers.get("content-type"), "text/plain; charset=utf-8");
      assert.equal(activePreview.headers.get("x-yeutech-original-content-type"), "text/html");
      assert.equal(activePreview.headers.get("x-yeutech-preview-kind"), "html-source");
      assert.match(activePreview.headers.get("content-disposition"), /^attachment;/);
      assert.match(await activePreview.text(), /<script>/);

      const renamedProject = await fetch(`${baseURL}/api/workbench/projects/novel`, {
        method: "PATCH", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ name: "星河创作" }),
      }).then((response) => response.json());
      assert.equal(renamedProject.data.name, "星河创作");
      const removedProject = await fetch(`${baseURL}/api/workbench/projects/novel`, { method: "DELETE", headers }).then((response) => response.json());
      assert.equal(removedProject.data.removed, true);
      const removedListing = await fetch(`${baseURL}/api/workbench/projects`, { headers }).then((response) => response.json());
      assert.deepEqual(removedListing.data.find((item) => item.id === "novel"), {
        id: "novel", name: "星河创作", workspaceDirectory: "小说创作", registered: false, removed: true,
      });
      const restoredProject = await fetch(`${baseURL}/api/workbench/projects/register`, {
        method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ name: "小说创作" }),
      }).then((response) => response.json());
      assert.equal(restoredProject.data.name, "星河创作");

      const uploaded = await fetch(`${baseURL}/api/workbench/attachments?project=${encodeURIComponent("小说创作")}`, {
        method: "POST",
        headers: { ...headers, "content-type": "text/plain", "x-yeutech-filename": encodeURIComponent("本轮设定.txt") },
        body: "不复制主数据",
      });
      assert.equal(uploaded.status, 201);
      const artifact = (await uploaded.json()).data;
      assert.deepEqual(artifact.reference, { type: "file", path: "小说创作/附件/本轮设定.txt" });
      const file = await fetch(`${baseURL}/api/workbench/file?project=${encodeURIComponent("小说创作")}&path=${encodeURIComponent(artifact.path)}`, { headers });
      assert.equal(await file.text(), "不复制主数据");

      const arbitrary = await fetch(`${baseURL}/api/workbench/attachments?project=${encodeURIComponent("小说创作")}&directory=${encodeURIComponent("草稿")}`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/x-anything", "x-yeutech-filename": "payload.exe" },
        body: "binary",
      });
      assert.equal(arbitrary.status, 201);
      const arbitraryArtifact = (await arbitrary.json()).data;
      assert.equal(arbitraryArtifact.path, "草稿/payload.exe");
      assert.equal(await readFile(path.join(project, "草稿", "payload.exe"), "utf8"), "binary");
      const emptyUpload = await fetch(`${baseURL}/api/workbench/attachments?project=${encodeURIComponent("小说创作")}`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/octet-stream", "x-yeutech-filename": "empty.bin" },
        body: new Uint8Array(),
      });
      assert.equal(emptyUpload.status, 201);
      assert.equal((await emptyUpload.json()).data.size, 0);

      const standaloneUpload = await fetch(`${baseURL}/api/workbench/attachments?session=ses_files`, {
        method: "POST",
        headers: { ...headers, "content-type": "text/plain", "x-yeutech-filename": "notes.txt" },
        body: "session only",
      });
      assert.equal(standaloneUpload.status, 201);
      const standaloneArtifact = (await standaloneUpload.json()).data;
      assert.equal(standaloneArtifact.workspacePath, "独立会话/附件/notes.txt");
      const standaloneList = await fetch(`${baseURL}/api/workbench/files?session=ses_files&path=${encodeURIComponent("附件")}`, { headers }).then((response) => response.json());
      assert.deepEqual(standaloneList.data.entries.map((entry) => entry.name), ["notes.txt"]);
      const removed = await fetch(`${baseURL}/api/workbench/attachments?session=ses_files&path=${encodeURIComponent(standaloneArtifact.path)}`, { method: "DELETE", headers });
      assert.equal(removed.status, 200);
      assert.equal((await removed.json()).data.deleted, true);

      const created = await fetch(`${baseURL}/api/workbench/goals`, {
        method: "POST", headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ scopeKey: "project:novel", objective: "完成可审阅稿", acceptancePolicy: "novel-writing" }),
      });
      assert.equal(created.status, 201);
      const goal = (await created.json()).data;
      const changed = await fetch(`${baseURL}/api/workbench/goals/${goal.id}`, {
        method: "PATCH", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ revision: goal.revision, status: "paused" }),
      });
      assert.equal((await changed.json()).data.status, "paused");
      const goals = await fetch(`${baseURL}/api/workbench/goals?scope=${encodeURIComponent("project:novel")}`, { headers }).then((response) => response.json());
      assert.equal(goals.data.length, 1);
      const contextPack = await fetch(`${baseURL}/api/workbench/context-packs`, {
        method: "POST", headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ project: "小说创作", paths: ["README.md"] }),
      }).then((response) => response.json());
      assert.equal(contextPack.data.sources[0].path, "README.md");
      assert.equal(contextPack.data.sources[0].hash.length, 64);
      assert.equal(contextPack.data.hash.length, 64);
      assert.equal(contextPack.data.appliedToExecution, false);
      const replay = await fetch(`${baseURL}/api/workbench/replays`, {
        method: "POST", headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ baseline: { id: "one", metrics: { durationMs: 10 } }, candidate: { id: "two", metrics: { durationMs: 8 } } }),
      }).then((response) => response.json());
      assert.equal(replay.data.metrics.durationMs.improved, true);
      assert.equal(replay.data.executedReplay, false);
    }, {
      users: [{ portalUserId: 3, username: "ryan", workspace }],
      controlPlaneDatabasePath: path.join(directory, "runtime", "control.sqlite"),
    });
  } finally {
    await rm(directory, { recursive: true });
  }
});

test("executes Replay through the BFF with deny-by-default tools and audits the completed trajectory", async (t) => {
  for (const scenario of [
    { name: "read-only trajectory completes", tool: "read", expectedStatus: "completed", expectedCode: null },
    { name: "side-effect trajectory fails closed", tool: "webfetch", expectedStatus: "failed", expectedCode: "replay_policy_violation" },
  ]) await t.test(scenario.name, async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "yeutech-bff-replay-"));
    const workspace = path.join(directory, "workspace");
    await mkdir(workspace, { recursive: true });
    let forwardedPrompt = null;
    const catalog = http.createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ data: [{
        id: "replay-model", display_name: "Replay model", context_length: 128000,
        max_input_tokens: 120000, max_output_tokens: 8000,
        supported_input_modalities: ["text"], supported_output_modalities: ["text"],
      }] }));
    });
    const modelCatalogURL = await listen(catalog);
    try {
      await withBff((request, response) => {
        const pathname = new URL(request.url, "http://127.0.0.1").pathname;
        response.setHeader("content-type", "application/json");
        if (request.method === "POST" && pathname === "/session") return response.end(JSON.stringify({ id: "ses_replay123", title: "Replay" }));
        if (pathname === "/experimental/tool/ids") return response.end(JSON.stringify(["read", "bash", "webfetch", "task"]));
        if (request.method === "POST" && pathname === "/session/ses_replay123/prompt_async") {
          const chunks = [];
          request.on("data", (chunk) => chunks.push(chunk));
          request.on("end", () => {
            forwardedPrompt = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            response.writeHead(204).end();
          });
          return;
        }
        if (pathname === "/session/status") return response.end("{}");
        if (pathname === "/permission" || pathname.endsWith("/children") || pathname.endsWith("/todo")) return response.end("[]");
        if (pathname === "/session/ses_source123") return response.end(JSON.stringify({ id: "ses_source123", title: "Source" }));
        if (pathname === "/session/ses_source123/message") return response.end(JSON.stringify([{
          info: { id: "msg_source", sessionID: "ses_source123", role: "user", time: { created: 1 } },
          parts: [{ type: "text", text: "Inspect the project" }],
        }]));
        if (pathname === "/session/ses_replay123") return response.end(JSON.stringify({ id: "ses_replay123", title: "Replay" }));
        if (pathname === "/session/ses_replay123/message") return response.end(JSON.stringify([{
          info: { id: "msg_replay", sessionID: "ses_replay123", role: "assistant", time: { created: 2, completed: 3 }, modelID: "replay-model", tokens: { input: 10, output: 5, reasoning: 0, cache_read: 0, cache_write: 0 }, cost: 0 },
          parts: [{ id: "prt_tool", type: "tool", tool: scenario.tool, state: { status: "completed", output: "done" } }],
        }]));
        response.writeHead(404).end(JSON.stringify({ error: pathname }));
      }, async (baseURL) => {
        const startedResponse = await fetch(`${baseURL}/api/workbench/replays/execute`, {
          method: "POST",
          headers: { ...identityHeaders(), "content-type": "application/json" },
          body: JSON.stringify({ sessionId: "ses_source123", modelId: "replay-model", workload: "general-agent" }),
        });
        assert.equal(startedResponse.status, 202);
        const started = (await startedResponse.json()).data;
        let run = started;
        for (let attempt = 0; attempt < 100 && !new Set(["completed", "failed"]).has(run.status); attempt += 1) {
          await new Promise((resolve) => setTimeout(resolve, 5));
          const current = await fetch(`${baseURL}/api/workbench/replays/${started.id}`, { headers: identityHeaders() });
          assert.equal(current.status, 200);
          run = (await current.json()).data;
        }
        assert.equal(run.status, scenario.expectedStatus);
        assert.ok(forwardedPrompt);
        assert.equal(Object.keys(forwardedPrompt.tools)[0], "*");
        assert.equal(forwardedPrompt.tools["*"], false);
        assert.equal(forwardedPrompt.tools.read, true);
        for (const tool of ["bash", "webfetch", "task"]) assert.equal(forwardedPrompt.tools[tool], false, tool);
        if (scenario.expectedCode) assert.equal(run.error.code, scenario.expectedCode);
        else {
          assert.equal(run.error, null);
          assert.equal(run.result.executedReplay, true);
          assert.equal(run.result.policy.mode, "deny-by-default");
          assert.equal(run.result.policyAudit.compliant, true);
        }
      }, {
        users: [{ portalUserId: 3, username: "ryan", workspace }],
        modelCatalogURL,
        modelCatalogToken: "catalog-secret",
        controlPlaneDatabasePath: path.join(directory, "control.sqlite"),
        replayPollMs: 1,
        replayTimeoutMs: 1_000,
      });
    } finally {
      await close(catalog);
      await rm(directory, { recursive: true, force: true });
    }
  });
});

test("streams replayable durable projection events and releases prompt activity on terminal events", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "yeutech-bff-projection-"));
  const leaseFile = path.join(directory, "activity.json");
  try {
    await reserveActivityLease({ activityLeaseFile: leaseFile }, { sessionId: "ses_stream", reasons: ["portal-prompt"], durationMs: 5_000 });
    await withBff((request, response) => {
      const pathname = new URL(request.url, "http://127.0.0.1").pathname;
      response.setHeader("content-type", pathname === "/event" ? "text/event-stream" : "application/json");
      if (pathname === "/event") {
        response.write("data: {\"type\":\"message.part.updated\",\"properties\":{\"sessionID\":\"ses_stream\",\"part\":{\"type\":\"text\",\"messageID\":\"msg_one\",\"text\":\"live\"}}}\n\n");
        response.write("data: {\"type\":\"session.idle\",\"properties\":{\"sessionID\":\"ses_stream\"}}\n\n");
        return;
      }
      if (pathname === "/session/ses_stream") return response.end(JSON.stringify({ id: "ses_stream", title: "stream" }));
      if (pathname === "/session/ses_stream/message/msg_big") return response.end(JSON.stringify({ info: { id: "msg_big" }, parts: [{ id: "prt_big", type: "tool", state: { output: "full result" } }] }));
      if (pathname === "/session/ses_stream/message") return response.end(JSON.stringify([{ info: { id: "msg_one", sessionID: "ses_stream", role: "assistant", time: { created: 1, completed: 2 } }, parts: [{ type: "text", text: "durable" }] }]));
      if (pathname === "/session/status") return response.end(JSON.stringify({}));
      return response.end(JSON.stringify([]));
    }, async (baseURL) => {
      const controller = new AbortController();
      const response = await fetch(`${baseURL}/api/workbench/sessions/ses_stream/events?cursor=0`, { headers: identityHeaders(), signal: controller.signal });
      assert.equal(response.headers.get("content-type"), "text/event-stream");
      const reader = response.body.getReader();
      let body = "";
      while (!body.includes("event: ephemeral")) body += new TextDecoder().decode((await reader.read()).value);
      assert.match(body, /event: durable/);
      assert.match(body, /message\.upsert/);
      assert.match(body, /event: ephemeral/);
      assert.match(body, /\"cursor\":\d+/);
      for (let attempt = 0; attempt < 100 && await readActivityLease({ activityLeaseFile: leaseFile }); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 5));
      assert.equal(await readActivityLease({ activityLeaseFile: leaseFile }), null);
      controller.abort();
      const full = await fetch(`${baseURL}/api/workbench/sessions/ses_stream/tool-results/msg_big/prt_big`, { headers: identityHeaders() }).then((value) => value.json());
      assert.equal(full.data.value, "full result");
    }, {
      users: [{ portalUserId: 3, username: "ryan", workspace: WORKSPACE, activityLeaseFile: leaseFile }],
      controlPlaneDatabasePath: path.join(directory, "control.sqlite"),
      activityLeaseMs: 5_000,
    });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("serves the built workbench and forwards same-origin migration routes", async () => {
  const webRoot = await mkdtemp(path.join(os.tmpdir(), "yeutech-agent-web-"));
  await writeFile(path.join(webRoot, "index.html"), "<main>YEUTECH Agent</main>");
  await mkdir(path.join(webRoot, "assets"));
  await writeFile(path.join(webRoot, "assets", "app.js"), "window.YEUTECH = true;");
  let workerStarts = 0;
  const migration = http.createServer((request, response) => {
    assert.equal(request.url, "/projects");
    response.writeHead(200, { "content-type": "application/json" });
    response.end("[]");
  });
  const migrationURL = await listen(migration);
  try {
    await withBff((_request, response) => response.end(), async (baseURL) => {
      assert.match(await fetch(baseURL, { headers: identityHeaders() }).then((response) => response.text()), /YEUTECH Agent/);
      assert.match(await fetch(`${baseURL}/assets/app.js`, { headers: identityHeaders() }).then((response) => response.text()), /YEUTECH/);
      assert.deepEqual(await fetch(`${baseURL}/api/migration/projects`, { headers: identityHeaders() }).then((response) => response.json()), []);
      assert.equal(workerStarts, 0);
    }, { migrationURL, webRoot, ensureWorker: async () => { workerStarts += 1; throw new Error("static reads must not start a worker"); } });
  } finally {
    await close(migration);
    await rm(webRoot, { recursive: true });
  }
});
