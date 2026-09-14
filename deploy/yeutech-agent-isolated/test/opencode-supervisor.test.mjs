import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createOpenCodeSupervisor, createSupervisorControlServer, createWorkerRegistry, isSessionStatusIdle, systemWorker } from "../src/opencode-supervisor.mjs";
import { readActivityLease, reserveActivityLease } from "../src/activity-lease.mjs";
import { buildOpenCodeConfig } from "../src/generate-opencode-config.mjs";
import { indexPortalProjects, PROJECT_MARKER } from "../src/workspace-identity.mjs";

const MODELS = [{ id: "ready", name: "ready", selectable: true, limit: { context: 10_000, input: 9_000, output: 1_000 }, modalities: { input: ["text"], output: ["text"] } }];
const virtualWorkspace = ({ projectsRoot, portalUserId, legacyWorkspace }) => legacyWorkspace ?? path.join(projectsRoot, "users", String(portalUserId));

test("treats only an empty OpenCode status map as idle", () => {
  assert.equal(isSessionStatusIdle({}), true);
  assert.equal(isSessionStatusIdle({ ses_busy: { type: "busy" } }), false);
  assert.equal(isSessionStatusIdle(null), false);
  assert.equal(isSessionStatusIdle([]), false);
});

test("fails closed when the idle status request or JSON body hangs", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-idle-timeout-"));
  const base = {
    command: "opencode", username: "user", password: "password", runtimeRoot: root, projectsRoot: path.join(root, "projects"),
    registryFile: path.join(root, "workers", "registry.json"), portStart: 18150, portEnd: 18160,
    systemWorker: systemWorker({ runtimeRoot: root, systemWorkspace: path.join(root, "projects/system/kaoyan"), systemPort: 18133 }),
    modelCatalogURL: "http://catalog", modelCatalogToken: "token", idleRequestTimeoutMs: 5,
  };
  const worker = { id: "user-timeout", workspace: "/projects/users/timeout", url: "http://127.0.0.1:18199", root: path.join(root, "worker"), stateFile: path.join(root, "worker/state.json") };
  try {
    const fetchHung = createOpenCodeSupervisor({ ...base, fetch: async () => new Promise(() => {}) });
    assert.equal(await fetchHung.idle(worker), false);
    await fetchHung.stop();
    const jsonHung = createOpenCodeSupervisor({ ...base, fetch: async () => ({ ok: true, json: async () => new Promise(() => {}) }) });
    assert.equal(await jsonHung.idle(worker), false);
    await jsonHung.stop();
  } finally { await rm(root, { recursive: true }); }
});

test("waits for SIGKILL exit before forgetting and restarting a worker", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-sigkill-exit-"));
  const projectsRoot = path.join(root, "projects");
  await mkdir(projectsRoot);
  const signals = [];
  function spawnProcess() {
    const child = new EventEmitter();
    child.exitCode = null;
    child.signalCode = null;
    child.kill = (signal) => {
      signals.push(signal);
      if (signal === "SIGKILL") setTimeout(() => { child.signalCode = signal; child.emit("exit", null, signal); }, 5);
      return true;
    };
    return child;
  }
  const supervisor = createOpenCodeSupervisor({
    command: "opencode", username: "user", password: "password", runtimeRoot: root, projectsRoot,
    registryFile: path.join(root, "workers/registry.json"), portStart: 18150, portEnd: 18160,
    systemWorker: systemWorker({ runtimeRoot: root, systemWorkspace: path.join(projectsRoot, "system/kaoyan"), systemPort: 18133 }),
    modelCatalogURL: "http://catalog", modelCatalogToken: "token", fetchCatalog: async () => MODELS, spawnProcess,
    fetch: async () => ({ ok: true, json: async () => ({}) }), healthAttempts: 1, stopTimeoutMs: 1, killWaitMs: 30,
  });
  try {
    await supervisor.ensurePortalWorker(91, "kill-user");
    await supervisor.stop();
    assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
    assert.deepEqual(supervisor.activeWorkerIds(), []);
  } finally { await rm(root, { recursive: true }); }
});

