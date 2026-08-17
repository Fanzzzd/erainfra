#!/bin/sh
# Portless hub — turn a Linux box you own into the PERMANENT hub: API+dashboard container,
# OCI registry container, a dedicated Cloudflare named tunnel (hub hostname + first-level
# wildcard app domain), all reboot-surviving. Run ON the hub box from a repo checkout:
#
#   PORTLESS_ZONE=example.com PORTLESS_HUB_HOST=portless.example.com \
#   TUNNEL_ORIGIN_CERT=$HOME/.cloudflared/cert.pem sh deploy/infra/hub.sh
#
# Requirements already on the box: docker, cloudflared, a CF origin cert for the zone
# (`cloudflared login`). Idempotent: containers are replaced, tunnel/DNS reused if present.
#
# The hub container does NOT mount this checkout. Each run assembles dist/hub — the hub, its
# production dependencies, the built UI, the CLI and these installer scripts — with
# build-hub-bundle.sh, and mounts that read-only instead. The checkout stays on the host, where a
# container behind a public tunnel cannot read it. State is untouched by all of this: it lives in
# the portless-data volume at /data, exactly as before.
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
REPO=$(cd "$(dirname "$0")/../.." && pwd)
BUNDLE="$REPO/dist/hub"                     # what the hub container mounts — see build-hub-bundle.sh
ENVDIR="$HOME/portless-env"
NODE_IMAGE="${PORTLESS_NODE_IMAGE:-node:22-bookworm-slim}"

log() { printf '\033[36m[hub]\033[0m %s\n' "$*" >&2; }
die() { printf '\033[31m[hub] %s\033[0m\n' "$*" >&2; exit 1; }

command -v docker >/dev/null || die "docker is required"
command -v cloudflared >/dev/null || die "cloudflared is required"
[ -f "$CERT" ] || die "origin cert not found: $CERT (run cloudflared login)"
export TUNNEL_ORIGIN_CERT="$CERT"

# --- hub env: 0600, no baked credentials — auth is user accounts (created on first visit) ------
mkdir -p "$ENVDIR"
if [ ! -f "$ENVDIR/hub.env" ]; then
  umask 077
  cat > "$ENVDIR/hub.env" <<EOF
NODE_ENV=production
PORTLESS_BIND=0.0.0.0
PORTLESS_APP_DOMAIN=$ZONE
PORTLESS_HUB_HOST=$HUB_HOST
PORTLESS_HUB_BASE=https://$HUB_HOST
PORTLESS_REGISTRY=127.0.0.1:$REG_PORT
TMPDIR=/data
EOF
  # Multi-node? Name the agent co-located with the registry so deploys wire remote nodes to it
  # over the mesh automatically: echo PORTLESS_REGISTRY_NODE=<node> >> $ENVDIR/hub.env
  log "hub env written → $ENVDIR/hub.env"
else
  log "reusing existing $ENVDIR/hub.env"
  # Upgrade path: an env file written before apps/web became apps/hub-web still names the old dist,
  # and server.ts only mounts the UI when the directory EXISTS — so a stale value serves the API with
  # no dashboard and no error. Rewrite that one value; the variable name itself never changes.
  if grep -q '^PORTLESS_WEB_DIR=/srv/portless/apps/web/dist$' "$ENVDIR/hub.env"; then
    sed -i.bak 's|^PORTLESS_WEB_DIR=/srv/portless/apps/web/dist$|PORTLESS_WEB_DIR=/srv/portless/apps/hub-web/dist|' "$ENVDIR/hub.env"
    rm -f "$ENVDIR/hub.env.bak"
    log "hub.env: PORTLESS_WEB_DIR repointed at apps/hub-web/dist"
  fi
fi

# Where the hub reads the four things it serves. Each of these already exists in server.ts as an
# override on an import.meta.dirname-relative default, and the bundle keeps the repository's
# directory depths precisely so both agree — including PORTLESS_WEB_DIR, whose value does not move
# across this upgrade, so a box that has been running the mounted-repo form keeps a true one.
# Stated explicitly all the same: a default that silently became load-bearing is the trap, and
# these four resolving to the same place is what makes the defaults safe rather than unused.
#
# Appended, never overwritten: hub.env is written once and reused forever, so a value this script
# starts depending on has to reach files written before it existed, and an operator's own edit has
# to survive a re-run.
add_env() {
  if ! grep -q "^$1=" "$ENVDIR/hub.env"; then
    printf '%s=%s\n' "$1" "$2" >>"$ENVDIR/hub.env"
    log "hub.env: added $1=$2"
  fi
}
add_env PORTLESS_WEB_DIR /srv/portless/apps/hub-web/dist
add_env PORTLESS_CLI_FILE /srv/portless/packages/cli/portless.mjs
add_env PORTLESS_DEPLOY_DIR /srv/portless/deploy/infra
add_env PORTLESS_AGENT_BIN_DIR /srv/agent-bin

