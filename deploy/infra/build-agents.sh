#!/bin/sh
# Cross-compile the portless agent for every platform the installers serve, into deploy/infra/bin/.
# Run this once on the hub (or in CI) so `curl <hub>/agent.sh | sh` has a binary to download.
# Self-hosted: the hub serves these — no Docker Hub, no third-party release host.
set -eu
HERE=$(CDPATH= cd "$(dirname "$0")" && pwd)
SRC="$HERE/../../apps/infra-agent"
OUT="$HERE/bin"
mkdir -p "$OUT"
log() { printf '\033[36m[portless]\033[0m %s\n' "$*" >&2; }

# Stamp the product version onto the binary so `portless-agent version` reports what shipped. This
# needs node only to read one field; a box without it still builds, and the binary says "dev".
VERSION="${ERAINFRA_AGENT_VERSION:-${PORTLESS_AGENT_VERSION:-}}"
if [ -n "${PORTLESS_AGENT_VERSION:-}" ] && [ -z "${ERAINFRA_AGENT_VERSION:-}" ]; then
  # Stage 1 of retiring the name (ADR 0004): both are read, the new one wins, neither is deleted.
  printf '\033[33m[erainfra] PORTLESS_AGENT_VERSION is a retired name — use ERAINFRA_AGENT_VERSION.\033[0m\n' >&2
fi
[ -n "$VERSION" ] || VERSION=$(node -p "require('$HERE/../../package.json').version" 2>/dev/null || echo dev)
log "stamping version $VERSION"

# CGO off → static binaries that run anywhere (alpine included). Names match agent.sh / agent.ps1.
for t in linux/amd64 linux/arm64 darwin/amd64 darwin/arm64 windows/amd64; do
  os=${t%/*}; arch=${t#*/}
  ext=""; [ "$os" = windows ] && ext=".exe"
  log "building portless-agent-${os}-${arch}${ext}"
  (cd "$SRC" && CGO_ENABLED=0 GOOS="$os" GOARCH="$arch" go build -trimpath -ldflags="-s -w -X main.version=$VERSION" -o "$OUT/portless-agent-${os}-${arch}${ext}" .)
done
log "done → $OUT"
ls -la "$OUT" >&2