test("clears a persisted prompt lease after a restarted worker reports no active sessions", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-stale-lease-"));
  const projectsRoot = path.join(root, "projects");
  await mkdir(projectsRoot);
  const leaseFile = path.join(root, "workers", "user-93", "activity-lease.json");
  function spawnProcess() {
    const child = new EventEmitter();
    child.exitCode = null;
    child.kill = () => { child.exitCode = 0; queueMicrotask(() => child.emit("exit", 0)); };
    return child;
  }
  const supervisor = createOpenCodeSupervisor({
    command: "opencode", username: "user", password: "password", runtimeRoot: root, projectsRoot,
    registryFile: path.join(root, "workers/registry.json"), portStart: 18150, portEnd: 18160,
    systemWorker: systemWorker({ runtimeRoot: root, systemWorkspace: path.join(projectsRoot, "system/kaoyan"), systemPort: 18133 }),
    modelCatalogURL: "http://catalog", modelCatalogToken: "token", fetchCatalog: async () => MODELS, spawnProcess,
    fetch: async () => ({ ok: true, json: async () => ({}) }), healthAttempts: 1, stopTimeoutMs: 1,
  });
  try {
    await reserveActivityLease({ activityLeaseFile: leaseFile }, { sessionId: "ses_crashed", reasons: ["portal-prompt"], durationMs: 60_000 });
    assert.ok(await readActivityLease({ activityLeaseFile: leaseFile }));
    await supervisor.ensurePortalWorker(93, "restart-user");
    assert.equal(await readActivityLease({ activityLeaseFile: leaseFile }), null);
  } finally { await supervisor.stop(); await rm(root, { recursive: true }); }
});

test("reconciles a completed prompt lease against runtime status without a browser terminal event", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-completed-lease-"));
  const projectsRoot = path.join(root, "projects");
  await mkdir(projectsRoot);
  function spawnProcess() {
    const child = new EventEmitter();
    child.exitCode = null;
    child.kill = () => { child.exitCode = 0; queueMicrotask(() => child.emit("exit", 0)); };
    return child;
  }
  const supervisor = createOpenCodeSupervisor({
    command: "opencode", username: "user", password: "password", runtimeRoot: root, projectsRoot,
    registryFile: path.join(root, "workers/registry.json"), portStart: 18150, portEnd: 18160,
    systemWorker: systemWorker({ runtimeRoot: root, systemWorkspace: path.join(projectsRoot, "system/kaoyan"), systemPort: 18133 }),
    modelCatalogURL: "http://catalog", modelCatalogToken: "token", fetchCatalog: async () => MODELS, spawnProcess,
    fetch: async () => ({ ok: true, json: async () => ({}) }), healthAttempts: 1, stopTimeoutMs: 1,
    leaseReconcileGraceMs: 0,
  });
  try {
    const worker = await supervisor.ensurePortalWorker(94, "completed-user");
    await reserveActivityLease(worker, { sessionId: "ses_completed", reasons: ["portal-prompt"], durationMs: 60_000 });
    assert.ok(await readActivityLease(worker));
    assert.equal(await supervisor.idle(worker), true);
    assert.equal(await readActivityLease(worker), null);
  } finally { await supervisor.stop(); await rm(root, { recursive: true }); }
});

