import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const MODES = new Set(["ask", "smart", "full"]);

function cleanModel(value) {
  const model = String(value || "").trim();
  if (!model || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(model)) {
    throw Object.assign(new Error("Model ID is invalid"), { statusCode: 400 });
  }
  return model;
}

export function createSessionPolicyStore(databasePath) {
  mkdirSync(path.dirname(databasePath), { recursive: true });
  const database = new DatabaseSync(databasePath);
  database.exec(`
    PRAGMA journal_mode=WAL;
    PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS session_policies (
      portal_user_id INTEGER NOT NULL,
      session_id TEXT NOT NULL,
      permission_mode TEXT NOT NULL,
      model_id TEXT,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (portal_user_id, session_id)
    );
  `);
  if (!database.prepare("PRAGMA table_info(session_policies)").all().some((column) => column.name === "model_id")) {
    database.exec("ALTER TABLE session_policies ADD COLUMN model_id TEXT");
  }
  if (!database.prepare("PRAGMA table_info(session_policies)").all().some(column => column.name === "reasoning_effort")) database.exec("ALTER TABLE session_policies ADD COLUMN reasoning_effort TEXT");
  const read = database.prepare("SELECT permission_mode, model_id, reasoning_effort, updated_at FROM session_policies WHERE portal_user_id = ? AND session_id = ?");
  const list = database.prepare("SELECT session_id, permission_mode, model_id, reasoning_effort, updated_at FROM session_policies WHERE portal_user_id = ?");
  const writeReasoning = database.prepare("UPDATE session_policies SET reasoning_effort = ?, updated_at = ? WHERE portal_user_id = ? AND session_id = ?");
  const write = database.prepare(`INSERT INTO session_policies (portal_user_id, session_id, permission_mode, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(portal_user_id, session_id) DO UPDATE SET permission_mode=excluded.permission_mode, updated_at=excluded.updated_at`);
  const writeModel = database.prepare(`INSERT INTO session_policies (portal_user_id, session_id, permission_mode, model_id, updated_at) VALUES (?, ?, 'smart', ?, ?)
    ON CONFLICT(portal_user_id, session_id) DO UPDATE SET model_id=excluded.model_id, updated_at=excluded.updated_at`);
  return {
    get(portalUserId, sessionId) { return read.get(Number(portalUserId), String(sessionId))?.permission_mode || "smart"; },
    set(portalUserId, sessionId, mode) {
      const selected = MODES.has(mode) ? mode : "smart";
      write.run(Number(portalUserId), String(sessionId), selected, Date.now());
      return selected;
    },
    getModel(portalUserId, sessionId) { return read.get(Number(portalUserId), String(sessionId))?.model_id || null; },
    getReasoning(portalUserId, sessionId) { return read.get(Number(portalUserId), String(sessionId))?.reasoning_effort || ""; },
    setReasoning(portalUserId, sessionId, effort) { writeReasoning.run(effort || null, Date.now(), Number(portalUserId), String(sessionId)); },
    setModel(portalUserId, sessionId, modelId) {
      const selected = cleanModel(modelId);
      writeModel.run(Number(portalUserId), String(sessionId), selected, Date.now());
      return selected;
    },
    list(portalUserId) {
      return list.all(Number(portalUserId)).map((row) => ({
        sessionId: row.session_id,
        permissionMode: MODES.has(row.permission_mode) ? row.permission_mode : "smart",
        modelId: row.model_id || null,
        reasoningEffort: row.reasoning_effort || "",
        updatedAt: Number(row.updated_at),
      }));
    },
    close() { database.close(); },
  };
}
