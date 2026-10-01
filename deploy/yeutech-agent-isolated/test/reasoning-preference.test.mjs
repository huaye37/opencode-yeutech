import test from "node:test";
import assert from "node:assert/strict";
import { reasoningVariant } from "../src/reasoning-preference.mjs";

test("reasoning variants use only declared levels and never silently downgrade", () => {
  const model = { reasoningEfforts: ["low", "high"] };
  assert.equal(reasoningVariant(model, "high"), "high");
  for (const value of [undefined, null, "", "default"]) assert.equal(reasoningVariant(model, value), undefined);
  assert.throws(() => reasoningVariant(model, "max"), { code: "reasoning_effort_unsupported", statusCode: 400 });
  assert.throws(() => reasoningVariant({}, "high"), { code: "reasoning_effort_unsupported" });
});
