import test from "node:test";
import assert from "node:assert/strict";
import { modelVariant, reasoningVariant, serviceTier } from "../src/reasoning-preference.mjs";

test("reasoning variants use only declared levels and never silently downgrade", () => {
  const model = { reasoningEfforts: ["low", "high"] };
  assert.equal(reasoningVariant(model, "high"), "high");
  for (const value of [undefined, null, "", "default"]) assert.equal(reasoningVariant(model, value), undefined);
  assert.throws(() => reasoningVariant(model, "max"), { code: "reasoning_effort_unsupported", statusCode: 400 });
  assert.throws(() => reasoningVariant({}, "high"), { code: "reasoning_effort_unsupported" });
});

test("service tier combines independently with every reasoning level", () => {
  const model = { reasoningEfforts: ["high", "ultra"], serviceTiers: ["priority", "ultrafast"] };
  assert.equal(serviceTier(model, "ultrafast"), "ultrafast");
  assert.equal(modelVariant(model, "ultra", "ultrafast"), "ultra--service-ultrafast");
  assert.equal(modelVariant(model, "", "priority"), "service-priority");
  assert.equal(modelVariant(model, "high", ""), "high");
  assert.throws(() => serviceTier(model, "flex"), { code: "service_tier_unsupported", statusCode: 400 });
});
