#!/usr/bin/env node
import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { buildOpenCodeConfig } from "./generate-opencode-config.mjs";
import { fetchModelCatalog, runnableModels } from "./model-catalog.mjs";
import { activityLeasePath, readActivityLease, releaseActivityLease } from "./activity-lease.mjs";
import { indexPortalProjects, rebindOpenCodeWorkspace, resolvePortalWorkspace } from "./workspace-identity.mjs";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function bounded(promise, timeoutMs, fallback = null) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((resolve) => { timer = setTimeout(() => resolve(fallback), timeoutMs); })]);
  } finally { clearTimeout(timer); }
}
export const isSessionStatusIdle = (payload) => Boolean(payload) && typeof payload === "object" && !Array.isArray(payload) && Object.keys(payload).length === 0;

export async function isLoopbackPortAvailable(port) {
  const server = net.createServer();
  const available = await new Promise((resolve) => {
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => resolve(true));
  });
  if (available) await new Promise((resolve) => server.close(resolve));
  return available;
}

async function writeJsonAtomic(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp.${process.pid}.${Date.now()}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, file);
}

export function portalWorker(portalUserId, username, options) {
  const id = `user-${portalUserId}`;
  const root = path.join(options.runtimeRoot, "workers", id);
  const worker = { id, kind: "portal", portalUserId, username, workspace: options.workspace ?? path.join(options.projectsRoot, "users", String(portalUserId)), projects: options.projects, projectsScannedMtimeMs: options.projectsScannedMtimeMs, identityScannedAt: options.identityScannedAt, port: options.port, root, url: `http://127.0.0.1:${options.port}`, configFile: path.join(root, "config", "opencode.json"), stateFile: path.join(root, "reload-state.json"), logFile: path.join(root, "logs", "opencode.log") };
  return { ...worker, activityLeaseFile: activityLeasePath(worker) };
}

export function systemWorker(options) {
  const root = path.join(options.runtimeRoot, "workers", "system-kaoyan");
  const worker = { id: "system-kaoyan", kind: "system", workspace: options.systemWorkspace, port: options.systemPort, root, url: `http://127.0.0.1:${options.systemPort}`, configFile: path.join(root, "config", "opencode.json"), stateFile: path.join(root, "reload-state.json"), logFile: path.join(root, "logs", "opencode.log") };
  return { ...worker, activityLeaseFile: activityLeasePath(worker) };
}

