#!/bin/sh
# Fleet relay: an iroh relay that only enrolled Nodes may use (ADR 0016, item 5). Run ON a Linux
# systemd host with a public address and a DNS A record that is not proxied, as a user with sudo:
#
#   ERAINFRA_RELAY_HOSTNAME=relay.example.com ERAINFRA_RELAY_CONTACT=ops@example.com \
#   ERAINFRA_CONVEX_SITE=https://<deployment>.convex.site \
#   ERAINFRA_RELAY_ACCESS_TOKEN_FILE=~/erainfra-relay-access-token sh deploy/infra/relay.sh
#
# It needs no checkout: fetch this one file from a release tag. docs/runbooks/run-a-fleet-relay.md
# is the whole procedure (DNS, firewall, the Convex secret, listing the relay on every Node).
#
# What it sets up, and why:
#
#   /usr/local/libexec/iroh-relay   n0's own release build of iroh-relay, pinned below by version
#                                   and SHA-256. The tarball is checked before it is unpacked.
#   erainfra-relay (system user)    runs the relay; not root, no Docker socket, no Convex
#                                   credential. Its only capability is CAP_NET_BIND_SERVICE.
#   /etc/erainfra-relay/config.toml the relay's TOML config. Access is `access.http`: for every
#                                   client, after the client has proven its EndpointId, the relay
#                                   asks Convex (POST $ERAINFRA_CONVEX_SITE/api/v1/relay/access)
#                                   and relays only for an enrolled Node with a proven endpoint.
#   /etc/erainfra-relay/relay.env   0600 root. The secret the relay sends to Convex
#                                   (IROH_RELAY_HTTP_BEARER_TOKEN), equal to Convex's
#                                   RELAY_ACCESS_TOKEN. systemd reads it before dropping to the user.
#   /var/lib/erainfra-relay         the Let's Encrypt account and certificate cache.
#   erainfra-relay.service          the relay on tcp/443 (HTTPS and the ACME TLS-ALPN-01
#                                   challenge), tcp/80 (the captive-portal probe) and udp/7842
#                                   (QUIC address discovery, the port iroh clients assume).
#
# TLS: Let's Encrypt by default. iroh-relay answers the TLS-ALPN-01 challenge itself on tcp/443,
# so tcp/443 must be reachable from the internet at the A record; tcp/80 is not used for it. With
# ERAINFRA_RELAY_CERT_FILE and ERAINFRA_RELAY_KEY_FILE it serves that certificate instead (copied;
# re-run after a renewal). A Cloudflare origin certificate will not do: iroh verifies the relay
# against the public web PKI.
#
# This script never touches the firewall or DNS. Idempotent: re-run to upgrade or change settings.
set -eu

log() { printf '\033[36m[relay]\033[0m %s\n' "$*" >&2; }
die() { printf '\033[31m[relay] %s\033[0m\n' "$*" >&2; exit 1; }

# n0's release assets for iroh-relay, from https://github.com/n0-computer/iroh/releases/tag/v1.4.1.
# n0 publishes no checksum file, so these are the SHA-256 digests GitHub records for each asset
# (`gh api repos/n0-computer/iroh/releases/tags/v1.4.1 --jq '.assets[] | [.name, .digest]'`),
# checked against a download. musl builds are static, so they run on any glibc. The version is
# the one apps/mesh pins (Cargo.toml, iroh =1.4.1): raise both together.
IROH_RELAY_VERSION=1.4.1
IROH_RELAY_SHA256_AARCH64=3fc0c2d67c1cd66250bf82f3e2f17a985b7081a3d272186bad9d63e3f2347b38
IROH_RELAY_SHA256_X86_64=75254641e3fad7fcbac6dee4d485556fbe06ef708340a9d8810469270ba626b8
# The UDP port iroh clients send QUIC address discovery to (iroh-relay DEFAULT_RELAY_QUIC_PORT).
# A client takes it from its relay config, and erainfra-mesh uses the default, so it is fixed here.
QUIC_PORT=7842

HOST="${ERAINFRA_RELAY_HOSTNAME:-}"
CONTACT="${ERAINFRA_RELAY_CONTACT:-}"
SITE="${ERAINFRA_CONVEX_SITE:-}"
TOKEN_FILE="${ERAINFRA_RELAY_ACCESS_TOKEN_FILE:-}"
CERT_FILE="${ERAINFRA_RELAY_CERT_FILE:-}"
KEY_FILE="${ERAINFRA_RELAY_KEY_FILE:-}"
BIND="${ERAINFRA_RELAY_BIND:-[::]}" # 0.0.0.0 on a host whose kernel has IPv6 disabled
HTTP_PORT="${ERAINFRA_RELAY_HTTP_PORT:-80}"
METRICS="${ERAINFRA_RELAY_METRICS:-}" # for example 127.0.0.1:9090; off when empty
TARBALL="${ERAINFRA_RELAY_TARBALL:-}" # a local copy of the release asset; checked the same way
RELAY_USER=erainfra-relay
ETC=/etc/erainfra-relay
STATE=/var/lib/erainfra-relay
BIN=/usr/local/libexec/iroh-relay
UNIT=/etc/systemd/system/erainfra-relay.service

