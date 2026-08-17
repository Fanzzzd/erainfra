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

# --- retiring the "Portless" name, stage 1 (ADR 0004; CONTEXT.md rule 4) -----------------------
# Read both names, prefer the new one, warn when the old one is what was found, delete nothing.
# Nothing writes an ERAINFRA_* name yet, so every dual_env below returns exactly what it returned
# before and prints one line to stderr. POSIX sh has no indirect expansion, hence eval on two names
# this script controls; `${x-}` inside it so "set to empty" survives, and the `[ -n ]` tests then
# apply the same empty-is-absent rule the `${VAR:-default}` call sites already used.
# Copied, not sourced: this file is curl'd and piped to sh. See apps/hub/src/env.ts for the reasons.
dual_env() { # dual_env NEW OLD [DEFAULT]
  eval "_dv_new=\${$1-}"
  eval "_dv_old=\${$2-}"
  if [ -n "${_dv_new:-}" ]; then
    printf '%s' "$_dv_new"
  elif [ -n "${_dv_old:-}" ]; then
    printf '\033[33m[erainfra] %s is a retired name — use %s instead. The old name still works.\033[0m\n' \
      "$2" "$1" >&2
    printf '%s' "$_dv_old"
  else
    printf '%s' "${3:-}"
  fi
}

# The prefix directory this machine already holds. Dual-READ only: with neither directory present
# this resolves to the old path, so a fresh install lands exactly where it lands today.
dual_prefix() {
  p="$(dual_env ERAINFRA_PREFIX PORTLESS_PREFIX)"
  if [ -n "$p" ]; then printf '%s' "$p"; return 0; fi
  h=${HOME:-/root}
  if [ -d "$h/.erainfra" ]; then printf '%s' "$h/.erainfra"; else printf '%s' "$h/.portless"; fi
}

PREFIX="$(dual_prefix)"
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