export function createWorkerRegistry(options) {
  let loaded = false;
  let entries = new Map();
  let mutation = Promise.resolve();
  async function load() {
    if (loaded) return;
    const stored = JSON.parse(await readFile(options.file, "utf8").catch(() => "{\"version\":1,\"workers\":[]}"));
    entries = new Map((Array.isArray(stored.workers) ? stored.workers : []).filter((item) => item?.kind === "portal" && Number.isSafeInteger(item.portalUserId) && Number.isSafeInteger(item.port)).map((item) => [item.id, item]));
    loaded = true;
  }
  async function ensureUnsafe(portalUserId, username, touchAccess = true) {
    await load();
    const id = `user-${portalUserId}`;
    const current = entries.get(id);
    const legacyWorkspace = current?.currentPath ?? current?.workspace ?? options.legacyWorkspaces?.[portalUserId];
    const identityScanAge = Date.now() - Date.parse(current?.identityScannedAt ?? "");
    const trustCurrentWorkspace = Boolean(current) && Number.isFinite(identityScanAge) && identityScanAge < (options.identityRescanMs ?? 60_000);
    const discoveredWorkspace = await (options.resolveWorkspace ?? resolvePortalWorkspace)({ projectsRoot: options.projectsRoot, portalUserId, legacyWorkspace, trustCurrentWorkspace });
    if (current) {
      const updated = { ...current, username, lastAccessAt: touchAccess ? new Date().toISOString() : current.lastAccessAt };
      entries.set(id, updated);
      await writeJsonAtomic(options.file, { version: 1, workers: [...entries.values()].sort((a, b) => a.portalUserId - b.portalUserId) });
      return { ...updated, previousWorkspace: legacyWorkspace, discoveredWorkspace, identityScanPerformed: !trustCurrentWorkspace };
    }
    const occupied = new Set([...entries.values()].map((item) => item.port));
    occupied.add(options.systemPort);
    const candidates = Array.from({ length: options.portEnd - options.portStart + 1 }, (_, index) => options.portStart + index).filter((candidate) => !occupied.has(candidate));
    const checked = await Promise.all(candidates.map(async (candidate) => ({ candidate, available: await (options.isPortAvailable ?? isLoopbackPortAvailable)(candidate) })));
    const port = checked.find((item) => item.available)?.candidate;
    if (!port) throw new Error("No Agent worker port is available");
    const created = { id, kind: "portal", portalUserId, username, workspace: discoveredWorkspace, currentPath: discoveredWorkspace, projects: [], port, createdAt: new Date().toISOString(), lastAccessAt: new Date().toISOString() };
    entries.set(id, created);
    await writeJsonAtomic(options.file, { version: 1, workers: [...entries.values()].sort((a, b) => a.portalUserId - b.portalUserId) });
    return { ...created, previousWorkspace: discoveredWorkspace, discoveredWorkspace, identityScanPerformed: true };
  }
  async function ensure(portalUserId, username, options = {}) {
    const result = mutation.then(() => ensureUnsafe(portalUserId, username, options.touchAccess !== false));
    mutation = result.then(() => undefined, () => undefined);
    return result;
  }
  async function list() { await mutation; await load(); return [...entries.values()]; }
  async function updateLocation(id, currentPath, projects, projectsScannedMtimeMs, identityScannedAt) {
    const result = mutation.then(async () => {
      await load();
      const current = entries.get(id);
      if (!current) throw new Error(`Worker registry entry does not exist: ${id}`);
      const updated = { ...current, workspace: currentPath, currentPath, projects, projectsScannedMtimeMs, identityScannedAt: identityScannedAt ?? current.identityScannedAt };
      entries.set(id, updated);
      await writeJsonAtomic(options.file, { version: 1, workers: [...entries.values()].sort((a, b) => a.portalUserId - b.portalUserId) });
      return updated;
    });
    mutation = result.then(() => undefined, () => undefined);
    return result;
  }
  return { ensure, list, updateLocation };
}

