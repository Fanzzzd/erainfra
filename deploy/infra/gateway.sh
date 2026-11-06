#!/bin/sh
# Gateway Node: public ingress without the Hub (ADR 0016 phase 3b). Run ON a Linux systemd Node
# that already runs the connect-convex Infra Agent with an erainfra-mesh sidecar, as a user with
# sudo and a Cloudflare origin cert for the zone (`cloudflared login`):
#
#   ERAINFRA_ZONE=example.com sh deploy/infra/gateway.sh
#
# It needs no checkout: fetch this one file from the release tag the Node's agent came from. The
# proxy is the Infra Agent's own `gateway` command, found where `/install --convex` puts the agent
# (/usr/local/lib/erainfra/erainfra-node) unless ERAINFRA_AGENT_BIN names another binary. Every
# read of that binary goes through sudo, so it may sit in a directory only root can enter.
#
# What it sets up, and why:
#
#   erainfra-gateway (system user)   runs the proxy and cloudflared; not root, no Docker socket,
#                                    no Convex credential. The proxy parses every public request.
#   /var/lib/erainfra-gateway        0750 root:erainfra-gateway. The root Infra Agent writes
#                                    routes.json here; the proxy only reads it.
#   erainfra-gateway.service         `infra-agent gateway` on 127.0.0.1:$PORT, sandboxed, with
#                                    network access to loopback only.
#   erainfra-gateway-tunnel.service  cloudflared running the shared gateway tunnel, *.<zone> to
#                                    that port. TLS ends at Cloudflare, as with the Hub (hub.sh).
#
# High availability: run this script on every gateway Node with the same ERAINFRA_GATEWAY_TUNNEL.
# Each run adds one cloudflared replica (connector) to the same tunnel. Cloudflare sends each
# request to the geographically closest replica and, if that connection fails, retries another;
# a tunnel takes up to 25 replicas. See docs/infra-management.md.
#
# This script never moves DNS. The wildcard stays wherever it points (the Hub's tunnel, if one
# exists) until you run the cutover in docs/runbooks/move-ingress-to-gateways.md, or set
# ERAINFRA_GATEWAY_ROUTE_DNS=1 on a zone that has no Hub. Idempotent: re-run after an upgrade.
set -eu

log() { printf '\033[36m[gateway]\033[0m %s\n' "$*" >&2; }
die() { printf '\033[31m[gateway] %s\033[0m\n' "$*" >&2; exit 1; }

ZONE="${ERAINFRA_ZONE:-}"
[ -n "$ZONE" ] || die "set ERAINFRA_ZONE (apps are served at <app>.<zone>)"
PORT="${ERAINFRA_GATEWAY_PORT:-61090}"
TUNNEL="${ERAINFRA_GATEWAY_TUNNEL:-erainfra-gateway}"
CERT="${TUNNEL_ORIGIN_CERT:-$HOME/.cloudflared/cert.pem}"
CONVEX_AGENT=/usr/local/lib/erainfra/erainfra-node # where /install --role node --convex puts it
if [ -n "${ERAINFRA_AGENT_BIN:-}" ]; then
  AGENT_BIN=$ERAINFRA_AGENT_BIN
elif [ -x "$CONVEX_AGENT" ]; then
  AGENT_BIN=$CONVEX_AGENT
else
  AGENT_BIN=$(command -v infra-agent || command -v portless-agent || true)
fi
AGENT_USER="${ERAINFRA_AGENT_USER:-root}" # the user the connect-convex Infra Agent runs as
GW_USER=erainfra-gateway
STATE=/var/lib/erainfra-gateway
ETC=/etc/erainfra-gateway

command -v systemctl >/dev/null || die "systemd is required"
command -v cloudflared >/dev/null || die "cloudflared is required"
# Through sudo: the connect-convex agent may live under /root (0700), which this user cannot enter.
[ -n "$AGENT_BIN" ] && sudo test -x "$AGENT_BIN" ||
  die "no Infra Agent at ${AGENT_BIN:-$CONVEX_AGENT}; install it with /install --role node --convex, or set ERAINFRA_AGENT_BIN"
[ -f "$CERT" ] || die "origin cert not found: $CERT (run cloudflared login)"
case "$PORT" in *[!0-9]*|'') die "ERAINFRA_GATEWAY_PORT must be a port number" ;; esac
sudo "$AGENT_BIN" gateway --help 2>&1 | grep -q -- '-routes-file' ||
  die "$AGENT_BIN has no gateway command; install an Infra Agent release that includes it"
export TUNNEL_ORIGIN_CERT="$CERT"

# --- user, state directory, binary the unit runs --------------------------------------------------
if ! id "$GW_USER" >/dev/null 2>&1; then
  sudo useradd --system --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin "$GW_USER"
  log "created system user $GW_USER"
fi
# The Infra Agent writes routes.json here, so the directory belongs to the user it runs as.
sudo install -d -m 0750 -o "$AGENT_USER" -g "$GW_USER" "$STATE"
sudo install -d -m 0750 -o root -g "$GW_USER" "$ETC"
# The unit runs a root-owned copy, so the unprivileged user can neither replace the binary it runs
# nor needs access to the agent's own install directory.
sudo install -d -m 0755 /usr/local/libexec
sudo install -m 0755 -o root -g root "$AGENT_BIN" /usr/local/libexec/erainfra-gateway

