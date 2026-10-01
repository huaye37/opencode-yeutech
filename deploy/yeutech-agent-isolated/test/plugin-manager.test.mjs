import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createPluginManager } from "../src/plugin-manager.mjs";

test("default plugins are installed for every workspace and required plugins remain enabled", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "yeutech-plugin-manager-"));
  const manager = createPluginManager(path.join(directory, "plugins.sqlite"));
  t.after(() => { manager.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const plugins = manager.list(3);
  assert.ok(plugins.length >= 6);
  assert.ok(plugins.every((plugin) => plugin.installed && plugin.enabled));
  assert.throws(() => manager.set(3, "workspace", "yeutech.image-generation", { enabled: false }), (error) => error.code === "plugin_required");
});

test("project preference overrides workspace preference and produces a tool policy", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "yeutech-plugin-manager-"));
  const manager = createPluginManager(path.join(directory, "plugins.sqlite"));
  t.after(() => { manager.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  manager.set(3, "workspace", "opencode.web-research", { enabled: false });
  assert.equal(manager.toolPolicy(3).websearch, false);
  manager.set(3, "project:project_123", "opencode.web-research", { installed: true, enabled: true });
  assert.equal(manager.toolPolicy(3, "project:project_123").websearch, true);
  manager.set(3, "project:project_123", "opencode.subagents", { installed: false });
  assert.equal(manager.toolPolicy(3, "project:project_123").task, false);
  assert.equal(manager.toolPolicy(3, "project:project_123").generate_image, true);
  manager.set(3, "project:project_123", "yeutech.document-ocr", { enabled: false });
  assert.equal(manager.toolPolicy(3, "project:project_123").document_ocr, false);
  assert.equal(manager.toolPolicy(3, "project:project_123").media_inspect, true);
});
