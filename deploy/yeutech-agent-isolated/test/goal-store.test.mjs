import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createGoalStore } from "../src/goal-store.mjs";

test("persists tenant-scoped goals with revision-safe lifecycle updates", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "yeutech-goals-"));
  const store = createGoalStore(path.join(directory, "goals.sqlite"));
  try {
    const goal = store.create(3, { scopeKey: "project:novel", objective: "交付可审阅候选稿", phase: "draft", acceptancePolicy: "novel-writing" });
    assert.equal(goal.revision, 1);
    assert.equal(store.get(7, goal.id), undefined);
    assert.equal(store.list(3, "project:novel").length, 1);
    const blocked = store.update(3, goal.id, { revision: 1, status: "blocked", blockReason: "缺少设定版本" });
    assert.equal(blocked.goal.revision, 2);
    assert.equal(blocked.goal.blockReason, "缺少设定版本");
    const stale = store.update(3, goal.id, { revision: 1, status: "complete" });
    assert.equal(stale.conflict, true);
    assert.equal(stale.goal.status, "blocked");
    const completed = store.update(3, goal.id, { revision: 2, status: "complete" });
    assert.equal(completed.goal.blockReason, null);
  } finally {
    store.close();
    await rm(directory, { recursive: true });
  }
});
