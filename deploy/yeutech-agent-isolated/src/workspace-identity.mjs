import { closeSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { copyFile, mkdir, rename, rm } from "node:fs/promises";
import { backup, DatabaseSync } from "node:sqlite";
import path from "node:path";

export const USER_MARKER = ".yeutech-user.json";
export const PROJECT_MARKER = ".yeutech-project.json";

function contained(root, candidate) {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

function requireDirectory(candidate, root, label) {
  let info;
  try { info = lstatSync(candidate); } catch { throw new Error(`${label} is unavailable: ${candidate}`); }
  if (info.isSymbolicLink()) throw new Error(`${label} cannot be a symlink: ${candidate}`);
  if (!info.isDirectory()) throw new Error(`${label} is not a directory: ${candidate}`);
  const resolved = realpathSync(candidate);
  if (!contained(realpathSync(root), resolved)) throw new Error(`${label} escapes the projects root: ${candidate}`);
  return resolved;
}

function readMarker(candidate, name) {
  const file = path.join(candidate, name);
  let info;
  try { info = lstatSync(file); } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  if (info.isSymbolicLink() || !info.isFile()) throw new Error(`Marker must be a regular file: ${file}`);
  try { return JSON.parse(readFileSync(file, "utf8")); } catch { throw new Error(`Marker is invalid JSON: ${file}`); }
}

function writeMarker(candidate, name, payload) {
  const file = path.join(candidate, name);
  const temporary = `${file}.tmp.${process.pid}.${Date.now()}`;
  const descriptor = openSync(temporary, "wx", 0o600);
  try { writeFileSync(descriptor, `${JSON.stringify(payload, null, 2)}\n`); } finally { closeSync(descriptor); }
  renameSync(temporary, file);
}

function children(root, excluded = []) {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    if (excluded.includes(entry.name)) return [];
    const candidate = path.join(root, entry.name);
    // Unrelated NAS links are not identity claims. Never follow them; a link
    // explicitly selected as the legacy/current workspace still fails in
    // requireDirectory(), and marker-file links fail in readMarker().
    if (entry.isSymbolicLink()) return [];
    if (!entry.isDirectory()) return [];
    return [requireDirectory(candidate, root, "Workspace entry")];
  });
}

function ownerCandidates(root) {
  const direct = children(root, ["@eaDir", "users", "system"]);
  const usersPath = path.join(root, "users");
  let users;
  try { users = lstatSync(usersPath); } catch (error) {
    if (error?.code === "ENOENT") return direct;
    throw error;
  }
  if (users.isSymbolicLink() || !users.isDirectory()) throw new Error(`Users workspace root must be a real directory: ${usersPath}`);
  const resolvedUsers = requireDirectory(usersPath, root, "Users workspace root");
  return [...direct, ...children(resolvedUsers, ["@eaDir"])];
}

function validateUserMarker(value, candidate) {
  if (value === null) return null;
  if (value.version !== 1 || !Number.isSafeInteger(value.portalUserId) || value.portalUserId <= 0) throw new Error(`User marker is invalid: ${candidate}`);
  return value;
}

function validateProjectMarker(value, candidate, portalUserId) {
  if (value === null) return null;
  const projectId = String(value.projectId || value.id || "").trim();
  const native = value.version === 1 && Number(value.portalUserId) === portalUserId;
  const legacy = value.portalUserId == null && typeof value.ownerKey === "string" && value.ownerKey.length >= 16;
  if (!projectId || (!native && !legacy)) throw new Error(`Project marker is invalid: ${candidate}`);
  return { ...value, projectId };
}