export function createOpenCodeSupervisor(options) {
  const authorization = `Basic ${Buffer.from(`${options.username}:${options.password}`).toString("base64")}`;
  const children = new Map();
  const starting = new Map();
  const ensuring = new Map();
  const stopOperations = new Map();
  const activeWorkers = new Map();
  const idleSince = new Map();
  const admissionGenerations = new Map();
  const registry = options.registry ?? createWorkerRegistry({ file: options.registryFile, projectsRoot: options.projectsRoot, portStart: options.portStart, portEnd: options.portEnd, systemPort: options.systemWorker.port, legacyWorkspaces: options.legacyWorkspaces, resolveWorkspace: options.resolveWorkspace, identityRescanMs: options.identityRescanMs });
  let stopping = false;
  let desired = null;
  let systemReady = false;
  const state = (worker, status, detail = {}) => writeJsonAtomic(worker.stateFile, { worker: worker.id, status, checkedAt: new Date().toISOString(), ...detail });
  const fromEntry = (entry) => portalWorker(entry.portalUserId, entry.username, { runtimeRoot: options.runtimeRoot, projectsRoot: options.projectsRoot, workspace: entry.currentPath ?? entry.workspace, projects: entry.projects, projectsScannedMtimeMs: entry.projectsScannedMtimeMs, identityScannedAt: entry.identityScannedAt, port: entry.port });
  async function desiredConfig() {
    const models = await (options.fetchCatalog ?? fetchModelCatalog)({ baseURL: options.modelCatalogURL, token: options.modelCatalogToken });
    const configOptions = { baseURL: `${String(options.modelCatalogURL).replace(/\/$/, "")}/v1`, defaultModel: options.defaultModel };
    return {
      models,
      config: buildOpenCodeConfig(models, configOptions),
      systemConfig: buildOpenCodeConfig(models, { ...configOptions, readOnly: true }),
    };
  }
  const workerConfig = (worker, nextDesired) =>
    worker.kind === "system"
      ? nextDesired.systemConfig ?? nextDesired.config
      : nextDesired.config;
  async function health(worker) {
    for (let attempt = 0; attempt < (options.healthAttempts ?? 60); attempt += 1) {
      const child = children.get(worker.id);
      if (!child || child.exitCode !== null) throw new Error(`${worker.id} exited during startup`);
      const requestTimeoutMs = options.healthRequestTimeoutMs ?? 2_000;
      const probe = (options.fetch ?? fetch)(new URL("/global/health", worker.url), {
        headers: { authorization },
        signal: AbortSignal.timeout(requestTimeoutMs),
      }).catch(() => null);
      // Keep the supervisor bounded even when an injected/custom fetch ignores
      // AbortSignal. Native fetch is also aborted to release its socket.
      const response = await bounded(probe, requestTimeoutMs);
      if (response?.ok) return;
      await delay(options.healthDelayMs ?? 1_000);
    }
    throw new Error(`${worker.id} did not become ready`);
  }
  async function start(worker) {
    if (stopOperations.has(worker.id)) await stopOperations.get(worker.id);
    if (starting.has(worker.id)) return starting.get(worker.id);
    if (children.get(worker.id)?.exitCode === null) {
      if (activeWorkers.has(worker.id)) return;
      throw new Error(`${worker.id} still has an unresponsive previous process`);
    }
    const promise = (async () => {
      if (worker.kind === "system") await mkdir(worker.workspace, { recursive: true });
      for (const directory of [path.join(worker.root, "config"), path.join(worker.root, "logs"), ...["config", "data", "cache", "state"].map((name) => path.join(worker.root, "xdg", name))]) await mkdir(directory, { recursive: true });
      if (!desired) desired = await desiredConfig();
      if (!(await readFile(worker.configFile, "utf8").catch(() => ""))) await writeJsonAtomic(worker.configFile, workerConfig(worker, desired));
      const spawnOptions = { cwd: worker.workspace, env: { ...process.env, OPENCODE_CONFIG: worker.configFile, OPENCODE_CONFIG_DIR: path.dirname(worker.configFile), XDG_CONFIG_HOME: path.join(worker.root, "xdg", "config"), XDG_DATA_HOME: path.join(worker.root, "xdg", "data"), XDG_CACHE_HOME: path.join(worker.root, "xdg", "cache"), XDG_STATE_HOME: path.join(worker.root, "xdg", "state") } };
      const child = options.spawnProcess
        ? options.spawnProcess(options.command, ["serve", "--hostname", "127.0.0.1", "--port", String(worker.port)], { ...spawnOptions, stdio: "inherit" })
        : (() => {
          const output = openSync(worker.logFile, "a", 0o600);
          try { return spawn(options.command, ["serve", "--hostname", "127.0.0.1", "--port", String(worker.port)], { ...spawnOptions, stdio: ["ignore", output, output] }); }
          finally { closeSync(output); }
        })();
      children.set(worker.id, child);
      const reportProcessError = (error) => { void state(worker, "error", { message: error.message }).catch(() => undefined); };
      child.on("error", reportProcessError);
      let startupError;
      const childFailed = new Promise((_, reject) => {
        startupError = reject;
        child.once("error", startupError);
      });
      try { await Promise.race([health(worker), childFailed]); }
      catch (error) {
        const exited = await terminateChild(child);
        if (exited && children.get(worker.id) === child) children.delete(worker.id);
        activeWorkers.delete(worker.id);
        await state(worker, "error", { message: error.message });
        throw error;
      } finally { child.off("error", startupError); }
      // A process restart cannot have a still-running prompt from the old
      // process. Once the new OpenCode instance authoritatively reports an
      // empty status map, discard any persisted lease left by that crash.
      if (await readActivityLease(worker) && await runtimeIdle(worker)) await releaseActivityLease(worker);
      await state(worker, "current", { startedAt: new Date().toISOString() });
      activeWorkers.set(worker.id, worker);
      idleSince.delete(worker.id);
    })().finally(() => { if (starting.get(worker.id) === promise) starting.delete(worker.id); });
    starting.set(worker.id, promise);
    return promise;
  }
  const exited = (child) => child.exitCode !== null || child.signalCode != null;
  async function terminateChild(child) {
    if (exited(child)) return true;
    const exit = new Promise((resolve) => child.once("exit", () => resolve(true)));
    child.kill("SIGTERM");
    if (await bounded(exit, options.stopTimeoutMs ?? 15_000, false)) return true;
    if (!exited(child)) child.kill("SIGKILL");
    return exited(child) || await bounded(exit, options.killWaitMs ?? 5_000, false);
  }
  async function stop(worker, reason = "stopped") {
    if (stopOperations.has(worker.id)) return stopOperations.get(worker.id);
    const operation = (async () => {
      const child = children.get(worker.id);
      if (!child) return;
      if (!(await terminateChild(child))) throw new Error(`${worker.id} did not exit after SIGKILL`);
      if (children.get(worker.id) === child) children.delete(worker.id);
      activeWorkers.delete(worker.id);
      idleSince.delete(worker.id);
      await state(worker, reason, { stoppedAt: new Date().toISOString() });
    })().finally(() => stopOperations.delete(worker.id));
    stopOperations.set(worker.id, operation);
    return operation;
  }
  async function runtimeStatuses(worker) {
    const url = new URL("/session/status", worker.url);
    url.searchParams.set("directory", worker.workspace);
    const timeoutMs = options.idleRequestTimeoutMs ?? 2_000;
    const request = (options.fetch ?? fetch)(url, { headers: { authorization }, signal: AbortSignal.timeout(timeoutMs) }).catch(() => null);
    const response = await bounded(request, timeoutMs, null);
    if (!response?.ok) return null;
    const payload = await bounded(Promise.resolve().then(() => response.json()).catch(() => null), timeoutMs, null);
    return payload && typeof payload === "object" && !Array.isArray(payload) ? payload : null;
  }
  async function runtimeIdle(worker) {
    return isSessionStatusIdle(await runtimeStatuses(worker));
  }
  async function reconcileActivityLease(worker, statuses, now = Date.now()) {
    let lease = await readActivityLease(worker, now);
    if (!lease || !statuses) return lease;
    const activeSessionIds = new Set(Object.keys(statuses));
    const graceMs = options.leaseReconcileGraceMs ?? 30_000;
    const sessions = new Map();
    for (const activity of lease.activities || []) {
      const current = sessions.get(activity.sessionId) || 0;
      sessions.set(activity.sessionId, Math.max(current, Number(activity.touchedAt || 0)));
    }
    for (const [sessionId, touchedAt] of sessions) {
      if (!activeSessionIds.has(sessionId) && now - touchedAt >= graceMs) {
        lease = await releaseActivityLease(worker, { sessionId, now });
      }
    }
    return lease;
  }
  async function idle(worker) {
    const now = Date.now();
    const statuses = await runtimeStatuses(worker);
    if (!statuses) return false;
    if (await reconcileActivityLease(worker, statuses, now)) return false;
    return isSessionStatusIdle(statuses);
  }
  async function stopIfConfirmedIdle(worker, reason, stillEligible = () => true) {
    if (!(await idle(worker))) return false;
    await delay(options.idleConfirmationMs ?? 100);
    if (!(await idle(worker))) return false;
    if (!stillEligible()) return false;
    await stop(worker, reason);
    return true;
  }
  async function refresh(worker, nextDesired) {
    const current = await readFile(worker.configFile, "utf8").catch(() => "");
    const nextConfig = workerConfig(worker, nextDesired);
    const serialized = `${JSON.stringify(nextConfig, null, 2)}\n`;
    const ready = runnableModels(nextDesired.models).length;
    const detail = { discovered: nextDesired.models.length, ready, incomplete: nextDesired.models.length - ready };
    if (!current) { await writeJsonAtomic(worker.configFile, nextConfig); return state(worker, "current", detail); }
    if (current === serialized) return state(worker, "current", detail);
    if (children.get(worker.id)?.exitCode !== null) { await writeJsonAtomic(worker.configFile, nextConfig); return state(worker, "current", detail); }
    await state(worker, "pending-idle", detail);
    if (!(await stopIfConfirmedIdle(worker, "reloading"))) return;
    await writeJsonAtomic(worker.configFile, nextConfig);
    await start(worker);
    await state(worker, "current", { ...detail, reloadedAt: new Date().toISOString() });
  }
  async function preparePortalWorkerUnsafe(portalUserId, username, touchAccess) {
    if (!Number.isSafeInteger(portalUserId) || portalUserId <= 0) throw new Error("Portal user ID is invalid");
    if (!/^[a-zA-Z0-9._-]{1,80}$/.test(username)) throw new Error("Portal username is invalid");
    let entry = await registry.ensure(portalUserId, username, { touchAccess });
    const previousWorkspace = entry.previousWorkspace ?? entry.currentPath ?? entry.workspace;
    const discoveredWorkspace = entry.discoveredWorkspace ?? entry.currentPath ?? entry.workspace;
    // Validate every project marker before changing either SQLite or registry.
    // A project folder rename only changes this index; sessions remain bound to
    // the owner workspace root and must not be rewritten for project renames.
    const workspaceInfo = await stat(discoveredWorkspace);
    const shouldScanProjects = previousWorkspace !== discoveredWorkspace || !Array.isArray(entry.projects) || entry.projectsScannedMtimeMs !== workspaceInfo.mtimeMs;
    const projectIndex = shouldScanProjects ? (options.indexProjects ?? indexPortalProjects)(discoveredWorkspace, [], portalUserId) : null;
    const projects = projectIndex
      ? [...projectIndex.projects].map(([projectId, project]) => ({ projectId, currentPath: project.path }))
      : entry.projects;
    if (previousWorkspace !== discoveredWorkspace) {
      const previousWorker = fromEntry({ ...entry, currentPath: previousWorkspace });
      const child = children.get(previousWorker.id);
      if (child?.exitCode === null) {
        if (!(await stopIfConfirmedIdle(previousWorker, "workspace-rebinding"))) throw new Error(`Workspace for ${previousWorker.id} was renamed while its worker is busy`);
      }
      const databaseFile = path.join(previousWorker.root, "xdg", "data", "opencode", "opencode.db");
      if ((await stat(databaseFile).catch(() => null))?.isFile()) {
        await rebindOpenCodeWorkspace(databaseFile, previousWorkspace, discoveredWorkspace, {
          backupFile: path.join(previousWorker.root, "backups", `opencode.before-workspace-rebind-${Date.now()}.db`),
        });
      }
    }
    entry = await registry.updateLocation(entry.id, discoveredWorkspace, projects, workspaceInfo.mtimeMs, entry.identityScanPerformed ? new Date().toISOString() : entry.identityScannedAt);
    return fromEntry(entry);
  }
  async function preparePortalWorker(portalUserId, username) {
    return preparePortalWorkerUnsafe(portalUserId, username, false);
  }
  async function ensurePortalWorkerUnsafe(portalUserId, username) {
    const worker = await preparePortalWorkerUnsafe(portalUserId, username, true);
    await start(worker);
    // A fresh execution request is activity even before OpenCode publishes its
    // busy status. Do not carry an earlier idle observation across admission.
    idleSince.delete(worker.id);
    return worker;
  }
  async function ensurePortalWorker(portalUserId, username) {
    const id = `user-${portalUserId}`;
    if (stopOperations.has(id)) await stopOperations.get(id);
    admissionGenerations.set(id, (admissionGenerations.get(id) ?? 0) + 1);
    idleSince.delete(id);
    const active = activeWorkers.get(id);
    if (active && children.get(id)?.exitCode === null) {
      const workspaceInfo = await stat(active.workspace).catch(() => null);
      if (workspaceInfo?.isDirectory() && workspaceInfo.mtimeMs === active.projectsScannedMtimeMs) return active;
    }
    if (ensuring.has(id)) return ensuring.get(id);
    const promise = ensurePortalWorkerUnsafe(portalUserId, username).finally(() => ensuring.delete(id));
    ensuring.set(id, promise);
    return promise;
  }
  async function describePortalWorker(portalUserId, username) {
    if (!Number.isSafeInteger(portalUserId) || portalUserId <= 0) throw new Error("Portal user ID is invalid");
    if (!/^[a-zA-Z0-9._-]{1,80}$/.test(username)) throw new Error("Portal username is invalid");
    const entry = (await registry.list()).find((item) => item.portalUserId === portalUserId);
    if (!entry || entry.username !== username) return null;
    const worker = fromEntry(entry);
    return { ...worker, active: children.get(worker.id)?.exitCode === null };
  }
  async function evictIdleWorkers(now = Date.now()) {
    await Promise.all((await registry.list()).map(async (entry) => {
      const worker = fromEntry(entry);
      const generation = admissionGenerations.get(worker.id) ?? 0;
      if (children.get(worker.id)?.exitCode !== null) { idleSince.delete(worker.id); return; }
      if (!(await idle(worker))) { idleSince.delete(worker.id); return; }
      if ((admissionGenerations.get(worker.id) ?? 0) !== generation) return;
      const observation = idleSince.get(worker.id);
      if (!observation || observation.generation !== generation) {
        idleSince.set(worker.id, { observedAt: now, generation });
        return;
      }
      if (now - observation.observedAt < options.idleEvictionMs) return;
      const stillEligible = () => idleSince.get(worker.id) === observation
        && (admissionGenerations.get(worker.id) ?? 0) === generation;
      if (await stopIfConfirmedIdle(worker, "evicted-idle", stillEligible)) idleSince.delete(worker.id);
    }));
  }
  async function refreshAll(nextDesired) {
    desired = nextDesired;
    const workers = [options.systemWorker, ...(await registry.list()).map(fromEntry)];
    const concurrency = Math.max(1, Number(options.refreshConcurrency ?? 1));
    for (let index = 0; index < workers.length; index += concurrency) {
      await Promise.all(workers.slice(index, index + concurrency).map((worker) => refresh(worker, nextDesired).catch((error) => state(worker, "error", { message: error.message }))));
    }
  }
  async function run() {
    desired = await desiredConfig();
    await refresh(options.systemWorker, desired);
    await start(options.systemWorker);
    systemReady = true;
    while (!stopping) {
      try { await refreshAll(await desiredConfig()); } catch (error) { await state(options.systemWorker, "error", { message: error.message }); }
      await evictIdleWorkers();
      if (!stopping) await delay(options.intervalMs ?? 15_000);
    }
  }
  async function stopAll() { stopping = true; systemReady = false; await Promise.all([options.systemWorker, ...(await registry.list()).map(fromEntry)].map((worker) => stop(worker))); }
  return { run, stop: stopAll, idle, refresh, refreshAll, preparePortalWorker, ensurePortalWorker, describePortalWorker, evictIdleWorkers, isSystemReady: () => systemReady && children.get(options.systemWorker.id)?.exitCode === null, activeWorkerIds: () => [...children.keys()] };
}

