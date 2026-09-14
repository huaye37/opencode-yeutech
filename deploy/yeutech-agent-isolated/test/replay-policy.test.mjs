import assert from "node:assert/strict";
import test from "node:test";
import { auditReplayTrajectory, buildReplayPrompt, buildReplayToolPolicy, isReplayToolAllowed, REPLAY_READ_ONLY_TOOLS } from "../src/replay-policy.mjs";

test("builds an OpenCode prompt policy with wildcard deny before explicit read-only allows", () => {
  const policy = buildReplayToolPolicy(["read", "bash", "webfetch", "mcp_publish", "task", "edit", "read"]);
  assert.deepEqual(Object.entries(policy.tools).slice(0, 1), [["*", false]]);
  for (const tool of REPLAY_READ_ONLY_TOOLS) assert.equal(policy.tools[tool], true);
  for (const tool of ["bash", "webfetch", "mcp_publish", "task", "edit"]) assert.equal(policy.tools[tool], false);
  assert.equal(policy.mode, "deny-by-default");
});

test("denies unknown and external side-effect tools instead of relying on a fixed blacklist", () => {
  for (const tool of ["write", "apply_patch", "bash", "webfetch", "websearch", "task", "question", "todowrite", "skill", "mcp_remote", "future_destructive_tool"]) {
    assert.equal(isReplayToolAllowed(tool), false, tool);
  }
  for (const tool of REPLAY_READ_ONLY_TOOLS) assert.equal(isReplayToolAllowed(tool), true, tool);
});

test("builds a directly usable prompt_async body and preserves deny-before-allow order", () => {
  const value = buildReplayPrompt({ modelId: "gpt-5.6-sol", prompt: "Review the result", sourceSessionId: "ses_source", discoveredToolIds: ["read", "bash"] });
  assert.deepEqual(Object.keys(value.body.tools).slice(0, 2), ["*", "bash"]);
  assert.equal(value.body.tools.read, true);
  assert.match(value.body.parts[0].text, /replay-readonly-v1/);
  assert.match(value.body.parts[0].text, /ses_source/);
});

test("fails closed when the resulting trajectory reports any non-read-only tool", () => {
  const audit = auditReplayTrajectory([
    { id: "one", type: "tool", tool: "read", status: "completed" },
    { id: "two", type: "tool", tool: "webfetch", status: "completed" },
    { id: "three", type: "tool", status: "completed" },
  ]);
  assert.equal(audit.compliant, false);
  assert.deepEqual(audit.violations.map((item) => item.reason), ["tool-not-read-only", "tool-identity-missing"]);
  assert.equal(auditReplayTrajectory([{ type: "tool", tool: "grep" }]).compliant, true);
});

test("rejects malformed catalogs and tool identifiers", () => {
  assert.throws(() => buildReplayToolPolicy("bash"), /catalog/);
  assert.throws(() => buildReplayToolPolicy(["bad tool"]), /tool ID/);
});
