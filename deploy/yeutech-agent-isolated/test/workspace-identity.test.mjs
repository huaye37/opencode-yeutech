import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, realpath, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { indexPortalProjects, PROJECT_MARKER, rebindOpenCodeWorkspace, resolvePortalWorkspace, USER_MARKER } from "../src/workspace-identity.mjs";

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "yeutech-workspace-identity-"));
  const projectsRoot = path.join(root, "projects");
  await mkdir(projectsRoot);
  return { root, projectsRoot };
}

test("seeds legacy owner and follows its immutable user ID after rename", async () => {
  const sample = await fixture();
  try {
    const legacy = path.join(sample.projectsRoot, "ryan");
    await mkdir(legacy);
    assert.equal(resolvePortalWorkspace({ projectsRoot: sample.projectsRoot, portalUserId: 3, legacyWorkspace: legacy }), await realpath(legacy));
    assert.equal(JSON.parse(await readFile(path.join(legacy, USER_MARKER), "utf8")).portalUserId, 3);
    const renamed = path.join(sample.projectsRoot, "Ryan-新名称");
    await rename(legacy, renamed);
    assert.equal(resolvePortalWorkspace({ projectsRoot: sample.projectsRoot, portalUserId: 3, legacyWorkspace: legacy }), await realpath(renamed));
  } finally { await rm(sample.root, { recursive: true }); }
});

test("creates isolated new-user workspace and rejects duplicate claims", async () => {
  const sample = await fixture();
  try {
    const created = resolvePortalWorkspace({ projectsRoot: sample.projectsRoot, portalUserId: 8 });
    assert.equal(created, await realpath(path.join(sample.projectsRoot, "users", "8")));
    const duplicate = path.join(sample.projectsRoot, "duplicate");
    await mkdir(duplicate);
    await writeFile(path.join(duplicate, USER_MARKER), JSON.stringify({ version: 1, portalUserId: 8 }));
    assert.throws(() => resolvePortalWorkspace({ projectsRoot: sample.projectsRoot, portalUserId: 8 }), /Multiple workspaces/);
  } finally { await rm(sample.root, { recursive: true }); }
});

test("keeps project identity after folder rename and rejects duplicate project IDs", async () => {
  const sample = await fixture();
  try {
    const owner = path.join(sample.projectsRoot, "ryan");
    const original = path.join(owner, "项目一");
    await mkdir(original, { recursive: true });
    resolvePortalWorkspace({ projectsRoot: sample.projectsRoot, portalUserId: 3, legacyWorkspace: owner });
    let result = indexPortalProjects(owner, [{ id: "project-stable", name: "项目一" }], 3);
    assert.equal(result.projects.get("project-stable").path, await realpath(original));
    assert.equal(JSON.parse(await readFile(path.join(original, PROJECT_MARKER), "utf8")).projectId, "project-stable");
    const renamed = path.join(owner, "改名后的项目");
    await rename(original, renamed);
    result = indexPortalProjects(owner, [{ id: "project-stable", name: "项目一" }], 3);
    assert.equal(result.projects.get("project-stable").path, await realpath(renamed));
    const duplicate = path.join(owner, "duplicate");
    await mkdir(duplicate);
    await writeFile(path.join(duplicate, PROJECT_MARKER), JSON.stringify({ version: 1, projectId: "project-stable", portalUserId: 3 }));
    assert.throws(() => indexPortalProjects(owner, [{ id: "project-stable", name: "项目一" }], 3), /Multiple project folders/);
  } finally { await rm(sample.root, { recursive: true }); }
});

test("preserves the existing portal id and ownerKey project marker format", async () => {
  const sample = await fixture();
  try {
    const owner = path.join(sample.projectsRoot, "ryan");
    const project = path.join(owner, "旧门户项目");
    await mkdir(project, { recursive: true });
    resolvePortalWorkspace({ projectsRoot: sample.projectsRoot, portalUserId: 3, legacyWorkspace: owner });
    const legacy = { id: "project-legacy", name: "旧门户项目", ownerKey: "legacy-owner-key-0123456789", createdAt: "2026-08-29T00:00:00.000Z" };
    await writeFile(path.join(project, PROJECT_MARKER), `${JSON.stringify(legacy)}\n`);
    const indexed = indexPortalProjects(owner, [{ id: "project-legacy", name: "旧门户项目" }], 3);
    assert.equal(indexed.projects.get("project-legacy").path, await realpath(project));
    assert.deepEqual(JSON.parse(await readFile(path.join(project, PROJECT_MARKER), "utf8")), legacy);
  } finally { await rm(sample.root, { recursive: true }); }
});

test("ignores symlink owners and projects", async () => {
  const sample = await fixture();
  try {
    const outside = path.join(sample.root, "outside");
    await mkdir(outside);
    await writeFile(path.join(outside, USER_MARKER), JSON.stringify({ version: 1, portalUserId: 3 }));
    await symlink(outside, path.join(sample.projectsRoot, "linked-owner"));
    assert.throws(() => resolvePortalWorkspace({ projectsRoot: sample.projectsRoot, portalUserId: 3, create: false }), /was not found/);
  } finally { await rm(sample.root, { recursive: true }); }
});

