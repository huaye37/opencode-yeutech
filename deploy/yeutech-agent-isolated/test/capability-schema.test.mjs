import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const schemaURL = new URL("../contracts/capability-v1.schema.json", import.meta.url);
const projectionSchemaURL = new URL("../contracts/portal-projection-event-v1.schema.json", import.meta.url);

test("publishes a strict capability-v1 JSON Schema with the shared window rule", async () => {
  const schema = JSON.parse(await readFile(schemaURL, "utf8"));
  const capability = schema.$defs.modelCapability;
  assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.required, ["data"]);
  assert.deepEqual(schema.properties.generation, {
    description: "Monotonic catalog revision published by the capability provider.",
    type: "integer",
    minimum: 0,
    maximum: Number.MAX_SAFE_INTEGER,
  });
  assert.equal(capability.additionalProperties, false);
  assert.deepEqual(Object.keys(capability.properties).sort(), [
    "available", "capability_status", "context_length", "created", "description", "display_name", "id",
    "max_input_tokens", "max_output_tokens", "object", "owned_by", "selectable", "supported_input_modalities",
    "supported_output_modalities", "supported_parameters", "supports_web_search", "thinking", "type",
  ]);
  assert.equal(capability.properties.object.const, "model_capability");
  assert.equal(capability.properties.created.maximum, Number.MAX_SAFE_INTEGER);
  assert.equal(capability.properties.thinking.additionalProperties, false);
  assert.equal(capability.properties.supports_web_search.type, "boolean");
  assert.deepEqual(capability.required, ["id"]);
  assert.match(capability["x-yeutech-window-rule"], /min\(max_input_tokens, context_length - max_output_tokens\)/);
  assert.deepEqual(schema.$defs.modality.enum, ["text", "image", "audio", "video"]);
  assert.ok(capability.allOf.some((rule) => rule.then?.required?.includes("max_output_tokens")));
});

test("publishes a strict durable projection event contract", async () => {
  const schema = JSON.parse(await readFile(projectionSchemaURL, "utf8"));
  assert.deepEqual(schema.required, ["cursor", "type", "data"]);
  assert.equal(schema.additionalProperties, false);
  assert.match(schema["x-yeutech-stream-semantics"], /Only durable events advance cursor/);
  assert.ok(schema.properties.type.enum.includes("trajectory.upsert"));
});
