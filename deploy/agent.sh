#!/bin/sh
# Portless agent — ONE command turns a fresh Linux box into a ready deploy node.
# It dials OUT to the hub over WSS (no inbound port, works behind NAT), installs the container
# runtime if it's missing, and (when run as root) registers a systemd service so the node survives
# reboots. Everything self-hosted: the agent binary comes from the hub, Docker from the distro repos.
#
#   curl -fsSL <hub>/agent.sh | sudo sh -s -- --token <token> [--name <name>]   # full setup
#   curl -fsSL <hub>/agent.sh | sh -s -- --token <token>                        # no-root: agent only
#
# The hub URL defaults to wherever this script was served from, so usually just --token is needed.
# Flags: --hub <url>  --token <tok>  --name <id>  --no-docker (skip runtime install)  --foreground
set -eu

# <hub> is templated by the server to the base URL this script was served from.
SERVED_FROM="<hub>"
HUB=""; TOKEN="${PORTLESS_TOKEN:-}"; NAME=""; FOREGROUND=""; WANT_DOCKER=1
while [ $# -gt 0 ]; do
  case "$1" in
    --hub)   HUB=$2; shift 2 ;;
    --token) TOKEN=$2; shift 2 ;;
    --name)  NAME=$2; shift 2 ;;
    --no-docker) WANT_DOCKER=0; shift ;;
    --foreground) FOREGROUND=1; shift ;;
    *) shift ;;
  esac
done

PREFIX="${PORTLESS_PREFIX:-$HOME/.portless}"
BIN="$PREFIX/bin"; RUN="$PREFIX/run"
log()  { printf '\033[36m[portless]\033[0m %s\n' "$*" >&2; }
warn() { printf '\033[33m[portless] %s\033[0m\n' "$*" >&2; }
die()  { printf '\033[31m[portless] %s\033[0m\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

[ -n "$TOKEN" ] || die "need --token <token> (or PORTLESS_TOKEN)"

# Resolve the hub: --hub wins; else derive from where this script was served. Accept http(s) or ws(s)
# and normalize to an http base (for the binary download) + a wss .../agent url (for the agent).
RAW=${HUB:-$SERVED_FROM}
case "$RAW" in
  wss://*) HTTP_BASE="https://${RAW#wss://}"; WSS="$RAW" ;;
  ws://*)  HTTP_BASE="http://${RAW#ws://}";   WSS="$RAW" ;;
  https://*) HTTP_BASE="$RAW" ;;
  http://*)  HTTP_BASE="$RAW" ;;
  *) die "bad hub url: $RAW" ;;
esac
# strip any trailing path (e.g. /agent.sh, /agent) to get the bare base, then build the canonical urls
HOSTBASE=$(printf '%s' "$HTTP_BASE" | sed -E 's#^([a-z]+://[^/]+).*#\1#')
[ -n "${WSS:-}" ] || WSS=$(printf '%s/agent' "$HOSTBASE" | sed -E 's#^http#ws#')

# root? pick a sudo prefix for the privileged steps (runtime install + systemd service).
if [ "$(id -u)" = 0 ]; then SUDO=""; else SUDO="sudo"; fi
priv() { if [ -z "$SUDO" ]; then "$@"; elif have sudo; then sudo "$@"; else return 1; fi; }

detect_target() {
  os=$(uname -s); arch=$(uname -m)
  case "$os" in Linux) os=linux ;; Darwin) os=darwin ;; *) die "unsupported OS: $os" ;; esac
  case "$arch" in x86_64|amd64) arch=amd64 ;; aarch64|arm64) arch=arm64 ;; *) die "unsupported arch: $arch" ;; esac
  echo "${os}-${arch}"
}

