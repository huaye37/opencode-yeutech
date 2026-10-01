import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createSessionPolicyStore } from "../src/session-policy-store.mjs";

test("persists permission mode per user and session", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "session-policy-"));
  const file = path.join(root, "control.sqlite");
  try {
    let store = createSessionPolicyStore(file);
    assert.equal(store.get(3, "ses_one"), "smart");
    store.set(3, "ses_one", "full");
    store.setModel(3, "ses_one", "gemini-3-flash");
    store.setReasoning(3, "ses_one", "high");
    store.set(4, "ses_one", "ask");
    store.close();
    store = createSessionPolicyStore(file);
    assert.equal(store.get(3, "ses_one"), "full");
    assert.equal(store.getModel(3, "ses_one"), "gemini-3-flash");
    assert.equal(store.getReasoning(3, "ses_one"), "high");
    assert.equal(store.get(4, "ses_one"), "ask");
    assert.equal(store.get(3, "ses_two"), "smart");
    assert.deepEqual(store.list(3).map(({ sessionId, permissionMode, modelId }) => ({ sessionId, permissionMode, modelId })), [
      { sessionId: "ses_one", permissionMode: "full", modelId: "gemini-3-flash" },
    ]);
    store.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("adds model preferences to an existing permission-only database", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "session-policy-upgrade-"));
  const file = path.join(root, "control.sqlite");
  try {
    const legacy = new DatabaseSync(file);
    legacy.exec("CREATE TABLE session_policies (portal_user_id INTEGER NOT NULL, session_id TEXT NOT NULL, permission_mode TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (portal_user_id, session_id))");
    legacy.prepare("INSERT INTO session_policies VALUES (?, ?, ?, ?)").run(3, "ses_old", "full", 1);
    legacy.close();
    const store = createSessionPolicyStore(file);
    assert.equal(store.get(3, "ses_old"), "full");
    assert.equal(store.getModel(3, "ses_old"), null);
    assert.equal(store.setModel(3, "ses_old", "gpt-5.6-sol"), "gpt-5.6-sol");
    store.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});
