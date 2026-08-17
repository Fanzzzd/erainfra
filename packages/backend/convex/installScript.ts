import type { AgentRelease } from "./agentRelease";

const INSTALL_SCRIPT = String.raw`#!/usr/bin/env bash
set -euo pipefail

# --role picks which machine this is, in CONTEXT.md's terms: a Worker executes CI jobs and runs the
# Action Runner Agent; a Node runs deployed Apps and runs the Infra Agent. It is a flag on the
# script rather than a query parameter on the URL because the /install handler takes no request
# argument — one body, rendered from this deployment's own configuration, cacheable, and impossible
# to steer by crafting a request. Everything below the dispatch is the Worker path, unchanged.
INSTALL_ROLE='worker'
ROLE_REMAINING=$#
while [ "$ROLE_REMAINING" -gt 0 ]; do
  ROLE_ARG=$1
  shift
  case "$ROLE_ARG" in
    --role)
      # ROLE_REMAINING, not $#: the loop rotates every other argument to the back of "$@", so $#
      # counts arguments this loop has already parsed. "--token X --role" would pass a $# test, take
      # the rotated --token as the role, and hand the Worker parser a bare X — silently rewriting the
      # argument list rather than refusing.
      if [ "$ROLE_REMAINING" -lt 2 ]; then
        printf '❌ %s\n' '--role requires a value: worker or node' >&2
        exit 1
      fi
      INSTALL_ROLE=$1
      shift
      ROLE_REMAINING=$((ROLE_REMAINING - 2))
      ;;
    *)
      # Rotate everything else to the back, so each role's own parser sees exactly its own flags.
      set -- "$@" "$ROLE_ARG"
      ROLE_REMAINING=$((ROLE_REMAINING - 1))
      ;;
  esac
done

node_log() { printf '✅ %s\n' "$1"; }
node_warn() { printf '⚠️  %s\n' "$1" >&2; }
node_fail() {
  printf '❌ %s\n' "$1" >&2
  exit 1
}

node_usage() {
  printf '%s\n' 'Usage: bash -s -- --role node --token <hub token> --hub wss://<hub>/agent [--name NAME]'
  printf '%s\n' '                  [--source <url|file:///path>] [--no-docker] [--foreground]'
}

# Every Infra Agent digest this deployment pins, one line per published target. A target that is
# not listed is a target this installer refuses: there would be nothing to check the bytes against,
# and an unchecked binary running as root on a customer's Node is the thing ADR 0006 exists to end.
node_pinned_digest() {
  case "$1" in
__INFRA_AGENT_DIGESTS__
    *) printf '' ;;
  esac
}

node_sha256_file() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | cut -d ' ' -f 1
  elif command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d ' ' -f 1
  else
    node_fail 'A SHA-256 utility (shasum or sha256sum) is required'
  fi
}

# Bring up a container runtime if there is not one, exactly as deploy/infra/agent.sh does: distro
# packages only, and a failure warns rather than aborts so the box still enrolls. Apps cannot deploy
# until a runtime is on PATH, but a Node with no runtime is still a Node the Hub can see.
node_ensure_runtime() {
  if [ "$NODE_WANT_DOCKER" -ne 1 ]; then
    node_log 'Skipping the container runtime install (--no-docker).'
    return 0
  fi
  if command -v docker >/dev/null 2>&1; then
    node_log "Container runtime present: $(docker --version 2>/dev/null || printf 'docker')"
    return 0
  fi
  if [ "$NODE_OS_NAME" = 'darwin' ]; then
    node_warn 'No container runtime — install Docker Desktop by hand; this Node still enrolls.'
    return 0
  fi
  node_log 'Installing a container runtime from the distro repositories…'
  if command -v apt-get >/dev/null 2>&1; then
    $NODE_SUDO sh -c 'apt-get update -y && DEBIAN_FRONTEND=noninteractive apt-get install -y docker.io' || node_warn 'Runtime install failed (apt).'
  elif command -v dnf >/dev/null 2>&1; then
    $NODE_SUDO dnf install -y docker || node_warn 'Runtime install failed (dnf).'
  elif command -v yum >/dev/null 2>&1; then
    $NODE_SUDO yum install -y docker || node_warn 'Runtime install failed (yum).'
  elif command -v apk >/dev/null 2>&1; then
    $NODE_SUDO apk add --no-cache docker || node_warn 'Runtime install failed (apk).'
  elif command -v zypper >/dev/null 2>&1; then
    $NODE_SUDO zypper -n install docker || node_warn 'Runtime install failed (zypper).'
  else
    node_warn 'No supported package manager (apt/dnf/yum/apk/zypper) — install docker by hand.'
    return 0
  fi
  if command -v systemctl >/dev/null 2>&1; then
    $NODE_SUDO systemctl enable --now docker >/dev/null 2>&1 || true
  fi
  if command -v docker >/dev/null 2>&1; then
    node_log "Container runtime installed: $(docker --version 2>/dev/null || printf 'docker')"
  else
    node_warn 'Docker is still not on PATH — deploys will fail until it is.'
  fi
}

# The bytes may come from anywhere. --source moves the payload's origin — a hub mirror, a file on a
# USB stick — and never the script's: this script and the digest below it arrived from this
# deployment over TLS, which is what makes an untrusted byte source safe to read from.
node_fetch() {
  case "$1" in
    file://*)
      cp "$(printf '%s' "$1" | sed 's|^file://||')" "$2" ||
        node_fail "Could not read the Infra Agent from $1"
      ;;
    /*)
      cp "$1" "$2" || node_fail "Could not read the Infra Agent from $1"
      ;;
    *)
      curl -fsSL "$1" -o "$2" || node_fail "Could not download the Infra Agent from $1"
      ;;
  esac
}

# The unit, its name, the environment file and the download path are all identifiers a running Node
# already holds. Renaming any of them disconnects live Nodes, so this installer writes exactly the
# names deploy/infra/agent.sh writes; retiring them is its own staged migration.
node_install_service() {
  command -v systemctl >/dev/null 2>&1 || return 1
  $NODE_SUDO test -d /run/systemd/system || return 1
  # Only the directory holding agent.env may have moved already, and only if something else moved
  # it: this installer creates neither name. The unit name, the file name and the variable names
  # inside it all stay frozen, because a second unit would leave the first one enabled.
  NODE_ENV_DIR=/etc/portless
  [ -d /etc/erainfra ] && NODE_ENV_DIR=/etc/erainfra
  $NODE_SUDO mkdir -p "$NODE_ENV_DIR" || return 1
  # 0600 before the token is written, not after: creating it world-readable and chmodding afterwards
  # leaves a window in which any local user can read the Hub credential.
  $NODE_SUDO install -m 600 /dev/null "$NODE_ENV_DIR/agent.env" || return 1
  printf 'PORTLESS_HUB=%s\nPORTLESS_TOKEN=%s\n' "$NODE_HUB" "$NODE_TOKEN" |
    $NODE_SUDO tee "$NODE_ENV_DIR/agent.env" >/dev/null || return 1
  printf '%s\n' \
    '[Unit]' \
    'Description=Portless deploy agent' \
    'After=network-online.target docker.service' \
    'Wants=network-online.target' \
    '[Service]' \
    "EnvironmentFile=$NODE_ENV_DIR/agent.env" \
    "Environment=HOME=$HOME" \
    "ExecStart=$NODE_BIN_DIR/portless-agent connect --name $NODE_MACHINE_NAME" \
    'Restart=always' \
    'RestartSec=3' \
    '[Install]' \
    'WantedBy=multi-user.target' |
    $NODE_SUDO tee /etc/systemd/system/portless-agent.service >/dev/null || return 1
  $NODE_SUDO systemctl daemon-reload
  $NODE_SUDO systemctl enable --now portless-agent >/dev/null 2>&1 || return 1
  # "enable --now" starts a stopped unit and does nothing to a running one, so on a re-install the
  # old process keeps executing the bytes it was started with while is-active happily reports
  # success. Restart explicitly: this installer's whole claim is that what runs was verified.
  $NODE_SUDO systemctl restart portless-agent || return 1
  sleep 1
  $NODE_SUDO systemctl is-active --quiet portless-agent || {
    $NODE_SUDO journalctl -u portless-agent -n 8 --no-pager >&2 || true
    return 1
  }
  return 0
}

node_install() {
  NODE_TOKEN=""
  NODE_HUB=""
  NODE_NAME=""
  NODE_SOURCE=""
  NODE_WANT_DOCKER=1
  NODE_FOREGROUND=0
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --token)
        [ "$#" -ge 2 ] || node_fail '--token requires a value'
        NODE_TOKEN=$2
        shift 2
        ;;
      --hub)
        [ "$#" -ge 2 ] || node_fail '--hub requires a value'
        NODE_HUB=$2
        shift 2
        ;;
      --name)
        [ "$#" -ge 2 ] || node_fail '--name requires a value'
        NODE_NAME=$2
        shift 2
        ;;
      --source)
        [ "$#" -ge 2 ] || node_fail '--source requires a url or file:// path'
        NODE_SOURCE=$2
        shift 2
        ;;
      --no-docker)
        NODE_WANT_DOCKER=0
        shift
        ;;
      --foreground)
        NODE_FOREGROUND=1
        shift
        ;;
      -h|--help)
        node_usage
        exit 0
        ;;
      *)
        node_usage >&2
        node_fail "Unknown option: $1"
        ;;
    esac
  done

  [ -n "$NODE_TOKEN" ] || { node_usage >&2; node_fail 'A Hub enrollment token is required'; }
  [ -n "$NODE_HUB" ] || { node_usage >&2; node_fail 'The Hub URL is required, e.g. --hub wss://hub.example.com/agent'; }

  case "$(uname -s)" in
    Linux) NODE_OS_NAME='linux' ;;
    Darwin) NODE_OS_NAME='darwin' ;;
    *) node_fail 'On Windows, run the PowerShell installer this deployment serves at /install.ps1' ;;
  esac
  case "$(uname -m)" in
    x86_64|amd64) NODE_ARCH_NAME='x86_64' ;;
    arm64|aarch64) NODE_ARCH_NAME='arm64' ;;
    *) node_fail "Unsupported CPU architecture: $(uname -m)" ;;
  esac
  NODE_TARGET="$NODE_OS_NAME-$NODE_ARCH_NAME"
  NODE_ASSET="infra-agent-$NODE_TARGET"

  NODE_EXPECTED_SHA=$(node_pinned_digest "$NODE_TARGET")
  [ -n "$NODE_EXPECTED_SHA" ] ||
    node_fail "This EraInfra deployment pins no Infra Agent build for $NODE_TARGET, so there is nothing to verify the download against. Deploy a backend whose AGENT_RELEASE pins a release that publishes it."

  if [ "$(id -u)" = '0' ]; then NODE_SUDO=''; else NODE_SUDO='sudo'; fi
  # $PORTLESS_PREFIX and the paths under it are identifiers a running Node already holds (rule 4).
  # Stage 1 of retiring the name (ADR 0004) reads both and prefers the new one; it writes neither,
  # so with nothing set and no ~/.erainfra directory this resolves to exactly the old path.
  NODE_PREFIX=$(printenv ERAINFRA_PREFIX || true)
  if [ -z "$NODE_PREFIX" ]; then
    NODE_PREFIX=$(printenv PORTLESS_PREFIX || true)
    [ -z "$NODE_PREFIX" ] ||
      node_warn 'PORTLESS_PREFIX is a retired name — use ERAINFRA_PREFIX. The old name still works.'
  fi
  if [ -z "$NODE_PREFIX" ]; then
    if [ -d "$HOME/.erainfra" ]; then NODE_PREFIX="$HOME/.erainfra"; else NODE_PREFIX="$HOME/.portless"; fi
  fi
  NODE_BIN_DIR="$NODE_PREFIX/bin"
  NODE_RUN_DIR="$NODE_PREFIX/run"
  NODE_MACHINE_NAME=$NODE_NAME
  if [ -z "$NODE_MACHINE_NAME" ]; then
    NODE_MACHINE_NAME=$(hostname -s 2>/dev/null || hostname)
  fi

  NODE_TMP_DIR=$(mktemp -d)
  trap 'rm -rf "$NODE_TMP_DIR"' EXIT

  NODE_URL="https://github.com/$NODE_REPO/releases/download/v$NODE_VERSION/$NODE_ASSET"
  NODE_ORIGIN="the release this deployment pins"
  if [ -n "$NODE_SOURCE" ]; then
    case "$NODE_SOURCE" in
      */) NODE_URL="$NODE_SOURCE$NODE_ASSET" ;;
      *) NODE_URL=$NODE_SOURCE ;;
    esac
    NODE_ORIGIN="$NODE_URL"
  fi

  node_log "Fetching the Infra Agent $NODE_VERSION for $NODE_TARGET from $NODE_ORIGIN."
  NODE_DOWNLOAD="$NODE_TMP_DIR/$NODE_ASSET"
  node_fetch "$NODE_URL" "$NODE_DOWNLOAD"

  NODE_ACTUAL_SHA=$(node_sha256_file "$NODE_DOWNLOAD")
  if [ "$NODE_ACTUAL_SHA" != "$NODE_EXPECTED_SHA" ]; then
    rm -f "$NODE_DOWNLOAD"
    node_fail "Infra Agent checksum verification failed: expected $NODE_EXPECTED_SHA but got $NODE_ACTUAL_SHA. Nothing was installed."
  fi
  node_log "Verified $NODE_ASSET against the checksum pinned by this EraInfra deployment."

  # Only past the verification does anything on this machine change. A mismatch above leaves an
  # already-installed agent running on the bytes it was installed with.
  # Detect and report, never rename (ADR 0004 stage 1). A second unit under a new name would leave
  # portless-agent.service ENABLED and running, so the Node would hold two agents dialling this Hub.
  # Checked here rather than inside node_install_service, whose output is discarded on the way to the
  # nohup fallback — which would then start a third.
  if [ -f /etc/systemd/system/erainfra-agent.service ] &&
     [ -f /etc/systemd/system/portless-agent.service ]; then
    node_fail 'This Node has both portless-agent.service and erainfra-agent.service; two agents would dial the same Hub. Disable one first: systemctl disable --now erainfra-agent'
  fi

  node_ensure_runtime
  mkdir -p "$NODE_BIN_DIR"
  chmod +x "$NODE_DOWNLOAD"
  mv "$NODE_DOWNLOAD" "$NODE_BIN_DIR/portless-agent"
  node_log "Installed $NODE_BIN_DIR/portless-agent."

  # --foreground installs nothing that outlives the shell: the verification and the binary are the
  # same, only the supervision is the operator's. It is how deploy/infra/agent.sh has always let
  # someone watch a Node's first connection.
  if [ "$NODE_FOREGROUND" -eq 1 ]; then
    node_log "Connecting to $NODE_HUB in the foreground."
    trap - EXIT
    rm -rf "$NODE_TMP_DIR"
    # Exported, not passed as flags, for the same reason the background path does it: this process
    # is long-lived and /proc/<pid>/cmdline is world-readable. Written on their own lines rather
    # than as an assignment prefix on the exec — the prefix form does export, but it silently stops
    # doing so the moment anything is inserted between it and the exec, and this is the line where
    # that would matter. All three launch paths now name the two variables the same way.
    PORTLESS_HUB=$NODE_HUB
    PORTLESS_TOKEN=$NODE_TOKEN
    export PORTLESS_HUB PORTLESS_TOKEN
    exec "$NODE_BIN_DIR/portless-agent" connect --name "$NODE_MACHINE_NAME"
  fi

  if node_install_service 2>/dev/null; then
    node_log "systemd service 'portless-agent' is active; it reconnects and survives reboot."
    printf '   Stop and remove it with: systemctl disable --now portless-agent\n'
    exit 0
  fi

  mkdir -p "$NODE_RUN_DIR"
  NODE_PID_FILE="$NODE_RUN_DIR/agent.pid"
  NODE_LOG_FILE="$NODE_RUN_DIR/agent.log"
  if [ -f "$NODE_PID_FILE" ]; then
    kill "$(cat "$NODE_PID_FILE")" 2>/dev/null || true
  fi
  : > "$NODE_LOG_FILE"
  # The token goes in the environment, never in argv: /proc/<pid>/cmdline is world-readable on
  # Linux, so a token passed as a flag is a Hub credential any local user can read for as long as
  # the agent runs. The agent reads PORTLESS_TOKEN and PORTLESS_HUB as its flag defaults, which is
  # the same channel the systemd unit uses through /etc/portless/agent.env.
  PORTLESS_HUB="$NODE_HUB" PORTLESS_TOKEN="$NODE_TOKEN" nohup "$NODE_BIN_DIR/portless-agent" \
    connect --name "$NODE_MACHINE_NAME" \
    >>"$NODE_LOG_FILE" 2>&1 &
  printf '%s\n' "$!" > "$NODE_PID_FILE"
  sleep 1
  kill -0 "$(cat "$NODE_PID_FILE")" 2>/dev/null || {
    tail -n 5 "$NODE_LOG_FILE" >&2 || true
    node_fail 'The Infra Agent exited on startup.'
  }
  node_log "Infra Agent connecting to $NODE_HUB (pid $(cat "$NODE_PID_FILE"), logs: $NODE_LOG_FILE)."
  node_warn 'Not reboot-persistent — re-run as root on a systemd box for a service.'
  exit 0
}

NODE_REPO='__AGENT_REPO__'
NODE_VERSION='__AGENT_VERSION__'

case "$INSTALL_ROLE" in
  worker) ;;
  node)
    node_install "$@"
    exit 0
    ;;
  *)
    printf '❌ %s\n' "Unknown --role: $INSTALL_ROLE (expected worker or node)" >&2
    exit 1
    ;;
esac

SITE_URL='__ERAINFRA_SITE_URL__'
AGENT_REPO='__AGENT_REPO__'
PINNED_VERSION='__AGENT_VERSION__'
PINNED_SHA256='__AGENT_SHA256__'
RC_HOME="$HOME/.runner-center"
AGENT_DIR="$RC_HOME/agent"
PREVIOUS_DIR="$RC_HOME/agent.previous"
BIN_DIR="$RC_HOME/bin"
ENV_FILE="$AGENT_DIR/.env"
META_FILE="$RC_HOME/install-meta"
LOG_FILE="$RC_HOME/agent.log"
START_SCRIPT="$RC_HOME/start-agent.sh"
PLIST="$HOME/Library/LaunchAgents/center.runner.agent.plist"
UNIT="$HOME/.config/systemd/user/runner-center-agent.service"
PID_FILE="$RC_HOME/agent.pid"
TOKEN=""
NAME=""
LABELS=""
SLOTS=""
VERSION_ARG=""
SHA_ARG=""
UPDATE=0
TMP_DIR=""
RC_CLI_TMP=""
SERVICE_KIND=""

fail() {
  trap - ERR
  printf '❌ %s\n' "$1" >&2
  exit 1
}

on_error() {
  code=$?
  trap - ERR
  printf '❌ Installation failed at line %s (exit %s).\n' "$1" "$code" >&2
  exit "$code"
}
trap 'on_error $LINENO' ERR

cleanup() {
  if [ -n "$TMP_DIR" ] && [ -d "$TMP_DIR" ]; then
    rm -rf "$TMP_DIR"
  fi
  if [ -n "$RC_CLI_TMP" ] && [ -f "$RC_CLI_TMP" ]; then
    rm -f "$RC_CLI_TMP"
  fi
}
trap cleanup EXIT

usage() {
  printf '%s\n' 'Usage: bash -s -- --token rcreg_xxx [--name NAME] [--labels a,b] [--slots N]'
  printf '%s\n' '       bash -s -- --update [--version vX.Y.Z] [--sha256 HEX]'
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --token)
      [ "$#" -ge 2 ] || fail '--token requires a value'
      TOKEN=$2
      shift 2
      ;;
    --name)
      [ "$#" -ge 2 ] || fail '--name requires a value'
      NAME=$2
      shift 2
      ;;
    --labels)
      [ "$#" -ge 2 ] || fail '--labels requires a value'
      LABELS=$2
      shift 2
      ;;
    --slots)
      [ "$#" -ge 2 ] || fail '--slots requires a value'
      SLOTS=$2
      shift 2
      ;;
    --version)
      [ "$#" -ge 2 ] || fail '--version requires a value'
      VERSION_ARG=$(printf '%s' "$2" | sed 's/^v//')
      shift 2
      ;;
    --sha256)
      [ "$#" -ge 2 ] || fail '--sha256 requires a value'
      SHA_ARG=$2
      shift 2
      ;;
    --update)
      UPDATE=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      fail "Unknown option: $1"
      ;;
  esac
done

if [ "$UPDATE" -eq 0 ] && [ -z "$TOKEN" ]; then
  usage >&2
  fail 'A registration token is required'
fi
if [ -n "$SLOTS" ]; then
  case "$SLOTS" in
    *[!0-9]*|'') fail '--slots must be a positive integer' ;;
  esac
  [ "$SLOTS" -ge 1 ] || fail '--slots must be a positive integer'
fi
if [ -n "$VERSION_ARG" ]; then
  printf '%s' "$VERSION_ARG" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.-]+)*$' ||
    fail '--version must be a release version such as v1.2.3'
fi
if [ -n "$SHA_ARG" ]; then
  printf '%s' "$SHA_ARG" | grep -Eq '^[0-9a-f]{64}$' ||
    fail '--sha256 must be a 64-character lowercase hex digest'
fi

case "$(uname -s)" in
  Darwin)
    MACHINE_OS='mac'
    NODE_OS='darwin'
    ;;
  Linux)
    MACHINE_OS='linux'
    NODE_OS='linux'
    ;;
  *)
    fail 'This installer onboards macOS and Linux hosts only. Windows is a preview with no supported onboarding path yet; see the Windows section of the README.'
    ;;
esac

case "$(uname -m)" in
  arm64|aarch64)
    MACHINE_ARCH='arm64'
    NODE_ARCH='arm64'
    ;;
  x86_64|amd64)
    MACHINE_ARCH='x86_64'
    NODE_ARCH='x64'
    ;;
  *)
    fail "Unsupported CPU architecture: $(uname -m)"
    ;;
esac

if command -v shasum >/dev/null 2>&1; then
  SHA_TOOL='shasum'
elif command -v sha256sum >/dev/null 2>&1; then
  SHA_TOOL='sha256sum'
else
  fail 'A SHA-256 utility (shasum or sha256sum) is required'
fi

sha256_file() {
  if [ "$SHA_TOOL" = 'shasum' ]; then
    shasum -a 256 "$1" | cut -d ' ' -f 1
  else
    sha256sum "$1" | cut -d ' ' -f 1
  fi
}

meta_field() {
  grep "^$1=" "$META_FILE" 2>/dev/null | cut -d= -f2- | tail -n 1 || true
}

stop_service() {
  case "$(meta_field SERVICE_KIND)" in
    launchd)
      launchctl bootout "gui/$UID" "$PLIST" >/dev/null 2>&1 || true
      ;;
    systemd)
      systemctl --user stop runner-center-agent.service >/dev/null 2>&1 || true
      ;;
    nohup)
      if [ -f "$PID_FILE" ]; then
        pid=$(grep -E '^[0-9]+$' "$PID_FILE" || true)
        if [ -n "$pid" ]; then kill "$pid" >/dev/null 2>&1 || true; fi
        rm -f "$PID_FILE"
      fi
      ;;
  esac
}

start_service() {
  case "$SERVICE_KIND" in
    launchd)
      launchctl bootout "gui/$UID" "$PLIST" >/dev/null 2>&1 || true
      launchctl bootstrap "gui/$UID" "$PLIST"
      launchctl kickstart -k "gui/$UID/center.runner.agent"
      ;;
    systemd)
      systemctl --user daemon-reload
      systemctl --user enable --now runner-center-agent.service
      systemctl --user restart runner-center-agent.service
      ;;
    nohup)
      if [ -f "$PID_FILE" ]; then
        pid=$(grep -E '^[0-9]+$' "$PID_FILE" || true)
        if [ -n "$pid" ]; then kill "$pid" >/dev/null 2>&1 || true; fi
      fi
      nohup "$START_SCRIPT" >> "$LOG_FILE" 2>&1 </dev/null &
      printf '%s\n' "$!" > "$PID_FILE"
      ;;
  esac
}

# Never delete the working agent before its replacement is staged and verified:
# every failure path above the swap leaves the old directory untouched, and this
# restores it if the swap or the first connection attempt goes wrong.
restore_previous() {
  [ -d "$PREVIOUS_DIR" ] || return 1
  rm -rf "$AGENT_DIR"
  mv "$PREVIOUS_DIR" "$AGENT_DIR"
}

write_meta() {
  umask 077
  printf 'SITE_URL=%s\nNODE_BIN=%s\nMACHINE_NAME=%s\nSERVICE_KIND=%s\nAGENT_VERSION=%s\n' \
    "$SITE_URL" "$NODE_BIN" "$MACHINE_NAME" "$SERVICE_KIND" "$1" > "$META_FILE"
  chmod 600 "$META_FILE"
}

if [ "$MACHINE_OS" = 'mac' ]; then
  CPUS=$(sysctl -n hw.ncpu)
  MEMORY_MIB=$(( $(sysctl -n hw.memsize) / 1048576 ))
else
  CPUS=$(getconf _NPROCESSORS_ONLN 2>/dev/null || nproc 2>/dev/null || printf '1')
  MEMORY_MIB=$(awk '/MemTotal/{printf "%d", $2 / 1024}' /proc/meminfo 2>/dev/null || printf '0')
fi
HOST_NAME=$(hostname -s 2>/dev/null || hostname)
MACHINE_NAME=$NAME
if [ -z "$MACHINE_NAME" ]; then
  MACHINE_NAME=$HOST_NAME
fi
PREVIOUS_VERSION=$(meta_field AGENT_VERSION)

mkdir -p "$RC_HOME" "$BIN_DIR"
TMP_DIR=$(mktemp -d "$RC_HOME/install.XXXXXX")

printf '✅ Detected %s %s with %s CPUs and %s MiB memory (%s).\n' "$MACHINE_OS" "$MACHINE_ARCH" "$CPUS" "$MEMORY_MIB" "$MACHINE_NAME"

NODE_BIN=""
if command -v node >/dev/null 2>&1; then
  CANDIDATE_NODE=$(command -v node)
  NODE_MAJOR=$("$CANDIDATE_NODE" -p 'Number(process.versions.node.split(".")[0])' 2>/dev/null || printf '0')
  if [ "$NODE_MAJOR" -ge 20 ]; then
    NODE_BIN=$CANDIDATE_NODE
  fi
fi
if [ -z "$NODE_BIN" ] && [ -x "$RC_HOME/node/bin/node" ]; then
  NODE_MAJOR=$("$RC_HOME/node/bin/node" -p 'Number(process.versions.node.split(".")[0])' 2>/dev/null || printf '0')
  if [ "$NODE_MAJOR" -ge 20 ]; then
    NODE_BIN="$RC_HOME/node/bin/node"
  fi
fi

if [ -z "$NODE_BIN" ]; then
  printf '✅ Installing the latest official Node.js 22 release.\n'
  SHASUMS_FILE="$TMP_DIR/SHASUMS256.txt"
  curl -fsSL 'https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt' -o "$SHASUMS_FILE"
  NODE_ARCHIVE=""
  EXPECTED_SHA=""
  while read -r checksum filename rest; do
    case "$filename" in
      node-v22.*-"$NODE_OS"-"$NODE_ARCH".tar.gz)
        EXPECTED_SHA=$checksum
        NODE_ARCHIVE=$filename
        break
        ;;
    esac
  done < "$SHASUMS_FILE"
  [ -n "$NODE_ARCHIVE" ] || fail "Could not find a Node.js 22 build for $NODE_OS-$NODE_ARCH"

  NODE_TARBALL="$TMP_DIR/$NODE_ARCHIVE"
  curl -fsSL "https://nodejs.org/dist/latest-v22.x/$NODE_ARCHIVE" -o "$NODE_TARBALL"
  ACTUAL_SHA=$(sha256_file "$NODE_TARBALL")
  [ "$ACTUAL_SHA" = "$EXPECTED_SHA" ] || fail 'Node.js archive checksum verification failed'

  mkdir -p "$TMP_DIR/node-extract"
  tar -xzf "$NODE_TARBALL" -C "$TMP_DIR/node-extract"
  EXTRACTED_NODE=""
  for candidate in "$TMP_DIR"/node-extract/node-v22*; do
    if [ -d "$candidate" ]; then
      EXTRACTED_NODE=$candidate
      break
    fi
  done
  [ -n "$EXTRACTED_NODE" ] || fail 'Could not extract Node.js'
  rm -rf "$RC_HOME/node"
  mv "$EXTRACTED_NODE" "$RC_HOME/node"
  NODE_BIN="$RC_HOME/node/bin/node"
else
  printf '✅ Using Node.js %s at %s.\n' "$("$NODE_BIN" --version)" "$NODE_BIN"
fi

NODE_BIN_DIR=$(dirname "$NODE_BIN")
PATH="$NODE_BIN_DIR:$PATH"
export PATH
NPM_BIN="$NODE_BIN_DIR/npm"
[ -x "$NPM_BIN" ] || fail "npm was not found next to $NODE_BIN"

if [ "$UPDATE" -eq 1 ] && [ ! -f "$ENV_FILE" ]; then
  fail 'No existing EraInfra registration was found; use a dashboard install command first'
fi

ENV_BACKUP="$TMP_DIR/agent.env"
if [ -f "$ENV_FILE" ]; then
  cp "$ENV_FILE" "$ENV_BACKUP"
fi

VERSION=$PINNED_VERSION
if [ -n "$VERSION_ARG" ]; then
  VERSION=$VERSION_ARG
fi
[ -n "$VERSION" ] || fail 'This EraInfra deployment pins no agent version; redeploy the backend'
if [ -n "$VERSION_ARG" ] && [ "$VERSION" != "$PINNED_VERSION" ] && [ -z "$SHA_ARG" ]; then
  fail 'Updating to a release other than the deployment pin requires --sha256 with an independently verified digest'
fi

ASSET="erainfra-agent-$VERSION.tar.gz"
RELEASE_URL="https://github.com/$AGENT_REPO/releases/download/v$VERSION"
ARCHIVE="$TMP_DIR/$ASSET"

printf '✅ Downloading the EraInfra agent %s release.\n' "$VERSION"
if ! curl -fsL "$RELEASE_URL/$ASSET" -o "$ARCHIVE"; then
  # Pre-rename releases keep their published asset names forever.
  ASSET="runner-center-agent-$VERSION.tar.gz"
  ARCHIVE="$TMP_DIR/$ASSET"
  curl -fsSL "$RELEASE_URL/$ASSET" -o "$ARCHIVE" ||
    fail "Could not download $ASSET from release v$VERSION of $AGENT_REPO"
fi

EXPECTED_SHA=$SHA_ARG
CHECKSUM_SOURCE='the checksum passed on the command line'
if [ -z "$EXPECTED_SHA" ]; then
  curl -fsSL "$RELEASE_URL/$ASSET.sha256" -o "$ARCHIVE.sha256" ||
    fail "Could not download the checksum published with release v$VERSION"
  EXPECTED_SHA=$(head -n 1 "$ARCHIVE.sha256" | cut -d ' ' -f 1)
  CHECKSUM_SOURCE='the checksum published with the release'
fi
[ -n "$EXPECTED_SHA" ] || fail 'The expected agent checksum is empty'

ACTUAL_SHA=$(sha256_file "$ARCHIVE")
[ "$ACTUAL_SHA" = "$EXPECTED_SHA" ] ||
  fail "Agent archive checksum verification failed: expected $EXPECTED_SHA but got $ACTUAL_SHA"
if [ -n "$PINNED_SHA256" ] && [ "$VERSION" = "$PINNED_VERSION" ]; then
  [ "$ACTUAL_SHA" = "$PINNED_SHA256" ] ||
    fail "Agent archive does not match the checksum pinned by this EraInfra deployment"
  CHECKSUM_SOURCE='the checksum pinned by this EraInfra deployment'
fi
printf '✅ Verified the agent archive against %s.\n' "$CHECKSUM_SOURCE"

STAGE_DIR="$TMP_DIR/staged-agent"
mkdir -p "$STAGE_DIR"
tar -xzf "$ARCHIVE" -C "$STAGE_DIR" --strip-components=1
[ -f "$STAGE_DIR/dist/index.js" ] || fail 'The agent archive is missing dist/index.js'
[ -f "$STAGE_DIR/package-lock.json" ] || fail 'The agent archive is missing package-lock.json'
if [ "$MACHINE_OS" = 'linux' ]; then
  [ -x "$STAGE_DIR/runtime/linux-$MACHINE_ARCH/runner-center-runtime" ] ||
    fail "The agent archive is missing the Linux $MACHINE_ARCH Firecracker runtime"
fi
chmod +x "$STAGE_DIR"/provisioners/*.sh
if [ -f "$ENV_BACKUP" ]; then
  cp "$ENV_BACKUP" "$STAGE_DIR/.env"
  chmod 600 "$STAGE_DIR/.env"
fi

printf '✅ Installing agent dependencies from the release lockfile.\n'
(
  cd "$STAGE_DIR"
  "$NPM_BIN" ci --omit=dev --no-audit --no-fund
)

printf '✅ Replacing the installed agent.\n'
stop_service
rm -rf "$PREVIOUS_DIR"
if [ -d "$AGENT_DIR" ]; then
  mv "$AGENT_DIR" "$PREVIOUS_DIR"
fi
if ! mv "$STAGE_DIR" "$AGENT_DIR"; then
  restore_previous || fail 'Could not install the new agent, and no previous installation was available'
  fail 'Could not install the new agent; the previous installation was restored'
fi

if [ "$UPDATE" -eq 0 ]; then
  printf '✅ Registering this machine.\n'
  REQUEST_BODY=$(REGISTRATION_TOKEN="$TOKEN" MACHINE_NAME="$MACHINE_NAME" MACHINE_OS="$MACHINE_OS" MACHINE_ARCH="$MACHINE_ARCH" MACHINE_CPUS="$CPUS" MACHINE_MEMORY_MIB="$MEMORY_MIB" MACHINE_LABELS="$LABELS" MACHINE_SLOTS="$SLOTS" "$NODE_BIN" -e '
const payload = {
  registrationToken: process.env.REGISTRATION_TOKEN,
  name: process.env.MACHINE_NAME,
  os: process.env.MACHINE_OS,
  arch: process.env.MACHINE_ARCH,
  cpus: Number(process.env.MACHINE_CPUS),
  memoryMiB: Number(process.env.MACHINE_MEMORY_MIB),
};
if (process.env.MACHINE_LABELS) {
  payload.labels = process.env.MACHINE_LABELS.split(",").map((label) => label.trim()).filter(Boolean);
}
if (process.env.MACHINE_SLOTS) payload.maxSlots = Number(process.env.MACHINE_SLOTS);
process.stdout.write(JSON.stringify(payload));
')
  RESPONSE_FILE="$TMP_DIR/register.json"
  if ! HTTP_STATUS=$(curl -sS -o "$RESPONSE_FILE" -w '%{http_code}' -H 'Content-Type: application/json' --data "$REQUEST_BODY" "$SITE_URL/agents/register"); then
    fail 'Could not reach the EraInfra registration endpoint'
  fi
  if [ "$HTTP_STATUS" -lt 200 ] || [ "$HTTP_STATUS" -ge 300 ]; then
    SERVER_MESSAGE=$("$NODE_BIN" -e '
const fs = require("node:fs");
try {
  const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  process.stdout.write(typeof value.error === "string" ? value.error : "Registration failed");
} catch {
  process.stdout.write("Registration failed");
}
' "$RESPONSE_FILE")
    fail "$SERVER_MESSAGE (HTTP $HTTP_STATUS)"
  fi
  MACHINE_TOKEN=$("$NODE_BIN" -e '
const fs = require("node:fs");
const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
if (typeof value.machineToken !== "string") process.exit(1);
process.stdout.write(value.machineToken);
' "$RESPONSE_FILE")
  CONVEX_URL=$("$NODE_BIN" -e '
const fs = require("node:fs");
const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
if (typeof value.convexUrl !== "string") process.exit(1);
process.stdout.write(value.convexUrl);
' "$RESPONSE_FILE")
  umask 077
  printf 'CONVEX_URL=%s\nMACHINE_TOKEN=%s\n' "$CONVEX_URL" "$MACHINE_TOKEN" > "$ENV_FILE"
  chmod 600 "$ENV_FILE"
else
  OLD_NAME=$(meta_field MACHINE_NAME)
  if [ -n "$OLD_NAME" ]; then
    MACHINE_NAME=$OLD_NAME
  fi
fi

cat > "$START_SCRIPT" <<'START_AGENT'
#!/usr/bin/env bash
set -euo pipefail
RC_HOME="$HOME/.runner-center"
AGENT_DIR="$RC_HOME/agent"
READY_FILE="$RC_HOME/agent.ready"
set -a
. "$AGENT_DIR/.env"
set +a
RC_AGENT_VERSION=$(grep '^AGENT_VERSION=' "$RC_HOME/install-meta" | cut -d= -f2-)
export RC_AGENT_VERSION
export RC_READY_FILE="$READY_FILE"
export RC_BENCHMARK_DIR="$RC_HOME/benchmarks"
rm -f "$READY_FILE"
if [ "$(uname -s)" = 'Linux' ]; then
  case "$(uname -m)" in
    x86_64|amd64) runtime_arch='x86_64' ;;
    arm64|aarch64) runtime_arch='arm64' ;;
    *) printf 'Unsupported runtime architecture: %s\n' "$(uname -m)" >&2; exit 1 ;;
  esac
  export RC_RUNTIME_BINARY="$AGENT_DIR/runtime/linux-$runtime_arch/runner-center-runtime"
fi
NODE_BIN=$(grep '^NODE_BIN=' "$RC_HOME/install-meta" | cut -d= -f2-)
exec "$NODE_BIN" "$AGENT_DIR/dist/index.js"
START_AGENT
chmod 700 "$START_SCRIPT"

# The update command runs this installer from the existing CLI. Replacing that path by
# truncating it lets bash read a mixture of the old and new scripts after the
# child installer returns. Build beside it and rename atomically so the running
# shell keeps its old inode while the next invocation sees the new CLI.
RC_CLI_TMP=$(mktemp "$BIN_DIR/.rc.XXXXXX")
cat > "$RC_CLI_TMP" <<'RC_CLI'
#!/usr/bin/env bash
set -euo pipefail

RC_HOME="$HOME/.runner-center"
META_FILE="$RC_HOME/install-meta"
LOG_FILE="$RC_HOME/agent.log"
START_SCRIPT="$RC_HOME/start-agent.sh"
PLIST="$HOME/Library/LaunchAgents/center.runner.agent.plist"
UNIT="$HOME/.config/systemd/user/runner-center-agent.service"
PID_FILE="$RC_HOME/agent.pid"

field() {
  grep "^$1=" "$META_FILE" 2>/dev/null | cut -d= -f2- | tail -n 1 || true
}

service_kind() {
  field SERVICE_KIND
}

stop_agent() {
  case "$(service_kind)" in
    launchd)
      launchctl bootout "gui/$UID" "$PLIST" >/dev/null 2>&1 || true
      ;;
    systemd)
      systemctl --user stop runner-center-agent.service >/dev/null 2>&1 || true
      ;;
    nohup)
      if [ -f "$PID_FILE" ]; then
        pid=$(grep -E '^[0-9]+$' "$PID_FILE" || true)
        if [ -n "$pid" ]; then kill "$pid" >/dev/null 2>&1 || true; fi
        rm -f "$PID_FILE"
      fi
      ;;
  esac
}

start_agent() {
  case "$(service_kind)" in
    launchd)
      launchctl bootstrap "gui/$UID" "$PLIST" >/dev/null 2>&1 || true
      launchctl kickstart -k "gui/$UID/center.runner.agent"
      ;;
    systemd)
      systemctl --user daemon-reload
      systemctl --user enable --now runner-center-agent.service
      systemctl --user restart runner-center-agent.service
      ;;
    nohup)
      stop_agent
      nohup "$START_SCRIPT" >> "$LOG_FILE" 2>&1 </dev/null &
      printf '%s\n' "$!" > "$PID_FILE"
      ;;
    *)
      printf '%s\n' 'EraInfra service metadata is missing. Run update from the dashboard install URL.' >&2
      exit 1
      ;;
  esac
}

is_running() {
  case "$(service_kind)" in
    # grep -q closes the pipe as soon as it matches, which makes launchctl
    # exit 141 under pipefail and reports a live service as stopped.
    launchd) launchctl print "gui/$UID/center.runner.agent" 2>/dev/null | grep 'state = running' >/dev/null ;;
    systemd) systemctl --user is-active --quiet runner-center-agent.service ;;
    nohup)
      [ -f "$PID_FILE" ] && pid=$(grep -E '^[0-9]+$' "$PID_FILE" || true) && [ -n "$pid" ] && kill -0 "$pid" >/dev/null 2>&1
      ;;
    *) return 1 ;;
  esac
}

usage() {
  printf '%s\n' 'Usage: rc status | doctor | benchmark | logs [-f] | restart | stop | update [--version vX.Y.Z] | uninstall'
}

command='status'
if [ "$#" -gt 0 ]; then command=$1; fi
case "$command" in
  status)
    machine=$(field MACHINE_NAME)
    version=$(field AGENT_VERSION)
    if is_running; then state='running'; else state='stopped'; fi
    last_line=$(tail -n 1 "$LOG_FILE" 2>/dev/null || true)
    printf 'Machine: %s\nAgent: %s\nStatus: %s\n' "$machine" "$version" "$state"
    if [ -n "$last_line" ]; then printf 'Last log: %s\n' "$last_line"; fi
    ;;
  doctor)
    printf 'Host: %s %s\n' "$(uname -s)" "$(uname -m)"
    printf 'Agent: %s\n' "$(field AGENT_VERSION)"
    if [ "$(uname -s)" = 'Linux' ]; then
      case "$(uname -m)" in
        x86_64|amd64) runtime_arch='x86_64' ;;
        arm64|aarch64) runtime_arch='arm64' ;;
        *) printf 'FAIL unsupported Linux architecture\n' >&2; exit 1 ;;
      esac
      runtime="$RC_HOME/agent/runtime/linux-$runtime_arch/runner-center-runtime"
      usable=0
      if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
        printf 'OK Docker is ready for trusted-only Linux Profiles.\n'
        usable=1
      else
        printf 'WARN Docker is unavailable to this user.\n' >&2
      fi
      # preflight writes its readiness document to stdout and the summary of any
      # failed check to stderr, so capturing stdout keeps doctor readable while
      # still showing an operator exactly which prerequisite is broken.
      if "$runtime" preflight >/dev/null; then
        printf 'OK the privileged runtime reports Firecracker, KVM, devmapper, kernel, CNI and the job network policy ready.\n'
        usable=1
      else
        printf 'WARN the privileged Firecracker runtime is unavailable or incomplete.\n' >&2
        printf 'Re-run deploy/provision-firecracker-host.sh, or verify the network policy alone with:\n' >&2
        printf '  sudo /usr/local/lib/runner-center/runner-center-runtime verify-network\n' >&2
        printf 'Use a dedicated thin-pool device; never place it on the root filesystem.\n' >&2
      fi
      if [ "$usable" -eq 0 ]; then exit 1; fi
    elif [ "$(uname -s)" = 'Darwin' ]; then
      tart_bin=$(printenv TART || true)
      if [ -z "$tart_bin" ]; then tart_bin=/opt/homebrew/bin/tart; fi
      if [ ! -x "$tart_bin" ]; then
        printf 'FAIL Tart is not installed at %s.\n' "$tart_bin" >&2
        exit 1
      fi
      "$tart_bin" --version
      printf 'OK Tart is ready; Profile readiness also verifies each immutable image.\n'
    else
      printf 'FAIL unsupported host OS\n' >&2
      exit 1
    fi
    ;;
  benchmark)
    AGENT_DIR="$RC_HOME/agent"
    NODE_BIN=$(field NODE_BIN)
    [ -n "$NODE_BIN" ] || { printf '%s\n' 'Node.js metadata is missing.' >&2; exit 1; }
    set -a
    . "$AGENT_DIR/.env"
    set +a
    export RC_BENCHMARK_DIR="$RC_HOME/benchmarks"
    exec "$NODE_BIN" "$AGENT_DIR/dist/benchmark-cli.js"
    ;;
  logs)
    follow=''
    if [ "$#" -ge 2 ]; then follow=$2; fi
    if [ "$follow" = '-f' ]; then
      touch "$LOG_FILE"
      tail -f "$LOG_FILE"
    else
      tail -n 100 "$LOG_FILE" 2>/dev/null || true
    fi
    ;;
  restart)
    start_agent
    printf '%s\n' 'EraInfra agent restarted.'
    ;;
  stop)
    stop_agent
    printf '%s\n' 'EraInfra agent stopped.'
    ;;
  update)
    site=$(field SITE_URL)
    [ -n "$site" ] || { printf '%s\n' 'EraInfra site URL is missing.' >&2; exit 1; }
    if [ "$#" -gt 1 ]; then
      shift
      curl -fsSL "$site/install" | bash -s -- --update "$@"
    else
      curl -fsSL "$site/install" | bash -s -- --update
    fi
    ;;
  uninstall)
    kind=$(service_kind)
    stop_agent
    if [ "$kind" = 'systemd' ]; then
      systemctl --user disable runner-center-agent.service >/dev/null 2>&1 || true
    fi
    rm -f "$PLIST" "$UNIT"
    if command -v systemctl >/dev/null 2>&1; then
      systemctl --user daemon-reload >/dev/null 2>&1 || true
    fi
    if command -v crontab >/dev/null 2>&1; then
      tmp=$(mktemp)
      (crontab -l 2>/dev/null || true) | grep -Fv "$START_SCRIPT" > "$tmp" || true
      crontab "$tmp" 2>/dev/null || true
      rm -f "$tmp"
    fi
    path_line='export PATH="$HOME/.runner-center/bin:$PATH" # runner-center'
    for shell_rc in "$HOME/.zshrc" "$HOME/.bashrc" "$HOME/.profile"; do
      if [ -f "$shell_rc" ] && grep -Fq "$path_line" "$shell_rc"; then
        tmp=$(mktemp)
        grep -Fv "$path_line" "$shell_rc" > "$tmp" || true
        mv "$tmp" "$shell_rc"
      fi
    done
    rm -rf "$RC_HOME"
    printf '%s\n' 'EraInfra was removed. Delete the machine from the dashboard to remove its registration.'
    ;;
  -h|--help|help)
    usage
    ;;
  *)
    usage >&2
    exit 1
    ;;
esac
RC_CLI
chmod 755 "$RC_CLI_TMP"
mv "$RC_CLI_TMP" "$BIN_DIR/rc"
RC_CLI_TMP=""

PATH_LINE='export PATH="$HOME/.runner-center/bin:$PATH" # runner-center'
CURRENT_SHELL=$(printenv SHELL || true)
case "$CURRENT_SHELL" in
  */zsh) SHELL_RC="$HOME/.zshrc" ;;
  */bash) SHELL_RC="$HOME/.bashrc" ;;
  *) SHELL_RC="$HOME/.profile" ;;
esac
touch "$SHELL_RC"
if ! grep -Fq "$PATH_LINE" "$SHELL_RC"; then
  printf '\n%s\n' "$PATH_LINE" >> "$SHELL_RC"
  printf '✅ Added %s to %s.\n' "$BIN_DIR" "$SHELL_RC"
else
  printf '✅ EraInfra CLI is already on PATH in %s.\n' "$SHELL_RC"
fi

if [ "$MACHINE_OS" = 'mac' ]; then
  SERVICE_KIND='launchd'
elif command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1; then
  SERVICE_KIND='systemd'
else
  SERVICE_KIND='nohup'
fi

# start-agent.sh reads NODE_BIN from the metadata file, so it has to exist
# before anything starts the service.
write_meta "$VERSION"

case "$SERVICE_KIND" in
  launchd)
    mkdir -p "$HOME/Library/LaunchAgents"
    cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>center.runner.agent</string>
  <key>ProgramArguments</key>
  <array><string>$START_SCRIPT</string></array>
  <key>WorkingDirectory</key>
  <string>$AGENT_DIR</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>$LOG_FILE</string>
  <key>StandardErrorPath</key>
  <string>$LOG_FILE</string>
</dict>
</plist>
PLIST
    ;;
  systemd)
    mkdir -p "$HOME/.config/systemd/user"
    cat > "$UNIT" <<UNIT
[Unit]
Description=EraInfra agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$AGENT_DIR
ExecStart=$START_SCRIPT
StandardOutput=append:$LOG_FILE
StandardError=append:$LOG_FILE
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
UNIT
    ;;
  nohup)
    if command -v crontab >/dev/null 2>&1; then
      CRON_FILE="$TMP_DIR/crontab"
      (crontab -l 2>/dev/null || true) | grep -Fv "$START_SCRIPT" > "$CRON_FILE" || true
      printf '@reboot %s >> %s 2>&1\n' "$START_SCRIPT" "$LOG_FILE" >> "$CRON_FILE"
      crontab "$CRON_FILE"
    fi
    ;;
esac

: > "$LOG_FILE"
rm -f "$RC_HOME/agent.ready"
start_service

printf '✅ Started the EraInfra agent with %s.\n' "$SERVICE_KIND"
CONNECTED=0
for second in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
  if [ "$(cat "$RC_HOME/agent.ready" 2>/dev/null || true)" = "$VERSION" ]; then
    CONNECTED=1
    break
  fi
  sleep 1
done
if [ "$CONNECTED" -ne 1 ]; then
  LAST_LOG=$(tail -n 1 "$LOG_FILE" 2>/dev/null || true)
  # Only an update can roll back: a fresh install has just registered a new
  # machine, and the preserved directory holds the previous machine's identity.
  if [ "$UPDATE" -eq 1 ] && restore_previous; then
    write_meta "$PREVIOUS_VERSION"
    start_service || true
    fail "Agent $VERSION did not connect within 20 seconds; rolled back to the previous installation. Last log: $LAST_LOG"
  fi
  if [ -n "$LAST_LOG" ]; then
    fail "Agent did not connect within 20 seconds. Last log: $LAST_LOG"
  fi
  fail 'Agent did not connect within 20 seconds; check ~/.runner-center/agent.log'
fi

printf '✅ EraInfra %s is connected. Dashboard: %s\n' "$VERSION" "$SITE_URL"
printf '⏳ Compatible Profiles are prewarming in the background; cold capacity is not schedulable.\n'
printf '   Follow live progress with "rc logs -f" or in the dashboard readiness detail.\n'
`;