command -v systemctl >/dev/null || die "systemd is required"
command -v curl >/dev/null || die "curl is required"
[ "$(uname -s)" = Linux ] || die "the fleet relay runs on Linux"

printf '%s' "$HOST" | grep -Eqx '[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+' ||
  die "set ERAINFRA_RELAY_HOSTNAME to the relay's DNS name, lowercase (for example relay.example.com)"
# The Infra Agent's own setting, when this host is a connect-convex Node and it was not given.
if [ -z "$SITE" ]; then
  SITE=$(systemctl show -p Environment --value erainfra-node 2>/dev/null | tr ' ' '\n' |
    sed -n 's/^ERAINFRA_CONVEX_SITE=//p' | head -n 1)
fi
SITE=${SITE%/}
printf '%s' "$SITE" | grep -Eqx 'https://[A-Za-z0-9.-]+(:[0-9]+)?' ||
  die "set ERAINFRA_CONVEX_SITE to the deployment's site URL (https://<deployment>.convex.site)"
case "$HTTP_PORT" in *[!0-9]*|'') die "ERAINFRA_RELAY_HTTP_PORT must be a port number" ;; esac
case "$BIND" in '[::]'|0.0.0.0) ;; *) die "ERAINFRA_RELAY_BIND must be [::] or 0.0.0.0" ;; esac
if [ -n "$METRICS" ]; then
  printf '%s' "$METRICS" | grep -Eqx '127\.0\.0\.1:[0-9]+|\[::1\]:[0-9]+' ||
    die "ERAINFRA_RELAY_METRICS must be a loopback address and port, for example 127.0.0.1:9090"
fi
if [ -n "$CERT_FILE$KEY_FILE" ]; then
  [ -n "$CERT_FILE" ] && [ -n "$KEY_FILE" ] ||
    die "set both ERAINFRA_RELAY_CERT_FILE and ERAINFRA_RELAY_KEY_FILE, or neither"
  sudo test -s "$CERT_FILE" || die "no certificate at $CERT_FILE"
  sudo test -s "$KEY_FILE" || die "no private key at $KEY_FILE"
else
  printf '%s' "$CONTACT" | grep -Eqx '[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+' ||
    die "set ERAINFRA_RELAY_CONTACT to an email address for Let's Encrypt"
fi

# --- the shared secret ------------------------------------------------------------------------------
# Taken from a file, never from argv or the environment. Kept across re-runs when none is given.
TOKEN=
if [ -n "$TOKEN_FILE" ]; then
  [ -r "$TOKEN_FILE" ] || die "cannot read ERAINFRA_RELAY_ACCESS_TOKEN_FILE ($TOKEN_FILE)"
  TOKEN=$(tr -d ' \r\n' < "$TOKEN_FILE")
elif sudo test -s "$ETC/relay.env"; then
  TOKEN=$(sudo sed -n 's/^IROH_RELAY_HTTP_BEARER_TOKEN=//p' "$ETC/relay.env")
fi
GENERATED=0
if [ -z "$TOKEN" ]; then
  TOKEN=$(od -An -tx1 -N32 /dev/urandom | tr -d ' \n')
  GENERATED=1
fi
# Safe in a systemd EnvironmentFile and an HTTP header, and long enough not to be guessed.
{ printf '%s' "$TOKEN" | grep -Eqx '[A-Za-z0-9._~+/=-]{32,}' && [ "${#TOKEN}" -le 512 ]; } ||
  die "the relay access token must be 32 to 512 characters of A-Z a-z 0-9 . _ ~ + / = -"

