#!/bin/sh
# Portless image store — a self-hosted OCI registry (zot, single binary, NO Docker needed to run).
# This is the "place to store images": build boxes push here, deploy boxes pull. Storage is local
# disk by default, or YOUR S3 (set the PORTLESS_REGISTRY_S3_* env). Not Docker Hub, not third-party.
#
#   curl -fsSL <hub>/registry.sh | sh -s -- up [port]   # install zot + run it (default 127.0.0.1:5000)
#   ... | sh -s -- status | down
#
# It binds 127.0.0.1 by default so it has no public exposure — put it on the mesh with:
#   curl -fsSL <hub>/mesh-node.sh | sh -s -- share <port>     # → a ticket; deploy boxes connect it
# Or expose it on a VPS interface with PORTLESS_REGISTRY_BIND=0.0.0.0 (then add TLS yourself).
#
# S3 backing store (when you wire S3): set PORTLESS_REGISTRY_S3_BUCKET (+ _REGION, optional
# _ENDPOINT/_PREFIX) and AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY in the env before `up`.
set -eu

ZOT_VERSION="${ZOT_VERSION:-v2.1.18}"
PREFIX="${PORTLESS_PREFIX:-$HOME/.portless}"
BIN="$PREFIX/bin"
DATA="${PORTLESS_REGISTRY_DATA:-$PREFIX/registry/data}"
RUN="$PREFIX/run"
CONF="$PREFIX/registry/config.json"
BIND="${PORTLESS_REGISTRY_BIND:-127.0.0.1}"

log() { printf '\033[36m[portless]\033[0m %s\n' "$*" >&2; }
die() { printf '\033[31m[portless] %s\033[0m\n' "$*" >&2; exit 1; }

detect_target() {
  os=$(uname -s); arch=$(uname -m)
  case "$os" in Linux) os=linux ;; Darwin) os=darwin ;; *) die "unsupported OS: $os" ;; esac
  case "$arch" in x86_64|amd64) arch=amd64 ;; aarch64|arm64) arch=arm64 ;; *) die "unsupported arch: $arch" ;; esac
  echo "${os}-${arch}"
}

install_zot() {
  [ -x "$BIN/zot" ] && return
  mkdir -p "$BIN"
  target=$(detect_target)
  # Full build (the -minimal variant drops the S3 storage driver we may need). Override with ZOT_ASSET.
  asset="${ZOT_ASSET:-zot-${target}}"
  url="https://github.com/project-zot/zot/releases/download/${ZOT_VERSION}/${asset}"
  log "downloading zot ${ZOT_VERSION} (${asset})…"
  curl -fsSL "$url" -o "$BIN/zot" || die "download failed: $url"
  chmod +x "$BIN/zot"
  log "installed zot -> $BIN/zot"
}

write_config() {
  port=$1
  mkdir -p "$(dirname "$CONF")" "$DATA"
  if [ -n "${PORTLESS_REGISTRY_S3_BUCKET:-}" ]; then
    log "storage backend: S3 bucket '$PORTLESS_REGISTRY_S3_BUCKET' (creds from AWS_* env)"
    # zot uses the Distribution s3 driver; the local rootDirectory is just a small cache.
    cat > "$CONF" <<EOF
{
  "storage": {
    "rootDirectory": "$DATA",
    "dedupe": false,
    "storageDriver": {
      "name": "s3",
      "region": "${PORTLESS_REGISTRY_S3_REGION:-us-east-1}",
      "bucket": "$PORTLESS_REGISTRY_S3_BUCKET",
      "rootdirectory": "${PORTLESS_REGISTRY_S3_PREFIX:-portless-images}",
      "regionendpoint": "${PORTLESS_REGISTRY_S3_ENDPOINT:-}",
      "secure": true
    }
  },
  "http": { "address": "$BIND", "port": "$port" },
  "log": { "level": "warn" }
}
EOF
  else
    log "storage backend: local disk ($DATA)"
    cat > "$CONF" <<EOF
{
  "storage": { "rootDirectory": "$DATA", "dedupe": true },
  "http": { "address": "$BIND", "port": "$port" },
  "log": { "level": "warn" }
}
EOF
  fi
}

cmd_up() {
  port=${1:-5000}
  install_zot
  write_config "$port"
  mkdir -p "$RUN"
  pidf="$RUN/registry.pid"; logf="$RUN/registry.log"
  if [ -f "$pidf" ] && kill -0 "$(cat "$pidf")" 2>/dev/null; then die "registry already running (pid $(cat "$pidf"))"; fi
  : > "$logf"
  nohup "$BIN/zot" serve "$CONF" >>"$logf" 2>&1 &
  echo $! > "$pidf"
  # wait for the v2 API
  i=0; while [ $i -lt 60 ]; do
    curl -fsS "http://127.0.0.1:$port/v2/" >/dev/null 2>&1 && break
    kill -0 "$(cat "$pidf")" 2>/dev/null || { tail -5 "$logf" >&2; die "zot exited on startup"; }
    sleep 0.25; i=$((i + 1))
  done
  printf '\n\033[32m✅ image store up at %s:%s\033[0m (pid %s)\n' "$BIND" "$port" "$(cat "$pidf")" >&2
  printf '   Put it on the mesh so deploy boxes can reach it with no public IP:\n' >&2
  printf '     portless link <registry-node>:%s <this-node>   # nodes enrolled via agent.sh\n' "$port" >&2
}

cmd_status() {
  pidf="$RUN/registry.pid"
  [ -f "$pidf" ] && kill -0 "$(cat "$pidf")" 2>/dev/null && log "registry up (pid $(cat "$pidf"))" || log "registry not running"
}

cmd_down() {
  pidf="$RUN/registry.pid"
  [ -f "$pidf" ] || die "registry not running"
  kill "$(cat "$pidf")" 2>/dev/null || true; rm -f "$pidf"; log "registry stopped"
}

cmd=${1:-help}; [ $# -gt 0 ] && shift || true
case "$cmd" in
  up) cmd_up "$@" ;;
  status) cmd_status ;;
  down) cmd_down ;;
  *) cat >&2 <<EOF
portless image store (self-hosted OCI registry, no Docker to run it)

  up [port]   install + run zot (default port 5000, binds $BIND)
  status      is it running?
  down        stop it

storage: local disk by default; set PORTLESS_REGISTRY_S3_BUCKET (+ AWS_* creds) for S3.
EOF
     exit 1 ;;
esac
