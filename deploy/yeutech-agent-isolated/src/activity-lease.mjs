import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const leaseMutations = new Map();

export function activityLeasePath(worker) {
  return worker.activityLeaseFile || path.join(worker.root || path.dirname(worker.stateFile), "activity-lease.json");
}

export async function readActivityLease(worker, now = Date.now()) {
  let serialized;
  try {
    serialized = await readFile(activityLeasePath(worker), "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  let lease;
  try { lease = JSON.parse(serialized); }
  catch {
    return {
      version: 0,
      invalid: true,
      worker: worker.id || null,
      activities: [],
      reasons: ["invalid-lease"],
      sessionId: null,
      sessionIds: [],
      touchedAt: now,
      expiresAt: Number.MAX_SAFE_INTEGER,
    };
  }
  if (!lease) return null;
  const activities = normalizeActivities(lease).filter((activity) => activity.expiresAt > now);
  return activities.length > 0 ? summarizeLease(worker, activities) : null;
}

export async function writeActivityLease(worker, lease) {
  const file = activityLeasePath(worker);
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp.${process.pid}.${Date.now()}`;
  await writeFile(temporary, `${JSON.stringify(lease, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, file);
}

async function withLeaseFileLock(file, operation, options = {}) {
  const lock = `${file}.lock`;
  const attempts = options.lockAttempts ?? 100;
  const retryMs = options.lockRetryMs ?? 10;
  const staleMs = options.staleLockMs ?? 30_000;
  await mkdir(path.dirname(file), { recursive: true });
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await mkdir(lock);
      try { return await operation(); }
      finally { await rm(lock, { recursive: true, force: true }); }
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const info = await stat(lock).catch(() => null);
      if (info && Date.now() - info.mtimeMs > staleMs) {
        await rm(lock, { recursive: true, force: true }).catch(() => undefined);
        continue;
      }
      await delay(retryMs);
    }
  }
  throw new Error(`Timed out acquiring activity lease lock: ${file}`);
}

function normalizeActivities(lease) {
  if (lease?.version === 3 && Array.isArray(lease.activities)) {
    return lease.activities.flatMap((activity) => {
      const sessionId = String(activity?.sessionId || "");
      const reason = String(activity?.reason || "");
      const touchedAt = Number(activity?.touchedAt || 0);
      const expiresAt = Number(activity?.expiresAt || 0);
      return sessionId && reason && Number.isFinite(touchedAt) && Number.isFinite(expiresAt)
        ? [{ sessionId, reason, touchedAt, expiresAt }]
        : [];
    });
  }
  const sessionIds = [...new Set([...(lease?.sessionIds || []), lease?.sessionId].filter(Boolean).map(String))];
  const reasons = [...new Set((lease?.reasons || ["agent-execution"]).filter(Boolean).map(String))];
  return sessionIds.flatMap((sessionId) => reasons.map((reason) => ({
    sessionId,
    reason,
    touchedAt: Number(lease?.touchedAt || 0),
    expiresAt: Number(lease?.expiresAt || 0),
  })));
}

function summarizeLease(worker, activities) {
  const ordered = [...activities].sort((left, right) => left.sessionId.localeCompare(right.sessionId) || left.reason.localeCompare(right.reason));
  const latest = ordered.reduce((current, activity) => !current || activity.touchedAt >= current.touchedAt ? activity : current, null);
  return {
    version: 3,
    worker: worker.id || null,
    activities: ordered,
    reasons: [...new Set(ordered.map((activity) => activity.reason))].sort(),
    sessionId: latest?.sessionId || null,
    sessionIds: [...new Set(ordered.map((activity) => activity.sessionId))].sort(),
    touchedAt: Math.max(...ordered.map((activity) => activity.touchedAt)),
    expiresAt: Math.max(...ordered.map((activity) => activity.expiresAt)),
  };
}

function activityReasons(value, fallback) {
  const reasons = [...new Set((value ?? fallback).filter(Boolean).map(String))];
  if (reasons.length === 0) throw new Error("Activity lease reasons must not be empty");
  return reasons;
}

async function mutateActivityLease(worker, options, operation) {
  const file = activityLeasePath(worker);
  const previous = leaseMutations.get(file) ?? Promise.resolve();
  const mutation = previous.then(() => withLeaseFileLock(file, operation, options));
  const tail = mutation.then(() => undefined, () => undefined);
  leaseMutations.set(file, tail);
  try { return await mutation; }
  finally {
    if (leaseMutations.get(file) === tail) leaseMutations.delete(file);
  }
}

export async function extendActivityLease(worker, options = {}) {
  return mutateActivityLease(worker, options, async () => {
    const now = options.now ?? Date.now();
    const durationMs = options.durationMs ?? 6 * 60 * 60 * 1_000;
    const current = await readActivityLease(worker, now);
    const sessionId = String(options.sessionId || "");
    if (!sessionId) throw new Error("Activity lease sessionId is required");
    const reasons = activityReasons(options.reasons, ["agent-execution"]);
    const activities = normalizeActivities(current).filter((activity) => activity.expiresAt > now);
    for (const reason of reasons) {
      const existing = activities.find((activity) => activity.sessionId === sessionId && activity.reason === reason);
      if (existing) {
        existing.touchedAt = now;
        existing.expiresAt = Math.max(existing.expiresAt, now + durationMs);
      } else activities.push({ sessionId, reason, touchedAt: now, expiresAt: now + durationMs });
    }
    const lease = summarizeLease(worker, activities);
    await writeActivityLease(worker, lease);
    return lease;
  });
}

export async function reserveActivityLease(worker, options = {}) {
  return mutateActivityLease(worker, options, async () => {
    const now = options.now ?? Date.now();
    const durationMs = options.durationMs ?? 6 * 60 * 60 * 1_000;
    const sessionId = String(options.sessionId || "");
    if (!sessionId) throw new Error("Activity lease sessionId is required");
    const reasons = activityReasons(options.reasons, ["agent-execution"]);
    const current = await readActivityLease(worker, now);
    const activities = normalizeActivities(current).filter((activity) => activity.expiresAt > now);
    if (activities.some((activity) => activity.sessionId === sessionId)) return { reserved: false, sessionBusy: true, lease: current };
    const activeSessions = new Set(activities.map((activity) => activity.sessionId));
    if (activeSessions.size >= Number(options.maxActive ?? 2)) return { reserved: false, capacityReached: true, lease: current };
    for (const reason of reasons) activities.push({ sessionId, reason, touchedAt: now, expiresAt: now + durationMs });
    const lease = summarizeLease(worker, activities);
    await writeActivityLease(worker, lease);
    return { reserved: true, lease };
  });
}

export async function releaseActivityLease(worker, options = {}) {
  return mutateActivityLease(worker, options, async () => {
    const now = options.now ?? Date.now();
    const sessionId = options.sessionId ? String(options.sessionId) : null;
    const reasons = options.reasons ? new Set(activityReasons(options.reasons, [])) : null;
    const current = await readActivityLease(worker, now);
    const activities = normalizeActivities(current).filter((activity) => {
      if (activity.expiresAt <= now) return false;
      const sessionMatches = sessionId === null || activity.sessionId === sessionId;
      const reasonMatches = reasons === null || reasons.has(activity.reason);
      return !(sessionMatches && reasonMatches);
    });
    if (activities.length === 0) {
      await rm(activityLeasePath(worker), { force: true });
      return null;
    }
    const lease = summarizeLease(worker, activities);
    await writeActivityLease(worker, lease);
    return lease;
  });
}