function createOpenCodeDatabase(file, oldWorkspace, options = {}) {
  const database = new DatabaseSync(file);
  database.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT NOT NULL, path TEXT);
    CREATE TABLE project (id TEXT PRIMARY KEY, worktree TEXT NOT NULL, sandboxes TEXT NOT NULL);
    CREATE TABLE project_directory (project_id TEXT NOT NULL, directory TEXT NOT NULL, PRIMARY KEY(project_id, directory));
  `);
  database.prepare("INSERT INTO session VALUES (?, ?, ?)").run("ses_owner", oldWorkspace, "项目一");
  database.prepare("INSERT INTO session VALUES (?, ?, ?)").run("ses_child", path.join(oldWorkspace, "nested"), "nested");
  database.prepare("INSERT INTO session VALUES (?, ?, ?)").run("ses_other", "/projects/other", null);
  database.prepare("INSERT INTO project VALUES (?, ?, ?)").run("prj_1", path.join(oldWorkspace, "项目一"), JSON.stringify([path.join(oldWorkspace, "sandbox"), "/outside"]));
  database.prepare("INSERT INTO project_directory VALUES (?, ?)").run("prj_1", path.join(oldWorkspace, "项目一"));
  if (options.collision) database.prepare("INSERT INTO project_directory VALUES (?, ?)").run("prj_1", path.join(options.currentWorkspace, "项目一"));
  database.close();
}

test("backs up and transactionally rebinds owner paths without changing relative session.path", async () => {
  const sample = await fixture();
  const databaseFile = path.join(sample.root, "opencode.db");
  const backupFile = path.join(sample.root, "backups", "before.db");
  const previousWorkspace = "/projects/ryan";
  const currentWorkspace = "/projects/Ryan-新名称";
  try {
    createOpenCodeDatabase(databaseFile, previousWorkspace);
    const result = await rebindOpenCodeWorkspace(databaseFile, previousWorkspace, currentWorkspace, { backupFile });
    assert.deepEqual(result.counts, { sessions: 2, projectWorktrees: 1, projectDirectories: 1, projectSandboxes: 1 });
    assert.equal((await stat(backupFile)).isFile(), true);
    const database = new DatabaseSync(databaseFile, { readOnly: true });
    assert.deepEqual({ ...database.prepare("SELECT directory, path FROM session WHERE id = 'ses_owner'").get() }, { directory: currentWorkspace, path: "项目一" });
    assert.equal(database.prepare("SELECT directory FROM session WHERE id = 'ses_child'").get().directory, path.join(currentWorkspace, "nested"));
    assert.equal(database.prepare("SELECT directory FROM session WHERE id = 'ses_other'").get().directory, "/projects/other");
    assert.equal(database.prepare("SELECT worktree FROM project WHERE id = 'prj_1'").get().worktree, path.join(currentWorkspace, "项目一"));
    assert.deepEqual(JSON.parse(database.prepare("SELECT sandboxes FROM project WHERE id = 'prj_1'").get().sandboxes), [path.join(currentWorkspace, "sandbox"), "/outside"]);
    assert.equal(database.prepare("SELECT directory FROM project_directory WHERE project_id = 'prj_1'").get().directory, path.join(currentWorkspace, "项目一"));
    database.close();
    const snapshot = new DatabaseSync(backupFile, { readOnly: true });
    assert.equal(snapshot.prepare("SELECT directory FROM session WHERE id = 'ses_owner'").get().directory, previousWorkspace);
    snapshot.close();
  } finally { await rm(sample.root, { recursive: true }); }
});

test("rejects a running worker and rolls back a colliding project_directory rebind", async () => {
  const sample = await fixture();
  const databaseFile = path.join(sample.root, "opencode.db");
  const previousWorkspace = "/projects/ryan";
  const currentWorkspace = "/projects/renamed";
  try {
    createOpenCodeDatabase(databaseFile, previousWorkspace, { collision: true, currentWorkspace });
    await assert.rejects(rebindOpenCodeWorkspace(databaseFile, previousWorkspace, currentWorkspace, { workerRunning: true }), /must be stopped/);
    await assert.rejects(rebindOpenCodeWorkspace(databaseFile, previousWorkspace, currentWorkspace, { backupFile: path.join(sample.root, "collision-backup.db") }), /duplicate row/);
    const database = new DatabaseSync(databaseFile, { readOnly: true });
    assert.equal(database.prepare("SELECT directory FROM session WHERE id = 'ses_owner'").get().directory, previousWorkspace);
    assert.equal(database.prepare("SELECT worktree FROM project WHERE id = 'prj_1'").get().worktree, path.join(previousWorkspace, "项目一"));
    database.close();
  } finally { await rm(sample.root, { recursive: true }); }
});

test("fails closed for a selected legacy symlink and marker-file symlink", async () => {
  const sample = await fixture();
  try {
    const outside = path.join(sample.root, "outside-owner");
    await mkdir(outside);
    const selected = path.join(sample.projectsRoot, "ryan");
    await symlink(outside, selected);
    assert.throws(() => resolvePortalWorkspace({ projectsRoot: sample.projectsRoot, portalUserId: 3, legacyWorkspace: selected }), /cannot be a symlink/);
    await rm(selected);
    await mkdir(selected);
    const markerTarget = path.join(sample.root, "marker.json");
    await writeFile(markerTarget, JSON.stringify({ version: 1, portalUserId: 3 }));
    await symlink(markerTarget, path.join(selected, USER_MARKER));
    assert.throws(() => resolvePortalWorkspace({ projectsRoot: sample.projectsRoot, portalUserId: 3, legacyWorkspace: selected }), /regular file/);
  } finally { await rm(sample.root, { recursive: true }); }
});