test("starts the eviction clock at the first idle observation and resets it when the worker becomes busy", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-idle-confirmation-"));
  const projectsRoot = path.join(root, "projects");
  await mkdir(projectsRoot);
  let statusCalls = 0;
  function spawnProcess() {
    const child = new EventEmitter();
    child.exitCode = null;
    child.kill = () => { child.exitCode = 0; queueMicrotask(() => child.emit("exit", 0)); };
    return child;
  }
  const supervisor = createOpenCodeSupervisor({
    command: "opencode", username: "user", password: "password", runtimeRoot: root, projectsRoot,
    registryFile: path.join(root, "workers/registry.json"), portStart: 18150, portEnd: 18160, idleEvictionMs: 1,
    systemWorker: systemWorker({ runtimeRoot: root, systemWorkspace: path.join(projectsRoot, "system/kaoyan"), systemPort: 18133 }),
    modelCatalogURL: "http://catalog", modelCatalogToken: "token", fetchCatalog: async () => MODELS, spawnProcess,
    fetch: async (url) => ({ ok: true, json: async () => String(url).includes("session/status") && ++statusCalls > 1 ? { ses_started: { type: "busy" } } : {} }),
    healthAttempts: 1, idleConfirmationMs: 1, stopTimeoutMs: 1,
  });
  try {
    await supervisor.ensurePortalWorker(92, "race-user");
    const observedAt = Date.now() + 10_000;
    await supervisor.evictIdleWorkers(observedAt);
    assert.equal(statusCalls, 1);
    assert.deepEqual(supervisor.activeWorkerIds(), ["user-92"]);
    await supervisor.evictIdleWorkers(observedAt + 2);
    assert.equal(statusCalls, 2);
    assert.deepEqual(supervisor.activeWorkerIds(), ["user-92"]);
  } finally { await supervisor.stop(); await rm(root, { recursive: true }); }
});

test("does not evict a worker admitted during the final idle confirmation", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-idle-admission-race-"));
  const projectsRoot = path.join(root, "projects");
  await mkdir(projectsRoot);
  let statusCalls = 0;
  let releaseFinalStatus;
  let signalFinalStatus;
  const finalStatusStarted = new Promise((resolve) => { signalFinalStatus = resolve; });
  const finalStatusReleased = new Promise((resolve) => { releaseFinalStatus = resolve; });
  function spawnProcess() {
    const child = new EventEmitter();
    child.exitCode = null;
    child.kill = () => { child.exitCode = 0; queueMicrotask(() => child.emit("exit", 0)); };
    return child;
  }
  const supervisor = createOpenCodeSupervisor({
    command: "opencode", username: "user", password: "password", runtimeRoot: root, projectsRoot,
    registryFile: path.join(root, "workers/registry.json"), portStart: 18150, portEnd: 18160, idleEvictionMs: 1,
    systemWorker: systemWorker({ runtimeRoot: root, systemWorkspace: path.join(projectsRoot, "system/kaoyan"), systemPort: 18133 }),
    modelCatalogURL: "http://catalog", modelCatalogToken: "token", fetchCatalog: async () => MODELS, spawnProcess,
    fetch: async () => ({ ok: true, json: async () => {
      statusCalls += 1;
      if (statusCalls === 4) { signalFinalStatus(); await finalStatusReleased; }
      return {};
    } }),
    healthAttempts: 1, idleConfirmationMs: 0, stopTimeoutMs: 1,
  });
  try {
    await supervisor.ensurePortalWorker(95, "admission-race-user");
    const observedAt = Date.now() + 10_000;
    await supervisor.evictIdleWorkers(observedAt);
    const eviction = supervisor.evictIdleWorkers(observedAt + 2);
    await finalStatusStarted;
    await supervisor.ensurePortalWorker(95, "admission-race-user");
    releaseFinalStatus();
    await eviction;
    assert.equal(statusCalls, 4);
    assert.deepEqual(supervisor.activeWorkerIds(), ["user-95"]);
  } finally {
    releaseFinalStatus?.();
    await supervisor.stop();
    await rm(root, { recursive: true });
  }
});

