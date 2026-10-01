import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

function publicItem(row) {
  return row ? {
    id: row.id,
    portalUserId: Number(row.portal_user_id),
    username: row.username,
    sessionId: row.session_id,
    payload: JSON.parse(row.payload_json),
    status: row.status,
    createdAt: Number(row.created_at),
    attempts: Number(row.attempts),
  } : null;
}

export function createSessionInboxStore(databasePath) {
  mkdirSync(path.dirname(databasePath), { recursive: true });
  const database = new DatabaseSync(databasePath);
  database.exec(`
    PRAGMA journal_mode=WAL;
    PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS session_inbox (
      id TEXT PRIMARY KEY,
      portal_user_id INTEGER NOT NULL,
      username TEXT NOT NULL,
      session_id TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued',
      attempts INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS session_inbox_pending
      ON session_inbox(status, created_at ASC);
    UPDATE session_inbox SET status = 'queued' WHERE status = 'submitting';
  `);
  const insert = database.prepare("INSERT INTO session_inbox VALUES (?, ?, ?, ?, ?, 'queued', 0, ?, ?)");
  const get = database.prepare("SELECT * FROM session_inbox WHERE id = ?");
  const findActiveDuplicate = database.prepare("SELECT * FROM session_inbox WHERE portal_user_id = ? AND session_id = ? AND payload_json = ? AND status IN ('queued', 'submitting') ORDER BY created_at ASC LIMIT 1");
  const pending = database.prepare("SELECT * FROM session_inbox WHERE status = 'queued' ORDER BY created_at ASC LIMIT ?");
  const forSession = database.prepare("SELECT * FROM session_inbox WHERE portal_user_id = ? AND session_id = ? AND status IN ('queued', 'submitting') ORDER BY created_at ASC");
  const count = database.prepare("SELECT COUNT(*) AS count FROM session_inbox WHERE portal_user_id = ? AND session_id = ? AND status IN ('queued', 'submitting')");
  const claim = database.prepare("UPDATE session_inbox SET status = 'submitting', attempts = attempts + 1, updated_at = ? WHERE id = ? AND status = 'queued'");
  const requeue = database.prepare("UPDATE session_inbox SET status = 'queued', updated_at = ? WHERE id = ? AND status = 'submitting'");
  const complete = database.prepare("DELETE FROM session_inbox WHERE id = ? AND status = 'submitting'");
  return {
    enqueue({ portalUserId, username, sessionId, payload }) {
      const serializedPayload = JSON.stringify(payload);
      const duplicate = publicItem(findActiveDuplicate.get(portalUserId, sessionId, serializedPayload));
      if (duplicate) {
        const position = forSession.all(portalUserId, sessionId).findIndex((row) => row.id === duplicate.id) + 1;
        return { ...duplicate, position: Math.max(1, position), duplicate: true };
      }
      const id = `inbox_${randomUUID().replaceAll("-", "")}`;
      const now = Date.now();
      insert.run(id, portalUserId, username, sessionId, serializedPayload, now, now);
      return { ...publicItem(get.get(id)), position: Number(count.get(portalUserId, sessionId).count) };
    },
    pending(limit = 20) { return pending.all(Math.min(100, Math.max(1, Number(limit) || 20))).map(publicItem); },
    forSession(portalUserId, sessionId) {
      return forSession.all(portalUserId, sessionId).map((row, index) => ({ ...publicItem(row), position: index + 1 }));
    },
    claim(id) { return claim.run(Date.now(), id).changes === 1 ? publicItem(get.get(id)) : null; },
    requeue(id) { return requeue.run(Date.now(), id).changes === 1; },
    complete(id) { return complete.run(id).changes === 1; },
    count(portalUserId, sessionId) { return Number(count.get(portalUserId, sessionId).count); },
    close() { database.close(); },
  };
}