export function resolvePortalWorkspace(options) {
  if (!Number.isSafeInteger(options.portalUserId) || options.portalUserId <= 0) throw new Error("Portal user ID is invalid");
  if (!path.isAbsolute(options.projectsRoot || "")) throw new Error("Projects root must be absolute");
  const requestedRoot = path.resolve(options.projectsRoot);
  const root = requireDirectory(requestedRoot, requestedRoot, "Projects root");
  // Registry currentPath was established by a previous full scan. Validate
  // that exact marker first so an ordinary warm request does not synchronously
  // realpath every owner directory on a NAS. If it disappeared (rename), fall
  // through to the full immutable-ID scan below.
  if (options.trustCurrentWorkspace && options.legacyWorkspace) {
    const currentPath = path.resolve(options.legacyWorkspace);
    if (!contained(root, currentPath)) throw new Error(`Current workspace escapes the projects root: ${currentPath}`);
    try {
      const current = requireDirectory(currentPath, root, "Current workspace");
      const currentMarker = validateUserMarker(readMarker(current, USER_MARKER), current);
      if (!currentMarker || currentMarker.portalUserId !== options.portalUserId) throw new Error(`Current workspace marker does not match portal user ${options.portalUserId}`);
      return current;
    } catch (error) {
      if (!String(error.message).includes("is unavailable")) throw error;
    }
  }
  const matches = ownerCandidates(root).filter((candidate) => validateUserMarker(readMarker(candidate, USER_MARKER), candidate)?.portalUserId === options.portalUserId);
  if (matches.length > 1) throw new Error(`Multiple workspaces claim portal user ${options.portalUserId}`);
  if (matches.length === 1) return matches[0];

  if (options.legacyWorkspace) {
    const legacyPath = path.resolve(options.legacyWorkspace);
    if (!contained(requestedRoot, legacyPath)) throw new Error(`Legacy workspace escapes the projects root: ${legacyPath}`);
    let legacy;
    try { legacy = requireDirectory(legacyPath, root, "Legacy workspace"); } catch (error) {
      if (!String(error.message).includes("is unavailable")) throw error;
    }
    if (legacy) {
      const existing = validateUserMarker(readMarker(legacy, USER_MARKER), legacy);
      if (existing && existing.portalUserId !== options.portalUserId) throw new Error(`Legacy workspace is already owned by another portal user: ${legacy}`);
      if (!existing) writeMarker(legacy, USER_MARKER, { version: 1, portalUserId: options.portalUserId });
      return legacy;
    }
  }
  if (options.create === false) throw new Error(`Workspace for portal user ${options.portalUserId} was not found`);
  const users = path.join(root, "users");
  try { requireDirectory(users, root, "Users workspace root"); } catch (error) {
    if (!String(error.message).includes("is unavailable")) throw error;
    mkdirSync(users, { recursive: false, mode: 0o700 });
  }
  const workspace = path.join(users, String(options.portalUserId));
  try { mkdirSync(workspace, { recursive: false, mode: 0o700 }); } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    requireDirectory(workspace, root, "Portal workspace");
  }
  const existing = validateUserMarker(readMarker(workspace, USER_MARKER), workspace);
  if (existing && existing.portalUserId !== options.portalUserId) throw new Error(`Workspace is already owned by another portal user: ${workspace}`);
  if (!existing) writeMarker(workspace, USER_MARKER, { version: 1, portalUserId: options.portalUserId });
  return realpathSync(workspace);
}

export function indexPortalProjects(ownerWorkspace, snapshotProjects = [], portalUserId) {
  const requestedOwner = path.resolve(ownerWorkspace);
  const owner = requireDirectory(requestedOwner, requestedOwner, "Portal workspace");
  const ownerMarker = validateUserMarker(readMarker(owner, USER_MARKER), owner);
  if (!ownerMarker || ownerMarker.portalUserId !== portalUserId) throw new Error(`Portal workspace marker does not match user ${portalUserId}`);
  const folders = children(owner, ["@eaDir", "独立会话", ".独立会话附件", "附件"]).map((folder) => ({ name: path.basename(folder), path: folder }));
  const indexed = new Map();
  for (const folder of folders) {
    const value = validateProjectMarker(readMarker(folder.path, PROJECT_MARKER), folder.path, portalUserId);
    if (!value) continue;
    if (indexed.has(value.projectId)) throw new Error(`Multiple project folders claim project ${value.projectId}`);
    indexed.set(value.projectId, folder);
  }
  for (const project of snapshotProjects) {
    const projectId = String(project.id || "").trim();
    if (!projectId || indexed.has(projectId)) continue;
    const expected = String(project.rootPath || project.name || "");
    const candidates = folders.filter((folder) => folder.name === expected && !readMarker(folder.path, PROJECT_MARKER));
    if (candidates.length > 1) throw new Error(`Multiple unmarked folders match project ${projectId}`);
    if (candidates.length === 0) continue;
    writeMarker(candidates[0].path, PROJECT_MARKER, { version: 1, projectId, portalUserId });
    indexed.set(projectId, candidates[0]);
  }
  return { owner, projects: indexed, folders };
}

function tables(database) {
  return new Set(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name));
}

function columns(database, table) {
  return new Set(database.prepare(`PRAGMA table_info(${JSON.stringify(table)})`).all().map((row) => row.name));
}

function underPrefix(value, prefix) {
  return typeof value === "string" && (value === prefix || value.startsWith(`${prefix}${path.sep}`));
}

