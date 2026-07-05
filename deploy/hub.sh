#!/bin/sh
# Portless hub — turn a Linux box you own into the PERMANENT hub: API+dashboard container,
# OCI registry container, a dedicated Cloudflare named tunnel (hub hostname + first-level
# wildcard app domain), all reboot-surviving. Run ON the hub box from a repo checkout:
#
#   PORTLESS_ZONE=example.com PORTLESS_HUB_HOST=portless.example.com \
#   TUNNEL_ORIGIN_CERT=$HOME/.cloudflared/cert.pem sh deploy/hub.sh
#
# Requirements already on the box: docker, cloudflared, a CF origin cert for the zone
# (`cloudflared login`). Idempotent: containers are replaced, tunnel/DNS reused if present.
#
# WHY apps live at <app>.<zone> (first level), NOT <app>.apps.<zone>: Cloudflare's free
# Universal SSL covers only ONE wildcard level (*.zone). A second level (*.apps.zone) resolves
# but fails TLS. Explicit DNS records you already have always win over the wildcard, so
# existing subdomains are unaffected. Want *.apps.<zone>? Buy Advanced Certificate Manager.
set -eu

ZONE="${PORTLESS_ZONE:?set PORTLESS_ZONE (e.g. example.com — apps get <app>.<zone>)}"
HUB_HOST="${PORTLESS_HUB_HOST:-portless.$ZONE}"
CERT="${TUNNEL_ORIGIN_CERT:-$HOME/.cloudflared/cert.pem}"
HUB_PORT="${PORTLESS_HUB_PORT:-61080}"      # host loopback port the tunnel points at
REG_PORT="${PORTLESS_REG_PORT:-61050}"      # host loopback port for the OCI registry
TUNNEL="${PORTLESS_TUNNEL_NAME:-portless}"
REPO=$(cd "$(dirname "$0")/.." && pwd)
ENVDIR="$HOME/portless-env"
NODE_IMAGE="${PORTLESS_NODE_IMAGE:-node:22-bookworm-slim}"

log() { printf '\033[36m[hub]\033[0m %s\n' "$*" >&2; }
die() { printf '\033[31m[hub] %s\033[0m\n' "$*" >&2; exit 1; }

command -v docker >/dev/null || die "docker is required"
command -v cloudflared >/dev/null || die "cloudflared is required"
[ -f "$CERT" ] || die "origin cert not found: $CERT (run cloudflared login)"
export TUNNEL_ORIGIN_CERT="$CERT"

# --- tokens: generate once, keep in a 0600 env file -------------------------------------------
mkdir -p "$ENVDIR"
if [ ! -f "$ENVDIR/hub.env" ]; then
  OWNER=$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')
  NODE_TOK=$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')
  umask 077
  cat > "$ENVDIR/hub.env" <<EOF
NODE_ENV=production
PORTLESS_DEV_TOKENS={"$OWNER":{"id":"u-owner","name":"Owner","roles":["owner"]},"$NODE_TOK":{"id":"u-nodes","name":"Node Agent","roles":["operator"]}}
PORTLESS_BIND=0.0.0.0
PORTLESS_APP_DOMAIN=$ZONE
PORTLESS_HUB_HOST=$HUB_HOST
PORTLESS_WEB_DIR=/srv/portless/apps/web/dist
PORTLESS_HUB_BASE=https://$HUB_HOST
PORTLESS_REGISTRY=127.0.0.1:$REG_PORT
TMPDIR=/data
PORTLESS_STATE_DIR=/data/state
EOF
  log "tokens generated → $ENVDIR/hub.env (owner token: $OWNER)"
else
  log "reusing existing $ENVDIR/hub.env"
fi

# --- app deps + web build must exist (built dashboard is served by the API) -------------------
[ -d "$REPO/apps/web/dist" ] || die "apps/web/dist missing — build the dashboard first (pnpm --filter @portless/web build)"
if [ ! -d "$REPO/node_modules" ]; then
  log "installing workspace deps (inside $NODE_IMAGE)…"
  docker run --rm -v "$REPO":/srv/portless -w /srv/portless "$NODE_IMAGE" \
    sh -c "corepack enable >/dev/null 2>&1; corepack prepare pnpm@9.15.0 --activate >/dev/null 2>&1; pnpm install --frozen-lockfile"
