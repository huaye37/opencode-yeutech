import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createSessionInboxStore } from "../src/session-inbox-store.mjs";

test("keeps queued session prompts durable and FIFO across restart", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "session-inbox-"));
  const file = path.join(root, "control.sqlite");
  try {
    let store = createSessionInboxStore(file);
    const first = store.enqueue({ portalUserId: 3, username: "ryan", sessionId: "ses_one", payload: { parts: [{ text: "one" }] } });
    const second = store.enqueue({ portalUserId: 3, username: "ryan", sessionId: "ses_one", payload: { parts: [{ text: "two" }] } });
    const duplicate = store.enqueue({ portalUserId: 3, username: "ryan", sessionId: "ses_one", payload: { parts: [{ text: "two" }] } });
    assert.equal(first.position, 1);
    assert.equal(second.position, 2);
    assert.equal(duplicate.id, second.id);
    assert.equal(duplicate.position, 2);
    assert.equal(duplicate.duplicate, true);
    assert.deepEqual(store.pending().map((item) => item.id), [first.id, second.id]);
    assert.deepEqual(store.forSession(3, "ses_one").map((item) => [item.id, item.position]), [[first.id, 1], [second.id, 2]]);
    assert.deepEqual(store.forSession(4, "ses_one"), []);
    assert.equal(store.claim(first.id).status, "submitting");
    store.close();
    store = createSessionInboxStore(file);
    assert.deepEqual(store.pending().map((item) => item.id), [first.id, second.id]);
    assert.equal(store.complete(store.claim(first.id).id), true);
    assert.equal(store.pending()[0].id, second.id);
    store.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});