function replacePrefix(value, previousPath, currentPath) {
  return underPrefix(value, previousPath) ? `${currentPath}${value.slice(previousPath.length)}` : value;
}

export async function rebindOpenCodeWorkspace(databaseFile, previousWorkspace, currentWorkspace, options = {}) {
  if (!path.isAbsolute(databaseFile) || !path.isAbsolute(previousWorkspace) || !path.isAbsolute(currentWorkspace)) throw new Error("Database and workspace paths must be absolute");
  const previousPath = path.resolve(previousWorkspace);
  const currentPath = path.resolve(currentWorkspace);
  if (previousPath === currentPath) return { changed: false, backupFile: null, counts: {} };
  if (options.workerRunning) throw new Error("OpenCode worker must be stopped before workspace rebinding");
  const backupFile = options.backupFile ?? `${databaseFile}.before-workspace-rebind-${Date.now()}`;
  const database = new DatabaseSync(databaseFile);
  let committed = false;
  const counts = { sessions: 0, projectWorktrees: 0, projectDirectories: 0, projectSandboxes: 0 };
  try {
    await mkdir(path.dirname(backupFile), { recursive: true });
    await backup(database, backupFile);
    const schema = tables(database);
    database.exec("PRAGMA foreign_keys = ON; BEGIN IMMEDIATE");
    try {
      if (schema.has("session") && columns(database, "session").has("directory")) {
        const rows = database.prepare("SELECT id, directory FROM session").all().filter((row) => underPrefix(row.directory, previousPath));
        const update = database.prepare("UPDATE session SET directory = ? WHERE id = ?");
        for (const row of rows) { update.run(replacePrefix(row.directory, previousPath, currentPath), row.id); counts.sessions += 1; }
      }
      if (schema.has("project")) {
        const fields = columns(database, "project");
        if (fields.has("worktree")) {
          const rows = database.prepare("SELECT id, worktree FROM project").all().filter((row) => underPrefix(row.worktree, previousPath));
          const update = database.prepare("UPDATE project SET worktree = ? WHERE id = ?");
          for (const row of rows) { update.run(replacePrefix(row.worktree, previousPath, currentPath), row.id); counts.projectWorktrees += 1; }
        }
        if (fields.has("sandboxes")) {
          const rows = database.prepare("SELECT id, sandboxes FROM project").all();
          const update = database.prepare("UPDATE project SET sandboxes = ? WHERE id = ?");
          for (const row of rows) {
            let sandboxes;
            try { sandboxes = JSON.parse(row.sandboxes); } catch { throw new Error(`Project ${row.id} has invalid sandboxes JSON`); }
            if (!Array.isArray(sandboxes)) throw new Error(`Project ${row.id} has invalid sandboxes JSON`);
            const rebound = sandboxes.map((value) => typeof value === "string" ? replacePrefix(value, previousPath, currentPath) : value);
            if (JSON.stringify(rebound) !== JSON.stringify(sandboxes)) { update.run(JSON.stringify(rebound), row.id); counts.projectSandboxes += 1; }
          }
        }
      }
      if (schema.has("project_directory") && columns(database, "project_directory").has("directory")) {
        const rows = database.prepare("SELECT project_id, directory FROM project_directory").all();
        const keys = new Set(rows.map((row) => `${row.project_id}\0${row.directory}`));
        const moving = rows.filter((item) => underPrefix(item.directory, previousPath));
        for (const row of moving) {
          const target = replacePrefix(row.directory, previousPath, currentPath);
          if (target !== row.directory && keys.has(`${row.project_id}\0${target}`)) throw new Error(`Project directory rebind would create a duplicate row for ${row.project_id}`);
        }
        const update = database.prepare("UPDATE project_directory SET directory = ? WHERE project_id = ? AND directory = ?");
        for (const row of moving) { update.run(replacePrefix(row.directory, previousPath, currentPath), row.project_id, row.directory); counts.projectDirectories += 1; }
      }
      database.exec("COMMIT");
      committed = true;
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  } finally {
    database.close();
    if (!committed && options.restoreOnFailure !== false) {
      const staging = `${databaseFile}.restore.${process.pid}.${Date.now()}`;
      await copyFile(backupFile, staging).catch(() => null);
      await rename(staging, databaseFile).catch(() => null);
      await Promise.all([rm(`${databaseFile}-wal`, { force: true }), rm(`${databaseFile}-shm`, { force: true })]);
    }
  }
  return { changed: Object.values(counts).some((count) => count > 0), backupFile, counts };
}
