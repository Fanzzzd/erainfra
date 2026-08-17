#!/bin/sh
# Install the portless CLI on a dev machine (needs Node >= 20 on PATH):
#
#   curl -fsSL <hub>/cli.sh | sh
#
# Then connect it to your hub:
#
#   portless login <hub> --token <owner-token>
set -eu

SERVED_FROM="<hub>"
PREFIX="${PORTLESS_PREFIX:-$HOME/.portless}"
BIN="$PREFIX/bin"

log() { printf '\033[36m[portless]\033[0m %s\n' "$*" >&2; }
die() { printf '\033[31m[portless] %s\033[0m\n' "$*" >&2; exit 1; }

command -v node >/dev/null 2>&1 || die "node >= 20 is required (https://nodejs.org)"
node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 20 ? 0 : 1)' || die "node >= 20 required, found $(node --version)"

mkdir -p "$BIN"
log "downloading portless CLI from $SERVED_FROM …"
curl -fsSL "$SERVED_FROM/cli/portless.mjs" -o "$BIN/portless" || die "download failed"
chmod +x "$BIN/portless"
log "installed → $BIN/portless"

case ":$PATH:" in
  *":$BIN:"*) ;;
  *) log "add it to your PATH:  export PATH=\"\$PATH:$BIN\"" ;;
esac
log "next:  portless login $SERVED_FROM"
