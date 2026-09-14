import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createProjectPreferenceStore } from "../src/project-preference-store.mjs";

test("persists tenant-scoped project names and reversible removal state", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "yeutech-project-prefs-"));
  const store = createProjectPreferenceStore(path.join(root, "control.sqlite"));
  try {
    assert.equal(store.get(3, "project_alpha"), null);
    assert.equal(store.rename(3, "project_alpha", "家庭网络").displayName, "家庭网络");
    assert.equal(store.setHidden(3, "project_alpha", true).hidden, true);
    assert.equal(store.get(7, "project_alpha"), null);
    assert.equal(store.setHidden(3, "project_alpha", false).hidden, false);
    assert.equal(store.get(3, "project_alpha").displayName, "家庭网络");
  } finally { store.close(); await rm(root, { recursive: true }); }
});