/**
 * The `case` arms of `node_pinned_digest`, one per pinned target.
 *
 * Both halves are interpolated into single-quoted shell, so both are checked against the shapes the
 * release workflow enforces rather than trusted: a pin carrying a quote would be command injection
 * in a script an operator pipes to `sudo bash`. An empty map renders no arms, which is what makes
 * an unpinned deployment refuse `--role node` instead of installing something unverifiable.
 */
function renderPinnedDigests(infraAgent: AgentRelease["infraAgent"]) {
  return Object.entries(infraAgent)
    .map(([target, digest]) => {
      if (!/^[a-z0-9]+-[a-z0-9_]+$/.test(target)) {
        throw new Error(`Infra Agent pin has an unusable target name: ${target}`);
      }
      if (!/^[0-9a-f]{64}$/.test(digest)) {
        throw new Error(`Infra Agent pin for ${target} is not a lowercase SHA-256 digest`);
      }
      return `    ${target}) printf '%s' '${digest}' ;;`;
    })
    .join("\n");
}

export function renderInstallScript(siteUrl: string, release: AgentRelease) {
  return INSTALL_SCRIPT.replaceAll("__ERAINFRA_SITE_URL__", siteUrl.replace(/\/+$/, ""))
    .replaceAll("__AGENT_REPO__", release.repo)
    .replaceAll("__AGENT_VERSION__", release.version)
    .replaceAll("__AGENT_SHA256__", release.sha256)
    .replaceAll("__INFRA_AGENT_DIGESTS__", renderPinnedDigests(release.infraAgent));
}
