import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { PROJECT_SPACE_MARKER, resolveProjectSpace } from "../scripts/resolve-project-space.mjs";

const SPACE_ID = "yeutech-codex-projects-v1";
const execute = promisify(execFile);

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "yeutech-project-space-"));
  const parent = path.join(root, "volume2");
  await mkdir(parent);
  return { root, parent };
}

async function mark(directory, spaceId = SPACE_ID) {
  await mkdir(directory);
  await writeFile(path.join(directory, PROJECT_SPACE_MARKER), `${spaceId}\n`);
}

test("resolves one renamed project root by immutable spaceId", async () => {
  const sample = await fixture();
  try {
    const renamed = path.join(sample.parent, "AI项目空间-新盘");
    await mark(renamed);
    await mark(path.join(sample.parent, "other-space"), "unrelated-space-id");
    assert.equal(await resolveProjectSpace({ parent: sample.parent, spaceId: SPACE_ID }), await realpath(renamed));
  } finally { await rm(sample.root, { recursive: true }); }
});

test("fails closed when the marker is missing or duplicated", async () => {
  const sample = await fixture();
  try {
    await mkdir(path.join(sample.parent, "old-empty-path"));
    await assert.rejects(resolveProjectSpace({ parent: sample.parent, spaceId: SPACE_ID }), /No project space/);
    await mark(path.join(sample.parent, "first"));
    await mark(path.join(sample.parent, "second"));
    await assert.rejects(resolveProjectSpace({ parent: sample.parent, spaceId: SPACE_ID }), /Multiple project spaces/);
  } finally { await rm(sample.root, { recursive: true }); }
});

test("does not follow symlink roots, parents, or marker files", async () => {
  const sample = await fixture();
  try {
    const actual = path.join(sample.root, "actual");
    await mark(actual);
    await symlink(actual, path.join(sample.parent, "linked-root"));
    await assert.rejects(resolveProjectSpace({ parent: sample.parent, spaceId: SPACE_ID }), /No project space/);

    const markerLinkRoot = path.join(sample.parent, "marker-link-root");
    await mkdir(markerLinkRoot);
    await symlink(path.join(actual, PROJECT_SPACE_MARKER), path.join(markerLinkRoot, PROJECT_SPACE_MARKER));
    await assert.rejects(resolveProjectSpace({ parent: sample.parent, spaceId: SPACE_ID }), /No project space/);

    const linkedParent = path.join(sample.root, "linked-parent");
    await symlink(sample.parent, linkedParent);
    await assert.rejects(resolveProjectSpace({ parent: linkedParent, spaceId: SPACE_ID }), /parent is unavailable/);
  } finally { await rm(sample.root, { recursive: true }); }
});

test("compose cannot fall back to the old literal NAS path", async () => {
  const compose = await import("node:fs/promises").then(({ readFile }) => readFile(new URL("../compose.nas.yml", import.meta.url), "utf8"));
  assert.match(compose, /YEUTECH_PROJECTS_BIND_SOURCE:\?/);
  assert.match(compose, /create_host_path: false/);
  assert.doesNotMatch(compose, /\/volume2\/codex项目空间:\/projects/);
});

test("NAS compose wrapper injects the resolved root into Docker without creating an old path", async () => {
  const sample = await fixture();
  try {
    const renamed = path.join(sample.parent, "renamed-project-space");
    await mark(renamed);
    const fakeDocker = path.join(sample.root, "docker-probe.sh");
    await writeFile(fakeDocker, "#!/bin/sh\nprintf '%s\\n' \"$YEUTECH_PROJECTS_BIND_SOURCE\" \"$*\"\n", { mode: 0o755 });
    const wrapper = fileURLToPath(new URL("../scripts/compose-nas.sh", import.meta.url));
    const result = await execute(wrapper, ["config", "--quiet"], { env: {
      ...process.env,
      YEUTECH_DOCKER_BIN: fakeDocker,
      YEUTECH_PROJECT_SPACE_PARENT: sample.parent,
      YEUTECH_PROJECT_SPACE_ID: SPACE_ID,
    } });
    const [source, invocation] = result.stdout.trim().split("\n");
    assert.equal(source, await realpath(renamed));
    assert.match(invocation, /compose -f .*compose\.nas\.yml config --quiet$/);
    assert.doesNotMatch(await import("node:fs/promises").then(({ readFile }) => readFile(wrapper, "utf8")), /\bnode\b/);
  } finally { await rm(sample.root, { recursive: true }); }
});