export function createSupervisorControlServer(supervisor, token, options = {}) {
  if (typeof token !== "string" || token.length < 32) throw new Error("Supervisor control token must contain at least 32 characters");
  return http.createServer(async (request, response) => {
    const incoming = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.headers.authorization !== `Bearer ${token}`) { response.writeHead(401).end(); return; }
    if (request.method === "GET" && incoming.pathname === "/health") { response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true })); return; }
    if (request.method === "GET" && incoming.pathname === "/ready") {
      const ready = supervisor.isSystemReady();
      response.writeHead(ready ? 200 : 503, { "content-type": "application/json" }).end(JSON.stringify({ ready, systemWorker: "system-kaoyan" }));
      return;
    }
    if (request.method === "POST" && incoming.pathname === "/workers/describe") {
      try {
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        const payload = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
        const worker = await supervisor.describePortalWorker(Number(payload.portalUserId), String(payload.username || ""));
        response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(worker ? { id: worker.id, workspace: worker.workspace, url: worker.url, root: worker.root, configFile: worker.configFile, stateFile: worker.stateFile, activityLeaseFile: worker.activityLeaseFile, active: worker.active } : null));
      } catch (error) { response.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: error.message } })); }
      return;
    }
    if (request.method === "POST" && incoming.pathname === "/workers/prepare") {
      try {
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        const payload = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
        const worker = await supervisor.preparePortalWorker(Number(payload.portalUserId), String(payload.username || ""));
        response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ id: worker.id, workspace: worker.workspace, url: worker.url, root: worker.root, configFile: worker.configFile, stateFile: worker.stateFile, activityLeaseFile: worker.activityLeaseFile, active: supervisor.activeWorkerIds().includes(worker.id) }));
      } catch (error) { response.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: error.message } })); }
      return;
    }
    if (request.method !== "POST" || incoming.pathname !== "/workers/ensure") { response.writeHead(404).end(); return; }
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const payload = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      const pending = supervisor.ensurePortalWorker(Number(payload.portalUserId), String(payload.username || ""));
      // Do not hold a portal request for the whole cold OpenCode startup. The
      // same in-flight promise remains owned by the supervisor, so a retry
      // observes that work instead of spawning a second worker or losing it.
      const timeout = Symbol("ensure-timeout");
      const worker = await bounded(pending, options.ensureWaitMs ?? 5_000, timeout);
      if (worker === timeout) {
        pending.catch(() => undefined);
        response.writeHead(503, { "content-type": "application/json", "retry-after": String(options.retryAfterSeconds ?? 2) });
        response.end(JSON.stringify({ error: { code: "worker_starting", message: "Agent worker is still starting; retry this request" } }));
        return;
      }
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ id: worker.id, workspace: worker.workspace, url: worker.url, configFile: worker.configFile, stateFile: worker.stateFile, activityLeaseFile: worker.activityLeaseFile }));
    } catch (error) { response.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: error.message } })); }
  });
}

