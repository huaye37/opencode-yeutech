import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}

function fingerprint(value) {
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

export function createProjectionEventStore(databasePath) {
  mkdirSync(path.dirname(databasePath), { recursive: true });
  const database = new DatabaseSync(databasePath);
  database.exec(`
    PRAGMA journal_mode=WAL;
    PRAGMA busy_timeout=5000;
    PRAGMA synchronous=NORMAL;
    CREATE TABLE IF NOT EXISTS projection_events (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      portal_user_id INTEGER NOT NULL,
      session_id TEXT NOT NULL,
      event_key TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      type TEXT NOT NULL,
      payload TEXT NOT NULL,
      recorded_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS projection_events_replay_idx
      ON projection_events(portal_user_id, session_id, sequence);
  `);
  const insert = database.prepare(`INSERT INTO projection_events
    (portal_user_id, session_id, event_key, fingerprint, type, payload, recorded_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`);
  const replay = database.prepare(`SELECT sequence, type, payload, recorded_at FROM projection_events
    WHERE portal_user_id = ? AND session_id = ? AND sequence > ? ORDER BY sequence ASC LIMIT ?`);
  const latest = database.prepare("SELECT COALESCE(MAX(sequence), 0) AS sequence FROM projection_events WHERE portal_user_id = ? AND session_id = ?");
  const latestForKey = database.prepare("SELECT fingerprint, sequence FROM projection_events WHERE portal_user_id = ? AND session_id = ? AND event_key = ? ORDER BY sequence DESC LIMIT 1");

  return {
    append(portalUserId, sessionId, eventKey, type, payload) {
      const digest = fingerprint(payload);
      const previous = latestForKey.get(portalUserId, sessionId, eventKey);
      if (previous?.fingerprint === digest) return { inserted: false, cursor: Number(previous.sequence) };
      const result = insert.run(portalUserId, sessionId, eventKey, digest, type, JSON.stringify(payload), Date.now());
      return { inserted: true, cursor: Number(result.lastInsertRowid) };
    },
    replay(portalUserId, sessionId, after = 0, limit = 500) {
      return replay.all(portalUserId, sessionId, Math.max(0, Number(after) || 0), Math.min(1000, Math.max(1, Number(limit) || 500))).map((row) => ({
        cursor: Number(row.sequence), type: row.type, data: JSON.parse(row.payload), recordedAt: Number(row.recorded_at),
      }));
    },
    *replayAll(portalUserId, sessionId, after = 0, pageSize = 500) {
      let cursor = Math.max(0, Number(after) || 0);
      const limit = Math.min(1000, Math.max(1, Number(pageSize) || 500));
      for (;;) {
        const page = replay.all(portalUserId, sessionId, cursor, limit);
        for (const row of page) {
          cursor = Number(row.sequence);
          yield { cursor, type: row.type, data: JSON.parse(row.payload), recordedAt: Number(row.recorded_at) };
        }
        if (page.length < limit) return;
      }
    },
    messages(portalUserId, sessionId, before = null, limit = 10) {
      const latestMessages = new Map();
      for (const event of this.replayAll(portalUserId, sessionId)) {
        if (event.type === "message.upsert" && event.data?.id) latestMessages.set(String(event.data.id), event.data);
      }
      const records = [...latestMessages.values()].sort((left, right) =>
        Number(left.createdAt || 0) - Number(right.createdAt || 0) || String(left.id).localeCompare(String(right.id)));
      const pageSize = Math.min(100, Math.max(1, Number(limit) || 10));
      const requestedEnd = before === null || before === undefined || before === "" ? records.length : Number(before);
      const end = Number.isSafeInteger(requestedEnd) ? Math.min(records.length, Math.max(0, requestedEnd)) : records.length;
      const start = Math.max(0, end - pageSize);
      return { records: records.slice(start, end), cursor: start > 0 ? String(start) : null };
    },
    latestCursor: (portalUserId, sessionId) => Number(latest.get(portalUserId, sessionId).sequence),
    close: () => database.close(),
  };
}
