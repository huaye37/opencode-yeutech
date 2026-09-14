import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const STATUSES = new Set(["active", "paused", "blocked", "complete"]);

function requireText(value, label, limit = 20_000) {
  const text = String(value || "").trim();
  if (!text || text.length > limit) throw Object.assign(new Error(`${label} is invalid`), { statusCode: 400 });
  return text;
}

function publicGoal(row) {
  return row && {
    id: row.id,
    scopeKey: row.scope_key,
    objective: row.objective,
    phase: row.phase,
    status: row.status,
    blockReason: row.block_reason,
    acceptancePolicy: row.acceptance_policy,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function createGoalStore(databasePath) {
  mkdirSync(path.dirname(databasePath), { recursive: true });
  const database = new DatabaseSync(databasePath);
  database.exec(`
    PRAGMA journal_mode=WAL;
    PRAGMA busy_timeout=5000;
    PRAGMA synchronous=NORMAL;
    CREATE TABLE IF NOT EXISTS work_goals (
      id TEXT PRIMARY KEY,
      portal_user_id INTEGER NOT NULL,
      scope_key TEXT NOT NULL,
      objective TEXT NOT NULL,
      phase TEXT NOT NULL,
      status TEXT NOT NULL,
      block_reason TEXT,
      acceptance_policy TEXT NOT NULL,
      revision INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS work_goals_owner_scope_idx ON work_goals(portal_user_id, scope_key, updated_at DESC);
  `);
  const find = database.prepare("SELECT * FROM work_goals WHERE id = ? AND portal_user_id = ?");
  const list = database.prepare("SELECT * FROM work_goals WHERE portal_user_id = ? AND scope_key = ? ORDER BY updated_at DESC");
  const insert = database.prepare(`INSERT INTO work_goals
    (id, portal_user_id, scope_key, objective, phase, status, block_reason, acceptance_policy, revision, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`);
  const update = database.prepare(`UPDATE work_goals SET phase = ?, status = ?, block_reason = ?, acceptance_policy = ?, revision = revision + 1, updated_at = ?
    WHERE id = ? AND portal_user_id = ? AND revision = ?`);

  return {
    create(portalUserId, payload) {
      if (!Number.isSafeInteger(portalUserId) || portalUserId <= 0) throw Object.assign(new Error("Portal user is invalid"), { statusCode: 400 });
      const scopeKey = requireText(payload?.scopeKey, "Goal scope", 200);
      const objective = requireText(payload?.objective, "Goal objective");
      const phase = requireText(payload?.phase || "delivery", "Goal phase", 120);
      const status = String(payload?.status || "active");
      if (!STATUSES.has(status)) throw Object.assign(new Error("Goal status is invalid"), { statusCode: 400 });
      const acceptancePolicy = requireText(payload?.acceptancePolicy || "profile-evidence", "Goal acceptance policy", 500);
      const id = `goal_${randomUUID().replaceAll("-", "")}`;
      const now = Date.now();
      insert.run(id, portalUserId, scopeKey, objective, phase, status, status === "blocked" ? requireText(payload?.blockReason, "Goal block reason", 2_000) : null, acceptancePolicy, now, now);
      return publicGoal(find.get(id, portalUserId));
    },
    get(portalUserId, id) {
      return publicGoal(find.get(id, portalUserId));
    },
    list(portalUserId, scopeKey) {
      return list.all(portalUserId, requireText(scopeKey, "Goal scope", 200)).map(publicGoal);
    },
    update(portalUserId, id, payload) {
      const current = find.get(id, portalUserId);
      if (!current) return { missing: true };
      const expectedRevision = Number(payload?.revision);
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) throw Object.assign(new Error("Goal revision is invalid"), { statusCode: 400 });
      const status = String(payload?.status || current.status);
      if (!STATUSES.has(status)) throw Object.assign(new Error("Goal status is invalid"), { statusCode: 400 });
      const phase = requireText(payload?.phase || current.phase, "Goal phase", 120);
      const acceptancePolicy = requireText(payload?.acceptancePolicy || current.acceptance_policy, "Goal acceptance policy", 500);
      const blockReason = status === "blocked" ? requireText(payload?.blockReason || current.block_reason, "Goal block reason", 2_000) : null;
      const result = update.run(phase, status, blockReason, acceptancePolicy, Date.now(), id, portalUserId, expectedRevision);
      if (result.changes !== 1) return { conflict: true, goal: publicGoal(find.get(id, portalUserId)) };
      return { goal: publicGoal(find.get(id, portalUserId)) };
    },
    close() { database.close(); },
  };
}
