import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export function createSystemTaskStore(databasePath) {
  mkdirSync(path.dirname(databasePath), { recursive: true });
  const database = new DatabaseSync(databasePath);
  database.exec(`
    PRAGMA journal_mode=WAL;
    PRAGMA busy_timeout=5000;
    PRAGMA synchronous=NORMAL;
    CREATE TABLE IF NOT EXISTS system_sessions (
      session_key TEXT PRIMARY KEY,
      runtime_session_id TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS system_tasks (
      id TEXT PRIMARY KEY,
      idempotency_key TEXT UNIQUE,
      session_key TEXT NOT NULL,
      runtime_session_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      model_id TEXT NOT NULL,
      prompt TEXT NOT NULL,
      status TEXT NOT NULL,
      error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS system_tasks_session_idx ON system_tasks(session_key, created_at DESC);
  `);
  const columns = new Set(database.prepare("PRAGMA table_info(system_tasks)").all().map((column) => column.name));
  if (!columns.has("prompt_message_id")) database.exec("ALTER TABLE system_tasks ADD COLUMN prompt_message_id TEXT");
  if (!columns.has("error_code")) database.exec("ALTER TABLE system_tasks ADD COLUMN error_code TEXT");
  const findSession = database.prepare("SELECT * FROM system_sessions WHERE session_key = ?");
  const saveSession = database.prepare(`INSERT INTO system_sessions(session_key, runtime_session_id, created_at, updated_at)
    VALUES (?, ?, ?, ?) ON CONFLICT(session_key) DO UPDATE SET runtime_session_id=excluded.runtime_session_id, updated_at=excluded.updated_at`);
  const findTask = database.prepare("SELECT * FROM system_tasks WHERE id = ?");
  const findIdempotent = database.prepare("SELECT * FROM system_tasks WHERE idempotency_key = ?");
  const insertTask = database.prepare(`INSERT INTO system_tasks
    (id, idempotency_key, session_key, runtime_session_id, kind, model_id, prompt, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const updateTask = database.prepare("UPDATE system_tasks SET status = ?, error = ?, error_code = ?, updated_at = ? WHERE id = ? AND status IN (SELECT value FROM json_each(?))");
  const updateAttempt = database.prepare("UPDATE system_tasks SET prompt_message_id = ?, model_id = ?, prompt = ?, status = 'submitting', error = NULL, error_code = NULL, updated_at = ? WHERE id = ?");
  const updateAttemptStatus = database.prepare("UPDATE system_tasks SET status = ?, error = ?, error_code = ?, updated_at = ? WHERE id = ? AND prompt_message_id = ? AND status IN (SELECT value FROM json_each(?))");
  const activeCount = database.prepare("SELECT COUNT(*) AS count FROM system_tasks WHERE status IN ('submitting', 'running')");
  const activeForSession = database.prepare("SELECT COUNT(*) AS count FROM system_tasks WHERE session_key = ? AND id != ? AND status IN ('submitting', 'running')");

  function insert(task) {
    const now = Date.now();
    insertTask.run(task.id, task.idempotencyKey || null, task.sessionKey, task.runtimeSessionID, task.kind, task.modelID, task.prompt, task.status, now, now);
    if (task.promptMessageID) updateAttempt.run(task.promptMessageID, task.modelID, task.prompt, now, task.id);
    return findTask.get(task.id);
  }

  return {
    session: (key) => findSession.get(key),
    saveSession(key, runtimeSessionID) {
      const now = Date.now();
      saveSession.run(key, runtimeSessionID, now, now);
    },
    task: (id) => findTask.get(id),
    idempotent: (key) => key ? findIdempotent.get(key) : undefined,
    create: insert,
    reserve(task, maxActive = 2) {
      database.exec("BEGIN IMMEDIATE");
      try {
        const existing = task.idempotencyKey ? findIdempotent.get(task.idempotencyKey) : undefined;
        if (existing) { database.exec("COMMIT"); return { task: existing, duplicate: true }; }
        if (Number(activeCount.get().count) >= maxActive) {
          database.exec("ROLLBACK");
          return { task: null, capacityReached: true };
        }
        if (Number(activeForSession.get(task.sessionKey, task.id).count) > 0) {
          database.exec("ROLLBACK");
          return { task: null, sessionBusy: true };
        }
        const created = insert(task);
        database.exec("COMMIT");
        return { task: created, duplicate: false };
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    },
    update(id, status, error = null, errorCode = null) {
      const allowedFrom = {
        running: ["submitting"],
        completed: ["submitting", "running"],
        failed: ["submitting", "running"],
        stopped: ["submitting", "running"],
      }[status];
      if (!allowedFrom) throw new Error(`Unsupported system task status transition: ${status}`);
      updateTask.run(status, error, errorCode, Date.now(), id, JSON.stringify(allowedFrom));
      return findTask.get(id);
    },
    updateAttemptStatus(id, expectedPromptMessageID, status, error = null, errorCode = null) {
      const allowedFrom = {
        running: ["submitting"],
        completed: ["submitting", "running"],
        failed: ["submitting", "running"],
      }[status];
      if (!allowedFrom) throw new Error(`Unsupported system task attempt transition: ${status}`);
      updateAttemptStatus.run(status, error, errorCode, Date.now(), id, expectedPromptMessageID, JSON.stringify(allowedFrom));
      return findTask.get(id);
    },
    setAttempt(id, promptMessageID, modelID, prompt) {
      updateAttempt.run(promptMessageID, modelID, prompt, Date.now(), id);
      return findTask.get(id);
    },
    reserveResume(id, promptMessageID, modelID, prompt, maxActive = 2) {
      database.exec("BEGIN IMMEDIATE");
      try {
        const task = findTask.get(id);
        if (!task) { database.exec("ROLLBACK"); return { task: null, missing: true }; }
        if (new Set(["submitting", "running"]).has(task.status)) {
          database.exec("COMMIT");
          return { task, alreadyActive: true };
        }
        if (Number(activeCount.get().count) >= maxActive) {
          database.exec("ROLLBACK");
          return { task: null, capacityReached: true };
        }
        if (Number(activeForSession.get(task.session_key, task.id).count) > 0) {
          database.exec("ROLLBACK");
          return { task: null, sessionBusy: true };
        }
        updateAttempt.run(promptMessageID, modelID, prompt, Date.now(), id);
        database.exec("COMMIT");
        return { task: findTask.get(id) };
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    },
    close: () => database.close(),
  };
}
