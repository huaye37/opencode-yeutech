import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { defaultPlugins, validatePluginCatalog } from "../src/plugin-manifest.mjs";

const catalog = JSON.parse(await readFile(new URL("../contracts/yeutech-plugin-defaults.json", import.meta.url), "utf8"));

test("default YEUTECH plugin catalog is strict and dependency complete", () => {
  assert.equal(validatePluginCatalog(catalog), catalog);
  assert.deepEqual(defaultPlugins(catalog, "agent-workbench").map((plugin) => plugin.id), [
    "yeutech.image-generation",
    "yeutech.document-ocr",
    "yeutech.media-inspect",
    "yeutech.skill-catalog",
    "yeutech.session-insight",
  ]);
  assert.deepEqual(defaultPlugins(catalog, "novel-workbench").map((plugin) => plugin.id), [
    "yeutech.image-generation",
    "yeutech.session-insight",
  ]);
});

test("catalog rejects duplicate IDs, unknown dependencies and dependency cycles", () => {
  const duplicate = structuredClone(catalog);
  duplicate.plugins.push(structuredClone(duplicate.plugins[0]));
  assert.throws(() => validatePluginCatalog(duplicate), /duplicated/);

  const unknown = structuredClone(catalog);
  unknown.plugins[0].requires = ["missing.plugin"];
  assert.throws(() => validatePluginCatalog(unknown), /unknown plugin/);

  const cycle = structuredClone(catalog);
  cycle.plugins.find((plugin) => plugin.id === "yeutech.image-generation").requires = ["yeutech.session-insight"];
  cycle.plugins.find((plugin) => plugin.id === "yeutech.session-insight").requires = ["yeutech.image-generation"];
  assert.throws(() => validatePluginCatalog(cycle), /dependency cycle/);
});

test("catalog rejects remote URLs and service declarations on local plugins", () => {
  const remote = structuredClone(catalog);
  remote.plugins[0].service.url = "https://example.com/plugin";
  assert.throws(() => validatePluginCatalog(remote), /service.url is not allowed/);

  const localService = structuredClone(catalog);
  localService.plugins.find((plugin) => plugin.source === "builtin").service = { id: "unexpected", protocol: "yeutech-plugin-http-v1" };
  assert.throws(() => validatePluginCatalog(localService), /only valid for platform-service/);
});