# --- ports ------------------------------------------------------------------------------------------
# iroh-relay exits when a port is taken, so name the holder now rather than in a restart loop.
if command -v ss >/dev/null; then
  for want in "tcp 443" "tcp $HTTP_PORT" "udp $QUIC_PORT"; do
    proto=${want% *}
    port=${want#* }
    if [ "$proto" = tcp ]; then flags=-Hltnp; else flags=-Hlunp; fi
    holder=$(sudo ss "$flags" "sport = :$port" 2>/dev/null | grep -v 'iroh-relay' || true)
    [ -z "$holder" ] || die "$proto/$port is already in use on this host: $holder"
  done
fi

# --- binary -----------------------------------------------------------------------------------------
case "$(uname -m)" in
  aarch64|arm64) TARGET=aarch64-unknown-linux-musl SHA=$IROH_RELAY_SHA256_AARCH64 ;;
  x86_64|amd64) TARGET=x86_64-unknown-linux-musl SHA=$IROH_RELAY_SHA256_X86_64 ;;
  *) die "n0 publishes iroh-relay for aarch64 and x86_64 only; this host is $(uname -m)" ;;
esac
ASSET="iroh-relay-v$IROH_RELAY_VERSION-$TARGET.tar.gz"
if sudo test -x "$BIN" && sudo "$BIN" --version 2>/dev/null | grep -qx "iroh-relay $IROH_RELAY_VERSION"; then
  log "iroh-relay $IROH_RELAY_VERSION already installed at $BIN"
else
  TMP=$(mktemp -d)
  trap 'rm -rf "$TMP"' EXIT INT TERM
  if [ -n "$TARBALL" ]; then
    cp "$TARBALL" "$TMP/$ASSET"
  else
    curl -fsSL --proto '=https' --tlsv1.2 -o "$TMP/$ASSET" \
      "https://github.com/n0-computer/iroh/releases/download/v$IROH_RELAY_VERSION/$ASSET"
  fi
  if command -v sha256sum >/dev/null; then
    got=$(sha256sum "$TMP/$ASSET" | cut -d' ' -f1)
  else
    got=$(shasum -a 256 "$TMP/$ASSET" | cut -d' ' -f1)
  fi
  [ "$got" = "$SHA" ] || die "$ASSET has SHA-256 $got, expected $SHA; nothing was installed"
  mkdir "$TMP/x"
  tar -xzf "$TMP/$ASSET" -C "$TMP/x" ./iroh-relay
  sudo install -d -m 0755 /usr/local/libexec
  sudo install -m 0755 -o root -g root "$TMP/x/iroh-relay" "$BIN"
  rm -rf "$TMP"
  log "installed iroh-relay $IROH_RELAY_VERSION ($TARGET, sha256 $SHA) at $BIN"
fi

# --- user, directories, config, secret --------------------------------------------------------------
if ! id "$RELAY_USER" >/dev/null 2>&1; then
  sudo useradd --system --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin "$RELAY_USER"
  log "created system user $RELAY_USER"
fi
sudo install -d -m 0750 -o root -g "$RELAY_USER" "$ETC"
sudo install -d -m 0700 -o "$RELAY_USER" -g "$RELAY_USER" "$STATE"

if [ -n "$CERT_FILE" ]; then
  sudo install -m 0644 -o root -g root "$CERT_FILE" "$ETC/cert.pem"
  sudo install -m 0640 -o root -g "$RELAY_USER" "$KEY_FILE" "$ETC/key.pem"
  TLS="cert_mode = \"Manual\"
manual_cert_path = \"$ETC/cert.pem\"
manual_key_path = \"$ETC/key.pem\""
else
  TLS="cert_mode = \"LetsEncrypt\"
contact = \"$CONTACT\"
cert_dir = \"$STATE/certs\"
prod_tls = true"
fi
if [ -n "$METRICS" ]; then
  METRICS_TOML="enable_metrics = true
metrics_bind_addr = \"$METRICS\""
else
  METRICS_TOML="enable_metrics = false"
fi
ACCESS_URL="$SITE/api/v1/relay/access"

# Keys are those of iroh-relay $IROH_RELAY_VERSION's src/main.rs (`Config`, `TlsConfig`,
# `AccessConfig`); n0 publishes no reference for them.
sudo tee "$ETC/config.toml" >/dev/null <<EOF
# Written by deploy/infra/relay.sh for iroh-relay $IROH_RELAY_VERSION. Re-run the script to change it.
enable_relay = true
http_bind_addr = "$BIND:$HTTP_PORT"
enable_quic_addr_discovery = true
$METRICS_TOML

[tls]
https_bind_addr = "$BIND:443"
quic_bind_addr = "$BIND:$QUIC_PORT"
hostname = "$HOST"
$TLS

# Relay only for clients Convex vouches for. The bearer token comes from relay.env.
[access.http]
url = "$ACCESS_URL"
EOF
sudo chown root:"$RELAY_USER" "$ETC/config.toml"
sudo chmod 0640 "$ETC/config.toml"

