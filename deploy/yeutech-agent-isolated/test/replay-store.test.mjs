import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createReplayStore } from "../src/replay-store.mjs";

test("persists tenant-scoped executed replay lifecycle without exposing its directory", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "yeutech-replay-"));
  try {
    const store = createReplayStore(path.join(root, "control.sqlite"));
    const created = store.create({ id: "replay_0123456789abcdef0123456789abcdef", portalUserId: 3, sourceSessionId: "ses_source", directory: path.join(root, "sandbox"), modelId: "dynamic-model", workload: "agent-code", baseline: { id: "ses_source", metrics: { tokens: 10 } } });
    assert.equal(created.status, "queued");
    assert.equal("directory" in created, false);
    assert.equal(store.get(created.id, 4), null);
    const completed = store.update(created.id, 3, "completed", { replaySessionId: "ses_replay", result: { executedReplay: true } });
    assert.equal(completed.replaySessionId, "ses_replay");
    assert.equal(completed.result.executedReplay, true);
    store.close();
  } finally { await rm(root, { recursive: true }); }
});
