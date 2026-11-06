import type { AgentRelease } from "./agentRelease";
import { MESH_INSTALL_FUNCTIONS } from "./meshInstallScript.ts";
import {
  FIRECRACKER_HOST_PROVISIONER_B64,
  FIRECRACKER_HOST_PROVISIONER_SHA256,
  FIRECRACKER_RUNTIME_UNIT_B64,
  FIRECRACKER_RUNTIME_UNIT_SHA256,
} from "./provisionerFirecrackerHost.generated.ts";
import { CONTROLLER_UNIT_B64, CONTROLLER_UNIT_SHA256 } from "./controllerUnit.generated.ts";

const INSTALL_SCRIPT = String.raw`#!/usr/bin/env bash
set -euo pipefail

# --role picks which machine this is, in CONTEXT.md's terms: a Worker executes CI jobs and runs the
# Action Runner Agent; a Node runs deployed Apps and runs the Infra Agent. It is a flag on the
# script rather than a query parameter on the URL because the /install handler takes no request
# argument — one body, rendered from this deployment's own configuration, cacheable, and impossible
# to steer by crafting a request. worker-host is the third role: the root-level, once-per-machine
# Firecracker host provisioning that a Worker install assumes. controller is the fourth: one
# Profile's scale-set controller under systemd, on its own host or beside a Worker. Neither of the
# last two is a machine kind; they are setup steps on a host. Everything below the dispatch is the
# Worker path, unchanged.
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
        printf '❌ %s\n' '--role requires a value: worker, node, worker-host or controller' >&2
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
  printf '%s\n' '                  [--source <url|file:///path>] [--mesh] [--mesh-source <url|file:///path>] [--no-docker]'
  printf '%s\n' '       bash -s -- --role node --convex --credential-file <path> [--replace-hub-agent]'
  printf '%s\n' '                  [--source <url|file:///path>] [--mesh-source <url|file:///path>] [--no-docker]'
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

__MESH_INSTALL_FUNCTIONS__

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
    "$NODE_MESH_UNIT_REQUIRES" \
    "$NODE_MESH_UNIT_AFTER" \
    '[Service]' \
    "EnvironmentFile=$NODE_ENV_DIR/agent.env" \
    "Environment=HOME=$HOME" \
    "$NODE_MESH_SERVICE_ENV" \
    "$NODE_MESH_SERVICE_CONTROL" \
    "$NODE_MESH_SERVICE_GROUP" \
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

# True when a unit is running, starting or stopping, or enabled to start at boot. It reads the state
# systemctl prints rather than its exit status, so an unknown unit reads as not live.
node_unit_live() {
  command -v systemctl >/dev/null 2>&1 || return 1
  NODE_UNIT_STATE=$(systemctl is-active "$1" 2>/dev/null || true)
  case "$NODE_UNIT_STATE" in active|activating|reloading|refreshing|deactivating) return 0 ;; esac
  NODE_UNIT_STATE=$(systemctl is-enabled "$1" 2>/dev/null || true)
  case "$NODE_UNIT_STATE" in enabled|enabled-runtime) return 0 ;; esac
  return 1
}

# --convex installs the Infra Agent in connect-convex mode (ADR 0016): Convex is its control
# channel, and erainfra-mesh.service is required, so it installs only where that unit can run.
#
# The unit is erainfra-node.service, a name no deployed Node holds yet. portless-agent.service and
# erainfra-agent.service are both Hub-mode units a Node may already have (deploy/infra/agent.sh and
# this installer refuse a box holding both). A Convex unit under either name would be taken for a
# Hub agent, and would overwrite the unit a rollback to Hub mode re-enables. erainfra-node matches
# the credential file and state directory the unit uses. Once a Node holds these three names, they
# are frozen like the Hub-mode ones (CONTEXT.md rule 4).
node_convex_preflight() {
  if [ "$NODE_OS_NAME" != 'linux' ] || ! command -v systemctl >/dev/null 2>&1 ||
     ! $NODE_SUDO test -d /run/systemd/system; then
    node_fail '--convex installs systemd units, so it needs Linux with systemd. Elsewhere, start connect-convex by hand as "Set up a Node" in docs/infra-management.md describes.'
  fi
  # Read through sudo: the file may already be /etc/erainfra-node.credential, readable only by root.
  NODE_CREDENTIAL=$($NODE_SUDO cat "$NODE_CREDENTIAL_SOURCE" 2>/dev/null | tr -d '\r') ||
    node_fail "Cannot read the Node credential file $NODE_CREDENTIAL_SOURCE"
  [[ "$NODE_CREDENTIAL" =~ ^erainfra_node_[0-9a-f]{64}$ ]] ||
    node_fail "$NODE_CREDENTIAL_SOURCE does not hold one Node credential (erainfra_node_ and 64 hex characters). Write the output of 'erainfra nodes enroll <name>' to it."
  NODE_HUB_UNITS=''
  for node_unit in portless-agent erainfra-agent; do
    node_unit_live "$node_unit" || continue
    [ "$NODE_REPLACE_HUB" -eq 1 ] ||
      node_fail "$node_unit.service runs this Node in Hub mode, and one sidecar must never have two controllers. Re-run with --replace-hub-agent to stop and disable it first. Its unit file and agent.env stay, so Hub mode can come back."
    NODE_HUB_UNITS="$NODE_HUB_UNITS $node_unit"
  done
}

node_convex_install_service() {
  $NODE_SUDO install -d -m 700 -o root -g root /var/lib/erainfra-node || return 1
  # Written beside the target and renamed over it, so a failed write never truncates a credential
  # that is already in place, and the file is 0600 before the credential is in it.
  $NODE_SUDO install -m 600 -o root -g root /dev/null /etc/erainfra-node.credential.new || return 1
  printf '%s\n' "$NODE_CREDENTIAL" | $NODE_SUDO tee /etc/erainfra-node.credential.new >/dev/null || return 1
  $NODE_SUDO mv /etc/erainfra-node.credential.new /etc/erainfra-node.credential || return 1
  # UnsetEnvironment drops any Hub setting the service manager carries: connect-convex refuses to
  # start beside one.
  printf '%s\n' \
    '[Unit]' \
    'Description=EraInfra Infra Agent (connect-convex)' \
    'After=network-online.target docker.service erainfra-mesh.service' \
    'Wants=network-online.target' \
    'Requires=erainfra-mesh.service' \
    '[Service]' \
    'UnsetEnvironment=PORTLESS_HUB ERAINFRA_HUB PORTLESS_TOKEN ERAINFRA_TOKEN ERAINFRA_NODE_CREDENTIAL' \
    "Environment=HOME=$HOME" \
    "Environment=ERAINFRA_CONVEX_SITE=$NODE_SITE" \
    'Environment=ERAINFRA_MESH_SOCKET=/run/erainfra-mesh/control.sock' \
    'Environment=ERAINFRA_MESH_CONTROL_DIR=/var/lib/erainfra/mesh-control' \
    'SupplementaryGroups=erainfra-mesh' \
    "ExecStart=$NODE_BIN_DIR/portless-agent connect-convex --credential-file /etc/erainfra-node.credential --state-dir /var/lib/erainfra-node" \
    'Restart=always' \
    'RestartSec=3' \
    '[Install]' \
    'WantedBy=multi-user.target' |
    $NODE_SUDO tee /etc/systemd/system/erainfra-node.service >/dev/null || return 1
  $NODE_SUDO systemctl daemon-reload || return 1
  $NODE_SUDO systemctl enable erainfra-node >/dev/null 2>&1 || return 1
  # Restart, not start: on a re-install the old process would keep running the old bytes.
  $NODE_SUDO systemctl restart erainfra-node || return 1
  sleep 1
  $NODE_SUDO systemctl is-active --quiet erainfra-node || {
    $NODE_SUDO journalctl -u erainfra-node -n 8 --no-pager >&2 || true
    return 1
  }
  return 0
}

# Runs only past both checksum verifications, so bad bytes leave a Hub-mode agent running.
node_convex_install() {
  node_ensure_runtime
  for node_unit in $NODE_HUB_UNITS; do
    $NODE_SUDO systemctl disable --now "$node_unit" >/dev/null 2>&1 ||
      node_fail "Could not stop $node_unit.service. Nothing else was changed."
    node_log "Stopped and disabled $node_unit.service. Its unit file and agent.env stay for a rollback to Hub mode."
  done
  mkdir -p "$NODE_BIN_DIR"
  node_mesh_install
  chmod +x "$NODE_DOWNLOAD"
  mv "$NODE_DOWNLOAD" "$NODE_BIN_DIR/portless-agent"
  node_log "Installed $NODE_BIN_DIR/portless-agent."
  node_convex_install_service ||
    node_fail 'erainfra-node.service did not start; its last log lines are above. Fix it and re-run, or roll back to Hub mode: systemctl disable --now erainfra-node, then systemctl enable --now portless-agent'
  node_log "systemd service 'erainfra-node' is active: connect-convex to $NODE_SITE through erainfra-mesh.service."
  printf '%s\n' "   Logs:  journalctl -u erainfra-node -f   (expect 'published mesh endpoint', then 'applied mesh snapshot')"
  printf '%s\n' '   Check: erainfra nodes list   (this Node shows transport convex, online, MESH proven)'
  printf '%s\n' '   Relays or gateway routes: systemctl edit erainfra-node, add the Environment= lines, then systemctl restart erainfra-node'
  printf '%s\n' '   Roll back to Hub mode: systemctl disable --now erainfra-node, then systemctl enable --now portless-agent'
  printf '%s\n' '   (or re-run this installer with --token and --hub instead of --convex).'
  if [ "$NODE_CREDENTIAL_SOURCE" != '/etc/erainfra-node.credential' ]; then
    printf '%s\n' "   The credential is now in /etc/erainfra-node.credential. Delete $NODE_CREDENTIAL_SOURCE."
  fi
  exit 0
}

node_install() {
  NODE_TOKEN=""
  NODE_HUB=""
  NODE_NAME=""
  NODE_SOURCE=""
  NODE_MESH=0
  NODE_MESH_SOURCE=""
  NODE_MESH_UNIT=""
  NODE_MESH_SOCKET=""
  NODE_MESH_BIN=""
  NODE_MESH_UNIT_REQUIRES="# no erainfra-mesh dependency"
  NODE_MESH_UNIT_AFTER="# no erainfra-mesh ordering"
  NODE_MESH_SERVICE_ENV="# no erainfra-mesh socket"
  NODE_MESH_SERVICE_CONTROL="# no erainfra-mesh controller"
  NODE_MESH_SERVICE_GROUP="# no erainfra-mesh group"
  NODE_WANT_DOCKER=1
  NODE_CONVEX=0
  NODE_CREDENTIAL_SOURCE=""
  NODE_REPLACE_HUB=0
  NODE_HUB_UNITS=""
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --convex)
        NODE_CONVEX=1
        shift
        ;;
      --credential-file)
        [ "$#" -ge 2 ] || node_fail '--credential-file requires a path'
        NODE_CREDENTIAL_SOURCE=$2
        shift 2
        ;;
      --replace-hub-agent)
        NODE_REPLACE_HUB=1
        shift
        ;;
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
      --mesh)
        NODE_MESH=1
        shift
        ;;
      --mesh-source)
        [ "$#" -ge 2 ] || node_fail '--mesh-source requires a url or file:// path'
        NODE_MESH=1
        NODE_MESH_SOURCE=$2
        shift 2
        ;;
      --no-docker)
        NODE_WANT_DOCKER=0
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

  if [ "$NODE_CONVEX" -eq 1 ]; then
    # Hub and Convex modes are mutually exclusive, in the agent and here.
    [ -z "$NODE_TOKEN" ] && [ -z "$NODE_HUB" ] ||
      { node_usage >&2; node_fail '--convex takes no --token or --hub: a Convex Node reports to this deployment, not to a Hub. Drop them, or drop --convex for Hub mode.'; }
    [ -z "$NODE_NAME" ] ||
      node_fail '--convex takes no --name: a Convex Node is named when it is enrolled (erainfra nodes enroll <name>).'
    [ -n "$NODE_CREDENTIAL_SOURCE" ] ||
      { node_usage >&2; node_fail '--convex requires --credential-file <path>, a file holding the output of erainfra nodes enroll <name>.'; }
    NODE_MESH=1
  else
    [ -z "$NODE_CREDENTIAL_SOURCE" ] || node_fail '--credential-file is for --convex. Add --convex, or drop it for Hub mode.'
    [ "$NODE_REPLACE_HUB" -eq 0 ] || node_fail '--replace-hub-agent is for --convex.'
    [ -n "$NODE_TOKEN" ] || { node_usage >&2; node_fail 'A Hub enrollment token is required'; }
    [ -n "$NODE_HUB" ] || { node_usage >&2; node_fail 'The Hub URL is required, e.g. --hub wss://hub.example.com/agent'; }
  fi

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

  if [ "$NODE_MESH" -eq 1 ]; then
    NODE_MESH_EXPECTED=$(node_mesh_digest "$NODE_TARGET")
    [ -n "$NODE_MESH_EXPECTED" ] || node_fail "This EraInfra deployment pins no erainfra-mesh build for $NODE_TARGET. Deploy a backend whose AGENT_RELEASE pins all mesh targets; dumbpipe is not installed."
  fi
  if [ "$(id -u)" = '0' ]; then NODE_SUDO=''; else NODE_SUDO='sudo'; fi
  if [ "$NODE_CONVEX" -eq 1 ]; then
    node_convex_preflight
  elif node_unit_live erainfra-node; then
    node_fail 'erainfra-node.service runs this Node in Convex mode (connect-convex), and one sidecar must never have two controllers. To go back to Hub mode, stop it first: systemctl disable --now erainfra-node'
  fi
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
  node_mesh_prepare
  [ "$NODE_CONVEX" -eq 0 ] || node_convex_install

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
  node_mesh_install
  chmod +x "$NODE_DOWNLOAD"
  mv "$NODE_DOWNLOAD" "$NODE_BIN_DIR/portless-agent"
  node_log "Installed $NODE_BIN_DIR/portless-agent."

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
  if [ -n "$NODE_MESH_BIN" ]; then
    ERAINFRA_MESH_BIN="$NODE_MESH_BIN" PORTLESS_HUB="$NODE_HUB" PORTLESS_TOKEN="$NODE_TOKEN" nohup "$NODE_BIN_DIR/portless-agent" \
      connect --name "$NODE_MACHINE_NAME" \
      >>"$NODE_LOG_FILE" 2>&1 &
  else
    PORTLESS_HUB="$NODE_HUB" PORTLESS_TOKEN="$NODE_TOKEN" nohup "$NODE_BIN_DIR/portless-agent" \
      connect --name "$NODE_MACHINE_NAME" \
      >>"$NODE_LOG_FILE" 2>&1 &
  fi
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
# The site origin this script was served from: what a --convex Node's agent calls.
NODE_SITE='__ERAINFRA_SITE_URL__'

# --role worker-host turns a bare Linux box into a Firecracker microVM host in the one curl that
# fetched this script: the runtime binary comes out of the agent archive this deployment already
# pins — no second trust root — and deploy/provision-firecracker-host.sh travels embedded below,
# so nothing else is fetched from this deployment. Root, because the provisioner writes under
# /usr/local, /etc/runner-center and nftables; the Worker agent itself still installs
# unprivileged with --role worker afterwards.
worker_host_install() {
  WH_SITE='__ERAINFRA_SITE_URL__'
  WH_REPO='__AGENT_REPO__'
  WH_VERSION='__AGENT_VERSION__'
  WH_SHA256='__AGENT_SHA256__'

  wh_fail() {
    printf '❌ %s\n' "$1" >&2
    exit 1
  }
  wh_sha256() {
    if command -v shasum >/dev/null 2>&1; then
      shasum -a 256 "$1" | cut -d ' ' -f 1
    elif command -v sha256sum >/dev/null 2>&1; then
      sha256sum "$1" | cut -d ' ' -f 1
    else
      wh_fail 'A SHA-256 utility (shasum or sha256sum) is required'
    fi
  }
  wh_usage() {
    printf '%s\n' 'Usage: curl -fsSL <site>/install | sudo bash -s -- --role worker-host'
    printf '%s\n' '         [--pool-gib N] [--pool-dir PATH] [--worker-user NAME]'
    printf '%s\n' '         [--data-device DEV --meta-device DEV] [--uninstall]'
    printf '%s\n' ''
    printf '%s\n' 'Provisions this Linux host to run one ephemeral Firecracker microVM per CI job.'
    printf '%s\n' 'Storage defaults to a file-backed thin-pool (--pool-gib 200) under --pool-dir;'
    printf '%s\n' '--data-device/--meta-device use dedicated block devices instead and DESTROY'
    printf '%s\n' 'their contents. --uninstall reverses exactly what provisioning added.'
  }

  WH_POOL_GIB='200'
  WH_POOL_DIR=''
  WH_POOL_SET=0
  WH_WORKER_USER=''
  WH_DATA_DEVICE=''
  WH_META_DEVICE=''
  WH_UNINSTALL=0
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --pool-gib) [ "$#" -ge 2 ] || wh_fail '--pool-gib requires a value'; WH_POOL_GIB=$2; WH_POOL_SET=1; shift 2 ;;
      --pool-dir) [ "$#" -ge 2 ] || wh_fail '--pool-dir requires a value'; WH_POOL_DIR=$2; WH_POOL_SET=1; shift 2 ;;
      --worker-user) [ "$#" -ge 2 ] || wh_fail '--worker-user requires a value'; WH_WORKER_USER=$2; shift 2 ;;
      --data-device) [ "$#" -ge 2 ] || wh_fail '--data-device requires a value'; WH_DATA_DEVICE=$2; shift 2 ;;
      --meta-device) [ "$#" -ge 2 ] || wh_fail '--meta-device requires a value'; WH_META_DEVICE=$2; shift 2 ;;
      --uninstall) WH_UNINSTALL=1; shift ;;
      -h|--help) wh_usage; exit 0 ;;
      *) wh_usage >&2; wh_fail "Unknown worker-host option: $1" ;;
    esac
  done
  case "$WH_POOL_GIB" in
    ''|*[!0-9]*) wh_fail '--pool-gib must be a whole number of GiB' ;;
  esac
  [ "$WH_POOL_GIB" -ge 32 ] || wh_fail '--pool-gib needs at least 32 GiB; the provisioner refuses a smaller thin-pool'
  if [ -n "$WH_DATA_DEVICE" ] && [ -z "$WH_META_DEVICE" ]; then
    wh_fail '--data-device needs --meta-device: the thin-pool takes one device for data and one for metadata'
  fi
  if [ -n "$WH_META_DEVICE" ] && [ -z "$WH_DATA_DEVICE" ]; then
    wh_fail '--meta-device needs --data-device: the thin-pool takes one device for data and one for metadata'
  fi
  if [ -n "$WH_DATA_DEVICE" ] && [ "$WH_POOL_SET" -eq 1 ]; then
    wh_fail 'Choose one storage form: --data-device/--meta-device or --pool-gib/--pool-dir, not both'
  fi

  # The pin check precedes the root check on purpose: an unpinned deployment should refuse while
  # the operator is still unprivileged, not after they have escalated.
  if [ "$WH_UNINSTALL" -eq 0 ] && [ -z "$WH_SHA256" ]; then
    wh_fail 'This EraInfra deployment pins no agent release, so there is nothing to verify the runtime against; deploy a backend whose AGENT_RELEASE is pinned'
  fi
  [ "$(id -u)" -eq 0 ] ||
    wh_fail "worker-host provisioning must run as root: curl -fsSL $WH_SITE/install | sudo bash -s -- --role worker-host"
  [ "$(uname -s)" = 'Linux' ] || wh_fail 'Firecracker microVMs need Linux with /dev/kvm'
  for wh_tool in curl tar base64; do
    command -v "$wh_tool" >/dev/null 2>&1 || wh_fail "worker-host provisioning needs $wh_tool on PATH"
  done

  WH_TMP=$(mktemp -d)
  trap 'rm -rf "$WH_TMP"' EXIT INT TERM

  # The provisioner ships inside this script, base64 wrapped, because it is itself full of
  # heredocs no quoting scheme survives. The checksum was computed from the repository file at
  # render time, so a truncated download of THIS script fails here rather than half-provisioning.
  WH_PROVISIONER="$WH_TMP/provision-firecracker-host.sh"
  base64 -d > "$WH_PROVISIONER" <<'WH_PROVISIONER_B64'
__FIRECRACKER_PROVISIONER_B64__
WH_PROVISIONER_B64
  WH_PROVISIONER_SHA=$(wh_sha256 "$WH_PROVISIONER")
  [ "$WH_PROVISIONER_SHA" = '__FIRECRACKER_PROVISIONER_SHA256__' ] ||
    wh_fail 'The embedded provisioner failed its checksum; the download of this script was corrupted'
  chmod 0755 "$WH_PROVISIONER"

  # The runtime's systemd unit ships beside the provisioner in the repository, and the provisioner
  # refuses to install the runtime service without it — so it travels beside it here too.
  mkdir -p "$WH_TMP/systemd"
  base64 -d > "$WH_TMP/systemd/runner-center-runtime.service" <<'WH_RUNTIME_UNIT_B64'
__FIRECRACKER_RUNTIME_UNIT_B64__
WH_RUNTIME_UNIT_B64
  WH_UNIT_SHA=$(wh_sha256 "$WH_TMP/systemd/runner-center-runtime.service")
  [ "$WH_UNIT_SHA" = '__FIRECRACKER_RUNTIME_UNIT_SHA256__' ] ||
    wh_fail 'The embedded runtime unit failed its checksum; the download of this script was corrupted'

  if [ "$WH_UNINSTALL" -eq 1 ]; then
    bash "$WH_PROVISIONER" --uninstall
    exit 0
  fi

  case "$(uname -m)" in
    x86_64|amd64) WH_ARCH='x86_64' ;;
    aarch64|arm64) WH_ARCH='arm64' ;;
    *) wh_fail "This deployment publishes no Firecracker runtime for $(uname -m)" ;;
  esac

  WH_ASSET="erainfra-agent-$WH_VERSION.tar.gz"
  WH_ARCHIVE="$WH_TMP/$WH_ASSET"
  printf '✅ Downloading the EraInfra agent %s release for its Firecracker runtime.\n' "$WH_VERSION"
  curl -fsSL "https://github.com/$WH_REPO/releases/download/v$WH_VERSION/$WH_ASSET" -o "$WH_ARCHIVE" ||
    wh_fail "Could not download $WH_ASSET from release v$WH_VERSION of $WH_REPO"
  WH_ACTUAL=$(wh_sha256 "$WH_ARCHIVE")
  [ "$WH_ACTUAL" = "$WH_SHA256" ] ||
    wh_fail "Agent archive checksum verification failed: expected $WH_SHA256 but got $WH_ACTUAL. Nothing was installed."
  printf '✅ Verified the agent archive against the checksum pinned by this EraInfra deployment.\n'

  mkdir -p "$WH_TMP/staged"
  tar -xzf "$WH_ARCHIVE" -C "$WH_TMP/staged" --strip-components=1
  WH_RUNTIME="$WH_TMP/staged/runtime/linux-$WH_ARCH/runner-center-runtime"
  [ -f "$WH_RUNTIME" ] ||
    wh_fail "The pinned agent archive carries no Linux $WH_ARCH Firecracker runtime; releases before v0.2.0-rc.6 predate it"
  chmod 0755 "$WH_RUNTIME"

  # Whoever ran sudo is the Worker account unless told otherwise; root itself never is — the
  # whole point of the runner-center group is that the agent stays unprivileged.
  if [ -z "$WH_WORKER_USER" ]; then
    WH_WORKER_USER=$(printenv SUDO_USER || true)
  fi
  if [ "$WH_WORKER_USER" = 'root' ]; then
    WH_WORKER_USER=''
  fi

  set -- --runtime-binary "$WH_RUNTIME"
  if [ -n "$WH_DATA_DEVICE" ]; then
    set -- "$@" --data-device "$WH_DATA_DEVICE" --meta-device "$WH_META_DEVICE"
  else
    set -- "$@" --file-backed-pool "$WH_POOL_GIB"
    if [ -n "$WH_POOL_DIR" ]; then
      set -- "$@" --pool-dir "$WH_POOL_DIR"
    fi
  fi
  if [ -n "$WH_WORKER_USER" ]; then
    set -- "$@" --worker-user "$WH_WORKER_USER"
  else
    printf '⚠️  %s\n' 'No --worker-user and no sudo user to default to: no unprivileged account was added to the runner-center group.' >&2
  fi
  bash "$WH_PROVISIONER" "$@"

  printf '✅ %s\n' 'This host can now run one ephemeral Firecracker microVM per job.'
  if [ -n "$WH_WORKER_USER" ]; then
    printf '%s\n' "Next, as $WH_WORKER_USER (log out and back in first, so the runner-center group applies):"
  else
    printf '%s\n' 'Next, as the unprivileged Worker account:'
  fi
  printf '%s\n' "  curl -fsSL $WH_SITE/install | bash -s -- --token <registration token>"
  exit 0
}

# --role controller installs one Profile's scale-set controller as a systemd instance,
# runner-center-controller@<profile>, on a dedicated host or beside a Worker on the same machine.
# The binary is verified against the digest this deployment pins (ADR 0006), the unit travels
# embedded and checked like the worker-host files, and the Profile's configuration lands in a
# root-only env file whose secrets are paths, never values. --update moves every running instance
# on the host to the pinned release, keeping the old binary to roll back to.
#
# Without --controller-token-file, on a host that is already a Worker, the role installs a standby
# instead (ADR 0014): it signs in with the Worker's own machine credential and reads the Profile and
# GitHub credentials from the control plane, so the host holds no controller token and no GitHub key.
#
# Sharing a machine with a Worker is a supported shape, so this role owns only what it names:
# runner-center-controller*, its unit, its account, and the profiles/ and secrets/ trees. It
# creates the shared runner-center directories only when they are missing and never changes an
# existing one, and it leaves runner-center-runtime, the runner-center group, the Worker account
# and ~/.runner-center alone.
controller_install() {
  CTL_SITE='__ERAINFRA_SITE_URL__'
  CTL_REPO='__AGENT_REPO__'
  CTL_VERSION='__AGENT_VERSION__'
  CTL_LIB_DIR='/usr/local/lib/runner-center'
  CTL_BINARY="$CTL_LIB_DIR/runner-center-controller"
  CTL_ETC_DIR='/etc/runner-center'
  CTL_UNIT_PATH='/etc/systemd/system/runner-center-controller@.service'
  CTL_ACCOUNT='runner-center-controller'

  ctl_log() { printf '✅ %s\n' "$1"; }
  ctl_warn() { printf '⚠️  %s\n' "$1" >&2; }
  ctl_fail() {
    printf '❌ %s\n' "$1" >&2
    exit 1
  }
  ctl_sha256() {
    if command -v shasum >/dev/null 2>&1; then
      shasum -a 256 "$1" | cut -d ' ' -f 1
    elif command -v sha256sum >/dev/null 2>&1; then
      sha256sum "$1" | cut -d ' ' -f 1
    else
      ctl_fail 'A SHA-256 utility (shasum or sha256sum) is required'
    fi
  }
  # One arm per pinned target. A target that is not listed is refused: there would be nothing to
  # check the bytes against.
  ctl_pinned_digest() {
    case "$1" in
__CONTROLLER_DIGESTS__
      *) printf '' ;;
    esac
  }
  ctl_usage() {
    printf '%s\n' 'Usage: curl -fsSL <site>/install | sudo bash -s -- --role controller --profile NAME'
    printf '%s\n' '         [--worker-env-file PATH] [--cache-facts-url URL --cache-signing-key-file PATH]'
    printf '%s\n' '       curl -fsSL <site>/install | sudo bash -s -- --role controller --profile NAME'
    printf '%s\n' '         --github-config-url URL --executor docker|firecracker|tart|hyperv'
    printf '%s\n' '         --image-release REF@sha256:DIGEST --controller-token-file PATH'
    printf '%s\n' '         (--github-app-client-id ID --github-app-installation-id ID'
    printf '%s\n' '          --github-app-private-key-file PATH | --github-token-file PATH)'
    printf '%s\n' '         [--vcpus N] [--memory-mib N] [--warm-pool N] [--fit-policy balanced|cpu|network|io]'
    printf '%s\n' '         [--min-runners N] [--max-runners N] [--scale-set-name NAME] [--labels A,B]'
    printf '%s\n' '         [--runner-group NAME] [--worker-labels A,B] [--cache-facts-url URL --cache-signing-key-file PATH]'
    printf '%s\n' '         [--source <url|file:///path>] [--reconfigure] [--no-prompt]'
    printf '%s\n' '       curl -fsSL <site>/install | sudo bash -s -- --role controller --update [--source ...]'
    printf '%s\n' ''
    printf '%s\n' 'Installs the scale-set controller for one Profile as runner-center-controller@NAME,'
    printf '%s\n' 'on a dedicated host or beside a Worker. Secrets are given as files and copied to'
    printf '%s\n' '/etc/runner-center/secrets/NAME/; the env file /etc/runner-center/profiles/NAME.env'
    printf '%s\n' 'is kept on a rerun unless --reconfigure is given. --update moves every running'
    printf '%s\n' 'instance on this host to the release this deployment pins.'
    printf '%s\n' "Without --controller-token-file, on a Worker, it installs a standby that signs in with the Worker's"
    printf '%s\n' 'MACHINE_TOKEN (--worker-env-file, default ~SUDO_USER/.runner-center/agent/.env) and takes no other settings.'
  }
  # A flag's value, refused when it is missing rather than silently taking the next flag.
  ctl_take() {
    [ "$2" -ge 2 ] || ctl_fail "$1 requires a value"
  }
  ctl_get() { eval "printf '%s' \"\$$1\""; }

  CTL_PROFILE=''
  CTL_GITHUB_CONFIG_URL=''
  CTL_EXECUTOR=''
  CTL_IMAGE_RELEASE=''
  CTL_VCPUS=''
  CTL_MEMORY_MIB=''
  CTL_WARM_POOL=''
  CTL_FIT_POLICY=''
  CTL_MIN_RUNNERS=''
  CTL_MAX_RUNNERS=''
  CTL_SCALE_SET_NAME=''
  CTL_LABELS=''
  CTL_WORKER_LABELS=''
  CTL_RUNNER_GROUP=''
  CTL_APP_CLIENT_ID=''
  CTL_APP_INSTALLATION_ID=''
  CTL_APP_KEY_FILE=''
  CTL_GITHUB_TOKEN_FILE=''
  CTL_TOKEN_FILE=''
  CTL_CACHE_FACTS_URL=''
  CTL_CACHE_KEY_FILE=''
  CTL_WORKER_ENV_FILE=''
  CTL_SOURCE=''
  CTL_RECONFIGURE=0
  CTL_UPDATE=0
  CTL_PROMPT=1
  CTL_CONFIG_GIVEN=0
  CTL_SHAPE_GIVEN=''
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --github-config-url|--executor|--image-release|--vcpus|--memory-mib|--warm-pool|--fit-policy|--min-runners|--max-runners|--scale-set-name|--labels|--worker-labels|--runner-group|--github-app-*|--github-token-file)
        CTL_SHAPE_GIVEN="$CTL_SHAPE_GIVEN $1" ;;
    esac
    case "$1" in
      --profile) ctl_take "$1" "$#"; CTL_PROFILE=$2; shift 2 ;;
      --github-config-url) ctl_take "$1" "$#"; CTL_GITHUB_CONFIG_URL=$2; CTL_CONFIG_GIVEN=1; shift 2 ;;
      --executor) ctl_take "$1" "$#"; CTL_EXECUTOR=$2; CTL_CONFIG_GIVEN=1; shift 2 ;;
      --image-release) ctl_take "$1" "$#"; CTL_IMAGE_RELEASE=$2; CTL_CONFIG_GIVEN=1; shift 2 ;;
      --vcpus) ctl_take "$1" "$#"; CTL_VCPUS=$2; CTL_CONFIG_GIVEN=1; shift 2 ;;
      --memory-mib) ctl_take "$1" "$#"; CTL_MEMORY_MIB=$2; CTL_CONFIG_GIVEN=1; shift 2 ;;
      --warm-pool) ctl_take "$1" "$#"; CTL_WARM_POOL=$2; CTL_CONFIG_GIVEN=1; shift 2 ;;
      --fit-policy) ctl_take "$1" "$#"; CTL_FIT_POLICY=$2; CTL_CONFIG_GIVEN=1; shift 2 ;;
      --min-runners) ctl_take "$1" "$#"; CTL_MIN_RUNNERS=$2; CTL_CONFIG_GIVEN=1; shift 2 ;;
      --max-runners) ctl_take "$1" "$#"; CTL_MAX_RUNNERS=$2; CTL_CONFIG_GIVEN=1; shift 2 ;;
      --scale-set-name) ctl_take "$1" "$#"; CTL_SCALE_SET_NAME=$2; CTL_CONFIG_GIVEN=1; shift 2 ;;
      --labels) ctl_take "$1" "$#"; CTL_LABELS=$2; CTL_CONFIG_GIVEN=1; shift 2 ;;
      --worker-labels) ctl_take "$1" "$#"; CTL_WORKER_LABELS=$2; CTL_CONFIG_GIVEN=1; shift 2 ;;
      --runner-group) ctl_take "$1" "$#"; CTL_RUNNER_GROUP=$2; CTL_CONFIG_GIVEN=1; shift 2 ;;
      --github-app-client-id) ctl_take "$1" "$#"; CTL_APP_CLIENT_ID=$2; CTL_CONFIG_GIVEN=1; shift 2 ;;
      --github-app-installation-id) ctl_take "$1" "$#"; CTL_APP_INSTALLATION_ID=$2; CTL_CONFIG_GIVEN=1; shift 2 ;;
      --github-app-private-key-file) ctl_take "$1" "$#"; CTL_APP_KEY_FILE=$2; CTL_CONFIG_GIVEN=1; shift 2 ;;
      --github-token-file) ctl_take "$1" "$#"; CTL_GITHUB_TOKEN_FILE=$2; CTL_CONFIG_GIVEN=1; shift 2 ;;
      --controller-token-file) ctl_take "$1" "$#"; CTL_TOKEN_FILE=$2; CTL_CONFIG_GIVEN=1; shift 2 ;;
      --cache-facts-url) ctl_take "$1" "$#"; CTL_CACHE_FACTS_URL=$2; CTL_CONFIG_GIVEN=1; shift 2 ;;
      --cache-signing-key-file) ctl_take "$1" "$#"; CTL_CACHE_KEY_FILE=$2; CTL_CONFIG_GIVEN=1; shift 2 ;;
      --worker-env-file) ctl_take "$1" "$#"; CTL_WORKER_ENV_FILE=$2; shift 2 ;;
      --source) ctl_take "$1" "$#"; CTL_SOURCE=$2; shift 2 ;;
      --reconfigure) CTL_RECONFIGURE=1; shift ;;
      --update) CTL_UPDATE=1; shift ;;
      --no-prompt) CTL_PROMPT=0; shift ;;
      -h|--help) ctl_usage; exit 0 ;;
      *) ctl_usage >&2; ctl_fail "Unknown controller option: $1" ;;
    esac
  done

  if [ "$CTL_UPDATE" -eq 1 ]; then
    if [ -n "$CTL_PROFILE" ] || [ "$CTL_CONFIG_GIVEN" -eq 1 ] || [ "$CTL_RECONFIGURE" -eq 1 ] ||
      [ -n "$CTL_WORKER_ENV_FILE" ]; then
      ctl_fail '--update moves every controller on this host to the pinned release and takes no Profile settings; change a Profile with --profile NAME --reconfigure instead'
    fi
  fi

  # A standby takes both the Profile and GitHub credentials from Convex. Refuse these flags even
  # when their values are empty or there is no Worker credential, so they cannot turn into local
  # settings by accident. Dedicated-host settings require an explicit controller token file.
  if [ -z "$CTL_TOKEN_FILE" ] && [ -n "$CTL_SHAPE_GIVEN" ]; then
    ctl_fail "A Worker's standby reads the Profile and GitHub credentials from the control plane. Remove$CTL_SHAPE_GIVEN, or add --controller-token-file to install a dedicated controller host that takes them."
  fi

  # Every value below ends up in an EnvironmentFile, which systemd parses with its own quoting and
  # specifier rules. A conservative charset keeps a value from meaning anything but itself there,
  # and refusing before anything is written means a typo never leaves half a Profile behind.
  ctl_plain() {
    [[ "$2" =~ ^[A-Za-z0-9._:/@+=,-]*$ ]] ||
      ctl_fail "$1 may hold only letters, digits and . _ : / @ + = , - (no spaces, quotes or \$): $2"
  }
  ctl_integer() {
    [ -z "$2" ] || [[ "$2" =~ ^[0-9]+$ ]] || ctl_fail "$1 must be a whole number: $2"
  }
  ctl_absolute() {
    [ -z "$2" ] || [[ "$2" =~ ^/ ]] || ctl_fail "$1 must be an absolute path: $2"
  }
  ctl_validate() {
    if [ -n "$CTL_PROFILE" ]; then
      # The rules apps/controller/internal/config/profilename.go enforces, checked here so a bad
      # name is refused before it becomes a unit instance and a file name.
      if [ "$(printf '%s' "$CTL_PROFILE" | wc -c | tr -d ' ')" -gt 45 ] ||
        ! [[ "$CTL_PROFILE" =~ ^[a-z][a-z0-9-]*[a-z0-9]$ ]] ||
        [[ "$CTL_PROFILE" == *--* ]]; then
        ctl_fail "Profile name $CTL_PROFILE must be lowercase letters, digits and single hyphens, start with a letter, end with a letter or digit, and be at most 45 characters"
      fi
    fi
    case "$CTL_EXECUTOR" in
      ''|docker|firecracker|tart|hyperv) ;;
      *) ctl_fail "--executor must be docker, firecracker, tart or hyperv: $CTL_EXECUTOR" ;;
    esac
    if [ -n "$CTL_IMAGE_RELEASE" ] && ! [[ "$CTL_IMAGE_RELEASE" =~ @sha256:[0-9a-f]{64}$ ]]; then
      ctl_fail "--image-release must be immutable and end in @sha256:<64 hex characters>: $CTL_IMAGE_RELEASE"
    fi
    case "$CTL_FIT_POLICY" in
      ''|balanced|cpu|network|io) ;;
      *) ctl_fail "--fit-policy must be balanced, cpu, network or io: $CTL_FIT_POLICY" ;;
    esac
    if [ -n "$CTL_GITHUB_CONFIG_URL" ] && ! [[ "$CTL_GITHUB_CONFIG_URL" =~ ^https?://[^/]+/.+ ]]; then
      ctl_fail "--github-config-url must name a repository, organization or enterprise URL: $CTL_GITHUB_CONFIG_URL"
    fi
    ctl_integer --vcpus "$CTL_VCPUS"
    ctl_integer --memory-mib "$CTL_MEMORY_MIB"
    ctl_integer --warm-pool "$CTL_WARM_POOL"
    ctl_integer --min-runners "$CTL_MIN_RUNNERS"
    ctl_integer --max-runners "$CTL_MAX_RUNNERS"
    ctl_integer --github-app-installation-id "$CTL_APP_INSTALLATION_ID"
    ctl_plain --github-config-url "$CTL_GITHUB_CONFIG_URL"
    ctl_plain --image-release "$CTL_IMAGE_RELEASE"
    ctl_plain --scale-set-name "$CTL_SCALE_SET_NAME"
    ctl_plain --labels "$CTL_LABELS"
    ctl_plain --worker-labels "$CTL_WORKER_LABELS"
    ctl_plain --runner-group "$CTL_RUNNER_GROUP"
    ctl_plain --github-app-client-id "$CTL_APP_CLIENT_ID"
    ctl_plain --cache-facts-url "$CTL_CACHE_FACTS_URL"
    ctl_absolute --controller-token-file "$CTL_TOKEN_FILE"
    ctl_absolute --github-app-private-key-file "$CTL_APP_KEY_FILE"
    ctl_absolute --github-token-file "$CTL_GITHUB_TOKEN_FILE"
    ctl_absolute --cache-signing-key-file "$CTL_CACHE_KEY_FILE"
    ctl_absolute --worker-env-file "$CTL_WORKER_ENV_FILE"
    if [ -n "$CTL_GITHUB_TOKEN_FILE" ] &&
      { [ -n "$CTL_APP_CLIENT_ID" ] || [ -n "$CTL_APP_INSTALLATION_ID" ] || [ -n "$CTL_APP_KEY_FILE" ]; }; then
      ctl_fail 'Give GitHub App credentials or --github-token-file, not both'
    fi
    if { [ -n "$CTL_CACHE_FACTS_URL" ] && [ -z "$CTL_CACHE_KEY_FILE" ]; } ||
      { [ -z "$CTL_CACHE_FACTS_URL" ] && [ -n "$CTL_CACHE_KEY_FILE" ]; }; then
      ctl_fail '--cache-facts-url and --cache-signing-key-file go together'
    fi
  }
  ctl_validate

  # The pin check precedes the root check on purpose: an unpinned deployment should refuse while
  # the operator is still unprivileged, not after they have escalated.
  [ "$(uname -s)" = 'Linux' ] || ctl_fail 'The controller role installs a systemd unit, so it needs Linux'
  case "$(uname -m)" in
    x86_64|amd64) CTL_TARGET='linux-x86_64' ;;
    aarch64|arm64) CTL_TARGET='linux-arm64' ;;
    *) ctl_fail "This deployment publishes no controller for $(uname -m)" ;;
  esac
  CTL_ASSET="runner-center-controller-$CTL_TARGET"
  CTL_EXPECTED_SHA=$(ctl_pinned_digest "$CTL_TARGET")
  [ -n "$CTL_EXPECTED_SHA" ] ||
    ctl_fail "This EraInfra deployment pins no controller build for $CTL_TARGET, so there is nothing to verify the download against. Deploy a backend whose AGENT_RELEASE pins a release that publishes it."

  if [ "$(id -u)" = '0' ]; then
    CTL_SUDO=''
  else
    command -v sudo >/dev/null 2>&1 ||
      ctl_fail "The controller role must run as root: curl -fsSL $CTL_SITE/install | sudo bash -s -- --role controller"
    CTL_SUDO='sudo'
  fi
  $CTL_SUDO test -d /run/systemd/system ||
    ctl_fail 'The controller role needs systemd as the init system; run runner-center-controller under your own supervisor instead (README, "Run a Profile controller")'

  CTL_TMP=$(mktemp -d)
  trap 'rm -rf "$CTL_TMP"' EXIT INT TERM

  # The unit ships inside this script, checked like the worker-host files, so a truncated download
  # of the script fails here rather than writing half a unit.
  base64 -d > "$CTL_TMP/runner-center-controller@.service" <<'CTL_UNIT_B64'
__CONTROLLER_UNIT_B64__
CTL_UNIT_B64
  [ "$(ctl_sha256 "$CTL_TMP/runner-center-controller@.service")" = '__CONTROLLER_UNIT_SHA256__' ] ||
    ctl_fail 'The embedded controller unit failed its checksum; the download of this script was corrupted'

  # The digest of what is installed now, or nothing. Read through $CTL_SUDO like every other
  # privileged path, so a root-only file and the test suite's redirection both work.
  ctl_installed_sha() {
    if $CTL_SUDO test -f "$CTL_BINARY"; then
      $CTL_SUDO cp "$CTL_BINARY" "$CTL_TMP/installed"
      ctl_sha256 "$CTL_TMP/installed"
    fi
  }

  # The bytes may come from anywhere. --source moves the payload's origin, a mirror or a file on
  # local disk, and never the script's: this script and the digest in it arrived from this
  # deployment over TLS, which is what makes an untrusted byte source safe to read from.
  ctl_fetch_verified() {
    CTL_URL="https://github.com/$CTL_REPO/releases/download/v$CTL_VERSION/$CTL_ASSET"
    CTL_ORIGIN='the release this deployment pins'
    if [ -n "$CTL_SOURCE" ]; then
      case "$CTL_SOURCE" in
        */) CTL_URL="$CTL_SOURCE$CTL_ASSET" ;;
        *) CTL_URL=$CTL_SOURCE ;;
      esac
      CTL_ORIGIN=$CTL_URL
    fi
    ctl_log "Fetching the controller $CTL_VERSION for $CTL_TARGET from $CTL_ORIGIN."
    CTL_DOWNLOAD="$CTL_TMP/$CTL_ASSET"
    case "$CTL_URL" in
      file://*)
        cp "$(printf '%s' "$CTL_URL" | sed 's|^file://||')" "$CTL_DOWNLOAD" ||
          ctl_fail "Could not read the controller from $CTL_URL"
        ;;
      /*) cp "$CTL_URL" "$CTL_DOWNLOAD" || ctl_fail "Could not read the controller from $CTL_URL" ;;
      *) curl -fsSL "$CTL_URL" -o "$CTL_DOWNLOAD" || ctl_fail "Could not download the controller from $CTL_URL" ;;
    esac
    CTL_ACTUAL_SHA=$(ctl_sha256 "$CTL_DOWNLOAD")
    if [ "$CTL_ACTUAL_SHA" != "$CTL_EXPECTED_SHA" ]; then
      rm -f "$CTL_DOWNLOAD"
      ctl_fail "Controller checksum verification failed: expected $CTL_EXPECTED_SHA but got $CTL_ACTUAL_SHA. Nothing was installed."
    fi
    ctl_log "Verified $CTL_ASSET against the checksum pinned by this EraInfra deployment."
  }

  # Install to a temporary name in the same directory, then rename: a running instance that
  # restarts mid-install execs either the old file or the new one, never a partial copy.
  ctl_swap_binary() {
    $CTL_SUDO install -m 0755 "$1" "$CTL_BINARY.new" || return $?
    $CTL_SUDO mv -f "$CTL_BINARY.new" "$CTL_BINARY"
  }
  ctl_mkdir() {
    $CTL_SUDO test -d "$1" || $CTL_SUDO install -d -m "$2" "$1"
  }

  if [ "$CTL_UPDATE" -eq 1 ]; then
    CTL_CURRENT_SHA=$(ctl_installed_sha)
    [ -n "$CTL_CURRENT_SHA" ] ||
      ctl_fail "No controller is installed at $CTL_BINARY; install a Profile first with --role controller --profile NAME"
    ctl_fetch_verified
    if [ "$CTL_CURRENT_SHA" = "$CTL_EXPECTED_SHA" ]; then
      ctl_log "$CTL_BINARY is already the pinned controller $CTL_VERSION; nothing changed."
      exit 0
    fi
    CTL_OLD_VERSION=$($CTL_SUDO "$CTL_BINARY" version 2>/dev/null | awk 'NR == 1 { print $2 }' || true)
    [[ "$CTL_OLD_VERSION" =~ ^[0-9A-Za-z.+-]+$ ]] || CTL_OLD_VERSION='unknown'
    CTL_BACKUP="$CTL_BINARY.bak-$CTL_OLD_VERSION"
    # Only the instances running now. Restarting a pattern would also start a stopped instance,
    # which for a retired Profile re-registers a scale set nobody wants.
    CTL_ACTIVE_ROWS=$($CTL_SUDO systemctl list-units --type=service --state=active --plain --no-legend \
      'runner-center-controller@*') || ctl_fail 'Could not list active controllers; nothing was changed.'
    CTL_ACTIVE=$(printf '%s\n' "$CTL_ACTIVE_ROWS" |
      awk '$1 ~ /^runner-center-controller@[a-z0-9-]+\.service$/ { print $1 }')
    $CTL_SUDO cp -p "$CTL_BINARY" "$CTL_BACKUP"
    ctl_log "Kept the previous controller ($CTL_OLD_VERSION) at $CTL_BACKUP."
    CTL_HAD_UNIT=0
    CTL_UNIT_BACKUP='none (no unit existed)'
    if $CTL_SUDO test -f "$CTL_UNIT_PATH"; then
      # Keep this beside the binary backup, not under the EXIT-cleaned temporary directory:
      # a failed unit restore must leave its source available for manual recovery.
      CTL_UNIT_BACKUP="$CTL_UNIT_PATH.bak-$CTL_OLD_VERSION"
      $CTL_SUDO cp -p "$CTL_UNIT_PATH" "$CTL_UNIT_BACKUP"
      CTL_HAD_UNIT=1
    fi

    # The whole replacement, including reload and restart, is guarded. set -e used to exit on
    # a failed restart before the health-check rollback could run. A function used as an if
    # condition also disables errexit inside it, so every fallible step must return explicitly.
    # Keep command stderr on the terminal, and name the command and its exit status in the final
    # report so a failed recovery cannot hide the original update failure.
    ctl_update_step() {
      ctl_step_label=$1
      shift
      if "$@"; then
        return 0
      else
        ctl_step_status=$?
        CTL_STEP_ERROR="$ctl_step_label failed (exit $ctl_step_status)"
        return 1
      fi
    }
    ctl_apply_update() {
      ctl_update_step 'install controller binary' ctl_swap_binary "$CTL_DOWNLOAD" || return 1
      ctl_update_step 'install controller unit' $CTL_SUDO install -m 0644 \
        "$CTL_TMP/runner-center-controller@.service" "$CTL_UNIT_PATH" || return 1
      ctl_update_step 'daemon-reload' $CTL_SUDO systemctl daemon-reload || return 1
      for ctl_unit in $CTL_ACTIVE; do
        ctl_update_step "restart $ctl_unit" $CTL_SUDO systemctl restart "$ctl_unit" || return 1
      done
      if [ -n "$CTL_ACTIVE" ]; then
        ctl_update_step 'wait for controllers' sleep 3 || return 1
      fi
      CTL_HEALTH_ERRORS=''
      for ctl_unit in $CTL_ACTIVE; do
        if ! ctl_update_step "health check $ctl_unit" $CTL_SUDO systemctl is-active --quiet "$ctl_unit"; then
          CTL_HEALTH_ERRORS="$CTL_HEALTH_ERRORS$CTL_STEP_ERROR; "
          $CTL_SUDO journalctl -u "$ctl_unit" -n 20 --no-pager >&2 || true
        fi
      done
      if [ -n "$CTL_HEALTH_ERRORS" ]; then
        CTL_STEP_ERROR=$CTL_HEALTH_ERRORS
        return 1
      fi
      return 0
    }
    if ctl_apply_update; then
      ctl_log "Installed the controller $CTL_VERSION at $CTL_BINARY."
      if [ -z "$CTL_ACTIVE" ]; then
        ctl_log 'No controller instance is running on this host; the next one to start runs the new binary.'
      else
        for ctl_unit in $CTL_ACTIVE; do ctl_log "$ctl_unit restarted on $CTL_VERSION."; done
      fi
      exit 0
    fi
    CTL_UPDATE_ERROR=$CTL_STEP_ERROR

    # Recovery is best effort across all of the saved instances, even if the first restart fails.
    # Never enumerate units again: stopped/retired instances must remain stopped. Do not restart
    # anything if either file could not be restored, since that could execute the rejected build.
    CTL_ROLLBACK_ERRORS=''
    ctl_rollback_step() {
      if ctl_update_step "$@"; then
        return 0
      fi
      CTL_ROLLBACK_ERRORS="$CTL_ROLLBACK_ERRORS$CTL_STEP_ERROR; "
      return 1
    }
    CTL_FILES_RESTORED=1
    ctl_rollback_step 'restore controller binary' ctl_swap_binary "$CTL_BACKUP" || CTL_FILES_RESTORED=0
    if [ "$CTL_HAD_UNIT" -eq 1 ]; then
      ctl_rollback_step 'restore controller unit' $CTL_SUDO cp -p \
        "$CTL_UNIT_BACKUP" "$CTL_UNIT_PATH" || CTL_FILES_RESTORED=0
    else
      ctl_rollback_step 'remove newly installed controller unit' $CTL_SUDO rm -f \
        "$CTL_UNIT_PATH" || CTL_FILES_RESTORED=0
    fi
    ctl_rollback_step 'rollback daemon-reload' $CTL_SUDO systemctl daemon-reload || true
    if [ "$CTL_FILES_RESTORED" -eq 1 ]; then
      for ctl_unit in $CTL_ACTIVE; do
        ctl_rollback_step "rollback restart $ctl_unit" $CTL_SUDO systemctl restart "$ctl_unit" || true
      done
      if [ -n "$CTL_ACTIVE" ]; then
        ctl_rollback_step 'wait for restored controllers' sleep 3 || true
      fi
      for ctl_unit in $CTL_ACTIVE; do
        if ! ctl_rollback_step "rollback health check $ctl_unit" $CTL_SUDO systemctl is-active --quiet "$ctl_unit"; then
          $CTL_SUDO journalctl -u "$ctl_unit" -n 20 --no-pager >&2 || true
        fi
      done
      CTL_RESTORED="Rolled back to $CTL_OLD_VERSION (binary and unit)."
    else
      CTL_RESTORED='Could not restore both files; skipped controller restarts to avoid running the rejected build.'
    fi
    if [ -n "$CTL_ROLLBACK_ERRORS" ]; then
      ctl_fail "Update to $CTL_VERSION failed: $CTL_UPDATE_ERROR. $CTL_RESTORED Rollback recovery failed: $CTL_ROLLBACK_ERRORS Manual recovery required; binary backup: $CTL_BACKUP; unit backup: $CTL_UNIT_BACKUP."
    fi
    ctl_fail "Update to $CTL_VERSION failed: $CTL_UPDATE_ERROR. $CTL_RESTORED Restarted and checked the previously active instances."
  fi

  # A fresh Profile, or a rerun for one this host already serves.
  CTL_TTY=0
  # --no-prompt is for automation that runs under a pseudo-terminal (cloud-init, Ansible), where a
  # prompt would hang instead of failing with the list of what is missing.
  if [ "$CTL_PROMPT" -eq 1 ] && ( exec 3</dev/tty ) 2>/dev/null; then CTL_TTY=1; fi
  # Prompt on the terminal, not stdin: stdin is this script, piped from curl.
  ctl_prompt() {
    printf '%s: ' "$2" >/dev/tty
    ctl_answer=''
    IFS= read -r ctl_answer </dev/tty || ctl_answer=''
    printf -v "$1" '%s' "$ctl_answer"
  }
  CTL_MISSING=''
  ctl_need() {
    if [ -z "$(ctl_get "$1")" ] && [ "$CTL_TTY" -eq 1 ]; then ctl_prompt "$1" "$3"; fi
    [ -n "$(ctl_get "$1")" ] || CTL_MISSING="$CTL_MISSING $2"
  }
  ctl_need CTL_PROFILE --profile 'Profile name (for example erainfra-4vcpu-ubuntu-2404)'
  ctl_validate

  CTL_ENV_FILE="$CTL_ETC_DIR/profiles/$CTL_PROFILE.env"
  CTL_SECRETS_DIR="$CTL_ETC_DIR/secrets/$CTL_PROFILE"
  CTL_MACHINE_TOKEN_PATH="$CTL_SECRETS_DIR/machine-token"
  CTL_UNIT="runner-center-controller@$CTL_PROFILE"

  # Without a Profile there is no env file to keep, so every setting counts as missing and the
  # refusal below lists them all at once.
  CTL_WRITE_CONFIG=1
  if [ -n "$CTL_PROFILE" ] && $CTL_SUDO test -f "$CTL_ENV_FILE" && [ "$CTL_RECONFIGURE" -eq 0 ]; then
    CTL_WRITE_CONFIG=0
    [ "$CTL_CONFIG_GIVEN" -eq 0 ] ||
      ctl_warn "Kept the existing $CTL_ENV_FILE and ignored the settings given; rerun with --reconfigure to replace it."
  fi

  # The Worker's machine credential, from the env file the Worker installer wrote in its account's
  # ~/.runner-center. Under sudo that account is SUDO_USER; root itself never runs a Worker. A
  # default file that is not there only means this host is not a Worker, but a path the operator
  # named has to hold a token. The value stays in a variable and is never printed.
  CTL_MACHINE_TOKEN=''
  CTL_WORKER_ENV=''
  ctl_find_worker_token() {
    CTL_WORKER_ENV=$CTL_WORKER_ENV_FILE
    if [ -n "$CTL_WORKER_ENV" ]; then
      $CTL_SUDO test -r "$CTL_WORKER_ENV" || ctl_fail "Cannot read the Worker env file $CTL_WORKER_ENV"
    else
      ctl_sudo_user=$(printenv SUDO_USER || true)
      if [ -z "$ctl_sudo_user" ] || [ "$ctl_sudo_user" = 'root' ]; then return 0; fi
      ctl_worker_home=$(getent passwd "$ctl_sudo_user" 2>/dev/null | cut -d : -f 6 || true)
      if [ -z "$ctl_worker_home" ]; then return 0; fi
      CTL_WORKER_ENV="$ctl_worker_home/.runner-center/agent/.env"
      $CTL_SUDO test -f "$CTL_WORKER_ENV" || return 0
    fi
    $CTL_SUDO test -r "$CTL_WORKER_ENV" || ctl_fail "Cannot read the Worker env file $CTL_WORKER_ENV"
    if ! $CTL_SUDO grep -q '^MACHINE_TOKEN=' "$CTL_WORKER_ENV"; then
      [ -z "$CTL_WORKER_ENV_FILE" ] ||
        ctl_fail "$CTL_WORKER_ENV holds no MACHINE_TOKEN line; install and register the Worker first"
      return 0
    fi
    CTL_MACHINE_TOKEN=$($CTL_SUDO sed -n 's/^MACHINE_TOKEN=//p' "$CTL_WORKER_ENV") ||
      ctl_fail "Cannot read the Worker env file $CTL_WORKER_ENV"
    # The rule apps/action-runner-agent/config.ts enforces, so a value the Worker itself would
    # refuse never becomes the controller's credential.
    if ! [[ "$CTL_MACHINE_TOKEN" =~ ^[0-9a-fA-F]{32}$ ]]; then
      CTL_MACHINE_TOKEN=''
      ctl_fail "The MACHINE_TOKEN in $CTL_WORKER_ENV is not the 32 hex characters a registered Worker holds; nothing was written"
    fi
  }

  # One setting from a kept env file, under either of its names (docs/runbooks/rename-phase-2.md,
  # section 1): ERAINFRA_<NAME> wins over RC_<NAME>, an empty value counts as unset, and the two
  # set to different values stop the install naming both, never printing either value. The last
  # assignment of a name wins, as it does for systemd's EnvironmentFile=. This installer still
  # writes only RC_ names; this is how a rerun keeps working on an env file an operator has
  # started moving to the new names. Sets CTL_ENV_NAME and CTL_ENV_VALUE.
  ctl_env_file_value() { # ctl_env_file_value SUFFIX
    ctl_new=$($CTL_SUDO sed -n "s/^ERAINFRA_$1=//p" "$CTL_ENV_FILE" | tail -n 1) ||
      ctl_fail "Cannot read $CTL_ENV_FILE"
    ctl_old=$($CTL_SUDO sed -n "s/^RC_$1=//p" "$CTL_ENV_FILE" | tail -n 1) ||
      ctl_fail "Cannot read $CTL_ENV_FILE"
    if [ -n "$ctl_new" ] && [ -n "$ctl_old" ] && [ "$ctl_new" != "$ctl_old" ]; then
      ctl_fail "ERAINFRA_$1 and RC_$1 in $CTL_ENV_FILE are both set, to different values; remove one, or give both the same value"
    fi
    if [ -n "$ctl_new" ]; then
      CTL_ENV_NAME="ERAINFRA_$1"
      CTL_ENV_VALUE=$ctl_new
    else
      CTL_ENV_NAME="RC_$1"
      CTL_ENV_VALUE=$ctl_old
    fi
  }

  # Which controller this is. A controller token makes it a dedicated host, exactly as before; with
  # no token, a Worker's credential makes it a standby. A kept env file already says which it is,
  # and for a standby the rerun refreshes the token copy, because a Worker that re-registers gets a
  # new token and the old copy stops working.
  CTL_STANDBY=0
  CTL_REFRESH_TOKEN=0
  if [ "$CTL_WRITE_CONFIG" -eq 1 ]; then
    if [ -z "$CTL_TOKEN_FILE" ]; then
      ctl_find_worker_token
      [ -z "$CTL_MACHINE_TOKEN" ] || CTL_STANDBY=1
    elif [ -n "$CTL_WORKER_ENV_FILE" ]; then
      ctl_warn 'Ignored --worker-env-file: with --controller-token-file this is a dedicated controller host, which signs in with the controller token.'
    fi
  elif $CTL_SUDO grep -Eq '^(ERAINFRA|RC)_MACHINE_TOKEN_FILE=' "$CTL_ENV_FILE"; then
    CTL_STANDBY=1
    ctl_env_file_value MACHINE_TOKEN_FILE
    CTL_MACHINE_TOKEN_PATH=$CTL_ENV_VALUE
    [ -n "$CTL_MACHINE_TOKEN_PATH" ] || ctl_fail "$CTL_ENV_NAME in $CTL_ENV_FILE is empty"
    ctl_absolute "$CTL_ENV_NAME" "$CTL_MACHINE_TOKEN_PATH"
    ctl_find_worker_token
    [ -z "$CTL_MACHINE_TOKEN" ] || CTL_REFRESH_TOKEN=1
  fi

  if [ "$CTL_WRITE_CONFIG" -eq 1 ] && [ "$CTL_STANDBY" -eq 1 ]; then
    [ -z "$CTL_MISSING" ] || { ctl_usage >&2; ctl_fail "Missing:$CTL_MISSING"; }
    [ -z "$CTL_CACHE_KEY_FILE" ] || $CTL_SUDO test -r "$CTL_CACHE_KEY_FILE" ||
      ctl_fail "Cannot read $CTL_CACHE_KEY_FILE"
  elif [ "$CTL_WRITE_CONFIG" -eq 1 ]; then
    ctl_need CTL_GITHUB_CONFIG_URL --github-config-url 'GitHub repository, organization or enterprise URL'
    ctl_need CTL_EXECUTOR --executor 'Executor (docker, firecracker, tart or hyperv)'
    ctl_need CTL_IMAGE_RELEASE --image-release 'Image Release (ending in @sha256:<digest>)'
    ctl_need CTL_TOKEN_FILE --controller-token-file 'Path to a file holding the controller token'
    if [ -z "$CTL_GITHUB_TOKEN_FILE" ] && [ -z "$CTL_APP_CLIENT_ID" ] &&
      [ -z "$CTL_APP_INSTALLATION_ID" ] && [ -z "$CTL_APP_KEY_FILE" ] && [ "$CTL_TTY" -eq 1 ]; then
      ctl_prompt CTL_GITHUB_TOKEN_FILE 'Path to a GitHub token file (leave empty to use a GitHub App)'
    fi
    if [ -z "$CTL_GITHUB_TOKEN_FILE" ]; then
      if [ "$CTL_TTY" -eq 0 ] && [ -z "$CTL_APP_CLIENT_ID" ] && [ -z "$CTL_APP_INSTALLATION_ID" ] &&
        [ -z "$CTL_APP_KEY_FILE" ]; then
        CTL_MISSING="$CTL_MISSING --github-app-client-id/--github-app-installation-id/--github-app-private-key-file or --github-token-file"
      else
        ctl_need CTL_APP_CLIENT_ID --github-app-client-id 'GitHub App client ID'
        ctl_need CTL_APP_INSTALLATION_ID --github-app-installation-id 'GitHub App installation ID'
        ctl_need CTL_APP_KEY_FILE --github-app-private-key-file 'Path to the GitHub App private key'
      fi
    fi
    [ -z "$CTL_MISSING" ] || { ctl_usage >&2; ctl_fail "Missing:$CTL_MISSING"; }
    ctl_validate
    for ctl_source in "$CTL_TOKEN_FILE" "$CTL_APP_KEY_FILE" "$CTL_GITHUB_TOKEN_FILE" "$CTL_CACHE_KEY_FILE"; do
      [ -z "$ctl_source" ] || $CTL_SUDO test -r "$ctl_source" || ctl_fail "Cannot read $ctl_source"
    done
  fi

  # Nothing on this machine has changed yet. Past the verification, it does.
  if [ "$(ctl_installed_sha)" = "$CTL_EXPECTED_SHA" ]; then
    ctl_log "$CTL_BINARY is already the pinned controller $CTL_VERSION."
  else
    ctl_fetch_verified
    ctl_mkdir "$CTL_LIB_DIR" 0755
    ctl_swap_binary "$CTL_DOWNLOAD"
    ctl_log "Installed the controller $CTL_VERSION at $CTL_BINARY."
  fi
  $CTL_SUDO install -m 0644 "$CTL_TMP/runner-center-controller@.service" "$CTL_UNIT_PATH"

  if ! getent passwd "$CTL_ACCOUNT" >/dev/null 2>&1; then
    CTL_NOLOGIN=/usr/sbin/nologin
    [ -x "$CTL_NOLOGIN" ] || CTL_NOLOGIN=/sbin/nologin
    $CTL_SUDO useradd --system --user-group --no-create-home --home-dir /nonexistent \
      --shell "$CTL_NOLOGIN" "$CTL_ACCOUNT" || ctl_fail "Could not create the $CTL_ACCOUNT account"
    ctl_log "Created the unprivileged $CTL_ACCOUNT account."
  fi

  ctl_secrets_dirs() {
    ctl_mkdir "$CTL_ETC_DIR" 0755
    ctl_mkdir "$CTL_ETC_DIR/profiles" 0755
    ctl_mkdir "$CTL_ETC_DIR/secrets" 0750
    $CTL_SUDO chgrp "$CTL_ACCOUNT" "$CTL_ETC_DIR/secrets"
    ctl_mkdir "$CTL_SECRETS_DIR" 0750
    $CTL_SUDO chgrp "$CTL_ACCOUNT" "$CTL_SECRETS_DIR"
  }
  # systemd reads the env file as root, but the controller reads every *_FILE path itself, as its
  # unprivileged account. So the env file is root-only and each secret is group-readable by that
  # account alone: created 0600, filled, then opened to the group, so no other local user ever sees
  # a window in which it is readable.
  ctl_secret() {
    if [ -z "$1" ]; then return 0; fi
    if [ "$1" != "$2" ]; then
      $CTL_SUDO install -m 0600 /dev/null "$2"
      $CTL_SUDO cp "$1" "$2"
    fi
    $CTL_SUDO chgrp "$CTL_ACCOUNT" "$2"
    $CTL_SUDO chmod 0640 "$2"
  }
  # The machine token is written from the value read out of the Worker's env file, not copied from
  # that file, which holds more than the token. printf is a builtin, so the value reaches tee
  # through a pipe and never appears in any process's arguments.
  ctl_machine_token_secret() {
    $CTL_SUDO install -m 0600 /dev/null "$CTL_MACHINE_TOKEN_PATH"
    printf '%s' "$CTL_MACHINE_TOKEN" | $CTL_SUDO tee "$CTL_MACHINE_TOKEN_PATH" >/dev/null
    ctl_secret "$CTL_MACHINE_TOKEN_PATH" "$CTL_MACHINE_TOKEN_PATH"
  }

  ctl_line() { [ -z "$2" ] || printf '%s=%s\n' "$1" "$2"; }
  CTL_HEADER="# Written by $CTL_SITE/install --role controller. Rerun it with --reconfigure to replace this file."
  if [ "$CTL_WRITE_CONFIG" -eq 1 ] && [ "$CTL_STANDBY" -eq 1 ]; then
    ctl_secrets_dirs
    ctl_machine_token_secret
    ctl_secret "$CTL_CACHE_KEY_FILE" "$CTL_SECRETS_DIR/cache-signing-key"
    $CTL_SUDO install -m 0600 /dev/null "$CTL_ENV_FILE"
    {
      printf '%s\n' "$CTL_HEADER"
      printf '%s\n' '# A standby on a Worker: it reads its Profile and GitHub credentials from the control plane.'
      ctl_line RC_CONVEX_URL "$CTL_SITE"
      ctl_line RC_PROFILE "$CTL_PROFILE"
      ctl_line RC_MACHINE_TOKEN_FILE "$CTL_MACHINE_TOKEN_PATH"
      if [ -n "$CTL_CACHE_FACTS_URL" ]; then
        ctl_line RC_CACHE_FACTS_URL "$CTL_CACHE_FACTS_URL"
        ctl_line RC_CACHE_SIGNING_KEY_FILE "$CTL_SECRETS_DIR/cache-signing-key"
      fi
    } | $CTL_SUDO tee "$CTL_ENV_FILE" >/dev/null
    ctl_log "Wrote $CTL_ENV_FILE (mode 0600) and the Worker's machine token under $CTL_SECRETS_DIR."
  elif [ "$CTL_WRITE_CONFIG" -eq 1 ]; then
    ctl_secrets_dirs
    ctl_secret "$CTL_TOKEN_FILE" "$CTL_SECRETS_DIR/controller-token"
    ctl_secret "$CTL_APP_KEY_FILE" "$CTL_SECRETS_DIR/github-app.pem"
    ctl_secret "$CTL_GITHUB_TOKEN_FILE" "$CTL_SECRETS_DIR/github-token"
    ctl_secret "$CTL_CACHE_KEY_FILE" "$CTL_SECRETS_DIR/cache-signing-key"

    $CTL_SUDO install -m 0600 /dev/null "$CTL_ENV_FILE"
    {
      printf '%s\n' "$CTL_HEADER"
      ctl_line RC_CONVEX_URL "$CTL_SITE"
      ctl_line RC_CONTROLLER_TOKEN_FILE "$CTL_SECRETS_DIR/controller-token"
      ctl_line RC_GITHUB_CONFIG_URL "$CTL_GITHUB_CONFIG_URL"
      ctl_line RC_PROFILE "$CTL_PROFILE"
      ctl_line RC_SCALE_SET_NAME "$CTL_SCALE_SET_NAME"
      ctl_line RC_LABELS "$CTL_LABELS"
      ctl_line RC_WORKER_LABELS "$CTL_WORKER_LABELS"
      ctl_line RC_RUNNER_GROUP "$CTL_RUNNER_GROUP"
      ctl_line RC_EXECUTOR "$CTL_EXECUTOR"
      ctl_line RC_IMAGE_RELEASE "$CTL_IMAGE_RELEASE"
      ctl_line RC_VCPUS "$CTL_VCPUS"
      ctl_line RC_MEMORY_MIB "$CTL_MEMORY_MIB"
      ctl_line RC_WARM_POOL "$CTL_WARM_POOL"
      ctl_line RC_FIT_POLICY "$CTL_FIT_POLICY"
      ctl_line RC_MIN_RUNNERS "$CTL_MIN_RUNNERS"
      ctl_line RC_MAX_RUNNERS "$CTL_MAX_RUNNERS"
      if [ -n "$CTL_GITHUB_TOKEN_FILE" ]; then
        ctl_line RC_GITHUB_TOKEN_FILE "$CTL_SECRETS_DIR/github-token"
      else
        ctl_line RC_GITHUB_APP_CLIENT_ID "$CTL_APP_CLIENT_ID"
        ctl_line RC_GITHUB_APP_INSTALLATION_ID "$CTL_APP_INSTALLATION_ID"
        ctl_line RC_GITHUB_APP_PRIVATE_KEY_FILE "$CTL_SECRETS_DIR/github-app.pem"
      fi
      if [ -n "$CTL_CACHE_FACTS_URL" ]; then
        ctl_line RC_CACHE_FACTS_URL "$CTL_CACHE_FACTS_URL"
        ctl_line RC_CACHE_SIGNING_KEY_FILE "$CTL_SECRETS_DIR/cache-signing-key"
      fi
    } | $CTL_SUDO tee "$CTL_ENV_FILE" >/dev/null
    ctl_log "Wrote $CTL_ENV_FILE (mode 0600) and the secrets under $CTL_SECRETS_DIR."
  else
    ctl_log "Kept the existing $CTL_ENV_FILE."
    if [ "$CTL_REFRESH_TOKEN" -eq 1 ]; then
      ctl_secrets_dirs
      ctl_machine_token_secret
      ctl_log "Refreshed $CTL_MACHINE_TOKEN_PATH from the Worker's credential in $CTL_WORKER_ENV."
    fi
  fi

  $CTL_SUDO systemctl daemon-reload
  $CTL_SUDO systemctl enable --now "$CTL_UNIT" >/dev/null 2>&1 ||
    ctl_fail "Could not enable $CTL_UNIT"
  # "enable --now" starts a stopped unit and does nothing to a running one, so on a rerun the old
  # process would keep the bytes and settings it started with. Restart explicitly: what runs is
  # what was just verified and written.
  $CTL_SUDO systemctl restart "$CTL_UNIT"
  sleep 3
  if ! $CTL_SUDO systemctl is-active --quiet "$CTL_UNIT"; then
    $CTL_SUDO journalctl -u "$CTL_UNIT" -n 20 --no-pager >&2 || true
    ctl_fail "$CTL_UNIT did not stay running; its last log lines are above. Fix $CTL_ENV_FILE and rerun, or: sudo systemctl restart $CTL_UNIT"
  fi
  if [ "$CTL_STANDBY" -eq 1 ]; then
    ctl_log "$CTL_UNIT is running the controller $CTL_VERSION as a standby on this Worker."
    printf '%s\n' "  It takes the Profile's lease when no other controller holds it; the dashboard's Profiles table shows its status."
    printf '%s\n' "  After this Worker re-registers, rerun with --profile $CTL_PROFILE to refresh its machine token."
  else
    ctl_log "$CTL_UNIT is running the controller $CTL_VERSION."
  fi
  printf '%s\n' "  Status:   systemctl status $CTL_UNIT"
  printf '%s\n' "  Logs:     journalctl -u $CTL_UNIT -f"
  printf '%s\n' "  Config:   $CTL_ENV_FILE (secrets in $CTL_SECRETS_DIR)"
  printf '%s\n' "  Another Profile on this host: rerun this command with --profile <name>"
  printf '%s\n' "  Update every Profile here:    curl -fsSL $CTL_SITE/install | sudo bash -s -- --role controller --update"
  exit 0
}

case "$INSTALL_ROLE" in
  worker) ;;
  node)
    node_install "$@"
    exit 0
    ;;
  worker-host)
    worker_host_install "$@"
    exit 0
    ;;
  controller)
    controller_install "$@"
    exit 0
    ;;
  *)
    printf '❌ %s\n' "Unknown --role: $INSTALL_ROLE (expected worker, node, worker-host or controller)" >&2
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
    fail 'This installer onboards macOS and Linux hosts only. On Windows, run the PowerShell installer this deployment serves at /install.ps1 with -Role worker.'
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
 * The `case` arms of `node_pinned_digest` and `ctl_pinned_digest`, one per pinned target.
 *
 * Both halves are interpolated into single-quoted shell, so both are checked against the shapes the
 * release workflow enforces rather than trusted: a pin carrying a quote would be command injection
 * in a script an operator pipes to `sudo bash`. An empty map renders no arms, which is what makes
 * an unpinned deployment refuse `--role node` or `--role controller` instead of installing
 * something unverifiable.
 */
function renderPinnedDigests(pins: Record<string, string>, what: string, indent = "    ") {
  return Object.entries(pins)
    .map(([target, digest]) => {
      if (!/^[a-z0-9]+-[a-z0-9_]+$/.test(target)) {
        throw new Error(`${what} pin has an unusable target name: ${target}`);
      }
      if (!/^[0-9a-f]{64}$/.test(digest)) {
        throw new Error(`${what} pin for ${target} is not a lowercase SHA-256 digest`);
      }
      return `${indent}${target}) printf '%s' '${digest}' ;;`;
    })
    .join("\n");
}

/**
 * An embedded file for the worker-host or controller role, checked rather than trusted for the same reason the
 * digests are: it lands inside a heredoc in a script an operator pipes to `sudo bash`. The base64
 * alphabet cannot contain the heredoc terminators (no underscore), so proving the charset proves
 * the heredocs cannot be broken out of.
 */
function checkedEmbed(name: string, base64: string, sha256: string) {
  if (!/^[A-Za-z0-9+/=\n]+$/.test(base64)) {
    throw new Error(`The embedded ${name} is not base64; regenerate it`);
  }
  if (!/^[0-9a-f]{64}$/.test(sha256)) {
    throw new Error(`The embedded ${name} checksum is not a lowercase SHA-256 digest`);
  }
  return base64;
}

export function renderInstallScript(siteUrl: string, release: AgentRelease) {
  return INSTALL_SCRIPT.replaceAll("__ERAINFRA_SITE_URL__", siteUrl.replace(/\/+$/, ""))
    .replaceAll("__AGENT_REPO__", release.repo)
    .replaceAll("__AGENT_VERSION__", release.version)
    .replaceAll("__AGENT_SHA256__", release.sha256)
    .replaceAll("__MESH_INSTALL_FUNCTIONS__", MESH_INSTALL_FUNCTIONS)
    .replaceAll("__MESH_DIGESTS__", renderPinnedDigests(release.mesh, "Mesh"))
    .replaceAll("__INFRA_AGENT_DIGESTS__", renderPinnedDigests(release.infraAgent, "Infra Agent"))
    .replaceAll(
      "__CONTROLLER_DIGESTS__",
      renderPinnedDigests(release.controller, "Controller", "      "),
    )
    .replaceAll(
      "__CONTROLLER_UNIT_B64__",
      checkedEmbed("controller unit", CONTROLLER_UNIT_B64, CONTROLLER_UNIT_SHA256),
    )
    .replaceAll("__CONTROLLER_UNIT_SHA256__", CONTROLLER_UNIT_SHA256)
    .replaceAll(
      "__FIRECRACKER_PROVISIONER_B64__",
      checkedEmbed(
        "provisioner",
        FIRECRACKER_HOST_PROVISIONER_B64,
        FIRECRACKER_HOST_PROVISIONER_SHA256,
      ),
    )
    .replaceAll("__FIRECRACKER_PROVISIONER_SHA256__", FIRECRACKER_HOST_PROVISIONER_SHA256)
    .replaceAll(
      "__FIRECRACKER_RUNTIME_UNIT_B64__",
      checkedEmbed("runtime unit", FIRECRACKER_RUNTIME_UNIT_B64, FIRECRACKER_RUNTIME_UNIT_SHA256),
    )
    .replaceAll("__FIRECRACKER_RUNTIME_UNIT_SHA256__", FIRECRACKER_RUNTIME_UNIT_SHA256);
}
