import assert from "node:assert/strict";
import test from "node:test";
import { buildOpenCodeConfig } from "../src/generate-opencode-config.mjs";
import { isConversationModel, normalizeModelCatalog } from "../src/model-catalog.mjs";

test("filters image and dedicated review models", () => {
  assert.equal(isConversationModel("gpt-5.6-sol"), true);
  assert.equal(isConversationModel("codex-auto-review"), false);
  assert.equal(isConversationModel("gemini-image-preview"), false);
  assert.equal(isConversationModel("myimageish-model"), true);
});

test("normalizes, deduplicates, and sorts catalog", () => {
  const result = normalizeModelCatalog({ data: [
    { id: "z-chat" },
    { id: "codex-auto-review" },
    { id: "a-chat" },
    { id: "z-chat" },
    { id: "foo-image" },
  ] });
  assert.deepEqual(result, ["a-chat", "z-chat"]);
});

test("builds read-only OpenCode provider config", () => {
  const config = buildOpenCodeConfig(["gpt-5.6-sol", "gpt-5.6-terra"]);
  assert.equal(config.model, "yeutech/gpt-5.6-sol");
  assert.equal(config.permission.edit, "deny");
  assert.equal(config.permission.bash, "deny");
  assert.equal(config.provider.yeutech.options.baseURL, "http://cliproxy:8317/v1");
  assert.equal(config.provider.yeutech.options.apiKey, "{env:YEUTECH_CLI_PROXY_KEY}");
  assert.deepEqual(Object.keys(config.provider.yeutech.models), ["gpt-5.6-sol", "gpt-5.6-terra"]);
});

test("falls back to the first dynamic model when the preferred default is absent", () => {
  const config = buildOpenCodeConfig(["claude-haiku-4-5", "claude-sonnet-4-6"]);
  assert.equal(config.model, "yeutech/claude-haiku-4-5");
  assert.throws(
    () => buildOpenCodeConfig(["claude-haiku-4-5"], { defaultModel: "missing-model" }),
    /Default model is absent/,
  );
});
