#!/bin/sh
# Portless mesh node bootstrap — one line to join the mesh on any NAT'd box.
# No public IP, no account, no Rust toolchain (downloads a prebuilt dumbpipe binary).
#
#   curl -fsSL <url>/mesh-node.sh | sh -s -- share   <port>           # expose a local service -> prints a ticket
#   curl -fsSL <url>/mesh-node.sh | sh -s -- connect <ticket> <port>  # dial a ticket onto a local port
#   curl -fsSL <url>/mesh-node.sh | sh -s -- status                   # list local mesh links
#   curl -fsSL <url>/mesh-node.sh | sh -s -- stop <name>              # tear a link down
#
# `share` is location-transparent TCP: e.g. `share 5432` makes this box's Postgres reachable from
# any other box that runs `connect <ticket> 15432`, with NO changes to Postgres. Identity is stable
# across restarts (a per-link iroh secret is persisted), so a ticket keeps working after a reboot.
set -eu

# Pin the dumbpipe release we install (https-only, prebuilt — no cargo). Override via env if needed.
DUMBPIPE_VERSION="${DUMBPIPE_VERSION:-v0.39.0}"
PREFIX="${PORTLESS_PREFIX:-$HOME/.portless}"
BIN="$PREFIX/bin"
STATE="${PORTLESS_STATE_DIR:-$PREFIX/mesh}"
RUN="$PREFIX/run"
# Where this script was served from, so `share` can print the exact one-liner for the other box.
SELF_URL="${PORTLESS_SELF_URL:-<url>/mesh-node.sh}"

log()  { printf '\033[36m[portless]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[31m[portless] %s\033[0m\n' "$*" >&2; exit 1; }

detect_target() {
  os=$(uname -s); arch=$(uname -m)
  case "$os" in
    Linux)  os=linux ;;
    Darwin) os=darwin ;;
    *) die "unsupported OS: $os (need Linux or macOS)" ;;
  esac
  case "$arch" in
    x86_64|amd64)  arch=x86_64 ;;
    aarch64|arm64) arch=aarch64 ;;
    *) die "unsupported arch: $arch" ;;
  esac
  echo "${os}-${arch}"
}

dumbpipe_bin() { echo "$BIN/dumbpipe"; }

install_dumbpipe() {
  if [ -x "$(dumbpipe_bin)" ]; then return; fi
  mkdir -p "$BIN"
  # Reuse a system dumbpipe if the box already has one.
  if command -v dumbpipe >/dev/null 2>&1; then
    log "using system dumbpipe ($(command -v dumbpipe))"
    ln -sf "$(command -v dumbpipe)" "$(dumbpipe_bin)"
    return
  fi
  target=$(detect_target)
  url="https://github.com/n0-computer/dumbpipe/releases/download/${DUMBPIPE_VERSION}/dumbpipe-${DUMBPIPE_VERSION}-${target}.tar.gz"
  log "downloading dumbpipe ${DUMBPIPE_VERSION} (${target})…"
  tmp=$(mktemp -d)
  curl -fsSL "$url" -o "$tmp/dp.tgz" || die "download failed: $url"
  tar -xzf "$tmp/dp.tgz" -C "$tmp" || die "could not extract dumbpipe archive"
  dp=$(find "$tmp" -name dumbpipe -type f 2>/dev/null | head -1)
  [ -n "$dp" ] || die "dumbpipe binary not found in archive"
  install -m 0755 "$dp" "$(dumbpipe_bin)"
  rm -rf "$tmp"
  log "installed dumbpipe -> $(dumbpipe_bin)"
}

# Stable iroh identity per link name: 32 random bytes as hex, persisted 0600. Same name -> same NodeId.
secret_for() {
  f="$STATE/$1.key"
  if [ ! -f "$f" ]; then
    mkdir -p "$STATE"
    ( umask 077; head -c 32 /dev/urandom | od -An -v -tx1 | tr -d ' \n' > "$f" )
  fi
  cat "$f"
}

# Start a dumbpipe link in the background with a pidfile + logfile so it survives this shell and
# `status`/`stop` can manage it. ponytail: nohup+pidfile, not systemd — portable and reboot-survival
# is one `--service` step away (printed below). $2.. = dumbpipe args; IROH_SECRET passed via env.
start_link() {
  name=$1; shift
  mkdir -p "$RUN"
  pidf="$RUN/$name.pid"; logf="$RUN/$name.log"
  if [ -f "$pidf" ] && kill -0 "$(cat "$pidf")" 2>/dev/null; then
    die "a link named '$name' is already running (stop it first: $0 stop $name)"
  fi
  : > "$logf"
  # IROH_SECRET is inherited from the caller's env (share exports a stable one; connect sets none,
  # so dumbpipe mints an ephemeral dialer identity). Never pass it empty — dumbpipe rejects "".
  nohup "$(dumbpipe_bin)" "$@" >>"$logf" 2>&1 &
  echo $! > "$pidf"
  log "started '$name' (pid $(cat "$pidf"), log: $logf)"
}