test("writes the read-only config only for the system-kaoyan worker", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-system-config-"));
  const system = systemWorker({
    runtimeRoot: root,
    systemWorkspace: path.join(root, "projects", "system", "kaoyan"),
    systemPort: 18133,
  });
  const supervisor = createOpenCodeSupervisor({
    command: "opencode",
    username: "user",
    password: "password",
    runtimeRoot: root,
    projectsRoot: path.join(root, "projects"),
    registryFile: path.join(root, "workers", "registry.json"),
    portStart: 18150,
    portEnd: 18160,
    systemWorker: system,
    modelCatalogURL: "http://catalog",
    modelCatalogToken: "token",
  });
  const interactive = { ...buildOpenCodeConfig(MODELS) };
  const readOnly = buildOpenCodeConfig(MODELS, { readOnly: true });
  try {
    await supervisor.refresh(system, {
      models: MODELS,
      config: interactive,
      systemConfig: readOnly,
    });
    const stored = JSON.parse(await readFile(system.configFile, "utf8"));
    assert.equal(stored.permission["*"], "deny");
    assert.equal(stored.permission.edit, "deny");
    assert.equal(stored.permission.bash, "deny");
    assert.equal(stored.permission.external_directory, "deny");
  } finally {
    await supervisor.stop();
    await rm(root, { recursive: true });
  }
});

test("control readiness stays unavailable until the system worker is ready", async () => {
  let ready = false;
  const server = createSupervisorControlServer({ isSystemReady: () => ready }, "supervisor-test-token-0123456789abcdef");
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  const headers = { authorization: "Bearer supervisor-test-token-0123456789abcdef" };
  try {
    assert.equal((await fetch(`${url}/health`, { headers })).status, 200);
    assert.equal((await fetch(`${url}/ready`, { headers })).status, 503);
    ready = true;
    assert.equal((await fetch(`${url}/ready`, { headers })).status, 200);
  } finally { await new Promise((resolve) => server.close(resolve)); }
});

