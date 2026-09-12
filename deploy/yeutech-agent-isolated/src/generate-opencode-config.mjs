#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  DEFAULT_MODEL_ID,
  fetchModelCatalog,
} from "./model-catalog.mjs";

export function buildOpenCodeConfig(modelIds, options = {}) {
  if (modelIds.length === 0) throw new Error("Conversation model catalog is empty");
  const defaultModel = options.defaultModel ?? (modelIds.includes(DEFAULT_MODEL_ID) ? DEFAULT_MODEL_ID : modelIds[0]);
  if (!modelIds.includes(defaultModel)) {
    throw new Error(`Default model is absent from catalog: ${defaultModel}`);
  }

  return {
    $schema: "https://opencode.ai/config.json",
    provider: {
      yeutech: {
        npm: "@ai-sdk/openai-compatible",
        name: "YEUTECH Agent Gateway",
        options: {
          baseURL: options.baseURL ?? "http://127.0.0.1:18132/v1",
          apiKey: "{env:YEUTECH_AGENT_BRIDGE_TOKEN}",
        },
        models: Object.fromEntries(
          modelIds.map((id) => [id, { name: id }]),
        ),
      },
    },
    model: `yeutech/${defaultModel}`,
    permission: {
      read: "allow",
      glob: "allow",
      grep: "allow",
      list: "allow",
      lsp: "allow",
      edit: "deny",
      bash: "deny",
      external_directory: "deny",
    },
  };
}

export async function generateConfig({ output, baseURL, token, defaultModel }) {
  if (!token) throw new Error("YEUTECH_AGENT_BRIDGE_TOKEN is required");
  const modelIds = await fetchModelCatalog({ baseURL, token });
  const config = buildOpenCodeConfig(modelIds, { baseURL: `${baseURL}/v1`, defaultModel });
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  return modelIds;
}

async function main() {
  const output = process.env.OPENCODE_CONFIG_OUTPUT;
  if (!output) throw new Error("OPENCODE_CONFIG_OUTPUT is required");
  const baseURL = process.env.YEUTECH_AGENT_BRIDGE_URL ?? "http://127.0.0.1:18132";
  const modelIds = await generateConfig({
    output,
    baseURL,
    token: process.env.YEUTECH_AGENT_BRIDGE_TOKEN,
    defaultModel: process.env.YEUTECH_DEFAULT_MODEL,
  });
  process.stdout.write(`Generated ${output} with ${modelIds.length} conversation models.\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
