#!/bin/sh
set -eu

PROJECT_ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
RUNTIME_ROOT="${YEUTECH_AGENT_RUNTIME_ROOT:-$PROJECT_ROOT/.runtime}"

for name in opencode bridge; do
  pid_file="$RUNTIME_ROOT/pids/$name.pid"
  [ -f "$pid_file" ] || continue
  pid="$(cat "$pid_file")"
  case "$pid" in (*[!0-9]*|'') echo "Ignoring invalid PID file: $pid_file" >&2; continue;; esac
  if kill -0 "$pid" >/dev/null 2>&1; then
    kill "$pid"
    echo "Stopped isolated $name process $pid."
  fi
  rm -f "$pid_file"
done
