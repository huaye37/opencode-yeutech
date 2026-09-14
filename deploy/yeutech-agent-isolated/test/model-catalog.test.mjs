import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { buildOpenCodeConfig } from "../src/generate-opencode-config.mjs";
import { fetchModelCatalog, isConversationModel, normalizeModelCatalog, runnableModels, selectDefaultModel, validateCapabilityCatalog } from "../src/model-catalog.mjs";

test("bounds a model catalog request when the provider never responds", async () => {
  const server = http.createServer(() => {});
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await assert.rejects(fetchModelCatalog({ baseURL: `http://127.0.0.1:${server.address().port}`, token: "token", timeoutMs: 10 }),
      (error) => error?.name === "TimeoutError");
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("uses declared modalities instead of guessing capability from model IDs", () => {
  assert.equal(isConversationModel({ id: "gpt-5.6-sol", modalities: { input: ["text"], output: ["text"] } }), true);
  assert.equal(isConversationModel("codex-auto-review"), false);
  assert.equal(isConversationModel({ id: "gemini-image-preview", modalities: { input: ["text", "image"], output: ["image"] } }), false);
  assert.equal(isConversationModel({ id: "myimageish-model", modalities: { input: ["text"], output: ["text"] } }), true);
});

test("normalizes, deduplicates, and sorts catalog", () => {
  const result = normalizeModelCatalog({ data: [
    { id: "z-chat", context_length: 200000, max_input_tokens: 180000, max_output_tokens: 20000, supported_input_modalities: ["text", "image"], supported_output_modalities: ["text"] },
    { id: "codex-auto-review", context_length: 1000, max_output_tokens: 100 },
    { id: "a-chat", display_name: "A Chat", context_length: 128000, max_output_tokens: 8192, supported_input_modalities: ["text"], supported_output_modalities: ["text"] },
    { id: "foo-image", context_length: 0, max_output_tokens: 0 },
  ] });
  assert.deepEqual(result, [
    { id: "a-chat", name: "A Chat", available: true, selectable: true, disabledReason: null, limit: { context: 128000, input: 119808, output: 8192 }, modalities: { input: ["text"], output: ["text"] } },
    { id: "codex-auto-review", name: "codex-auto-review", available: true, selectable: false, disabledReason: "当前工作台不支持该模型类型", limit: { context: 1000, input: 900, output: 100 }, modalities: { input: [], output: [] } },
    { id: "foo-image", name: "foo-image", available: true, selectable: false, disabledReason: "能力信息待补全", limit: null, modalities: { input: [], output: [] } },
    { id: "z-chat", name: "z-chat", available: true, selectable: true, disabledReason: null, limit: { context: 200000, input: 180000, output: 20000 }, modalities: { input: ["text", "image"], output: ["text"] } },
  ]);
});

test("builds interactive OpenCode provider config", () => {
  const models = [
    { id: "gpt-5.6-sol", name: "GPT 5.6 Sol", selectable: true, limit: { context: 200000, input: 180000, output: 20000 }, modalities: { input: ["text", "image"], output: ["text"] } },
    { id: "gpt-5.6-terra", name: "GPT 5.6 Terra", selectable: true, limit: { context: 128000, input: 120000, output: 8000 }, modalities: { input: ["text"], output: ["text"] } },
  ];
  const config = buildOpenCodeConfig(models);
  assert.equal(config.model, "yeutech/gpt-5.6-sol");
  assert.equal(config.permission["*"], "ask");
  assert.equal(config.permission.edit, "allow");
  assert.equal(config.permission.bash, "ask");
  assert.equal(config.permission.external_directory, "deny");
  assert.equal(config.provider.yeutech.options.baseURL, "http://cliproxy:8317/v1");
  assert.equal(config.provider.yeutech.options.apiKey, "{env:YEUTECH_CLI_PROXY_KEY}");
  assert.deepEqual(Object.keys(config.provider.yeutech.models), ["gpt-5.6-sol", "gpt-5.6-terra"]);
  assert.deepEqual(config.provider.yeutech.models["gpt-5.6-sol"].limit, { context: 200000, input: 180000, output: 20000 });
  assert.deepEqual(config.provider.yeutech.models["gpt-5.6-sol"].modalities.input, ["text", "image"]);
});

test("builds a deny-by-default read-only config for system workers", () => {
  const models = [
    { id: "gpt-5.6-sol", name: "GPT 5.6 Sol", selectable: true, limit: { context: 200000, input: 180000, output: 20000 }, modalities: { input: ["text"], output: ["text"] } },
  ];
  const config = buildOpenCodeConfig(models, { readOnly: true });
  assert.equal(config.permission["*"], "deny");
  assert.equal(config.permission.read, "allow");
  assert.equal(config.permission.glob, "allow");
  assert.equal(config.permission.grep, "allow");
  assert.equal(config.permission.list, "allow");
  assert.equal(config.permission.lsp, "allow");
  assert.equal(config.permission.edit, "deny");
  assert.equal(config.permission.bash, "deny");
  assert.equal(config.permission.external_directory, "deny");
});

test("falls back to the first dynamic model when the preferred default is absent", () => {
  const models = ["claude-haiku-4-5", "claude-sonnet-4-6"].map((id) => ({ id, name: id, selectable: true, limit: { context: 200000, input: 180000, output: 20000 }, modalities: { input: ["text"], output: ["text"] } }));
  const config = buildOpenCodeConfig(models);
  assert.equal(config.model, "yeutech/claude-haiku-4-5");
  assert.throws(
    () => buildOpenCodeConfig(models, { defaultModel: "missing-model" }),
    /Default model is absent/,
  );
});

test("keeps incomplete discoveries visible but excludes them from execution", () => {
  const models = normalizeModelCatalog({ data: [
    { id: "ready", context_length: 10000, max_output_tokens: 1000, supported_input_modalities: ["text"], supported_output_modalities: ["text"] },
    { id: "new-model", context_length: 0, max_output_tokens: 0, capability_status: "incomplete", selectable: false },
    { id: "oversized-input", context_length: 1000, max_input_tokens: 2000, max_output_tokens: 100, supported_input_modalities: ["text"], supported_output_modalities: ["text"] },
    { id: "offline", available: false, context_length: 10000, max_output_tokens: 1000, supported_input_modalities: ["text"], supported_output_modalities: ["text"] },
    { id: "ready", context_length: 1, max_output_tokens: 1 },
  ] });
  assert.deepEqual(models.map(({ id, selectable, disabledReason }) => ({ id, selectable, disabledReason })), [
    { id: "new-model", selectable: false, disabledReason: "能力信息待补全" },
    { id: "offline", selectable: false, disabledReason: "模型当前不可用" },
    { id: "oversized-input", selectable: true, disabledReason: null },
    { id: "ready", selectable: true, disabledReason: null },
  ]);
  assert.deepEqual(runnableModels(models).map((item) => item.id), ["oversized-input", "ready"]);
  assert.deepEqual(Object.keys(buildOpenCodeConfig(models).provider.yeutech.models), ["oversized-input", "ready"]);
});

test("requires explicit text input and output modalities and explains default selection", () => {
  const models = normalizeModelCatalog({ data: [
    { id: "looks-like-chat", context_length: 10000, max_output_tokens: 1000 },
    { id: "image-output", context_length: 10000, max_output_tokens: 1000, supported_input_modalities: ["text"], supported_output_modalities: ["image"] },
    { id: "actual-chat", context_length: 10000, max_output_tokens: 1000, supported_input_modalities: ["text"], supported_output_modalities: ["text"] },
  ] });
  assert.deepEqual(runnableModels(models).map((item) => item.id), ["actual-chat"]);
  assert.deepEqual(selectDefaultModel(models, "missing"), { id: "actual-chat", reason: "first_runnable" });
});

test("mixed image output is not exposed as a text conversation model", () => {
  const [model] = normalizeModelCatalog({ data: [{
    id: "multimodal-output",
    context_length: 10000,
    max_input_tokens: 8000,
    max_output_tokens: 2000,
    supported_input_modalities: ["text", "image"],
    supported_output_modalities: ["text", "image"],
    capability_status: "ready",
    selectable: false,
  }] });
  assert.equal(model.selectable, false);
  assert.equal(model.disabledReason, "当前工作台不支持该模型类型");
});

test("reserves output tokens and clamps a standalone provider input maximum", () => {
  const [derived, explicitMaximum] = normalizeModelCatalog({ data: [
    { id: "derived", context_length: 10000, max_output_tokens: 2500, supported_input_modalities: ["text"], supported_output_modalities: ["text"] },
    { id: "explicit-overflow", context_length: 10000, max_input_tokens: 8000, max_output_tokens: 2500, supported_input_modalities: ["text"], supported_output_modalities: ["text"] },
  ] });
  assert.deepEqual(derived.limit, { context: 10000, input: 7500, output: 2500 });
  assert.equal(derived.selectable, true);
  assert.deepEqual(explicitMaximum.limit, { context: 10000, input: 7500, output: 2500 });
  assert.equal(explicitMaximum.selectable, true);
  assert.equal(explicitMaximum.disabledReason, null);
});

test("fails closed when output consumes the context or input is explicitly zero", () => {
  const models = normalizeModelCatalog({ data: [
    { id: "output-equals-context", context_length: 1000, max_input_tokens: 100, max_output_tokens: 1000, supported_input_modalities: ["text"], supported_output_modalities: ["text"] },
    { id: "output-exceeds-context", context_length: 1000, max_input_tokens: 100, max_output_tokens: 1200, supported_input_modalities: ["text"], supported_output_modalities: ["text"] },
    { id: "explicit-zero-input", context_length: 1000, max_input_tokens: 0, max_output_tokens: 100, supported_input_modalities: ["text"], supported_output_modalities: ["text"] },
  ] });
  for (const model of models) {
    assert.equal(model.selectable, false, model.id);
    assert.equal(model.limit, null, model.id);
    assert.equal(model.disabledReason, "能力信息待补全", model.id);
  }
});

test("rejects payloads outside the strict capability-v1 contract", () => {
  const invalidPayloads = [
    null,
    { data: [], object: "collection" },
    { data: [{}] },
    { data: [{ id: "bad id" }] },
    { data: [{ id: "model", context_length: -1 }] },
    { data: [{ id: "model", available: "yes" }] },
    { data: [{ id: "model", supported_input_modalities: ["text", "text"] }] },
    { data: [{ id: "model", supported_output_modalities: ["embedding"] }] },
    { data: [{ id: "model", capability_status: "unknown" }] },
    { data: [{ id: "model", capability_status: "incomplete", selectable: true }] },
    { data: [{ id: "model", selectable: true, context_length: 1000, max_output_tokens: 100 }] },
    { data: [{ id: "model", selectable: true, context_length: 0, max_output_tokens: 0, supported_input_modalities: ["text"], supported_output_modalities: ["text"] }] },
    { data: [{ id: "model", undocumented_flag: true }] },
  ];
  for (const payload of invalidPayloads) assert.throws(() => validateCapabilityCatalog(payload), TypeError);
});

test("accepts the standard OpenAI list envelope without relaxing capability entries", () => {
  assert.deepEqual(validateCapabilityCatalog({ object: "list", data: [] }), { object: "list", data: [] });
  assert.deepEqual(validateCapabilityCatalog({ object: "list", generation: 12, data: [] }), { object: "list", generation: 12, data: [] });
  for (const generation of [-1, 1.5, "12", Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(
      () => validateCapabilityCatalog({ object: "list", generation, data: [] }),
      /payload\.generation must be a non-negative safe integer/,
    );
  }
  assert.throws(() => validateCapabilityCatalog({ object: "list", data: [], extra: true }), TypeError);
});

test("accepts the complete safe metadata emitted by CLIProxyAPI", () => {
  const entry = {
    id: "gpt-5.6-sol",
    object: "model_capability",
    created: 1_789_256_911,
    owned_by: "openai",
    type: "openai",
    display_name: "GPT 5.6 Sol",
    description: "General agent model",
    context_length: 200_000,
    max_input_tokens: 180_000,
    max_output_tokens: 20_000,
    supported_parameters: ["reasoning_effort"],
    supported_input_modalities: ["text", "image"],
    supported_output_modalities: ["text"],
    thinking: { min: 0, max: 32_768, zero_allowed: true, dynamic_allowed: true, levels: ["low", "high"] },
    supports_web_search: true,
    available: true,
    selectable: true,
    capability_status: "ready",
  };
  assert.equal(validateCapabilityCatalog({ object: "list", generation: 4, data: [entry] }).data[0], entry);
});

test("adapts the deployed bounded legacy catalog as conservative text-only models", () => {
  const models = normalizeModelCatalog({
    object: "list",
    generation: 14,
    data: [{
      id: "legacy-chat",
      object: "model_capability",
      type: "openai",
      context_length: 128000,
      max_input_tokens: 120000,
      max_output_tokens: 8000,
      available: true,
      selectable: true,
      capability_status: "ready",
    }],
  });
  assert.deepEqual(models[0].modalities, { input: ["text"], output: ["text"] });
  assert.equal(models[0].selectable, true);
});

test("keeps CLIProxyAPI metadata strict and typed", () => {
  const invalidEntries = [
    { id: "model", object: "model" },
    { id: "model", created: -1 },
    { id: "model", created: 1.5 },
    { id: "model", owned_by: 1 },
    { id: "model", supported_parameters: ["x", "x"] },
    { id: "model", supported_parameters: [""] },
    { id: "model", thinking: [] },
    { id: "model", thinking: { min: 2, max: 1 } },
    { id: "model", thinking: { levels: ["high", "high"] } },
    { id: "model", thinking: { secret: true } },
    { id: "model", supports_web_search: "yes" },
  ];
  for (const entry of invalidEntries) {
    assert.throws(() => validateCapabilityCatalog({ data: [entry] }), TypeError);
  }
});

test("refuses startup only when every conversation model is unbounded", () => {
  const incomplete = normalizeModelCatalog({ data: [{ id: "new-model", context_length: 0, max_output_tokens: 0 }] });
  assert.throws(() => buildOpenCodeConfig(incomplete), /No conversation model/);
});