test("bounds a cold ensure with Retry-After while preserving the single in-flight start", async () => {
  let calls = 0;
  let finish;
  const worker = { id: "user-77", workspace: "/projects/users/77", url: "http://127.0.0.1:18150", configFile: "/runtime/config.json", stateFile: "/runtime/state.json" };
  const pending = new Promise((resolve) => { finish = () => resolve(worker); });
  const server = createSupervisorControlServer({
    isSystemReady: () => true,
    ensurePortalWorker: async () => { calls += 1; return pending; },
  }, "supervisor-test-token-0123456789abcdef", { ensureWaitMs: 5, retryAfterSeconds: 1 });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}/workers/ensure`;
  const request = () => fetch(url, { method: "POST", headers: { authorization: "Bearer supervisor-test-token-0123456789abcdef", "content-type": "application/json" }, body: JSON.stringify({ portalUserId: 77, username: "new-user" }) });
  try {
    const cold = await request();
    assert.equal(cold.status, 503);
    assert.equal(cold.headers.get("retry-after"), "1");
    assert.equal((await cold.json()).error.code, "worker_starting");
    finish();
    const warm = await request();
    assert.equal(warm.status, 200);
    assert.equal((await warm.json()).id, "user-77");
    assert.equal(calls, 2);
  } finally { await new Promise((resolve) => server.close(resolve)); }
});

test("prepares a portal workspace without spawning its OpenCode worker", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-prepare-only-"));
  const projectsRoot = path.join(root, "projects");
  const workspace = path.join(projectsRoot, "users", "73");
  await mkdir(workspace, { recursive: true });
  let spawns = 0;
  const supervisor = createOpenCodeSupervisor({
    command: "opencode", username: "user", password: "password", runtimeRoot: root, projectsRoot,
    registryFile: path.join(root, "workers/registry.json"), portStart: 18150, portEnd: 18160,
    systemWorker: systemWorker({ runtimeRoot: root, systemWorkspace: path.join(projectsRoot, "system/kaoyan"), systemPort: 18133 }),
    modelCatalogURL: "http://catalog", modelCatalogToken: "token",
    spawnProcess: () => { spawns += 1; throw new Error("prepare must not spawn"); },
  });
  try {
    const worker = await supervisor.preparePortalWorker(73, "sleeping-user");
    assert.equal(worker.workspace, await realpath(workspace));
    assert.equal(spawns, 0);
    assert.deepEqual(supervisor.activeWorkerIds(), []);
    assert.equal((await supervisor.describePortalWorker(73, "sleeping-user")).active, false);
  } finally { await supervisor.stop(); await rm(root, { recursive: true }); }
});

test("allocates one stable collision-free port under concurrent first access and restart", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-registry-"));
  const file = path.join(root, "registry.json");
  try {
    const registry = createWorkerRegistry({ file, projectsRoot: "/projects", portStart: 18150, portEnd: 18152, systemPort: 18151, resolveWorkspace: virtualWorkspace });
    const same = await Promise.all(Array.from({ length: 12 }, () => registry.ensure(7, "ryan")));
    assert.deepEqual(new Set(same.map((item) => item.port)), new Set([18150]));
    const other = await registry.ensure(8, "lucian");
    assert.equal(other.port, 18152);
    assert.equal(other.workspace, "/projects/users/8");
    const restarted = createWorkerRegistry({ file, projectsRoot: "/projects", portStart: 18150, portEnd: 18152, systemPort: 18151, resolveWorkspace: virtualWorkspace });
    assert.equal((await restarted.ensure(7, "renamed-user")).port, 18150);
    assert.equal(JSON.parse(await readFile(file, "utf8")).workers.length, 2);
  } finally { await rm(root, { recursive: true }); }
});

test("seeds legacy Ryan workspace without changing the existing user-3 runtime root", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-legacy-registry-"));
  const file = path.join(root, "registry.json");
  try {
    const registry = createWorkerRegistry({ file, projectsRoot: "/projects", portStart: 18150, portEnd: 18160, systemPort: 18133, legacyWorkspaces: { 3: "/projects/ryan" }, resolveWorkspace: virtualWorkspace });
    const ryan = await registry.ensure(3, "ryan");
    assert.equal(ryan.workspace, "/projects/ryan");
    assert.equal(path.join(root, "workers", ryan.id), path.join(root, "workers", "user-3"));
    const restarted = createWorkerRegistry({ file, projectsRoot: "/projects", portStart: 18150, portEnd: 18160, systemPort: 18133, legacyWorkspaces: {}, resolveWorkspace: virtualWorkspace });
    assert.equal((await restarted.ensure(3, "ryan")).workspace, "/projects/ryan");
  } finally { await rm(root, { recursive: true }); }
});

test("lazily starts isolated workers once, evicts only idle workers, and restores the same database root", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-workers-"));
  const projectsRoot = path.join(root, "projects");
  await mkdir(projectsRoot);
  const children = [];
  let busy = false;
  function spawnProcess(_command, _args, spawnOptions) {
    const child = new EventEmitter();
    child.exitCode = null;
    child.options = spawnOptions;
    child.kill = () => { child.exitCode = 0; queueMicrotask(() => child.emit("exit", 0)); };
    children.push(child);
    return child;
  }
  const system = systemWorker({ runtimeRoot: root, systemWorkspace: "/projects/system/kaoyan", systemPort: 18133 });
  const supervisor = createOpenCodeSupervisor({
    command: "opencode", username: "user", password: "password", runtimeRoot: root, projectsRoot, registryFile: path.join(root, "workers", "registry.json"), portStart: 18150, portEnd: 18160, idleEvictionMs: 1,
    systemWorker: system, modelCatalogURL: "http://catalog", modelCatalogToken: "token", fetchCatalog: async () => MODELS, spawnProcess,
    fetch: async (url) => ({ ok: true, json: async () => String(url).includes("session/status") && busy ? { ses_busy: {} } : {} }), healthAttempts: 1, stopTimeoutMs: 1,
  });
  try {
    const workers = await Promise.all(Array.from({ length: 8 }, () => supervisor.ensurePortalWorker(9, "portal-user")));
    assert.equal(children.length, 1);
    assert.deepEqual(new Set(workers.map((worker) => worker.url)), new Set(["http://127.0.0.1:18150"]));
    assert.equal(workers[0].workspace, await realpath(path.join(projectsRoot, "users", "9")));
    assert.match(children[0].options.env.XDG_DATA_HOME, /workers\/user-9\/xdg\/data$/);
    busy = true;
    const observedAt = Date.now() + 10_000;
    await supervisor.evictIdleWorkers(observedAt);
    assert.deepEqual(supervisor.activeWorkerIds(), ["user-9"]);
    busy = false;
    await supervisor.evictIdleWorkers(observedAt + 2);
    assert.deepEqual(supervisor.activeWorkerIds(), ["user-9"]);
    await supervisor.evictIdleWorkers(observedAt + 4);
    assert.deepEqual(supervisor.activeWorkerIds(), []);
    const restored = await supervisor.ensurePortalWorker(9, "portal-user");
    assert.equal(restored.port, 18150);
    assert.equal(children.length, 2);
    assert.equal(children[0].options.env.XDG_DATA_HOME, children[1].options.env.XDG_DATA_HOME);
    const second = await supervisor.ensurePortalWorker(10, "other-user");
    assert.notEqual(second.root, restored.root);
    assert.notEqual(path.join(second.root, "xdg/data/opencode/opencode.db"), path.join(restored.root, "xdg/data/opencode/opencode.db"));
  } finally { await supervisor.stop(); await rm(root, { recursive: true }); }
});

test("waits through delayed health once and returns an already-ready worker immediately on warm ensure", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-delayed-health-"));
  const projectsRoot = path.join(root, "projects");
  await mkdir(projectsRoot);
  const spawned = [];
  let healthCalls = 0;
  function spawnProcess() {
    const child = new EventEmitter();
    child.exitCode = null;
    child.kill = () => { child.exitCode = 0; queueMicrotask(() => child.emit("exit", 0)); };
    spawned.push(child);
    return child;
  }
  const supervisor = createOpenCodeSupervisor({
    command: "opencode", username: "user", password: "password", runtimeRoot: root, projectsRoot,
    registryFile: path.join(root, "workers", "registry.json"), portStart: 18150, portEnd: 18160,
    systemWorker: systemWorker({ runtimeRoot: root, systemWorkspace: path.join(projectsRoot, "system", "kaoyan"), systemPort: 18133 }),
    modelCatalogURL: "http://catalog", modelCatalogToken: "token", fetchCatalog: async () => MODELS, spawnProcess,
    fetch: async (url) => {
      if (String(url).includes("global/health")) { healthCalls += 1; return { ok: healthCalls >= 3 }; }
      return { ok: true, json: async () => ({}) };
    },
    healthAttempts: 5, healthDelayMs: 1, healthRequestTimeoutMs: 10, stopTimeoutMs: 1,
  });
  try {
    const cold = await supervisor.ensurePortalWorker(88, "slow-user");
    assert.equal(cold.id, "user-88");
    assert.equal(healthCalls, 3);
    assert.equal(spawned.length, 1);
    const started = performance.now();
    const warm = await supervisor.ensurePortalWorker(88, "slow-user");
    assert.equal(warm.id, "user-88");
    assert.equal(spawned.length, 1);
    assert.equal(healthCalls, 3);
    assert.ok(performance.now() - started < 50);
  } finally { await supervisor.stop(); await rm(root, { recursive: true }); }
});

test("bounds a hung health probe, clears ensure state, and permits a clean retry", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hung-health-"));
  const projectsRoot = path.join(root, "projects");
  await mkdir(projectsRoot);
  const spawned = [];
  let hang = true;
  function spawnProcess() {
    const child = new EventEmitter();
    child.exitCode = null;
    child.kill = () => { child.exitCode = 0; queueMicrotask(() => child.emit("exit", 0)); };
    spawned.push(child);
    return child;
  }
  const supervisor = createOpenCodeSupervisor({
    command: "opencode", username: "user", password: "password", runtimeRoot: root, projectsRoot,
    registryFile: path.join(root, "workers", "registry.json"), portStart: 18150, portEnd: 18160,
    systemWorker: systemWorker({ runtimeRoot: root, systemWorkspace: path.join(projectsRoot, "system", "kaoyan"), systemPort: 18133 }),
    modelCatalogURL: "http://catalog", modelCatalogToken: "token", fetchCatalog: async () => MODELS, spawnProcess,
    fetch: async () => hang ? new Promise(() => {}) : { ok: true },
    healthAttempts: 1, healthDelayMs: 1, healthRequestTimeoutMs: 5, stopTimeoutMs: 1,
  });
  try {
    const started = performance.now();
    await assert.rejects(supervisor.ensurePortalWorker(89, "hung-user"), /did not become ready/);
    assert.ok(performance.now() - started < 100);
    assert.equal(supervisor.activeWorkerIds().length, 0);
    hang = false;
    const retried = await supervisor.ensurePortalWorker(89, "hung-user");
    assert.equal(retried.id, "user-89");
    assert.equal(spawned.length, 2);
  } finally { await supervisor.stop(); await rm(root, { recursive: true }); }
});

test("rescans changed project markers for an active worker without restart and skips unchanged scans", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-active-project-index-"));
  const projectsRoot = path.join(root, "projects");
  await mkdir(projectsRoot);
  const spawned = [];
  let projectScans = 0;
  function spawnProcess() {
    const child = new EventEmitter();
    child.exitCode = null;
    child.kill = () => { child.exitCode = 0; queueMicrotask(() => child.emit("exit", 0)); };
    spawned.push(child);
    return child;
  }
  const registryFile = path.join(root, "workers", "registry.json");
  const supervisor = createOpenCodeSupervisor({
    command: "opencode", username: "user", password: "password", runtimeRoot: root, projectsRoot, registryFile,
    portStart: 18150, portEnd: 18160,
    systemWorker: systemWorker({ runtimeRoot: root, systemWorkspace: path.join(projectsRoot, "system", "kaoyan"), systemPort: 18133 }),
    modelCatalogURL: "http://catalog", modelCatalogToken: "token", fetchCatalog: async () => MODELS, spawnProcess,
    fetch: async () => ({ ok: true, json: async () => ({}) }), healthAttempts: 1, stopTimeoutMs: 1,
    indexProjects: (...args) => { projectScans += 1; return indexPortalProjects(...args); },
  });
  try {
    const worker = await supervisor.ensurePortalWorker(90, "project-user");
    assert.equal(projectScans, 1);
    assert.equal(spawned.length, 1);

    await new Promise((resolve) => setTimeout(resolve, 10));
    const original = path.join(worker.workspace, "项目一");
    await mkdir(original);
    await writeFile(path.join(original, PROJECT_MARKER), JSON.stringify({ version: 1, projectId: "project-90-a", portalUserId: 90 }));
    await supervisor.ensurePortalWorker(90, "project-user");
    let stored = JSON.parse(await readFile(registryFile, "utf8")).workers.find((entry) => entry.portalUserId === 90);
    assert.deepEqual(stored.projects, [{ projectId: "project-90-a", currentPath: await realpath(original) }]);
    assert.equal(projectScans, 2);
    assert.equal(spawned.length, 1);

    await new Promise((resolve) => setTimeout(resolve, 10));
    const renamed = path.join(worker.workspace, "改名后的项目");
    await rename(original, renamed);
    await supervisor.ensurePortalWorker(90, "project-user");
    stored = JSON.parse(await readFile(registryFile, "utf8")).workers.find((entry) => entry.portalUserId === 90);
    assert.deepEqual(stored.projects, [{ projectId: "project-90-a", currentPath: await realpath(renamed) }]);
    assert.equal(projectScans, 3);
    assert.equal(spawned.length, 1);

    await supervisor.ensurePortalWorker(90, "project-user");
    assert.equal(projectScans, 3);
    assert.equal(spawned.length, 1);
  } finally { await supervisor.stop(); await rm(root, { recursive: true }); }
});
