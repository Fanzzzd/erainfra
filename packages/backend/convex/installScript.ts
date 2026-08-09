import type { AgentRelease } from "./agentRelease";

const INSTALL_SCRIPT = String.raw`#!/usr/bin/env bash
set -euo pipefail

SITE_URL='__RUNNER_CENTER_SITE_URL__'
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
else
  CPUS=$(getconf _NPROCESSORS_ONLN 2>/dev/null || nproc 2>/dev/null || printf '1')
fi
HOST_NAME=$(hostname -s 2>/dev/null || hostname)
MACHINE_NAME=$NAME
if [ -z "$MACHINE_NAME" ]; then
  MACHINE_NAME=$HOST_NAME
fi
PREVIOUS_VERSION=$(meta_field AGENT_VERSION)

mkdir -p "$RC_HOME" "$BIN_DIR"
TMP_DIR=$(mktemp -d "$RC_HOME/install.XXXXXX")

printf '✅ Detected %s %s with %s CPUs (%s).\n' "$MACHINE_OS" "$MACHINE_ARCH" "$CPUS" "$MACHINE_NAME"

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
  fail 'No existing Runner Center registration was found; use a dashboard install command first'
fi

ENV_BACKUP="$TMP_DIR/agent.env"
if [ -f "$ENV_FILE" ]; then
  cp "$ENV_FILE" "$ENV_BACKUP"
fi

VERSION=$PINNED_VERSION
if [ -n "$VERSION_ARG" ]; then
  VERSION=$VERSION_ARG
fi
[ -n "$VERSION" ] || fail 'This Runner Center deployment pins no agent version; redeploy the backend'
if [ -n "$VERSION_ARG" ] && [ "$VERSION" != "$PINNED_VERSION" ] && [ -z "$SHA_ARG" ]; then
  fail 'Updating to a release other than the deployment pin requires --sha256 with an independently verified digest'
fi

ASSET="runner-center-agent-$VERSION.tar.gz"
RELEASE_URL="https://github.com/$AGENT_REPO/releases/download/v$VERSION"
ARCHIVE="$TMP_DIR/$ASSET"

printf '✅ Downloading the Runner Center agent %s release.\n' "$VERSION"
curl -fsSL "$RELEASE_URL/$ASSET" -o "$ARCHIVE" ||
  fail "Could not download $ASSET from release v$VERSION of $AGENT_REPO"

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
    fail "Agent archive does not match the checksum pinned by this Runner Center deployment"
  CHECKSUM_SOURCE='the checksum pinned by this Runner Center deployment'
fi
printf '✅ Verified the agent archive against %s.\n' "$CHECKSUM_SOURCE"

STAGE_DIR="$TMP_DIR/staged-agent"
mkdir -p "$STAGE_DIR"
tar -xzf "$ARCHIVE" -C "$STAGE_DIR" --strip-components=1
[ -f "$STAGE_DIR/dist/index.js" ] || fail 'The agent archive is missing dist/index.js'
[ -f "$STAGE_DIR/package-lock.json" ] || fail 'The agent archive is missing package-lock.json'
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
  REQUEST_BODY=$(REGISTRATION_TOKEN="$TOKEN" MACHINE_NAME="$MACHINE_NAME" MACHINE_OS="$MACHINE_OS" MACHINE_ARCH="$MACHINE_ARCH" MACHINE_CPUS="$CPUS" MACHINE_LABELS="$LABELS" MACHINE_SLOTS="$SLOTS" "$NODE_BIN" -e '
const payload = {
  registrationToken: process.env.REGISTRATION_TOKEN,
  name: process.env.MACHINE_NAME,
  os: process.env.MACHINE_OS,
  arch: process.env.MACHINE_ARCH,
  cpus: Number(process.env.MACHINE_CPUS),
};
if (process.env.MACHINE_LABELS) {
  payload.labels = process.env.MACHINE_LABELS.split(",").map((label) => label.trim()).filter(Boolean);
}
if (process.env.MACHINE_SLOTS) payload.maxSlots = Number(process.env.MACHINE_SLOTS);
process.stdout.write(JSON.stringify(payload));
')
  RESPONSE_FILE="$TMP_DIR/register.json"
  if ! HTTP_STATUS=$(curl -sS -o "$RESPONSE_FILE" -w '%{http_code}' -H 'Content-Type: application/json' --data "$REQUEST_BODY" "$SITE_URL/agents/register"); then
    fail 'Could not reach the Runner Center registration endpoint'
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
set -a
. "$AGENT_DIR/.env"
set +a
NODE_BIN=$(grep '^NODE_BIN=' "$RC_HOME/install-meta" | cut -d= -f2-)
exec "$NODE_BIN" "$AGENT_DIR/dist/index.js"
START_AGENT
chmod 700 "$START_SCRIPT"

cat > "$BIN_DIR/rc" <<'RC_CLI'
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
      printf '%s\n' 'Runner Center service metadata is missing. Run update from the dashboard install URL.' >&2
      exit 1
      ;;
  esac
}

is_running() {
  case "$(service_kind)" in
    launchd) launchctl print "gui/$UID/center.runner.agent" 2>/dev/null | grep -q 'state = running' ;;
    systemd) systemctl --user is-active --quiet runner-center-agent.service ;;
    nohup)
      [ -f "$PID_FILE" ] && pid=$(grep -E '^[0-9]+$' "$PID_FILE" || true) && [ -n "$pid" ] && kill -0 "$pid" >/dev/null 2>&1
      ;;
    *) return 1 ;;
  esac
}

usage() {
  printf '%s\n' 'Usage: rc status | logs [-f] | restart | stop | update [--version vX.Y.Z] | uninstall'
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
    printf '%s\n' 'Runner Center agent restarted.'
    ;;
  stop)
    stop_agent
    printf '%s\n' 'Runner Center agent stopped.'
    ;;
  update)
    site=$(field SITE_URL)
    [ -n "$site" ] || { printf '%s\n' 'Runner Center site URL is missing.' >&2; exit 1; }
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
    printf '%s\n' 'Runner Center was removed. Delete the machine from the dashboard to remove its registration.'
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
chmod 755 "$BIN_DIR/rc"

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
  printf '✅ Runner Center CLI is already on PATH in %s.\n' "$SHELL_RC"
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
Description=Runner Center agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$AGENT_DIR
ExecStart=$START_SCRIPT
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
start_service

printf '✅ Started the Runner Center agent with %s.\n' "$SERVICE_KIND"
CONNECTED=0
for second in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
  if grep -Fq 'Runner Center agent connected' "$LOG_FILE" 2>/dev/null; then
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

printf '✅ Runner Center %s is connected. Dashboard: %s\n' "$VERSION" "$SITE_URL"
`;

export function renderInstallScript(siteUrl: string, release: AgentRelease) {
  return INSTALL_SCRIPT.replaceAll("__RUNNER_CENTER_SITE_URL__", siteUrl.replace(/\/+$/, ""))
    .replaceAll("__AGENT_REPO__", release.repo)
    .replaceAll("__AGENT_VERSION__", release.version)
    .replaceAll("__AGENT_SHA256__", release.sha256);
}
