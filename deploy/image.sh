#!/bin/sh
# Portless image build/deploy — split the build box from the deploy box.
#
#   On the BUILD box (capable):
#     curl -fsSL <hub>/image.sh | sh -s -- ship <context-dir> <name:tag>   # docker build + push
#
#   On the DEPLOY box (weak, can't build):
#     curl -fsSL <hub>/image.sh | sh -s -- run <name:tag> [docker run args…] # docker pull + run
#
# The store is reached at $PORTLESS_REGISTRY (default 127.0.0.1:5000). Connect the mesh first so the
# store appears locally with no public IP:
#   curl -fsSL <hub>/mesh-node.sh | sh -s -- connect <registry-ticket> 5000
# Docker treats 127.0.0.1:* as an insecure registry automatically, so the mesh path needs NO daemon
# config. (On a public VPS registry, give it TLS or add it to the daemon's insecure-registries.)
set -eu

REGISTRY="${PORTLESS_REGISTRY:-127.0.0.1:5000}"
DOCKER="${DOCKER:-docker}"

log() { printf '\033[36m[portless]\033[0m %s\n' "$*" >&2; }
die() { printf '\033[31m[portless] %s\033[0m\n' "$*" >&2; exit 1; }
ref() { echo "$REGISTRY/$1"; }

need_docker() {
  command -v "$DOCKER" >/dev/null 2>&1 || die "no container CLI '$DOCKER' — install docker/podman or set DOCKER=podman"
  "$DOCKER" info >/dev/null 2>&1 || die "'$DOCKER' is installed but its daemon isn't responding"
}

# Confirm the store is reachable before doing docker work, with an actionable message.
check_registry() {
  curl -fsS "http://$REGISTRY/v2/" >/dev/null 2>&1 && { log "store reachable at $REGISTRY"; return 0; }
  die "store $REGISTRY not reachable — connect the mesh first:
     curl -fsSL <hub>/mesh-node.sh | sh -s -- connect <registry-ticket> ${REGISTRY##*:}"
}

cmd_ship() {
  dir=${1:-}; tag=${2:-}
  [ -n "$dir" ] && [ -n "$tag" ] || die "usage: image.sh ship <context-dir> <name:tag>"
  [ -d "$dir" ] || die "no such directory: $dir"
  need_docker; check_registry
  log "building $(ref "$tag") from $dir …"
  "$DOCKER" build -t "$(ref "$tag")" "$dir"
  log "pushing $(ref "$tag") to the store …"
  "$DOCKER" push "$(ref "$tag")"
  printf '\n\033[32m✅ shipped %s\033[0m — on a deploy box: image.sh run %s\n' "$(ref "$tag")" "$tag" >&2
}

cmd_run() {
  tag=${1:-}; [ -n "$tag" ] || die "usage: image.sh run <name:tag> [docker run args…]"
  shift
  need_docker; check_registry
  log "pulling $(ref "$tag") …"
  "$DOCKER" pull "$(ref "$tag")"
  log "running …"
  exec "$DOCKER" run "$@" "$(ref "$tag")"
}

cmd=${1:-help}; [ $# -gt 0 ] && shift || true
case "$cmd" in
  ship)  cmd_ship "$@" ;;
  build) [ $# -ge 2 ] || die "usage: image.sh build <dir> <name:tag>"; need_docker; "$DOCKER" build -t "$(ref "$2")" "$1" ;;
  push)  [ $# -ge 1 ] || die "usage: image.sh push <name:tag>"; need_docker; check_registry; "$DOCKER" push "$(ref "$1")" ;;
  pull)  [ $# -ge 1 ] || die "usage: image.sh pull <name:tag>"; need_docker; check_registry; "$DOCKER" pull "$(ref "$1")" ;;
  run)   cmd_run "$@" ;;
  check) check_registry ;;
  *) cat >&2 <<EOF
portless image build/deploy (store at \$PORTLESS_REGISTRY = $REGISTRY)

  ship <dir> <name:tag>        BUILD box: docker build + push to the store
  run  <name:tag> [run args…]  DEPLOY box: docker pull + docker run
  build|push|pull <…>          individual steps
  check                        is the store reachable?
EOF
     exit 1 ;;
esac
