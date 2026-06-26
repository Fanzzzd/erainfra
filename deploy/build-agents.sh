#!/bin/sh
# Cross-compile the portless agent for every platform the installers serve, into deploy/bin/.
# Run this once on the hub (or in CI) so `curl <hub>/agent.sh | sh` has a binary to download.
# Self-hosted: the hub serves these — no Docker Hub, no third-party release host.
set -eu
HERE=$(CDPATH= cd "$(dirname "$0")" && pwd)
SRC="$HERE/../agents/node-agent"
OUT="$HERE/bin"
mkdir -p "$OUT"
log() { printf '\033[36m[portless]\033[0m %s\n' "$*" >&2; }

# CGO off → static binaries that run anywhere (alpine included). Names match agent.sh / agent.ps1.
for t in linux/amd64 linux/arm64 darwin/amd64 darwin/arm64 windows/amd64; do
  os=${t%/*}; arch=${t#*/}
  ext=""; [ "$os" = windows ] && ext=".exe"
  log "building portless-agent-${os}-${arch}${ext}"
  (cd "$SRC" && CGO_ENABLED=0 GOOS="$os" GOARCH="$arch" go build -trimpath -ldflags='-s -w' -o "$OUT/portless-agent-${os}-${arch}${ext}" .)
done
log "done → $OUT"
ls -la "$OUT" >&2
