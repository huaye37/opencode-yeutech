import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createForkReviewStore } from "../src/fork-review-store.mjs";

test("persists tenant-scoped fork execution and revision-safe review decisions", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "yeutech-fork-review-"));
  try {
    const databasePath = path.join(root, "control.sqlite");
    let store = createForkReviewStore(databasePath);
    const created = store.create({
      id: "fork_0123456789abcdef0123456789abcdef",
      portalUserId: 3,
      sourceSessionId: "ses_source123",
      directory: path.join(root, "sandbox"),
      mode: "candidate",
      request: { instruction: "Try an alternative" },
    });
    assert.equal(created.status, "queued");
    assert.equal(created.revision, 1);
    assert.equal("directory" in created, false);
    assert.equal(store.get(4, created.id), null);
    const running = store.transition(3, created.id, 1, "running", { forkSessionId: "ses_fork1234" }).run;
    assert.equal(running.revision, 2);
    const reviewable = store.transition(3, created.id, 2, "awaiting_review", { result: { diffReference: "/safe/review/1" } }).run;
    assert.equal(reviewable.status, "awaiting_review");
    assert.equal(store.transition(3, created.id, 2, "accepted", { review: { decision: "accepted" } }).conflict, true);
    const accepted = store.transition(3, created.id, 3, "accepted", { review: { decision: "accepted", actor: "portal-user" } }).run;
    assert.equal(accepted.review.decision, "accepted");
    store.close();
    store = createForkReviewStore(databasePath);
    assert.equal(store.get(3, created.id).status, "accepted");
    assert.throws(() => store.transition(3, created.id, 4, "running"), /Unsupported fork transition/);
    store.close();
  } finally { await rm(root, { recursive: true }); }
});
