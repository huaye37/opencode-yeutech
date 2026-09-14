#!/bin/sh
set -eu

runtime_root="${YEUTECH_AGENT_RUNTIME_ROOT:-/runtime}"
migration_port="${YEUTECH_MIGRATION_PORT:-18142}"
bff_port="${YEUTECH_AGENT_BFF_PORT:-18140}"
supervisor_port="${YEUTECH_SUPERVISOR_PORT:-18141}"
key_file="${YEUTECH_CLI_PROXY_KEY_FILE:-/run/secrets/cliproxy.key}"

test -r "$key_file" || { echo "CLIProxyAPI key file is not readable: $key_file" >&2; exit 1; }
migration_source="${YEUTECH_MIGRATION_DATABASE:?YEUTECH_MIGRATION_DATABASE is required}"
test -r "$migration_source" || { echo "Migration database is not readable." >&2; exit 1; }
test -d "${YEUTECH_AGENT_PROJECTS_ROOT:-/projects}" || { echo "Agent projects root is not mounted." >&2; exit 1; }
test -d "${YEUTECH_SYSTEM_WORKSPACE:?YEUTECH_SYSTEM_WORKSPACE is required}" || { echo "System workspace is not mounted." >&2; exit 1; }

mkdir -p "$runtime_root/config" "$runtime_root/logs" "$runtime_root/migration" "$runtime_root/secrets" \
  "$runtime_root/xdg/config" "$runtime_root/xdg/data" "$runtime_root/xdg/cache" "$runtime_root/xdg/state"
chmod 700 "$runtime_root/config" "$runtime_root/migration" "$runtime_root/secrets" \
  "$runtime_root/xdg" "$runtime_root/xdg/config" "$runtime_root/xdg/data" "$runtime_root/xdg/cache" "$runtime_root/xdg/state"

# SQLite may need WAL/SHM files even when the database is opened read-only. Keep
# the immutable deployment snapshot mounted read-only and seed one writable,
# isolated runtime copy for the migration service.
migration_database="$runtime_root/migration/$(basename "$migration_source")"
if [ ! -s "$migration_database" ]; then
  migration_staging="$migration_database.tmp.$$"
  cp "$migration_source" "$migration_staging"
  chmod 600 "$migration_staging"
  mv "$migration_staging" "$migration_database"
fi
export YEUTECH_MIGRATION_DATABASE="$migration_database"

