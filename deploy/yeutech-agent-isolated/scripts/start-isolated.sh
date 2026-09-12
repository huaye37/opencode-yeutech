#!/bin/sh
set -eu

PROJECT_ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
RUNTIME_ROOT="${YEUTECH_AGENT_RUNTIME_ROOT:-$PROJECT_ROOT/.runtime}"
BRIDGE_PORT="${YEUTECH_AGENT_BRIDGE_PORT:-18132}"
OPENCODE_PORT="${YEUTECH_OPENCODE_PORT:-18130}"
BFF_PORT="${YEUTECH_AGENT_BFF_PORT:-18131}"
BRIDGE_URL="http://127.0.0.1:$BRIDGE_PORT"
OPENCODE_URL="http://127.0.0.1:$OPENCODE_PORT"
BFF_URL="http://127.0.0.1:$BFF_PORT"

mkdir -p "$RUNTIME_ROOT" "$RUNTIME_ROOT/config" "$RUNTIME_ROOT/logs" "$RUNTIME_ROOT/pids" \
  "$RUNTIME_ROOT/secrets" "$RUNTIME_ROOT/workspaces/sample" "$RUNTIME_ROOT/xdg/config" \
  "$RUNTIME_ROOT/xdg/data" "$RUNTIME_ROOT/xdg/cache" "$RUNTIME_ROOT/xdg/state"
chmod 700 "$RUNTIME_ROOT" "$RUNTIME_ROOT/config" "$RUNTIME_ROOT/secrets" "$RUNTIME_ROOT/xdg" \
  "$RUNTIME_ROOT/xdg/config" "$RUNTIME_ROOT/xdg/data" "$RUNTIME_ROOT/xdg/cache" "$RUNTIME_ROOT/xdg/state"
chmod 555 "$RUNTIME_ROOT/workspaces/sample"

for port in "$BRIDGE_PORT" "$OPENCODE_PORT" "$BFF_PORT"; do
  if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "Port $port is already occupied; refusing to alter any running service." >&2
    exit 1
  fi
done

token_file="$RUNTIME_ROOT/secrets/bridge.token"
password_file="$RUNTIME_ROOT/secrets/opencode.password"
portal_token_file="$RUNTIME_ROOT/secrets/portal.token"
[ -f "$token_file" ] || { umask 077; openssl rand -hex 32 > "$token_file"; }
[ -f "$password_file" ] || { umask 077; openssl rand -hex 32 > "$password_file"; }
[ -f "$portal_token_file" ] || { umask 077; openssl rand -hex 32 > "$portal_token_file"; }
export YEUTECH_AGENT_BRIDGE_TOKEN="$(tr -d '\r\n' < "$token_file")"
export YEUTECH_AGENT_BFF_TOKEN="$(tr -d '\r\n' < "$portal_token_file")"
export OPENCODE_SERVER_PASSWORD="$(tr -d '\r\n' < "$password_file")"
export OPENCODE_SERVER_USERNAME="yeutech-agent"
export YEUTECH_AGENT_BRIDGE_PORT="$BRIDGE_PORT"
export YEUTECH_AGENT_BRIDGE_URL="$BRIDGE_URL"
export YEUTECH_AGENT_BFF_PORT="$BFF_PORT"
export YEUTECH_OPENCODE_URL="$OPENCODE_URL"
export YEUTECH_AGENT_WORKSPACE="$RUNTIME_ROOT/workspaces/sample"
export OPENCODE_CONFIG_OUTPUT="$RUNTIME_ROOT/config/opencode.json"
export OPENCODE_CONFIG="$OPENCODE_CONFIG_OUTPUT"
export OPENCODE_CONFIG_DIR="$RUNTIME_ROOT/config"
export XDG_CONFIG_HOME="$RUNTIME_ROOT/xdg/config"
export XDG_DATA_HOME="$RUNTIME_ROOT/xdg/data"
export XDG_CACHE_HOME="$RUNTIME_ROOT/xdg/cache"
export XDG_STATE_HOME="$RUNTIME_ROOT/xdg/state"

OPENCODE_BIN="${OPENCODE_BIN:-$RUNTIME_ROOT/opencode/current}"
[ -x "$OPENCODE_BIN" ] || { echo "OpenCode is not installed at $OPENCODE_BIN" >&2; exit 1; }

nohup node "$PROJECT_ROOT/src/nas-gateway-bridge.mjs" > "$RUNTIME_ROOT/logs/bridge.log" 2>&1 &
bridge_pid=$!
echo "$bridge_pid" > "$RUNTIME_ROOT/pids/bridge.pid"
opencode_pid=""
bff_pid=""
cleanup() {
  for process_id in "$bff_pid" "$opencode_pid" "$bridge_pid"; do
    [ -n "$process_id" ] && kill "$process_id" >/dev/null 2>&1 || true
  done
}
trap cleanup EXIT INT TERM

ready=0
attempt=0
while [ "$attempt" -lt 20 ]; do
  if curl -fsS -H "Authorization: Bearer $YEUTECH_AGENT_BRIDGE_TOKEN" "$BRIDGE_URL/health" >/dev/null 2>&1; then ready=1; break; fi
  attempt=$((attempt + 1))
  sleep 0.25
done
[ "$ready" = 1 ] || { echo "Bridge did not become ready." >&2; exit 1; }

node "$PROJECT_ROOT/src/generate-opencode-config.mjs"

cd "$RUNTIME_ROOT/workspaces/sample"
nohup "$OPENCODE_BIN" serve --hostname 127.0.0.1 --port "$OPENCODE_PORT" > "$RUNTIME_ROOT/logs/opencode.log" 2>&1 &
opencode_pid=$!
echo "$opencode_pid" > "$RUNTIME_ROOT/pids/opencode.pid"

ready=0
attempt=0
while [ "$attempt" -lt 40 ]; do
  if curl -fsS -u "$OPENCODE_SERVER_USERNAME:$OPENCODE_SERVER_PASSWORD" "$OPENCODE_URL/global/health" >/dev/null 2>&1; then ready=1; break; fi
  attempt=$((attempt + 1))
  sleep 0.25
done
[ "$ready" = 1 ] || { echo "OpenCode did not become ready." >&2; exit 1; }

nohup node "$PROJECT_ROOT/src/agent-bff.mjs" > "$RUNTIME_ROOT/logs/bff.log" 2>&1 &
bff_pid=$!
echo "$bff_pid" > "$RUNTIME_ROOT/pids/bff.pid"

ready=0
attempt=0
while [ "$attempt" -lt 20 ]; do
  if curl -fsS -H "Authorization: Bearer $YEUTECH_AGENT_BFF_TOKEN" "$BFF_URL/health" >/dev/null 2>&1; then ready=1; break; fi
  attempt=$((attempt + 1))
  sleep 0.25
done
[ "$ready" = 1 ] || { echo "Agent BFF did not become ready." >&2; exit 1; }
trap - EXIT INT TERM

echo "Isolated bridge started on 127.0.0.1:$BRIDGE_PORT (PID $bridge_pid)."
echo "Isolated OpenCode started on 127.0.0.1:$OPENCODE_PORT (PID $opencode_pid)."
echo "Isolated Agent BFF started on 127.0.0.1:$BFF_PORT (PID $bff_pid)."
echo "Runtime: $RUNTIME_ROOT"
