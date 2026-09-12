#!/bin/sh
set -eu

PROJECT_ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
SOURCE_RUNTIME="${YEUTECH_AGENT_RUNTIME_ROOT:-$PROJECT_ROOT/.runtime}"
OPENCODE_BIN="${OPENCODE_BIN:-$SOURCE_RUNTIME/opencode/current}"
OPENCODE_PORT="${YEUTECH_HISTORY_OPENCODE_PORT:-19400}"
BFF_PORT="${YEUTECH_HISTORY_BFF_PORT:-19401}"
WORKSPACE="$SOURCE_RUNTIME/workspaces/sample"
SOURCE_DB="$SOURCE_RUNTIME/xdg/data/opencode/opencode.db"
COUNTS="${YEUTECH_HISTORY_COUNTS:-100 500 1000}"
WARM_RUNS="${YEUTECH_HISTORY_WARM_RUNS:-5}"

for command_name in curl lsof node openssl ps shasum sort sqlite3; do
  command -v "$command_name" >/dev/null 2>&1 || {
    echo "Required command is unavailable: $command_name" >&2
    exit 1
  }
done

[ -x "$OPENCODE_BIN" ] || { echo "OpenCode is unavailable at $OPENCODE_BIN" >&2; exit 1; }
[ -f "$SOURCE_DB" ] || { echo "OpenCode database is unavailable at $SOURCE_DB" >&2; exit 1; }
[ -f "$SOURCE_RUNTIME/config/opencode.json" ] || { echo "OpenCode config is unavailable." >&2; exit 1; }

for port in "$OPENCODE_PORT" "$BFF_PORT"; do
  if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "Port $port is occupied; refusing to alter the listener." >&2
    exit 1
  fi
done

BENCH_ROOT="$(mktemp -d /tmp/yeutech-history-bench.XXXXXX)"
opencode_pid=""
bff_pid=""

stop_stack() {
  for process_id in "$bff_pid" "$opencode_pid"; do
    [ -n "$process_id" ] && kill "$process_id" >/dev/null 2>&1 || true
  done
  bff_pid=""
  opencode_pid=""
}

cleanup() {
  stop_stack
  rm -rf "$BENCH_ROOT"
}
trap cleanup EXIT INT TERM

password="$(openssl rand -hex 32)"
portal_token="$(openssl rand -hex 32)"
bridge_token="$(tr -d '\r\n' < "$SOURCE_RUNTIME/secrets/bridge.token")"
authorization="Authorization: Bearer $portal_token"

start_stack() {
  runtime_root="$1"
  OPENCODE_CONFIG="$runtime_root/opencode.json" \
    OPENCODE_CONFIG_DIR="$runtime_root/xdg/config" \
    XDG_CONFIG_HOME="$runtime_root/xdg/config" \
    XDG_DATA_HOME="$runtime_root/xdg/data" \
    XDG_CACHE_HOME="$runtime_root/xdg/cache" \
    XDG_STATE_HOME="$runtime_root/xdg/state" \
    YEUTECH_AGENT_BRIDGE_TOKEN="$bridge_token" \
    OPENCODE_SERVER_USERNAME="yeutech-agent" \
    OPENCODE_SERVER_PASSWORD="$password" \
    "$OPENCODE_BIN" serve --hostname 127.0.0.1 --port "$OPENCODE_PORT" \
    > "$runtime_root/logs/opencode.log" 2>&1 &
  opencode_pid=$!

  ready=0
  attempt=0
  while [ "$attempt" -lt 80 ]; do
    if curl -fsS -u "yeutech-agent:$password" "http://127.0.0.1:$OPENCODE_PORT/global/health" >/dev/null 2>&1; then
      ready=1
      break
    fi
    attempt=$((attempt + 1))
    sleep 0.1
  done
  [ "$ready" = 1 ] || { tail -40 "$runtime_root/logs/opencode.log" >&2; return 1; }

  YEUTECH_AGENT_BFF_TOKEN="$portal_token" \
    YEUTECH_AGENT_WORKSPACE="$WORKSPACE" \
    YEUTECH_OPENCODE_URL="http://127.0.0.1:$OPENCODE_PORT" \
    YEUTECH_AGENT_BFF_PORT="$BFF_PORT" \
    OPENCODE_SERVER_USERNAME="yeutech-agent" \
    OPENCODE_SERVER_PASSWORD="$password" \
    node "$PROJECT_ROOT/src/agent-bff.mjs" > "$runtime_root/logs/bff.log" 2>&1 &
  bff_pid=$!

  ready=0
  attempt=0
  while [ "$attempt" -lt 50 ]; do
    if curl -fsS -H "$authorization" "http://127.0.0.1:$BFF_PORT/health" >/dev/null 2>&1; then
      ready=1
      break
    fi
    attempt=$((attempt + 1))
    sleep 0.1
  done
  [ "$ready" = 1 ] || { tail -40 "$runtime_root/logs/bff.log" >&2; return 1; }
}

