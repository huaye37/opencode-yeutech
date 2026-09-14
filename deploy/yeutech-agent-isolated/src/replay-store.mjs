import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export function createReplayStore(databasePath) {
  mkdirSync(path.dirname(databasePath), { recursive: true });
  const database = new DatabaseSync(databasePath);
  database.exec(`
    PRAGMA journal_mode=WAL;
    PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS replay_runs (
      id TEXT PRIMARY KEY, portal_user_id INTEGER NOT NULL, source_session_id TEXT NOT NULL,
      runtime_session_id TEXT, directory TEXT NOT NULL, model_id TEXT NOT NULL, workload TEXT NOT NULL,
      status TEXT NOT NULL, baseline_json TEXT NOT NULL, result_json TEXT, error_json TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS replay_runs_user_idx ON replay_runs(portal_user_id, created_at DESC);
  `);
  const find = database.prepare("SELECT * FROM replay_runs WHERE id = ? AND portal_user_id = ?");
  const insert = database.prepare("INSERT INTO replay_runs VALUES (?, ?, ?, NULL, ?, ?, ?, 'queued', ?, NULL, NULL, ?, ?)");
  const update = database.prepare("UPDATE replay_runs SET runtime_session_id = COALESCE(?, runtime_session_id), status = ?, result_json = ?, error_json = ?, updated_at = ? WHERE id = ? AND portal_user_id = ?");
  const publicRun = (row) => row ? ({
    id: row.id, sourceSessionId: row.source_session_id, replaySessionId: row.runtime_session_id,
    modelId: row.model_id, workload: row.workload, status: row.status,
    baseline: JSON.parse(row.baseline_json), result: row.result_json ? JSON.parse(row.result_json) : null,
    error: row.error_json ? JSON.parse(row.error_json) : null, createdAt: row.created_at, updatedAt: row.updated_at,
  }) : null;
  return {
    create(value) {
      const now = Date.now();
      insert.run(value.id, value.portalUserId, value.sourceSessionId, value.directory, value.modelId, value.workload, JSON.stringify(value.baseline), now, now);
      return publicRun(find.get(value.id, value.portalUserId));
    },
    get(id, portalUserId) { return publicRun(find.get(id, portalUserId)); },
    update(id, portalUserId, status, detail = {}) {
      update.run(detail.replaySessionId || null, status, detail.result ? JSON.stringify(detail.result) : null, detail.error ? JSON.stringify(detail.error) : null, Date.now(), id, portalUserId);
      return publicRun(find.get(id, portalUserId));
    },
    close() { database.close(); },
  };
}