# --- the bundle the hub container mounts -------------------------------------------------------
# The hub used to run straight out of this checkout: `-v "$REPO":/srv/portless -w /srv/portless
# node … apps/hub/src/server.ts`. That bind mount had two jobs and ADR 0006 retires only one — the
# hub PROCESS runs from the mounted tree, so dropping the mount means packaging the hub, not just
# deleting a flag. Since the merge, $REPO is the whole platform, so the mount also put
# packages/backend/convex — the control plane's source and its GitHub App configuration —
# read-write inside a container that runs continuously behind a public Cloudflare tunnel, on a box
# the customer owns. build-hub-bundle.sh assembles the hub, its production dependency closure, the
# built UI, the CLI and these installer scripts into dist/hub; that is all the container gets.
#
# Rebuilt on every run rather than cached on "does it exist": hub.sh is re-run after a `git pull`,
# and a bundle that quietly stayed at the previous revision is the same class of silent wrong
# answer as the 404 that a shell executes as a no-op.
[ -d "$REPO/apps/hub-web/dist" ] || die "apps/hub-web/dist missing — build the dashboard first (pnpm --filter @erainfra/hub-web build)"
# A box upgrading from the mounted-repo form still has the workspace install the old hub.sh put in
# the checkout. Nothing reads it any more — the bundle carries its own dependencies — but deleting
# a customer's files is not this script's call, so point at it instead.
if [ -d "$REPO/node_modules/.pnpm" ]; then
  log "note: $REPO/node_modules is left over from the mounted-repo form and is no longer used"
  log "      reclaim it with: rm -rf $REPO/node_modules"
fi
log "assembling the hub bundle (inside $NODE_IMAGE)…"
# The build container gets the repo read-write, because assembling is what it is for; it is
# ephemeral, holds no port and is gone before anything is published. The long-lived container
# below is the one that must not have this.
docker run --rm -v "$REPO":/srv/portless -w /srv/portless "$NODE_IMAGE" \
  sh -c "corepack enable >/dev/null 2>&1; corepack prepare pnpm@11.21.0 --activate >/dev/null 2>&1; sh deploy/infra/build-hub-bundle.sh dist/hub"
[ -f "$BUNDLE/.hub-bundle" ] || die "bundle assembly produced nothing at $BUNDLE"
# build-agents.sh cross-compiles the Infra Agent into deploy/infra/bin from Go source the bundle
# does not carry, and /agent-bin/<target> is still the only way to onboard a Node (ADR 0006 retires
# it only behind four platform proofs). Mounting that one directory — compiled binaries, nothing
# else — keeps `sh deploy/infra/build-agents.sh` serving immediately, exactly as it did when the
# whole repo was mounted, with no bundle rebuild in between. Created here so docker does not.
mkdir -p "$REPO/deploy/infra/bin"

# --- containers: registry + hub (replace-in-place, restart policy = reboot survival) -----------
log "starting registry (127.0.0.1:$REG_PORT) and hub (127.0.0.1:$HUB_PORT)…"
docker rm -f portless-registry >/dev/null 2>&1 || true
docker run -d --name portless-registry --restart unless-stopped \
  -p "127.0.0.1:$REG_PORT:5000" -v portless-registry:/var/lib/registry registry:2.8.2 >/dev/null
docker rm -f portless-hub >/dev/null 2>&1 || true
# :ro — the hub writes nothing into its own tree. Every durable path it touches hangs off TMPDIR,
# which this env file points at /data: portless.db (src/db.ts), the secrets key
# (src/runtime/secrets.ts) and upload staging (server.ts's buildsDir) all land on the portless-data
# volume, which is unchanged and still named portless-data. So read-only costs nothing and removes
# the write half of the exposure outright: "the container modified its own source" stops being
# something an operator would have to notice and becomes something the kernel refuses.
docker run -d --name portless-hub --restart unless-stopped \
  -p "127.0.0.1:$HUB_PORT:8787" \
  -v "$BUNDLE":/srv/portless:ro -v "$REPO/deploy/infra/bin":/srv/agent-bin:ro \
  -v portless-data:/data \
  -w /srv/portless --env-file "$ENVDIR/hub.env" \
  "$NODE_IMAGE" node --experimental-strip-types apps/hub/src/server.ts >/dev/null
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
log "first boot: open https://$HUB_HOST → create the owner account (one-time setup)"
log "node tokens: dashboard Settings → API tokens → create (role: operator), then:"
log "  enroll a node:  curl -fsSL https://$HUB_HOST/agent.sh | sudo sh -s -- --token <plt_...> --name <node>"
log "  enroll THIS box: curl -fsSL http://127.0.0.1:$HUB_PORT/agent.sh -o /tmp/a.sh && sudo sh /tmp/a.sh --token <plt_...> --name $(hostname) --hub ws://127.0.0.1:$HUB_PORT/agent"