prepare_case() {
  message_count="$1"
  runtime_root="$2"
  pair_count=$((message_count / 2))

  mkdir -p "$runtime_root/xdg/data/opencode" "$runtime_root/xdg/config" \
    "$runtime_root/xdg/cache" "$runtime_root/xdg/state" "$runtime_root/logs"
  sqlite3 "$SOURCE_DB" ".backup '$runtime_root/xdg/data/opencode/opencode.db'"
  cp "$SOURCE_RUNTIME/config/opencode.json" "$runtime_root/opencode.json"

  session_id="$(sqlite3 "$runtime_root/xdg/data/opencode/opencode.db" \
    "SELECT id FROM session WHERE directory = replace('$WORKSPACE', '''', '''''') ORDER BY time_created DESC LIMIT 1;")"
  [ -n "$session_id" ] || { echo "No seed session exists for the isolated workspace." >&2; return 1; }

  sqlite3 "$runtime_root/xdg/data/opencode/opencode.db" <<SQL
PRAGMA foreign_keys=ON;
DELETE FROM part WHERE session_id='$session_id';
DELETE FROM message WHERE session_id='$session_id';
WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i + 1 FROM n WHERE i < $pair_count)
INSERT INTO message(id, session_id, time_created, time_updated, data)
SELECT printf('msg_bench%04du', i), '$session_id', 1789300000000 + i * 10, 1789300000000 + i * 10,
  json_object('role', 'user', 'time', json_object('created', 1789300000000 + i * 10),
    'tools', json('{}'), 'agent', 'build',
    'model', json_object('providerID', 'yeutech', 'modelID', 'claude-haiku-4-5-20251001'),
    'summary', json_object('diffs', json('[]')))
FROM n;
WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i + 1 FROM n WHERE i < $pair_count)
INSERT INTO message(id, session_id, time_created, time_updated, data)
SELECT printf('msg_bench%04da', i), '$session_id', 1789300000000 + i * 10 + 1, 1789300000000 + i * 10 + 1,
  json_object('parentID', printf('msg_bench%04du', i), 'role', 'assistant', 'mode', 'build', 'agent', 'build',
    'path', json_object('cwd', '$WORKSPACE', 'root', '$PROJECT_ROOT'), 'cost', 0,
    'tokens', json_object('input', 12, 'output', 8, 'reasoning', 0, 'cache', json_object('read', 0, 'write', 0)),
    'modelID', 'claude-haiku-4-5-20251001', 'providerID', 'yeutech',
    'time', json_object('created', 1789300000000 + i * 10 + 1, 'completed', 1789300000000 + i * 10 + 2))
FROM n;
WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i + 1 FROM n WHERE i < $pair_count)
INSERT INTO part(id, message_id, session_id, time_created, time_updated, data)
SELECT printf('prt_bench%04du', i), printf('msg_bench%04du', i), '$session_id',
  1789300000000 + i * 10, 1789300000000 + i * 10,
  json_object('type', 'text', 'text', printf('历史测试用户消息 %04d', i))
FROM n;
WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i + 1 FROM n WHERE i < $pair_count)
INSERT INTO part(id, message_id, session_id, time_created, time_updated, data)
SELECT printf('prt_bench%04da', i), printf('msg_bench%04da', i), '$session_id',
  1789300000000 + i * 10 + 1, 1789300000000 + i * 10 + 1,
  json_object('type', 'text', 'text', printf('历史测试助手回复 %04d', i))
FROM n;
UPDATE session SET time_updated = 1789300000000 + $message_count WHERE id = '$session_id';
SQL
  printf '%s' "$session_id"
}

median() {
  sort -n "$1" | awk '{ values[NR] = $1 } END { if (NR % 2) print values[(NR + 1) / 2]; else printf "%.6f\n", (values[NR / 2] + values[NR / 2 + 1]) / 2 }'
}

printf 'messages,cold_seconds,warm_median_seconds,restart_seconds,payload_bytes,opencode_rss_mb,bff_rss_mb,recovery_hash_match\n'
for message_count in $COUNTS; do
  if [ $((message_count % 2)) -ne 0 ]; then
    echo "Message count must be even: $message_count" >&2
    exit 1
  fi
  runtime_root="$BENCH_ROOT/$message_count"
  session_id="$(prepare_case "$message_count" "$runtime_root")"
  start_stack "$runtime_root"
  endpoint="http://127.0.0.1:$BFF_PORT/session/$session_id/message"

  cold_metrics="$(curl -fsS -H "$authorization" -o "$runtime_root/cold.json" \
    -w '%{time_total},%{size_download}' "$endpoint")"
  actual_count="$(sqlite3 "$runtime_root/xdg/data/opencode/opencode.db" \
    "SELECT count(*) FROM message WHERE session_id='$session_id';")"
  [ "$actual_count" = "$message_count" ] || { echo "Unexpected message count: $actual_count" >&2; exit 1; }

  warm_file="$runtime_root/warm.txt"
  warm_attempt=0
  while [ "$warm_attempt" -lt "$WARM_RUNS" ]; do
    curl -fsS -H "$authorization" -o /dev/null -w '%{time_total}\n' "$endpoint" >> "$warm_file"
    warm_attempt=$((warm_attempt + 1))
  done
  warm_median="$(median "$warm_file")"
  opencode_rss="$(ps -o rss= -p "$opencode_pid" | awk '{ printf "%.1f", $1 / 1024 }')"
  bff_rss="$(ps -o rss= -p "$bff_pid" | awk '{ printf "%.1f", $1 / 1024 }')"
  before_hash="$(shasum -a 256 "$runtime_root/cold.json" | awk '{ print $1 }')"
  stop_stack

  start_stack "$runtime_root"
  restart_metrics="$(curl -fsS -H "$authorization" -o "$runtime_root/restarted.json" \
    -w '%{time_total}' "$endpoint")"
  after_hash="$(shasum -a 256 "$runtime_root/restarted.json" | awk '{ print $1 }')"
  hash_match=false
  [ "$before_hash" = "$after_hash" ] && hash_match=true
  stop_stack

  cold_seconds="$(printf '%s' "$cold_metrics" | cut -d, -f1)"
  payload_bytes="$(printf '%s' "$cold_metrics" | cut -d, -f2)"
  printf '%s,%s,%s,%s,%s,%s,%s,%s\n' "$message_count" "$cold_seconds" "$warm_median" \
    "$restart_metrics" "$payload_bytes" "$opencode_rss" "$bff_rss" "$hash_match"
done
