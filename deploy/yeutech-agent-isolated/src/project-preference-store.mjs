import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

function requireUser(value) {
  const user = Number(value);
  if (!Number.isSafeInteger(user) || user <= 0) throw Object.assign(new Error("Portal user is invalid"), { statusCode: 400 });
  return user;
}

function requireProjectId(value) {
  const id = String(value || "").trim();
  if (!/^[A-Za-z0-9_-]{3,160}$/.test(id)) throw Object.assign(new Error("Project ID is invalid"), { statusCode: 400 });
  return id;
}

export function createProjectPreferenceStore(databasePath) {
  mkdirSync(path.dirname(databasePath), { recursive: true });
  const database = new DatabaseSync(databasePath);
  database.exec(`
    PRAGMA journal_mode=WAL;
    PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS project_preferences (
      portal_user_id INTEGER NOT NULL,
      project_id TEXT NOT NULL,
      display_name TEXT,
      hidden INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (portal_user_id, project_id)
    );
  `);
  const get = database.prepare("SELECT * FROM project_preferences WHERE portal_user_id = ? AND project_id = ?");
  const list = database.prepare("SELECT * FROM project_preferences WHERE portal_user_id = ?");
  const upsertName = database.prepare(`INSERT INTO project_preferences VALUES (?, ?, ?, 0, ?)
    ON CONFLICT(portal_user_id, project_id) DO UPDATE SET display_name=excluded.display_name, hidden=0, updated_at=excluded.updated_at`);
  const upsertHidden = database.prepare(`INSERT INTO project_preferences VALUES (?, ?, NULL, ?, ?)
    ON CONFLICT(portal_user_id, project_id) DO UPDATE SET hidden=excluded.hidden, updated_at=excluded.updated_at`);
  const publicValue = (row) => row ? { projectId: row.project_id, displayName: row.display_name, hidden: Boolean(row.hidden), updatedAt: row.updated_at } : null;
  return {
    get(portalUserId, projectId) { return publicValue(get.get(requireUser(portalUserId), requireProjectId(projectId))); },
    list(portalUserId) { return list.all(requireUser(portalUserId)).map(publicValue); },
    rename(portalUserId, projectId, displayName) {
      const name = String(displayName || "").normalize("NFC").trim().slice(0, 120);
      if (!name || name.includes("/") || name.includes("\\") || name.includes("\0")) throw Object.assign(new Error("Project display name is invalid"), { statusCode: 400 });
      upsertName.run(requireUser(portalUserId), requireProjectId(projectId), name, Date.now());
      return publicValue(get.get(portalUserId, projectId));
    },
    setHidden(portalUserId, projectId, hidden) {
      upsertHidden.run(requireUser(portalUserId), requireProjectId(projectId), hidden ? 1 : 0, Date.now());
      return publicValue(get.get(portalUserId, projectId));
    },
    close() { database.close(); },
  };
}
