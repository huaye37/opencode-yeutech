import assert from "node:assert/strict";
import test from "node:test";
import { createSessionPreferenceQueue } from "../web/src/session-preference-queue.js";

const initial = { modelId: "gpt-6-sol", reasoningEffort: "", serviceTier: "" };

test("rapid independent edits merge snapshots and send waits for the last save", async () => {
  const requests = [];
  const rendered = [];
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const queue = createSessionPreferenceQueue(async (id, value) => {
    requests.push({ id, ...value });
    await gate;
    return value;
  });
  const speed = queue.update("a", initial, { serviceTier: "priority" }, value => rendered.push(value));
  const reasoning = queue.update("a", initial, { reasoningEffort: "medium" }, value => rendered.push(value));
  let sent = false;
  const sending = queue.flush("a", initial).then(value => { sent = true; return value; });
  await Promise.resolve();
  assert.equal(sent, false);
  release();
  await Promise.all([speed, reasoning]);
  const expected = { ...initial, serviceTier: "priority", reasoningEffort: "medium" };
  assert.deepEqual(await sending, expected);
  assert.deepEqual(requests.at(-1), { id: "a", ...expected });
  assert.deepEqual(rendered.slice(1), [expected, expected]);
});

test("model changes reset incompatible values and subsequent edits use the new model", async () => {
  const queue = createSessionPreferenceQueue(async (_id, value) => value);
  const publish = () => {};
  const operations = [
    queue.update("a", initial, { serviceTier: "priority" }, publish),
    queue.update("a", initial, { modelId: "gemini-4-argon-high", reasoningEffort: "", serviceTier: "" }, publish),
    queue.update("a", initial, { reasoningEffort: "high" }, publish),
    queue.update("b", initial, { reasoningEffort: "low" }, publish),
  ];
  await Promise.all(operations);
  assert.deepEqual(await queue.flush("a"), { modelId: "gemini-4-argon-high", reasoningEffort: "high", serviceTier: "" });
  assert.deepEqual(await queue.flush("b"), { ...initial, reasoningEffort: "low" });
});

test("failed save rolls back to last confirmed values and blocks send until a successful retry", async () => {
  let fail = false;
  let displayed;
  const queue = createSessionPreferenceQueue(async (_id, value) => {
    if (fail) throw new Error("save unavailable");
    return value;
  });
  const publish = value => { displayed = value; };
  await queue.update("a", initial, { serviceTier: "priority" }, publish);
  fail = true;
  await assert.rejects(queue.update("a", initial, { modelId: "other", reasoningEffort: "", serviceTier: "" }, publish), /unavailable/);
  assert.deepEqual(displayed, { ...initial, serviceTier: "priority" });
  await assert.rejects(queue.flush("a"), /unavailable/);
  fail = false;
  await queue.update("a", initial, { reasoningEffort: "medium" }, publish);
  assert.deepEqual(await queue.flush("a"), { ...initial, reasoningEffort: "medium", serviceTier: "priority" });
});

test("later queued save retries the whole intended snapshot after an earlier failure", async () => {
  let count = 0;
  const queue = createSessionPreferenceQueue(async (_id, value) => {
    if (++count === 1) throw new Error("transient");
    return value;
  });
  const first = queue.update("a", initial, { serviceTier: "priority" }, () => {});
  const second = queue.update("a", initial, { reasoningEffort: "medium" }, () => {});
  await assert.rejects(first, /transient/);
  await second;
  assert.deepEqual(await queue.flush("a"), { ...initial, reasoningEffort: "medium", serviceTier: "priority" });
});
