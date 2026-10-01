import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const DRAFT_ID = /^ses_local_[a-f0-9]{32}$/;

function requireUser(value) {
  const user = Number(value);
  if (!Number.isSafeInteger(user) || user <= 0) throw Object.assign(new Error("Portal user is invalid"), { statusCode: 400 });
  return user;
}

function requireDraftId(value) {
  const id = String(value || "");
  if (!DRAFT_ID.test(id)) throw Object.assign(new Error("Session draft ID is invalid"), { statusCode: 400 });
  return id;
}

function optionalProjectId(value) {
  if (value == null || value === "") return null;
  const id = String(value);
  if (!/^[A-Za-z0-9_-]{3,160}$/.test(id)) throw Object.assign(new Error("Project ID is invalid"), { statusCode: 400 });
  return id;
}

function cleanTitle(value) {
  return String(value || "新会话").normalize("NFC").trim().slice(0, 160) || "新会话";
}

function cleanModel(value) {
  const model = String(value || "").trim();
  if (model && !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(model)) throw Object.assign(new Error("Model ID is invalid"), { statusCode: 400 });
  return model || null;
}

function publicDraft(row) {
  if (!row) return null;
  return {
    id: row.id,
    title: row.title,
    model: row.model_id ? { id: row.model_id, providerID: "yeutech", variant: "default" } : null,
    time: { created: row.created_at, updated: row.updated_at },
    projectId: row.project_id,
    draft: true,
  };
}

export function createSessionDraftStore(databasePath) {
  mkdirSync(path.dirname(databasePath), { recursive: true });
  const database = new DatabaseSync(databasePath);
  database.exec(`
    PRAGMA journal_mode=WAL;
    PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS session_drafts (
      id TEXT PRIMARY KEY,
      portal_user_id INTEGER NOT NULL,
      project_id TEXT,
      title TEXT NOT NULL,
      model_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS session_drafts_user_updated
      ON session_drafts(portal_user_id, updated_at DESC);
  `);
  const get = database.prepare("SELECT * FROM session_drafts WHERE id = ? AND portal_user_id = ?");
  const list = database.prepare("SELECT * FROM session_drafts WHERE portal_user_id = ? ORDER BY updated_at DESC");
  const insert = database.prepare("INSERT INTO session_drafts VALUES (?, ?, ?, ?, ?, ?, ?)");
  const rename = database.prepare("UPDATE session_drafts SET title = ?, updated_at = ? WHERE id = ? AND portal_user_id = ?");
  const updateModel = database.prepare("UPDATE session_drafts SET model_id = ?, updated_at = ? WHERE id = ? AND portal_user_id = ?");
  const remove = database.prepare("DELETE FROM session_drafts WHERE id = ? AND portal_user_id = ?");
  const removeProject = database.prepare("DELETE FROM session_drafts WHERE project_id = ? AND portal_user_id = ?");
  return {
    create(portalUserId, value = {}) {
      const user = requireUser(portalUserId);
      const now = Date.now();
      const id = `ses_local_${randomUUID().replaceAll("-", "")}`;
      insert.run(id, user, optionalProjectId(value.projectId), cleanTitle(value.title), cleanModel(value.modelId), now, now);
      return publicDraft(get.get(id, user));
    },
    get(portalUserId, id) { return publicDraft(get.get(requireDraftId(id), requireUser(portalUserId))); },
    list(portalUserId) { return list.all(requireUser(portalUserId)).map(publicDraft); },
    rename(portalUserId, id, title) {
      const user = requireUser(portalUserId);
      const draftId = requireDraftId(id);
      if (rename.run(cleanTitle(title), Date.now(), draftId, user).changes !== 1) return null;
      return publicDraft(get.get(draftId, user));
    },
    updateModel(portalUserId, id, modelId) {
      const user = requireUser(portalUserId);
      const draftId = requireDraftId(id);
      if (updateModel.run(cleanModel(modelId), Date.now(), draftId, user).changes !== 1) return null;
      return publicDraft(get.get(draftId, user));
    },
    remove(portalUserId, id) { return remove.run(requireDraftId(id), requireUser(portalUserId)).changes === 1; },
    removeProject(portalUserId, projectId) { return removeProject.run(optionalProjectId(projectId), requireUser(portalUserId)).changes; },
    close() { database.close(); },
  };
}

export const isSessionDraftId = (value) => DRAFT_ID.test(String(value || ""));
