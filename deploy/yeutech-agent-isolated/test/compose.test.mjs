import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("keeps the NAS workbench as one predictably named container", async () => {
  const compose = await readFile(new URL("../compose.nas.yml", import.meta.url), "utf8");
  assert.match(compose, /^services:\n  yeutech-agent:\n    container_name: yeutech-agent$/m);
  assert.equal((compose.match(/^    container_name:/gm) || []).length, 1);
  assert.doesNotMatch(compose, /YEUTECH_AGENT_USERS_JSON/);
  assert.match(compose, /YEUTECH_WORKER_PORT_START: "18150"/);
  assert.match(compose, /YEUTECH_WORKER_IDLE_EVICTION_MS: "1800000"/);
  assert.match(compose, /YEUTECH_LEGACY_WORKSPACES_JSON: '\{"1":"\/projects\/lucian","3":"\/projects\/ryan"\}'/);
});

test("Synology Container Manager loads the authoritative NAS compose file", async () => {
  const wrapper = await readFile(new URL("../docker-compose.yml", import.meta.url), "utf8");
  assert.match(wrapper, /^include:\n  - compose\.nas\.yml$/m);
});