# Poll until a local TCP port accepts connections (connect-tcp binds it only AFTER it reaches the
# remote, ~seconds over a relay, and prints no "listening" line). Uses `nc -z` — a clean connect
# scan that sends NO data, so it doesn't disturb the freshly-established link (an abrupt curl
# --max-time probe tore it down). Falls back to a fixed best-effort wait if nc is unavailable.
wait_port_open() {
  port=$1
  command -v nc >/dev/null 2>&1 || { sleep 4; return 0; }
  i=0
  while [ $i -lt 80 ]; do   # ~20s
    nc -z 127.0.0.1 "$port" >/dev/null 2>&1 && return 0
    sleep 0.25; i=$((i + 1))
  done
  return 1
}

# Poll the logfile for the iroh node ticket dumbpipe prints on listen-tcp.
wait_for_ticket() {
  logf="$RUN/$1.log"
  i=0
  while [ $i -lt 100 ]; do
    t=$(grep -oE 'endpoint[a-z2-7]{40,}' "$logf" 2>/dev/null | head -1 || true)
    [ -n "$t" ] && { echo "$t"; return 0; }
    sleep 0.2; i=$((i + 1))
  done
  return 1
}

cmd_share() {
  port=${1:-}; name=${2:-"share-$port"}
  [ -n "$port" ] || die "usage: $0 share <port> [name]"
  install_dumbpipe
  IROH_SECRET=$(secret_for "$name")
  export IROH_SECRET
  start_link "$name" listen-tcp --host "127.0.0.1:$port"
  ticket=$(wait_for_ticket "$name") || { tail -5 "$RUN/$name.log" >&2; die "timed out waiting for the mesh ticket"; }
  printf '\n\033[32m✅ sharing 127.0.0.1:%s on the mesh (link: %s)\033[0m\n' "$port" "$name" >&2
  printf '   On the OTHER box, run:\n\n' >&2
  printf '     curl -fsSL %s | sh -s -- connect %s <local-port>\n\n' "$SELF_URL" "$ticket" >&2
  echo "$ticket"   # ticket on stdout, so it's pipeable/captureable
}

cmd_connect() {
  ticket=${1:-}; port=${2:-}; name=${3:-"connect-$port"}
  [ -n "$ticket" ] && [ -n "$port" ] || die "usage: $0 connect <ticket> <local-port> [name]"
  install_dumbpipe
  start_link "$name" connect-tcp --addr "127.0.0.1:$port" "$ticket"
  sleep 1
  pidf="$RUN/$name.pid"
  kill -0 "$(cat "$pidf")" 2>/dev/null || { tail -5 "$RUN/$name.log" >&2; die "link exited immediately (bad ticket?)"; }
  log "dialing remote…"
  if wait_port_open "$port"; then
    printf '\n\033[32m✅ connected — remote service is now at 127.0.0.1:%s (link: %s)\033[0m\n' "$port" "$name" >&2
  elif kill -0 "$(cat "$pidf")" 2>/dev/null; then
    printf '\n\033[32m✅ link up\033[0m — 127.0.0.1:%s will accept within a few seconds (check: %s status)\n' "$port" "$0" >&2
  else
    tail -5 "$RUN/$name.log" >&2; die "link died while connecting"
  fi
}

cmd_status() {
  [ -d "$RUN" ] || { log "no mesh links"; return 0; }
  found=0
  for pidf in "$RUN"/*.pid; do
    [ -e "$pidf" ] || continue
    name=$(basename "$pidf" .pid); pid=$(cat "$pidf")
    if kill -0 "$pid" 2>/dev/null; then printf '  %-20s pid %-7s up\n' "$name" "$pid"; found=1
    else printf '  %-20s (dead)\n' "$name"; fi
  done
  [ "$found" = 1 ] || log "no live mesh links"
}

cmd_stop() {
  name=${1:-}; [ -n "$name" ] || die "usage: $0 stop <name>"
  pidf="$RUN/$name.pid"
  [ -f "$pidf" ] || die "no such link: $name"
  kill "$(cat "$pidf")" 2>/dev/null || true
  rm -f "$pidf"
  log "stopped '$name'"
}

main() {
  cmd=${1:-help}; [ $# -gt 0 ] && shift || true
  case "$cmd" in
    install) install_dumbpipe; log "ready: $(dumbpipe_bin)" ;;
    share)   cmd_share "$@" ;;
    connect) cmd_connect "$@" ;;
    status)  cmd_status ;;
    stop)    cmd_stop "$@" ;;
    *) cat >&2 <<EOF
portless mesh node — link NAT'd boxes over iroh, no public IP, no account.

  share <port> [name]            expose a local service, print a ticket
  connect <ticket> <port> [name] dial a ticket onto a local port (transparent TCP)
  status                         list local mesh links
  stop <name>                    tear a link down
  install                        just install dumbpipe
EOF
       exit 1 ;;
  esac
}

main "$@"
