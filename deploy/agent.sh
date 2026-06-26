#!/bin/sh
# Portless agent — one line to bring a Linux/macOS box onto the mesh as a deploy node.
# The agent dials OUT to the hub over WSS (no inbound port, works behind NAT), then runs the
# containers the hub tells it to. No Docker needed to INSTALL the agent (only to deploy containers).
#
#   curl -fsSL <hub>/agent.sh | sh -s -- --token <token> [--name <name>]
#   curl -fsSL <hub>/agent.sh | sh -s -- --hub wss://hub.example.com/agent --token <token>
#
# The hub URL defaults to wherever this script was served from, so usually just --token is needed.
# Pass --hub explicitly when the installer is served from somewhere other than the hub (e.g. Vercel).
set -eu

# <hub> is templated by the server to the base URL this script was served from.
SERVED_FROM="<hub>"
HUB=""; TOKEN="${PORTLESS_TOKEN:-}"; NAME=""; FOREGROUND=""
while [ $# -gt 0 ]; do
  case "$1" in
    --hub)   HUB=$2; shift 2 ;;
    --token) TOKEN=$2; shift 2 ;;
    --name)  NAME=$2; shift 2 ;;
    --foreground) FOREGROUND=1; shift ;;
    *) shift ;;
  esac
done

PREFIX="${PORTLESS_PREFIX:-$HOME/.portless}"
BIN="$PREFIX/bin"; RUN="$PREFIX/run"
log() { printf '\033[36m[portless]\033[0m %s\n' "$*" >&2; }
die() { printf '\033[31m[portless] %s\033[0m\n' "$*" >&2; exit 1; }

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

detect_target() {
  os=$(uname -s); arch=$(uname -m)
  case "$os" in Linux) os=linux ;; Darwin) os=darwin ;; *) die "unsupported OS: $os" ;; esac
  case "$arch" in x86_64|amd64) arch=amd64 ;; aarch64|arm64) arch=arm64 ;; *) die "unsupported arch: $arch" ;; esac
  echo "${os}-${arch}"
}

install_agent() {
  mkdir -p "$BIN"
  target=$(detect_target)
  url="$HOSTBASE/agent-bin/portless-agent-${target}"
  log "downloading agent ($target) from $url …"
  curl -fsSL "$url" -o "$BIN/portless-agent" || die "download failed: $url (did you run build-agents.sh on the hub?)"
  chmod +x "$BIN/portless-agent"
}

install_agent
ARGS="connect --hub $WSS --token $TOKEN"
[ -n "$NAME" ] && ARGS="$ARGS --name $NAME"

if [ -n "$FOREGROUND" ]; then
  log "connecting to $WSS (foreground)…"
  exec "$BIN/portless-agent" $ARGS
fi

# Background it with a pidfile so re-running replaces the old one. ponytail: nohup survives the shell,
# not a reboot — wire a systemd unit / launchd plist for reboot-survival when you need it.
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
