FROM node:24-bookworm-slim AS web-builder
WORKDIR /build/web
COPY web/package.json web/package-lock.json ./
RUN npm ci --registry=https://registry.npmjs.org
COPY web/ ./
RUN npm run build

FROM node:24-bookworm-slim AS opencode-downloader
ARG OPENCODE_VERSION=1.18.30
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /download
RUN set -eu; \
  asset="opencode-linux-x64-baseline.tar.gz"; \
  curl -fsSL "https://api.github.com/repos/anomalyco/opencode/releases/tags/v${OPENCODE_VERSION}" -o release.json; \
  metadata="$(node -e 'const fs=require("fs");const release=JSON.parse(fs.readFileSync("release.json","utf8"));const asset=release.assets.find((item)=>item.name===process.argv[1]);if(!asset||!asset.digest?.startsWith("sha256:"))process.exit(2);process.stdout.write([asset.browser_download_url,asset.digest.slice(7),asset.size].join("\n"));' "$asset")"; \
  url="$(printf '%s\n' "$metadata" | sed -n '1p')"; \
  digest="$(printf '%s\n' "$metadata" | sed -n '2p')"; \
  size="$(printf '%s\n' "$metadata" | sed -n '3p')"; \
  curl -fL --retry 3 "$url" -o "$asset"; \
  test "$(stat -c '%s' "$asset")" = "$size"; \
  echo "$digest  $asset" | sha256sum -c -; \
  tar -xzf "$asset"; \
  test -x opencode; \
  ./opencode --version

FROM node:24-bookworm-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl openssl \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json ./
COPY src/ ./src/
COPY scripts/container-entrypoint.sh ./scripts/container-entrypoint.sh
COPY --from=web-builder /build/web/dist ./web/dist
COPY --from=opencode-downloader /download/opencode /usr/local/bin/opencode
RUN chmod 755 /app/scripts/container-entrypoint.sh /usr/local/bin/opencode
EXPOSE 18140
ENTRYPOINT ["/app/scripts/container-entrypoint.sh"]