# Bring up a container runtime if there isn't one. Best-effort: a failure here warns (so the box still
# enrolls) rather than aborts — deploys just won't work until docker is on PATH. Self-hosted: distro
# packages only (docker.io / docker), never get.docker.com or a Docker Hub convenience script.
ensure_docker() {
  [ "$WANT_DOCKER" = 1 ] || { log "skipping runtime install (--no-docker)"; return 0; }
  if have docker; then log "container runtime present: $(docker --version 2>/dev/null)"; return 0; fi
  if [ "$(uname -s)" = Darwin ]; then warn "no docker — on macOS install Docker Desktop manually; agent will still enroll"; return 0; fi
  log "container runtime not found — installing from distro repos…"
  if   have apt-get; then priv sh -c 'apt-get update -y && DEBIAN_FRONTEND=noninteractive apt-get install -y docker.io' || { warn "runtime install failed (apt)"; return 0; }
  elif have dnf;     then priv dnf install -y docker || { warn "runtime install failed (dnf)"; return 0; }
  elif have yum;     then priv yum install -y docker || { warn "runtime install failed (yum)"; return 0; }
  elif have apk;     then priv apk add --no-cache docker || { warn "runtime install failed (apk)"; return 0; }
  elif have zypper;  then priv zypper -n install docker || { warn "runtime install failed (zypper)"; return 0; }
  else warn "no supported package manager (apt/dnf/yum/apk/zypper) — install docker manually"; return 0; fi
  # start + enable across init systems (systemd / openrc / sysv). ponytail: best-effort, any one wins.
  if   have systemctl; then priv systemctl enable --now docker 2>/dev/null || priv service docker start 2>/dev/null || true
  elif have rc-update; then priv rc-update add docker default 2>/dev/null || true; priv service docker start 2>/dev/null || true
  else priv service docker start 2>/dev/null || true; fi
  # last resort (e.g. a container with no init): start dockerd ourselves and give it a moment.
  if ! priv docker info >/dev/null 2>&1 && have dockerd; then priv sh -c 'dockerd >/tmp/dockerd.log 2>&1 &'; sleep 3; fi
  # let the invoking non-root user drive docker without sudo (effective next login).
  [ -z "$SUDO" ] || priv usermod -aG docker "$(id -un)" 2>/dev/null || true
  if have docker; then log "container runtime installed: $(docker --version 2>/dev/null || echo ok)"; else warn "docker still not on PATH — deploys will fail until it is"; fi
}

install_agent() {
  mkdir -p "$BIN"
  target=$(detect_target)
  url="$HOSTBASE/agent-bin/portless-agent-${target}"
  log "downloading agent ($target) from $url …"
  curl -fsSL "$url" -o "$BIN/portless-agent" || die "download failed: $url (did you run build-agents.sh on the hub?)"
  chmod +x "$BIN/portless-agent"
}

# systemd service (root only) → reconnects forever and survives reboot. Token lives in a 0600 env
# file, never in a world-readable unit or argv.
install_service() {
  have systemctl || return 1
  priv test -d /run/systemd/system || return 1   # systemd actually running (not just installed)
  priv mkdir -p /etc/portless || return 1
  printf 'PORTLESS_HUB=%s\nPORTLESS_TOKEN=%s\n' "$WSS" "$TOKEN" | priv tee /etc/portless/agent.env >/dev/null || return 1
  priv chmod 600 /etc/portless/agent.env
  nm=${NAME:-$(hostname)}
  printf '%s\n' \
    '[Unit]' \
    'Description=Portless deploy agent' \
    'After=network-online.target docker.service' \
    'Wants=network-online.target' \
    '[Service]' \
    'EnvironmentFile=/etc/portless/agent.env' \
    "ExecStart=$BIN/portless-agent connect --name $nm" \
    'Restart=always' \
    'RestartSec=3' \
    '[Install]' \
    'WantedBy=multi-user.target' | priv tee /etc/systemd/system/portless-agent.service >/dev/null || return 1
  priv systemctl daemon-reload
  priv systemctl enable --now portless-agent >/dev/null 2>&1 || return 1
  sleep 1
  priv systemctl is-active --quiet portless-agent || { priv journalctl -u portless-agent -n 8 --no-pager >&2 || true; return 1; }
  log "✅ systemd service 'portless-agent' active (auto-reconnect, survives reboot)"
  log "   stop/remove: systemctl disable --now portless-agent"
}

ensure_docker
install_agent
ARGS="connect --hub $WSS --token $TOKEN"
[ -n "$NAME" ] && ARGS="$ARGS --name $NAME"

if [ -n "$FOREGROUND" ]; then
  log "connecting to $WSS (foreground)…"
  exec "$BIN/portless-agent" $ARGS
fi

# Prefer a real service (reboot-survival) when we're root on a systemd box; else background w/ pidfile.
if install_service 2>/dev/null; then
  exit 0
fi

mkdir -p "$RUN"
pidf="$RUN/agent.pid"; logf="$RUN/agent.log"
[ -f "$pidf" ] && kill "$(cat "$pidf")" 2>/dev/null || true
: > "$logf"
nohup "$BIN/portless-agent" $ARGS >>"$logf" 2>&1 &
echo $! > "$pidf"
sleep 1
kill -0 "$(cat "$pidf")" 2>/dev/null || { tail -5 "$logf" >&2; die "agent exited on startup"; }
log "agent connected to $WSS (pid $(cat "$pidf"), logs: $logf)"
grep -q "connected to" "$logf" 2>/dev/null && log "✅ registered with the hub" || log "starting… check $logf"
warn "not reboot-persistent — re-run as root (sudo) for a systemd service"
