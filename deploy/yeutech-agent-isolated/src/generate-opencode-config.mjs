#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  fetchModelCatalog,
  runnableModels,
} from "./model-catalog.mjs";

export function buildOpenCodeConfig(models, options = {}) {
  const safeModels = runnableModels(models);
  if (safeModels.length === 0) throw new Error("No conversation model has complete, bounded capabilities");
  const modelIds = safeModels.map((model) => model.id);
  const defaultModel = options.defaultModel ?? modelIds[0];
  if (!modelIds.includes(defaultModel)) {
    throw new Error(`Default model is absent from catalog: ${defaultModel}`);
  }

  const permission = options.readOnly
    ? {
        "*": "deny",
        read: "allow",
        glob: "allow",
        grep: "allow",
        list: "allow",
        lsp: "allow",
        edit: "deny",
        bash: "deny",
        external_directory: "deny",
      }
    : {
        "*": "ask",
        read: "allow",
        glob: "allow",
        grep: "allow",
        list: "allow",
        lsp: "allow",
        edit: "allow",
        bash: "ask",
        external_directory: "deny",
      };

  return {
    $schema: "https://opencode.ai/config.json",
    provider: {
      yeutech: {
        npm: "@ai-sdk/openai-compatible",
        name: "YEUTECH Agent Gateway",
        options: {
          baseURL: options.baseURL ?? "http://cliproxy:8317/v1",
          apiKey: "{env:YEUTECH_CLI_PROXY_KEY}",
        },
        models: Object.fromEntries(
          safeModels.map((model) => [model.id, {
            name: model.name,
            limit: model.limit,
            modalities: model.modalities,
          }]),
        ),
      },
    },
    model: `yeutech/${defaultModel}`,
    permission,
  };
}

export async function generateConfig({ output, baseURL, token, defaultModel }) {
  if (!token) throw new Error("YEUTECH_CLI_PROXY_KEY is required");
  const models = await fetchModelCatalog({ baseURL, token });
  const config = buildOpenCodeConfig(models, { baseURL: `${baseURL}/v1`, defaultModel });
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  return models;
}

async function main() {
  const output = process.env.OPENCODE_CONFIG_OUTPUT;
  if (!output) throw new Error("OPENCODE_CONFIG_OUTPUT is required");
  const baseURL = process.env.YEUTECH_CLI_PROXY_URL ?? "http://cliproxy:8317";
  const models = await generateConfig({
    output,
    baseURL,
    token: process.env.YEUTECH_CLI_PROXY_KEY,
    defaultModel: process.env.YEUTECH_DEFAULT_MODEL,
  });
  process.stdout.write(`Generated ${output} with ${runnableModels(models).length} bounded conversation models (${models.length} discovered).\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