# --- the shared tunnel and this replica's credentials ---------------------------------------------
ID=$(cloudflared tunnel list 2>/dev/null | awk -v t="$TUNNEL" '$2==t{print $1}')
if [ -z "$ID" ]; then
  cloudflared tunnel create "$TUNNEL" >/dev/null
  ID=$(cloudflared tunnel list 2>/dev/null | awk -v t="$TUNNEL" '$2==t{print $1}')
  log "created tunnel $TUNNEL"
fi
[ -n "$ID" ] || die "could not create or find tunnel $TUNNEL"
log "tunnel $TUNNEL = $ID"
CRED="$ETC/tunnel-$ID.json"
if ! sudo test -s "$CRED"; then
  TMP=$(mktemp -d)
  trap 'rm -rf "$TMP"' EXIT INT TERM
  # Every replica runs with the same tunnel credentials; this fetches them with the origin cert
  # rather than copying a file between Nodes.
  cloudflared tunnel token --cred-file "$TMP/cred.json" "$ID" >/dev/null
  sudo install -m 0640 -o root -g "$GW_USER" "$TMP/cred.json" "$CRED"
  rm -rf "$TMP"
  log "tunnel credentials → $CRED"
fi
sudo tee "$ETC/cloudflared.yml" >/dev/null <<EOF
tunnel: $ID
credentials-file: $CRED
ingress:
  - hostname: "*.$ZONE"
    service: http://127.0.0.1:$PORT
  - service: http_status:404
EOF
sudo chown root:"$GW_USER" "$ETC/cloudflared.yml"
sudo chmod 0640 "$ETC/cloudflared.yml"
# The same file where this user can read it, for DNS commands. `cloudflared tunnel route dns`
# without --config reads a default config (~/.cloudflared/config.yml, /etc/cloudflared/config.yml)
# and routes to the tunnel that one names, so every route command passes this one, as hub.sh does.
ROUTE_CONFIG="$(dirname "$CERT")/config-$TUNNEL.yml"
mkdir -p "$(dirname "$ROUTE_CONFIG")"
# shellcheck disable=SC2024 # root reads the file, this user owns the copy
sudo cat "$ETC/cloudflared.yml" > "$ROUTE_CONFIG"
log "DNS commands: cloudflared tunnel --config $ROUTE_CONFIG route dns --overwrite-dns $TUNNEL <hostname>"

# --- units ----------------------------------------------------------------------------------------
# Shared sandbox: no privileges, read-only system, loopback-only IP for the proxy.
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
CapabilityBoundingSet=
AmbientCapabilities=
UMask=0077'

sudo tee /etc/systemd/system/erainfra-gateway.service >/dev/null <<EOF
[Unit]
Description=EraInfra gateway proxy (*.$ZONE on 127.0.0.1:$PORT)
After=network-online.target
Wants=network-online.target

[Service]
User=$GW_USER
Group=$GW_USER
ExecStart=/usr/local/libexec/erainfra-gateway gateway --listen 127.0.0.1:$PORT --zone $ZONE --routes-file $STATE/routes.json
Restart=always
RestartSec=2
ReadOnlyPaths=$STATE
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
IPAddressDeny=any
IPAddressAllow=localhost
LimitNOFILE=65536
$HARDEN

[Install]
WantedBy=multi-user.target
EOF

sudo tee /etc/systemd/system/erainfra-gateway-tunnel.service >/dev/null <<EOF
[Unit]
Description=EraInfra gateway tunnel connector ($TUNNEL, *.$ZONE)
After=network-online.target erainfra-gateway.service
Wants=network-online.target
# A replica whose proxy is down must leave the tunnel, so Cloudflare sends its share to the others.
BindsTo=erainfra-gateway.service

[Service]
User=$GW_USER
Group=$GW_USER
ExecStart=$(command -v cloudflared) --no-autoupdate tunnel --config $ETC/cloudflared.yml run $ID
Restart=always
RestartSec=5
ReadOnlyPaths=$ETC
LimitNOFILE=65536
$HARDEN

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now erainfra-gateway erainfra-gateway-tunnel
sudo systemctl restart erainfra-gateway erainfra-gateway-tunnel

if [ "${ERAINFRA_GATEWAY_ROUTE_DNS:-0}" = 1 ]; then
  cloudflared tunnel --config "$ROUTE_CONFIG" route dns --overwrite-dns "$ID" "*.$ZONE"
  log "*.$ZONE now points at tunnel $TUNNEL"
fi

sleep 2
if curl -fsS -H 'Host: localhost' "http://127.0.0.1:$PORT/healthz"; then
  printf '\n'
else
  log "the proxy answers 503 until the Infra Agent writes $STATE/routes.json (see below)"
fi
log "proxy: erainfra-gateway.service on 127.0.0.1:$PORT; connector: erainfra-gateway-tunnel.service"
log "next, if not done yet:"
log "  1. give the connect-convex Infra Agent ERAINFRA_GATEWAY_ROUTES_FILE=$STATE/routes.json and restart it"
log "  2. mark this Node a gateway: npx convex run infra/nodes:setPlacementRoles '{\"nodeId\":\"<id>\",\"roles\":[\"gateway\"]}' --identity '…'"
log "  3. check: cloudflared tunnel info $TUNNEL   (one connector per gateway Node)"
