import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createSystemTaskStore } from "../src/system-task-store.mjs";

function task(id, sessionKey = "grading:one") {
  return {
    id, idempotencyKey: id, sessionKey, runtimeSessionID: `ses_${sessionKey.replaceAll(/[^A-Za-z0-9]/g, "")}`,
    kind: "grading", modelID: "ready-model", prompt: "grade", promptMessageID: `msg_${id}`, status: "submitting",
  };
}

test("keeps terminal system-task states terminal until an atomic resume reservation", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "system-task-store-"));
  const store = createSystemTaskStore(path.join(root, "tasks.sqlite"));
  try {
    const created = store.reserve(task("task_one"), 2).task;
    assert.equal(created.status, "submitting");
    assert.equal(store.update(created.id, "running").status, "running");
    assert.equal(store.update(created.id, "stopped").status, "stopped");
    assert.equal(store.update(created.id, "completed").status, "stopped");

    const resumed = store.reserveResume(created.id, "msg_resume", "ready-model", "resume", 2);
    assert.equal(resumed.task.status, "submitting");
    assert.equal(store.reserveResume(created.id, "msg_duplicate", "ready-model", "duplicate", 2).alreadyActive, true);
    assert.equal(store.update(created.id, "running").status, "running");
    assert.equal(store.update(created.id, "completed").status, "completed");
    assert.equal(store.update(created.id, "failed", "late error").status, "completed");
  } finally { store.close(); await rm(root, { recursive: true }); }
});

test("atomically rejects capacity and same-session concurrency", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "system-task-capacity-"));
  const store = createSystemTaskStore(path.join(root, "tasks.sqlite"));
  try {
    assert.ok(store.reserve(task("task_a", "grading:a"), 2).task);
    assert.equal(store.reserve(task("task_same", "grading:a"), 2).sessionBusy, true);
    assert.ok(store.reserve(task("task_b", "grading:b"), 2).task);
    assert.equal(store.reserve(task("task_c", "grading:c"), 2).capacityReached, true);
  } finally { store.close(); await rm(root, { recursive: true }); }
});

test("attempt-scoped updates cannot overwrite a resumed attempt", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "system-task-attempt-cas-"));
  const store = createSystemTaskStore(path.join(root, "tasks.sqlite"));
  try {
    const created = store.reserve(task("task_attempt"), 2).task;
    assert.equal(store.updateAttemptStatus(created.id, created.prompt_message_id, "running").status, "running");
    assert.equal(store.update(created.id, "stopped").status, "stopped");
    const resumed = store.reserveResume(created.id, "msg_current", "ready-model", "resume", 2).task;
    assert.equal(resumed.status, "submitting");
    assert.equal(store.updateAttemptStatus(created.id, created.prompt_message_id, "completed").status, "submitting");
    assert.equal(store.updateAttemptStatus(created.id, created.prompt_message_id, "failed", "late failure").status, "submitting");
    const completed = store.updateAttemptStatus(created.id, "msg_current", "completed");
    assert.equal(completed.status, "completed");
    assert.equal(completed.error, null);
  } finally { store.close(); await rm(root, { recursive: true }); }
});
