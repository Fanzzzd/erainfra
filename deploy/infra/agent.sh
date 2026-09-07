#!/bin/sh
# Portless agent — ONE command turns a fresh Linux box into a ready deploy node.
# It dials OUT to the hub over WSS (no inbound port, works behind NAT), installs the container
# runtime if it's missing, and (when run as root) registers a systemd service so the node survives
# reboots.
#
#   curl -fsSL <hub>/agent.sh | sudo sh -s -- --token <token> [--name <name>]   # full setup
#   curl -fsSL <hub>/agent.sh | sh -s -- --token <token>                        # no-root: agent only
#
# What this script no longer does (ADR 0006): download a binary and run it. It used to fetch
# $HOSTBASE/agent-bin/portless-agent-<target> with no integrity check of any kind, chmod +x it, and
# start it as root. It now hands the job to the control plane's verified installer, which checks
# what it downloaded against a SHA-256 the control plane pins and refuses to install on a mismatch.
#
# The bytes still come from this hub by default — --source points the payload at /agent-bin/ while
# the script and the digest come from the control plane over TLS — so self-hosted and air-gapped
# installs are unaffected. Populate the mirror with `build-agents.sh` from the same commit the
# control plane pins; a mirror built from anything else is refused, by design.
#
# The hub URL defaults to wherever this script was served from, so usually just --token is needed.
# Flags: --hub <url>  --token <tok>  --name <id>  --no-docker (skip runtime install)  --foreground
#        --install-url <url> (the control plane serving /install; defaults to ERAINFRA_INSTALL_URL)
#        --from-release (take the bytes from the GitHub release instead of this hub's mirror)
set -eu

# <hub> is templated by the server to the base URL this script was served from, and <install> to the
# control plane this hub is configured against (ERAINFRA_INSTALL_URL).
SERVED_FROM="<hub>"

# --- retiring the "Portless" name, stage 1 (ADR 0004; CONTEXT.md rule 4) -----------------------
# Read both names, prefer the new one, warn when the old one is what was found, delete nothing.
# Nothing writes an ERAINFRA_* name yet, so on a box in the field today every dual_env below
# returns exactly the value it returned before and prints one line to stderr.
#
# POSIX sh has no indirect expansion, hence eval on two names this script controls. `${x-}` (not
# `${x:-}`) inside the eval so "set to empty" survives the read; the `[ -n ]` tests below then
# apply the same empty-is-absent rule the `${VAR:-default}` call sites already used, which is what
# keeps this from changing what a box does rather than only what it prints.
#
# Copied rather than shared on purpose: this file is curl'd and piped to sh on a bare machine, so
# it cannot source anything. Same idiom as apps/hub/src/env.ts and internal/rename/rename.go.
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

HUB=""; TOKEN="$(dual_env ERAINFRA_TOKEN PORTLESS_TOKEN)"; NAME=""; FOREGROUND=""; WANT_DOCKER=1; FROM_RELEASE=0
# ERAINFRA_INSTALL_URL is new in this change, so it gets only the new name: no deployed box holds a
# PORTLESS_ spelling of it, and inventing one would freeze a retired alias for nothing (ADR 0004).
INSTALL_URL="${ERAINFRA_INSTALL_URL:-<install>}"
while [ $# -gt 0 ]; do
  case "$1" in
    --hub)   HUB=$2; shift 2 ;;
    --token) TOKEN=$2; shift 2 ;;
    --name)  NAME=$2; shift 2 ;;
    --install-url) INSTALL_URL=$2; shift 2 ;;
    --from-release) FROM_RELEASE=1; shift ;;
    --no-docker) WANT_DOCKER=0; shift ;;
    --foreground) FOREGROUND=1; shift ;;
    *) shift ;;
  esac
done

# The prefix directory a Node already holds. Dual-READ only: with neither directory present this
# resolves to the old path, so a fresh enrolment installs exactly where it installs today. Nothing
# creates ~/.erainfra yet — the release that starts writing new names is the one that flips this.
PREFIX="$(dual_env ERAINFRA_PREFIX PORTLESS_PREFIX)"
if [ -z "$PREFIX" ]; then
  if [ -d "$HOME/.erainfra" ]; then PREFIX="$HOME/.erainfra"; else PREFIX="$HOME/.portless"; fi
fi
BIN="$PREFIX/bin"
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