password_file="$runtime_root/secrets/opencode.password"
[ -s "$password_file" ] || { umask 077; openssl rand -hex 32 > "$password_file"; }
identity_file="${YEUTECH_AGENT_IDENTITY_SECRET_FILE:-$runtime_root/secrets/portal.identity.secret}"
[ -s "$identity_file" ] || { umask 077; openssl rand -hex 32 > "$identity_file"; }
system_token_file="${YEUTECH_SYSTEM_SERVICE_TOKEN_FILE:-$runtime_root/secrets/system-kaoyan.token}"
[ -s "$system_token_file" ] || { umask 077; openssl rand -hex 32 > "$system_token_file"; }
supervisor_token_file="${YEUTECH_SUPERVISOR_TOKEN_FILE:-$runtime_root/secrets/supervisor.token}"
[ -s "$supervisor_token_file" ] || { umask 077; openssl rand -hex 32 > "$supervisor_token_file"; }
export OPENCODE_SERVER_USERNAME="${OPENCODE_SERVER_USERNAME:-yeutech-agent}"
export OPENCODE_SERVER_PASSWORD="$(tr -d '\r\n' < "$password_file")"
export YEUTECH_AGENT_IDENTITY_SECRET="$(tr -d '\r\n' < "$identity_file")"
export YEUTECH_SYSTEM_SERVICE_TOKEN="$(tr -d '\r\n' < "$system_token_file")"
export YEUTECH_SUPERVISOR_TOKEN="$(tr -d '\r\n' < "$supervisor_token_file")"
export YEUTECH_CLI_PROXY_KEY="$(tr -d '\r\n' < "$key_file")"
export YEUTECH_CREDENTIAL_GENERATION="$(printf '%s' "$YEUTECH_CLI_PROXY_KEY" | openssl dgst -sha256 | awk '{print substr($NF,1,16)}')"
export YEUTECH_MODEL_ROUTE_ID="${YEUTECH_MODEL_ROUTE_ID:-nas-cliproxy-18319}"
export YEUTECH_SUPERVISOR_URL="http://127.0.0.1:$supervisor_port"
export YEUTECH_MIGRATION_URL="http://127.0.0.1:$migration_port"
export YEUTECH_MIGRATION_PORT="$migration_port"
export YEUTECH_AGENT_BFF_HOST="0.0.0.0"
export YEUTECH_AGENT_BFF_PORT="$bff_port"
export YEUTECH_AGENT_WEB_ROOT="/app/web/dist"
export YEUTECH_MODEL_RELOAD_STATE_FILE="${YEUTECH_MODEL_RELOAD_STATE_FILE:-$runtime_root/model-reload-state.json}"
export YEUTECH_SYSTEM_WORKSPACE="${YEUTECH_SYSTEM_WORKSPACE:-/projects/system/kaoyan}"
export YEUTECH_SYSTEM_TASK_DATABASE="${YEUTECH_SYSTEM_TASK_DATABASE:-$runtime_root/system/kaoyan-tasks.sqlite}"
export YEUTECH_SYSTEM_WORKER_PORT="${YEUTECH_SYSTEM_WORKER_PORT:-18133}"
export YEUTECH_SYSTEM_OPENCODE_URL="http://127.0.0.1:$YEUTECH_SYSTEM_WORKER_PORT"
export YEUTECH_SYSTEM_MODEL_CONFIG="$runtime_root/workers/system-kaoyan/config/opencode.json"
export YEUTECH_SYSTEM_MODEL_RELOAD_STATE="$runtime_root/workers/system-kaoyan/reload-state.json"
export YEUTECH_SYSTEM_ACTIVITY_LEASE_FILE="$runtime_root/workers/system-kaoyan/activity-lease.json"
export YEUTECH_MIGRATION_MAPPING_FILE="${YEUTECH_MIGRATION_MAPPING_FILE:-$runtime_root/migration/mappings.json}"
legacy_data="$runtime_root/xdg/data"
ryan_data="$runtime_root/workers/user-3/xdg/data"
if [ -s "$legacy_data/opencode/opencode.db" ] && [ ! -s "$ryan_data/opencode/opencode.db" ]; then
  mkdir -p "$ryan_data"
  cp -a "$legacy_data/." "$ryan_data/"
fi
node /app/src/opencode-supervisor.mjs &
supervisor_pid=$!
migration_pid=""
bff_pid=""
cleanup() {
  trap - EXIT INT TERM
  for process_id in "$bff_pid" "$migration_pid" "$supervisor_pid"; do
    [ -n "$process_id" ] && kill "$process_id" >/dev/null 2>&1 || true
  done
  wait >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

attempt=0
until curl -fsS -H "Authorization: Bearer $YEUTECH_SUPERVISOR_TOKEN" "$YEUTECH_SUPERVISOR_URL/ready" >/dev/null 2>&1; do
  kill -0 "$supervisor_pid" >/dev/null 2>&1 || { echo "OpenCode supervisor exited during startup." >&2; exit 1; }
  attempt=$((attempt + 1))
  [ "$attempt" -lt 60 ] || { echo "System OpenCode worker did not become ready." >&2; exit 1; }
  sleep 1
done

node /app/src/migration-service.mjs &
migration_pid=$!
attempt=0
until curl -fsS "$YEUTECH_MIGRATION_URL/health" >/dev/null 2>&1; do
  kill -0 "$migration_pid" >/dev/null 2>&1 || { echo "Migration service exited during startup." >&2; exit 1; }
  attempt=$((attempt + 1))
  [ "$attempt" -lt 30 ] || { echo "Migration service did not become ready." >&2; exit 1; }
  sleep 1
done

node /app/src/agent-bff.mjs &
bff_pid=$!
attempt=0
until curl -fsS "http://127.0.0.1:$bff_port/health" >/dev/null 2>&1; do
  kill -0 "$bff_pid" >/dev/null 2>&1 || { echo "Workbench BFF exited during startup." >&2; exit 1; }
  attempt=$((attempt + 1))
  [ "$attempt" -lt 30 ] || { echo "Workbench BFF did not become ready." >&2; exit 1; }
  sleep 1
done

echo "YEUTECH Agent ready on port $bff_port (dynamic workers, migration $migration_port)."
while kill -0 "$supervisor_pid" >/dev/null 2>&1 && kill -0 "$migration_pid" >/dev/null 2>&1 && kill -0 "$bff_pid" >/dev/null 2>&1; do
  sleep 5
done
echo "A required YEUTECH Agent process exited." >&2
exit 1
