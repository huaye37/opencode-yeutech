#!/bin/sh
set -eu

PROJECT_ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
RUNTIME_ROOT="${YEUTECH_AGENT_RUNTIME_ROOT:-$PROJECT_ROOT/.runtime}"
MIGRATION_PORT="${YEUTECH_MIGRATION_PORT:-18142}"

[ -n "${YEUTECH_MIGRATION_DATABASE:-}" ] || {
  echo "YEUTECH_MIGRATION_DATABASE must point to a local SQLite backup." >&2
  exit 1
}
[ -f "$YEUTECH_MIGRATION_DATABASE" ] || {
  echo "Migration database does not exist: $YEUTECH_MIGRATION_DATABASE" >&2
  exit 1
}
[ -z "${YEUTECH_MIGRATION_PROJECTS_ROOT:-}" ] || [ -d "$YEUTECH_MIGRATION_PROJECTS_ROOT" ] || {
  echo "Migration projects root does not exist: $YEUTECH_MIGRATION_PROJECTS_ROOT" >&2
  exit 1
}
if lsof -nP -iTCP:"$MIGRATION_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "Port $MIGRATION_PORT is already occupied; refusing to alter the running service." >&2
  exit 1
fi

mkdir -p "$RUNTIME_ROOT/logs" "$RUNTIME_ROOT/pids" "$RUNTIME_ROOT/migration"
chmod 700 "$RUNTIME_ROOT/migration"
export YEUTECH_AGENT_RUNTIME_ROOT="$RUNTIME_ROOT"
export YEUTECH_MIGRATION_USER_ID="${YEUTECH_MIGRATION_USER_ID:-3}"
export YEUTECH_MIGRATION_OWNER_DIRECTORY="${YEUTECH_MIGRATION_OWNER_DIRECTORY:-ryan}"
nohup node "$PROJECT_ROOT/src/migration-service.mjs" > "$RUNTIME_ROOT/logs/migration.log" 2>&1 &
migration_pid=$!
echo "$migration_pid" > "$RUNTIME_ROOT/pids/migration.pid"

ready=0
attempt=0
while [ "$attempt" -lt 20 ]; do
  if curl -fsS -H 'Origin: http://127.0.0.1:18140' "http://127.0.0.1:$MIGRATION_PORT/health" >/dev/null 2>&1; then ready=1; break; fi
  attempt=$((attempt + 1))
  sleep 0.25
done
[ "$ready" = 1 ] || { echo "Migration service did not become ready." >&2; exit 1; }
echo "Migration service started on 127.0.0.1:$MIGRATION_PORT (PID $migration_pid)."