OLD_UMASK=$(umask)
umask 077
printf 'IROH_RELAY_HTTP_BEARER_TOKEN=%s\n' "$TOKEN" | sudo tee "$ETC/relay.env" >/dev/null
umask "$OLD_UMASK"
sudo chown root:root "$ETC/relay.env"
sudo chmod 0600 "$ETC/relay.env"
TOKEN=

# --- unit -------------------------------------------------------------------------------------------
# The sandbox of gateway.sh, but with the one capability the relay needs: binding 80 and 443.
HARDEN='NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
PrivateDevices=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectKernelLogs=yes
ProtectControlGroups=yes
ProtectClock=yes
ProtectHostname=yes
RestrictNamespaces=yes
RestrictRealtime=yes
RestrictSUIDSGID=yes
LockPersonality=yes
MemoryDenyWriteExecute=yes
SystemCallArchitectures=native
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
AmbientCapabilities=CAP_NET_BIND_SERVICE
UMask=0077'

sudo tee "$UNIT" >/dev/null <<EOF
[Unit]
Description=EraInfra fleet relay (iroh-relay $IROH_RELAY_VERSION, https://$HOST)
After=network-online.target
Wants=network-online.target
# Without its config file iroh-relay starts with defaults: plain HTTP, open to everyone.
AssertPathExists=$ETC/config.toml

[Service]
User=$RELAY_USER
Group=$RELAY_USER
EnvironmentFile=$ETC/relay.env
Environment=RUST_LOG=warn,iroh_relay=info
WorkingDirectory=$STATE
ExecStart=$BIN --config-path $ETC/config.toml
Restart=always
RestartSec=5
ReadWritePaths=$STATE
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
LimitNOFILE=65536
$HARDEN

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable erainfra-relay >/dev/null
sudo systemctl restart erainfra-relay
sudo systemctl is-active --quiet erainfra-relay ||
  die "erainfra-relay did not start; see journalctl -u erainfra-relay -n 50"
log "erainfra-relay.service runs https://$HOST/ (tcp/443, tcp/$HTTP_PORT, udp/$QUIC_PORT)"

# --- checks -----------------------------------------------------------------------------------------
# Convex's answer for an EndpointId no Node has says whether it holds the same secret. The secret
# goes to curl on stdin, never in argv.
ZERO_ID=0000000000000000000000000000000000000000000000000000000000000000
code=$(sudo sed -n 's/^IROH_RELAY_HTTP_BEARER_TOKEN=/Authorization: Bearer /p' "$ETC/relay.env" |
  curl -sS -o /dev/null -w '%{http_code}' -X POST -H @- -H "X-Iroh-Endpoint-Id: $ZERO_ID" \
    "$ACCESS_URL" 2>/dev/null || true)
case "$code" in
  403) log "Convex holds this relay's secret: $ACCESS_URL answers as it should" ;;
  401) log "Convex holds a different RELAY_ACCESS_TOKEN, so the relay admits nobody yet (see below)" ;;
  503) log "Convex has no RELAY_ACCESS_TOKEN, so the relay admits nobody yet (see below)" ;;
  404) log "$ACCESS_URL does not exist: deploy a backend that has the relay access route" ;;
  *) log "could not check $ACCESS_URL (HTTP ${code:-none}); the relay admits nobody until it answers" ;;
esac
if [ "$GENERATED" = 1 ] || [ "$code" != 403 ]; then
  log "set the same secret in Convex, from packages/backend on a machine with the Convex CLI:"
  log "  ssh <this host> sudo sed -n 's/^IROH_RELAY_HTTP_BEARER_TOKEN=//p' $ETC/relay.env > ~/erainfra-relay-access-token"
  log "  npx convex env set --prod RELAY_ACCESS_TOKEN --from-file ~/erainfra-relay-access-token"
fi
if curl -fsS --retry 5 --retry-delay 3 --retry-all-errors -o /dev/null "https://$HOST/healthz" 2>/dev/null; then
  log "https://$HOST/healthz answers with a trusted certificate"
else
  log "https://$HOST/healthz does not answer yet: check that $HOST is an A record to this host,"
  log "not proxied, and that tcp/443 is open to the internet (Let's Encrypt connects to it)"
fi
log "next, if not done yet (docs/runbooks/run-a-fleet-relay.md):"
log "  1. open tcp/443, tcp/$HTTP_PORT and udp/$QUIC_PORT in the host firewall and the cloud security list"
log "  2. on every Node: ERAINFRA_MESH_RELAYS='[\"https://$HOST\"]' and ERAINFRA_MESH_N0_FALLBACK as chosen"
log "  3. mark this Node: erainfra nodes set-roles <name> relay (keep its other roles)"