fi

# --- containers: registry + hub (replace-in-place, restart policy = reboot survival) -----------
log "starting registry (127.0.0.1:$REG_PORT) and hub (127.0.0.1:$HUB_PORT)…"
docker rm -f portless-registry >/dev/null 2>&1 || true
docker run -d --name portless-registry --restart unless-stopped \
  -p "127.0.0.1:$REG_PORT:5000" -v portless-registry:/var/lib/registry registry:2.8.2 >/dev/null
docker rm -f portless-hub >/dev/null 2>&1 || true
docker run -d --name portless-hub --restart unless-stopped \
  -p "127.0.0.1:$HUB_PORT:8787" -v "$REPO":/srv/portless -v portless-data:/data \
  -w /srv/portless --env-file "$ENVDIR/hub.env" \
  "$NODE_IMAGE" node --experimental-strip-types apps/api/src/server.ts >/dev/null
sleep 3
curl -sf "http://127.0.0.1:$HUB_PORT/health" >/dev/null || { docker logs portless-hub | tail -20; die "hub failed health check"; }

# --- dedicated tunnel + DNS (never touches your other tunnels) ---------------------------------
ID=$(cloudflared tunnel list 2>/dev/null | awk -v t="$TUNNEL" '$2==t{print $1}')
if [ -z "$ID" ]; then
  cloudflared tunnel create "$TUNNEL" >/dev/null
  ID=$(cloudflared tunnel list 2>/dev/null | awk -v t="$TUNNEL" '$2==t{print $1}')
fi
[ -n "$ID" ] || die "could not create/find tunnel $TUNNEL"
log "tunnel $TUNNEL = $ID"
cat > "$HOME/.cloudflared/config-$TUNNEL.yml" <<EOF
tunnel: $ID
credentials-file: $HOME/.cloudflared/$ID.json
ingress:
  - hostname: $HUB_HOST
    service: http://127.0.0.1:$HUB_PORT
  - hostname: "*.$ZONE"
    service: http://127.0.0.1:$HUB_PORT
  - service: http_status:404
EOF
# --config pins the tunnel: plain `route dns` silently uses ~/.cloudflared/config.yml's tunnel.
cloudflared tunnel --config "$HOME/.cloudflared/config-$TUNNEL.yml" route dns --overwrite-dns "$ID" "$HUB_HOST"
cloudflared tunnel --config "$HOME/.cloudflared/config-$TUNNEL.yml" route dns --overwrite-dns "$ID" "*.$ZONE"

# --- systemd for the tunnel (root) -------------------------------------------------------------
UNIT=/etc/systemd/system/portless-tunnel.service
sudo tee "$UNIT" >/dev/null <<EOF
[Unit]
Description=Portless Cloudflare tunnel ($HUB_HOST + *.$ZONE)
After=network-online.target
Wants=network-online.target

[Service]
User=$(id -un)
Environment=TUNNEL_ORIGIN_CERT=$CERT
ExecStart=$(command -v cloudflared) --no-autoupdate tunnel --config $HOME/.cloudflared/config-$TUNNEL.yml run $TUNNEL
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
sudo systemctl daemon-reload
sudo systemctl enable --now portless-tunnel
sudo systemctl restart portless-tunnel

sleep 6
curl -sf --max-time 20 "https://$HUB_HOST/health" >/dev/null || die "https://$HUB_HOST/health not reachable yet (DNS may need a minute)"
log "✅ hub is live: https://$HUB_HOST"
NODE_TOK=$(sed -n 's/.*"\([0-9a-f]\{48\}\)":{"id":"u-nodes".*/\1/p' "$ENVDIR/hub.env")
log "enroll a node:  curl -fsSL https://$HUB_HOST/agent.sh | sudo sh -s -- --token $NODE_TOK --name <node>"
log "enroll THIS box: curl -fsSL http://127.0.0.1:$HUB_PORT/agent.sh -o /tmp/a.sh && sudo sh /tmp/a.sh --token $NODE_TOK --name $(hostname) --hub ws://127.0.0.1:$HUB_PORT/agent"
