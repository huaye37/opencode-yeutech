import assert from "node:assert/strict";
import test from "node:test";

import { sortSessionsByUpdatedAt } from "../web/src/session-ordering.js";

test("sorts project sessions newest first without mutating the source", () => {
  const source = [
    { id: "older", updatedAt: 10 },
    { id: "newer", updatedAt: 30 },
    { id: "middle", updatedAt: 20 },
  ];

  assert.deepEqual(sortSessionsByUpdatedAt(source).map((item) => item.id), ["newer", "middle", "older"]);
  assert.deepEqual(source.map((item) => item.id), ["older", "newer", "middle"]);
});

test("uses a stable id order when timestamps are absent or equal", () => {
  assert.deepEqual(sortSessionsByUpdatedAt([
    { id: "b" },
    { id: "a", updatedAt: 0 },
  ]).map((item) => item.id), ["a", "b"]);
});
