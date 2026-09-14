#!/bin/sh
set -eu

project_root="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
project_space_parent="${YEUTECH_PROJECT_SPACE_PARENT:?YEUTECH_PROJECT_SPACE_PARENT is required}"
project_space_id="${YEUTECH_PROJECT_SPACE_ID:?YEUTECH_PROJECT_SPACE_ID is required}"
docker_bin="${YEUTECH_DOCKER_BIN:-/usr/local/bin/docker}"

case "$project_space_id" in *[!A-Za-z0-9._:-]*|'') echo "Project spaceId is invalid." >&2; exit 1;; esac
[ -d "$project_space_parent" ] && [ ! -L "$project_space_parent" ] || { echo "Project space parent is unavailable." >&2; exit 1; }
YEUTECH_PROJECTS_BIND_SOURCE=""
for candidate in "$project_space_parent"/*; do
  [ -d "$candidate" ] && [ ! -L "$candidate" ] || continue
  marker="$candidate/.yeutech-space-id"
  [ -f "$marker" ] && [ ! -L "$marker" ] || continue
  [ "$(cat "$marker")" = "$project_space_id" ] || continue
  [ -z "$YEUTECH_PROJECTS_BIND_SOURCE" ] || { echo "Multiple project spaces use the requested spaceId." >&2; exit 1; }
  YEUTECH_PROJECTS_BIND_SOURCE="$(CDPATH= cd -- "$candidate" && pwd -P)"
done
[ -n "$YEUTECH_PROJECTS_BIND_SOURCE" ] || { echo "No project space uses the requested spaceId." >&2; exit 1; }
export YEUTECH_PROJECTS_BIND_SOURCE

test -d "$YEUTECH_PROJECTS_BIND_SOURCE" || { echo "Resolved project space disappeared before Compose started." >&2; exit 1; }
exec "$docker_bin" compose -f "$project_root/compose.nas.yml" "$@"
