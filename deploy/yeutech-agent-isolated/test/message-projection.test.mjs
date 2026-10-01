import assert from "node:assert/strict";
import test from "node:test";
import { dedupeProjectedMessages, latestProjectedMessageWindow, trajectoryForVisibleMessages } from "../web/src/message-projection.js";

test("deduplicates the same historical and runtime projection while preserving real repeated turns", () => {
  const duplicate = { role: "user", text: "简述一下", createdAt: 100, attachments: [], origin: "history" };
  const runtime = { ...duplicate, id: "runtime", origin: "runtime" };
  const intentionalRepeat = { ...duplicate, id: "later", createdAt: 101, origin: "runtime" };
  assert.deepEqual(dedupeProjectedMessages([duplicate, runtime, intentionalRepeat]).map((item) => item.id), ["runtime", "later"]);
});

test("keeps only the latest ten records visible until older history is requested", () => {
  const messages = Array.from({ length: 20 }, (_, index) => ({ id: `m${index + 1}`, role: index % 2 ? "assistant" : "user", text: String(index + 1), createdAt: index + 1, origin: index < 10 ? "history" : "passive" }));
  const window = latestProjectedMessageWindow(messages, 10);
  assert.deepEqual(window.visible.map((item) => item.id), messages.slice(-10).map((item) => item.id));
  assert.deepEqual(window.overflow.map((item) => item.id), messages.slice(0, 10).map((item) => item.id));
});

test("keeps a continued runtime message even when its old-history counterpart is absent", () => {
  const messages = [
    { id: "historical", role: "assistant", text: "旧记录", createdAt: 1, origin: "history" },
    { id: "passive-runtime-current", role: "assistant", text: "方案 C 优化点", createdAt: 2, origin: "passive-runtime" },
  ];
  assert.deepEqual(dedupeProjectedMessages(messages).map((item) => item.id), ["historical", "passive-runtime-current"]);
});

test("limits historical tools to the currently visible prefixed runtime message window", () => {
  const messages = [{ id: "passive-runtime-msg-new", role: "assistant", text: "done", createdAt: 200 }];
  const trajectory = [
    { id: "tool:msg-old:a", type: "tool", at: 100 },
    { id: "tool:msg-new:b", type: "tool", at: 210 },
    { id: "subagent:old", type: "subagent", at: 90 },
    { id: "subagent:new", type: "subagent", at: 220 },
  ];
  assert.deepEqual(trajectoryForVisibleMessages(trajectory, messages).map((item) => item.id), ["tool:msg-new:b", "subagent:new"]);
});