async function main() {
  const runtimeRoot = process.env.YEUTECH_AGENT_RUNTIME_ROOT || "/runtime";
  const system = systemWorker({ runtimeRoot, systemWorkspace: process.env.YEUTECH_SYSTEM_WORKSPACE, systemPort: Number(process.env.YEUTECH_SYSTEM_WORKER_PORT || 18133) });
  const supervisor = createOpenCodeSupervisor({ command: process.env.OPENCODE_BIN ?? "opencode", username: process.env.OPENCODE_SERVER_USERNAME, password: process.env.OPENCODE_SERVER_PASSWORD, modelCatalogURL: process.env.YEUTECH_CLI_PROXY_URL, modelCatalogToken: process.env.YEUTECH_CLI_PROXY_KEY, defaultModel: process.env.YEUTECH_DEFAULT_MODEL, intervalMs: Number(process.env.YEUTECH_MODEL_RELOAD_INTERVAL_MS ?? 15_000), idleEvictionMs: Number(process.env.YEUTECH_WORKER_IDLE_EVICTION_MS ?? 1_800_000), identityRescanMs: Number(process.env.YEUTECH_WORKSPACE_IDENTITY_RESCAN_MS ?? 60_000), refreshConcurrency: Number(process.env.YEUTECH_MODEL_REFRESH_CONCURRENCY ?? 1), runtimeRoot, projectsRoot: process.env.YEUTECH_AGENT_PROJECTS_ROOT || "/projects", registryFile: process.env.YEUTECH_WORKER_REGISTRY_FILE || path.join(runtimeRoot, "workers", "registry.json"), legacyWorkspaces: JSON.parse(process.env.YEUTECH_LEGACY_WORKSPACES_JSON || "{}"), portStart: Number(process.env.YEUTECH_WORKER_PORT_START ?? 18150), portEnd: Number(process.env.YEUTECH_WORKER_PORT_END ?? 18249), systemWorker: system });
  const control = createSupervisorControlServer(supervisor, process.env.YEUTECH_SUPERVISOR_TOKEN);
  await new Promise((resolve, reject) => { control.once("error", reject); control.listen(Number(process.env.YEUTECH_SUPERVISOR_PORT ?? 18141), "127.0.0.1", resolve); });
  const stop = () => { control.close(); void supervisor.stop(); };
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
  await supervisor.run();
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main().catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
