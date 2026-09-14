import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { extendActivityLease, readActivityLease, releaseActivityLease, reserveActivityLease } from "../src/activity-lease.mjs";

test("persists a bounded worker activity lease across processes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-lease-"));
  const worker = { id: "user-3", activityLeaseFile: path.join(root, "lease.json") };
  try {
    const lease = await extendActivityLease(worker, { now: 1_000, durationMs: 5_000, sessionId: "ses_work", reasons: ["portal-prompt"] });
    assert.equal(lease.expiresAt, 6_000);
    assert.equal((await readActivityLease(worker, 5_999)).sessionId, "ses_work");
    assert.equal(await readActivityLease(worker, 6_000), null);
  } finally { await rm(root, { recursive: true }); }
});

test("serializes concurrent lease extensions without losing sessions or reasons", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-lease-concurrent-"));
  const worker = { id: "user-3", activityLeaseFile: path.join(root, "lease.json") };
  try {
    await Promise.all([
      extendActivityLease(worker, { durationMs: 5_000, sessionId: "ses_a", reasons: ["portal-prompt"] }),
      extendActivityLease(worker, { durationMs: 10_000, sessionId: "ses_b", reasons: ["system-task"] }),
    ]);
    const lease = await readActivityLease(worker);
    assert.equal(lease.version, 3);
    assert.deepEqual(lease.sessionIds, ["ses_a", "ses_b"]);
    assert.deepEqual(lease.reasons, ["portal-prompt", "system-task"]);
    assert.equal(lease.activities.length, 2);
    assert.ok(lease.expiresAt >= lease.touchedAt + 10_000);
  } finally { await rm(root, { recursive: true }); }
});

test("atomically reserves prompt capacity and rejects duplicate sessions", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-lease-reserve-"));
  const worker = { id: "user-3", activityLeaseFile: path.join(root, "lease.json") };
  try {
    const [left, right] = await Promise.all([
      reserveActivityLease(worker, { sessionId: "ses_a", maxActive: 1 }),
      reserveActivityLease(worker, { sessionId: "ses_b", maxActive: 1 }),
    ]);
    assert.equal([left, right].filter((item) => item.reserved).length, 1);
    assert.equal([left, right].filter((item) => item.capacityReached).length, 1);
    const active = (await readActivityLease(worker)).sessionIds[0];
    const duplicate = await reserveActivityLease(worker, { sessionId: active, maxActive: 2 });
    assert.equal(duplicate.sessionBusy, true);
  } finally { await rm(root, { recursive: true }); }
});

test("releases one activity without dropping other sessions and removes an empty lease", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-lease-release-"));
  const worker = { id: "user-3", activityLeaseFile: path.join(root, "lease.json") };
  try {
    await extendActivityLease(worker, { now: 1_000, durationMs: 10_000, sessionId: "ses_a", reasons: ["portal-prompt", "system-task"] });
    await extendActivityLease(worker, { now: 2_000, durationMs: 10_000, sessionId: "ses_b", reasons: ["system-task"] });
    const remaining = await releaseActivityLease(worker, { now: 3_000, sessionId: "ses_a", reasons: ["portal-prompt"] });
    assert.deepEqual(remaining.activities.map(({ sessionId, reason }) => [sessionId, reason]), [["ses_a", "system-task"], ["ses_b", "system-task"]]);
    await Promise.all([
      releaseActivityLease(worker, { now: 4_000, sessionId: "ses_a" }),
      extendActivityLease(worker, { now: 4_000, durationMs: 10_000, sessionId: "ses_c", reasons: ["portal-prompt"] }),
    ]);
    const concurrent = await readActivityLease(worker, 4_001);
    assert.deepEqual(concurrent.sessionIds, ["ses_b", "ses_c"]);
    assert.equal(await releaseActivityLease(worker, { now: 5_000 }), null);
    assert.equal(await readActivityLease(worker, 5_001), null);
  } finally { await rm(root, { recursive: true }); }
});

test("treats malformed lease JSON as active until a locked mutation repairs it", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-lease-malformed-"));
  const worker = { id: "user-3", activityLeaseFile: path.join(root, "lease.json") };
  try {
    await writeFile(worker.activityLeaseFile, "{not-json");
    const invalid = await readActivityLease(worker, 1_000);
    assert.equal(invalid.invalid, true);
    assert.equal(invalid.expiresAt, Number.MAX_SAFE_INTEGER);
    const repaired = await extendActivityLease(worker, { now: 1_000, durationMs: 5_000, sessionId: "ses_repaired", reasons: ["portal-prompt"] });
    assert.equal(repaired.invalid, undefined);
    assert.deepEqual(repaired.sessionIds, ["ses_repaired"]);
  } finally { await rm(root, { recursive: true }); }
});

test("treats only a missing lease file as inactive and surfaces other read failures", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-lease-read-error-"));
  try {
    assert.equal(await readActivityLease({ activityLeaseFile: path.join(root, "missing.json") }), null);
    await assert.rejects(
      readActivityLease({ activityLeaseFile: root }),
      (error) => error.code === "EISDIR",
    );
  } finally { await rm(root, { recursive: true }); }
});

test("rejects an explicitly empty activity reason set", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-lease-empty-reasons-"));
  const worker = { id: "user-3", activityLeaseFile: path.join(root, "lease.json") };
  try {
    await assert.rejects(extendActivityLease(worker, { sessionId: "ses_a", reasons: [] }), /reasons must not be empty/);
    await assert.rejects(releaseActivityLease(worker, { sessionId: "ses_a", reasons: [] }), /reasons must not be empty/);
  } finally { await rm(root, { recursive: true }); }
});
