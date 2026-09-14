import assert from "node:assert/strict";
import test from "node:test";
import { buildContextPack, compareReplay, evaluateEvidence, modelEligibility, runtimeBudget, WORKLOAD_PROFILES } from "../src/control-plane.mjs";

test("profiles make workload requirements and evidence gates explicit", () => {
  assert.deepEqual(WORKLOAD_PROFILES.map((profile) => profile.id), ["general-agent", "agent-code", "novel-writing", "kaoyan-system"]);
  const eligible = modelEligibility({ id: "gpt", selectable: true, modalities: { input: ["text"], output: ["text"] }, limit: { context: 128_000 }, runtimeCompatibility: { status: "verified" } }, "novel-writing");
  assert.equal(eligible.eligible, true);
  assert.equal(eligible.lifecycle.workloadApproved, true);
  const rejected = modelEligibility({ id: "image", selectable: true, modalities: { input: ["text"], output: ["image"] }, limit: { context: 16_000 } }, "general-agent");
  assert.deepEqual(rejected.reasons, ["missing-output:text", "context-too-small", "tools-unverified", "runtime-untested"]);
});

test("evidence gate never promotes a settled generation without workload evidence", () => {
  const settled = evaluateEvidence("agent-code", [{ type: "generation", status: "passed", reference: "session:1" }]);
  assert.equal(settled.state, "generation-settled");
  assert.equal(settled.interpretation, "recorded-evidence-only");
  assert.equal(settled.userAcceptance, "not-evaluated");
  assert.equal(settled.interpretation, "recorded-evidence-only");
  assert.equal(settled.userAcceptance, "not-evaluated");
  assert.deepEqual(settled.missing, ["diff", "test"]);
  const ready = evaluateEvidence("agent-code", [
    { type: "generation", status: "passed" }, { type: "diff", status: "passed" }, { type: "test", status: "passed" },
  ]);
  assert.equal(ready.state, "deliverable-ready");
});

test("context packs reference authoritative project sources with stable hashes", () => {
  const left = buildContextPack({ projectId: "novel", revision: 7, sources: [
    { path: "设定/人物.md", version: "sha:a" }, { path: "正文/第一章.md", version: "sha:b" },
  ] });
  const right = buildContextPack({ projectId: "novel", revision: 7, sources: [
    { path: "正文/第一章.md", version: "sha:b" }, { path: "设定/人物.md", version: "sha:a" },
  ] });
  assert.equal(left.hash, right.hash);
  assert.equal(left.kind, "verified-source-receipt");
  assert.equal(left.appliedToExecution, false);
  assert.equal(left.persisted, false);
  assert.equal(left.kind, "verified-source-receipt");
  assert.equal(left.appliedToExecution, false);
  assert.equal(left.persisted, false);
  assert.equal("content" in left.sources[0], false);
});

test("replay and runtime budget produce reviewable decisions", () => {
  const replay = compareReplay({ id: "old", metrics: { ttftMs: 1000, toolSuccess: 0.8 } }, { id: "new", metrics: { ttftMs: 800, toolSuccess: 0.9 } });
  assert.equal(replay.metrics.ttftMs.improved, true);
  assert.equal(replay.metrics.toolSuccess.improved, true);
  assert.equal(replay.kind, "metric-snapshot-comparison");
  assert.equal(replay.executedReplay, false);
  assert.equal(replay.persisted, false);
  assert.equal(replay.kind, "metric-snapshot-comparison");
  assert.equal(replay.executedReplay, false);
  assert.equal(replay.persisted, false);
  const budget = runtimeBudget({ requestedInteractiveWorkers: 21 });
  assert.equal(budget.maxInteractiveWorkers, 19);
  assert.equal(budget.withinBudget, false);
  assert.equal(budget.overflowWorkers, 2);
});