detect_target() {
  os=$(uname -s); arch=$(uname -m)
  case "$os" in Linux) os=linux ;; Darwin) os=darwin ;; *) die "unsupported OS: $os" ;; esac
  case "$arch" in x86_64|amd64) arch=amd64 ;; aarch64|arm64) arch=arm64 ;; *) die "unsupported arch: $arch" ;; esac
  echo "${os}-${arch}"
}

# Hand the install to the control plane's verified installer. The container runtime, the binary, the
# systemd unit and the enrollment all happen in there — under one checksum check that this script
# cannot skip, weaken or work around. What is passed in is where the bytes may come from, never
# whether they are checked.
install_agent() {
  target=$(detect_target)
  # Unconfigured is the empty string: the server templates <install> to ERAINFRA_INSTALL_URL, which
  # is empty when unset. Nothing here compares against the placeholder text — the templating would
  # rewrite that comparison too, and the guard would pass exactly when it should fail.
  [ -n "$INSTALL_URL" ] ||
    die "no verified installer configured: set ERAINFRA_INSTALL_URL on the hub, or pass --install-url https://<control-plane>. Enrolling without one would mean installing a binary nothing vouches for, which is what ADR 0006 retired."
  have bash || die "bash is required by the verified installer (install bash, then re-run)"
  set -- --role node --hub "$WSS" --token "$TOKEN"
  [ -z "$NAME" ] || set -- "$@" --name "$NAME"
  [ "$WANT_DOCKER" = 1 ] || set -- "$@" --no-docker
  [ -z "$FOREGROUND" ] || set -- "$@" --foreground
  if [ "$FROM_RELEASE" = 0 ]; then
    # Self-hosted by default: the payload comes off this hub, the digest comes from the control
    # plane. An air-gapped box keeps working, and the mirror is no longer something to trust.
    set -- "$@" --source "$HOSTBASE/agent-bin/portless-agent-${target}"
  fi
  log "installing the verified agent via $INSTALL_URL/install …"
  curl -fsSL "$INSTALL_URL/install" | bash -s -- "$@" || die "verified install failed. If the checksum did not match, this hub's /agent-bin mirror is not the release the control plane pins: rebuild it with build-agents.sh from that commit, or re-run with --from-release."
}

# dumbpipe (iroh) powers cross-node service links (backend on this box → db on another NAT'd box).
# Prebuilt binary from its GitHub releases — no Rust toolchain. Best-effort: without it the node still
# deploys fine; only cross-node `needs:` links are unavailable.
DUMBPIPE_VERSION="${DUMBPIPE_VERSION:-v0.39.0}"
ensure_dumbpipe() {
  [ -x "$BIN/dumbpipe" ] && return 0
  os=$(uname -s); arch=$(uname -m)
  case "$os" in Linux) os=linux ;; Darwin) os=darwin ;; *) return 0 ;; esac
  case "$arch" in x86_64|amd64) arch=x86_64 ;; aarch64|arm64) arch=aarch64 ;; *) return 0 ;; esac
  url="https://github.com/n0-computer/dumbpipe/releases/download/${DUMBPIPE_VERSION}/dumbpipe-${DUMBPIPE_VERSION}-${os}-${arch}.tar.gz"
  log "downloading dumbpipe ${DUMBPIPE_VERSION} (cross-node links)…"
  tmp=$(mktemp -d)
  # mkdir here rather than relying on the agent install: that step is the verified installer's now,
  # and it runs after this one. Report what actually happened — the old wording said "installed"
  # whether or not the move worked.
  if curl -fsSL "$url" -o "$tmp/d.tgz" && tar -xzf "$tmp/d.tgz" -C "$tmp" 2>/dev/null &&
     [ -f "$tmp/dumbpipe" ] && mkdir -p "$BIN" && mv "$tmp/dumbpipe" "$BIN/dumbpipe"; then
    chmod +x "$BIN/dumbpipe"
    log "installed dumbpipe -> $BIN/dumbpipe"
  else
    warn "dumbpipe download failed — cross-node service links disabled on this node (deploys unaffected)"
  fi
  rm -rf "$tmp"
}

# The systemd unit, /etc/portless/agent.env and the container runtime install used to live here.
# They are the verified installer's now — under the same frozen names, written only after the
# checksum matches. Deleting this copy is what makes "the binary was never checked" unreachable
# rather than merely discouraged.
ensure_dumbpipe
install_agent
