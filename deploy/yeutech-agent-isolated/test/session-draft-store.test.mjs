import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createSessionDraftStore } from "../src/session-draft-store.mjs";

test("persists session drafts per portal user and project", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "yeutech-session-drafts-"));
  const databasePath = path.join(directory, "control.sqlite");
  try {
    let store = createSessionDraftStore(databasePath);
    const standalone = store.create(3, { title: " 独立草稿 ", modelId: "gpt-5.6-sol" });
    const project = store.create(3, { projectId: "project_alpha", title: "项目草稿", modelId: "gemini-3-flash" });
    store.create(4, { title: "另一用户" });
    assert.match(standalone.id, /^ses_local_[a-f0-9]{32}$/);
    assert.equal(project.projectId, "project_alpha");
    assert.equal(store.list(3).length, 2);
    assert.equal(store.get(4, standalone.id), null);
    store.close();

    store = createSessionDraftStore(databasePath);
    assert.deepEqual(new Set(store.list(3).map((draft) => draft.title)), new Set(["独立草稿", "项目草稿"]));
    assert.equal(store.rename(3, standalone.id, "刷新后仍存在").title, "刷新后仍存在");
    assert.equal(store.updateModel(3, standalone.id, "deepseek-v4-pro").model.id, "deepseek-v4-pro");
    assert.equal(store.removeProject(3, "project_alpha"), 1);
    assert.equal(store.list(3).length, 1);
    assert.equal(store.remove(4, standalone.id), false);
    assert.equal(store.remove(3, standalone.id), true);
    store.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
