#!/bin/sh
set -eu

VERSION="${OPENCODE_VERSION:-1.18.30}"
INSTALL_ROOT="${OPENCODE_INSTALL_ROOT:-$PWD/.runtime/opencode}"
ASSET="opencode-darwin-arm64.zip"
RELEASE_API="https://api.github.com/repos/anomalyco/opencode/releases/tags/v${VERSION}"

if [ "$(uname -s)" != "Darwin" ] || [ "$(uname -m)" != "arm64" ]; then
  echo "This isolated installer requires macOS arm64." >&2
  exit 1
fi

tmp_dir="$(mktemp -d /tmp/yeutech-opencode-install.XXXXXX)"
trap 'rm -rf "$tmp_dir"' EXIT INT TERM

curl -fsSL "$RELEASE_API" -o "$tmp_dir/release.json"
metadata="$(node -e '
  const fs = require("fs");
  const release = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  const asset = release.assets.find((item) => item.name === process.argv[2]);
  if (!asset || !asset.digest?.startsWith("sha256:")) process.exit(2);
  process.stdout.write([asset.browser_download_url, asset.digest.slice(7), asset.size].join("\n"));
' "$tmp_dir/release.json" "$ASSET")"
download_url="$(printf '%s\n' "$metadata" | sed -n '1p')"
expected_sha="$(printf '%s\n' "$metadata" | sed -n '2p')"
expected_size="$(printf '%s\n' "$metadata" | sed -n '3p')"

curl -fL --retry 3 "$download_url" -o "$tmp_dir/$ASSET"
actual_size="$(stat -f '%z' "$tmp_dir/$ASSET")"
actual_sha="$(shasum -a 256 "$tmp_dir/$ASSET" | awk '{print $1}')"
[ "$actual_size" = "$expected_size" ] || { echo "OpenCode asset size mismatch." >&2; exit 1; }
[ "$actual_sha" = "$expected_sha" ] || { echo "OpenCode SHA-256 mismatch." >&2; exit 1; }

mkdir -p "$INSTALL_ROOT/$VERSION"
ditto -x -k "$tmp_dir/$ASSET" "$INSTALL_ROOT/$VERSION"
binary="$(find "$INSTALL_ROOT/$VERSION" -type f -name opencode -perm +111 | head -1)"
[ -n "$binary" ] || { echo "OpenCode executable was not found in the verified archive." >&2; exit 1; }
ln -sfn "$binary" "$INSTALL_ROOT/current"
"$INSTALL_ROOT/current" --version
echo "Installed verified OpenCode v$VERSION at $INSTALL_ROOT/current"
