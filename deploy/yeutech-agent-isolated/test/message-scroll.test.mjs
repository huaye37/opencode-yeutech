import assert from "node:assert/strict";
import test from "node:test";

import { isNearMessageBottom, reconcileAfterTerminal, scrollTopAfterPrepend } from "../web/src/message-scroll.js";

test("message bottom detection tolerates small rendering shifts", () => {
  assert.equal(isNearMessageBottom({ scrollHeight: 2_000, scrollTop: 1_304, clientHeight: 600 }), true);
  assert.equal(isNearMessageBottom({ scrollHeight: 2_000, scrollTop: 1_303, clientHeight: 600 }), false);
});

test("prepending older messages preserves the visible viewport anchor", () => {
  assert.equal(scrollTopAfterPrepend(40, 1_200, 2_000), 840);
  assert.equal(scrollTopAfterPrepend(40, 1_200, 1_100), 40);
});

test("terminal reconciliation waits for an older snapshot before fetching the final result", async () => {
  const calls = [];
  let finish;
  const inFlight = new Promise((resolve) => { finish = resolve; });
  const queued = reconcileAfterTerminal(inFlight, async () => { calls.push("final"); return "snapshot"; });
  await Promise.resolve();
  assert.deepEqual(calls, []);
  finish();
  assert.equal(await queued, "snapshot");
  assert.deepEqual(calls, ["final"]);
});
