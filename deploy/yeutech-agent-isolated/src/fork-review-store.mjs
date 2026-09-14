import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const STATUSES = new Set(["queued", "running", "awaiting_review", "accepted", "rejected", "failed"]);
const TRANSITIONS = Object.freeze({
  queued: new Set(["running", "failed"]),
  running: new Set(["awaiting_review", "failed"]),
  awaiting_review: new Set(["accepted", "rejected"]),
  accepted: new Set(), rejected: new Set(), failed: new Set(),
});

function requireId(value, prefix, label) {
  const text = String(value || "");
  if (!new RegExp(`^${prefix}_[A-Za-z0-9]{8,64}$`).test(text)) {
    throw Object.assign(new Error(`${label} is invalid`), { statusCode: 400 });
  }
  return text;
}

function parse(value) { return value == null ? null : JSON.parse(value); }

function publicRecord(row) {
  return row ? {
    id: row.id,
    sourceSessionId: row.source_session_id,
    forkSessionId: row.fork_session_id,
    mode: row.mode,
    status: row.status,
    request: parse(row.request_json),
    result: parse(row.result_json),
    error: parse(row.error_json),
    review: parse(row.review_json),
    revision: Number(row.revision),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  } : null;
}

export function createForkReviewStore(databasePath) {
  mkdirSync(path.dirname(databasePath), { recursive: true });
  const database = new DatabaseSync(databasePath);
  database.exec(`
    PRAGMA journal_mode=WAL;
    PRAGMA busy_timeout=5000;
    PRAGMA synchronous=NORMAL;
    CREATE TABLE IF NOT EXISTS fork_review_runs (
      id TEXT PRIMARY KEY,
      portal_user_id INTEGER NOT NULL,
      source_session_id TEXT NOT NULL,
      fork_session_id TEXT,
      directory TEXT NOT NULL,
      mode TEXT NOT NULL,
      status TEXT NOT NULL,
      request_json TEXT NOT NULL,
      result_json TEXT,
      error_json TEXT,
      review_json TEXT,
      revision INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS fork_review_owner_idx
      ON fork_review_runs(portal_user_id, updated_at DESC);
  `);
  const find = database.prepare("SELECT * FROM fork_review_runs WHERE id = ? AND portal_user_id = ?");
  const insert = database.prepare(`INSERT INTO fork_review_runs
    (id, portal_user_id, source_session_id, fork_session_id, directory, mode, status, request_json, result_json, error_json, review_json, revision, created_at, updated_at)
    VALUES (?, ?, ?, NULL, ?, ?, 'queued', ?, NULL, NULL, NULL, 1, ?, ?)`);
  const update = database.prepare(`UPDATE fork_review_runs SET fork_session_id = COALESCE(?, fork_session_id), status = ?,
    result_json = ?, error_json = ?, review_json = ?, revision = revision + 1, updated_at = ?
    WHERE id = ? AND portal_user_id = ? AND revision = ? AND status = ?`);

  return {
    create(value) {
      const portalUserId = Number(value?.portalUserId);
      if (!Number.isSafeInteger(portalUserId) || portalUserId <= 0) throw Object.assign(new Error("Portal user is invalid"), { statusCode: 400 });
      const id = requireId(value?.id, "fork", "Fork run ID");
      const sourceSessionId = requireId(value?.sourceSessionId, "ses", "Source session ID");
      const directory = path.resolve(String(value?.directory || ""));
      if (!path.isAbsolute(String(value?.directory || ""))) throw Object.assign(new Error("Fork directory is invalid"), { statusCode: 400 });
      const mode = String(value?.mode || "review-only");
      if (!new Set(["review-only", "candidate"]).has(mode)) throw Object.assign(new Error("Fork mode is invalid"), { statusCode: 400 });
      const now = Date.now();
      insert.run(id, portalUserId, sourceSessionId, directory, mode, JSON.stringify(value?.request || {}), now, now);
      return publicRecord(find.get(id, portalUserId));
    },
    get(portalUserId, id) { return publicRecord(find.get(id, portalUserId)); },
    transition(portalUserId, id, expectedRevision, status, detail = {}) {
      if (!STATUSES.has(status)) throw Object.assign(new Error("Fork status is invalid"), { statusCode: 400 });
      const current = find.get(id, portalUserId);
      if (!current) return { missing: true };
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) throw Object.assign(new Error("Fork revision is invalid"), { statusCode: 400 });
      if (!TRANSITIONS[current.status]?.has(status)) throw Object.assign(new Error(`Unsupported fork transition: ${current.status} -> ${status}`), { statusCode: 409 });
      const forkSessionId = detail.forkSessionId == null ? null : requireId(detail.forkSessionId, "ses", "Fork session ID");
      const result = update.run(
        forkSessionId, status,
        detail.result == null ? current.result_json : JSON.stringify(detail.result),
        detail.error == null ? current.error_json : JSON.stringify(detail.error),
        detail.review == null ? current.review_json : JSON.stringify(detail.review),
        Date.now(), id, portalUserId, expectedRevision, current.status,
      );
      if (result.changes !== 1) return { conflict: true, run: publicRecord(find.get(id, portalUserId)) };
      return { run: publicRecord(find.get(id, portalUserId)) };
    },
    close() { database.close(); },
  };
}
