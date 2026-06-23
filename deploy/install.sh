#!/usr/bin/env bash
set -euo pipefail

# Portless server deploy — run this ON your target server (Linux, systemd).
#
# Single-origin: the API serves the dashboard AND /trpc on one port, behind a DEDICATED
# Cloudflare named tunnel pointed at YOUR domain. Stable URL, survives restarts, no open ports.
# Isolated from any other cloudflared you already run (its own tunnel + its own systemd unit).
#
#   PORTLESS_HOSTNAME=portless.example.com ./deploy/install.sh
#   PORTLESS_HOSTNAME=portless.example.com PORTLESS_TUNNEL=my-tunnel ./deploy/install.sh
#
# Prereqs on the server:
#   - node >= 22  (the API runs .ts directly via --experimental-strip-types)
#   - pnpm
#   - cloudflared, logged in once: `cloudflared tunnel login`  (creates ~/.cloudflared/cert.pem)
#   - a Cloudflare zone for the domain in PORTLESS_HOSTNAME
#
# After it finishes, LOCK IT DOWN with Cloudflare Access (see deploy/README.md). Until you do,
# the dashboard URL is open to anyone (it carries an owner token).

REPO="$(cd "$(dirname "$0")/.." && pwd)"
HOST="${PORTLESS_HOSTNAME:?set PORTLESS_HOSTNAME=portless.yourdomain.com}"
TUNNEL="${PORTLESS_TUNNEL:-portless}"
PORT="${PORTLESS_PORT:-8787}"
RUN_USER="${SUDO_USER:-$USER}"
ENV_FILE="$REPO/deploy/portless.env"
STATE_DIR="$REPO/deploy/state"
CF_DIR="${HOME}/.cloudflared"
CFG="$CF_DIR/portless-config.yml"

say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }

# --- 1. sanity ---
say "Checking prerequisites"
command -v node >/dev/null    || { echo "node >= 22 required"; exit 1; }
node -e 'process.exit(+process.versions.node.split(".")[0] >= 22 ? 0 : 1)' \
  || { echo "node >= 22 required (have $(node -v))"; exit 1; }
command -v pnpm >/dev/null     || { echo "pnpm required"; exit 1; }
command -v cloudflared >/dev/null || { echo "cloudflared required"; exit 1; }
[ -f "$CF_DIR/cert.pem" ]      || { echo "run 'cloudflared tunnel login' first (no $CF_DIR/cert.pem)"; exit 1; }

# --- 2. deps + token + web build ---
say "Installing dependencies"
cd "$REPO"
pnpm install --frozen-lockfile || pnpm install

# Reuse the token across re-runs so the bundle + API stay in sync; generate one the first time.
if [ -f "$ENV_FILE" ] && grep -q '^PORTLESS_TOKEN=' "$ENV_FILE"; then
  TOKEN="$(grep '^PORTLESS_TOKEN=' "$ENV_FILE" | head -1 | cut -d= -f2-)"
  say "Reusing existing owner token"
else
  TOKEN="$(node -e 'console.log(require("crypto").randomBytes(24).toString("base64url"))')"
  say "Generated a new owner token"
fi

say "Building dashboard (token baked in; Cloudflare Access is the real front door)"
VITE_PORTLESS_TOKEN="$TOKEN" pnpm --filter @portless/web build

# --- 3. env file ---
say "Writing $ENV_FILE"
mkdir -p "$STATE_DIR"
# NODE_ENV=production makes auth fail-closed; PORTLESS_DEV_TOKENS re-supplies our one real token.
cat > "$ENV_FILE" <<EOF
PORTLESS_TOKEN=$TOKEN
NODE_ENV=production
PORTLESS_PORT=$PORT
PORTLESS_BIND=127.0.0.1
PORTLESS_WEB_DIR=$REPO/apps/web/dist
PORTLESS_PROJECTS_FILE=$STATE_DIR/projects.json
PORTLESS_AUDIT_FILE=$STATE_DIR/audit.jsonl
PORTLESS_DEV_TOKENS={"$TOKEN":{"id":"u-owner","name":"Owner","roles":["owner"]}}
EOF
chmod 600 "$ENV_FILE"

# --- 4. systemd: API ---
say "Installing systemd unit: portless-api"
NODE_BIN="$(command -v node)"
sudo tee /etc/systemd/system/portless-api.service >/dev/null <<EOF
[Unit]
Description=Portless API (serves dashboard + tRPC, single origin)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$RUN_USER
WorkingDirectory=$REPO
EnvironmentFile=$ENV_FILE
ExecStart=$NODE_BIN --experimental-strip-types apps/api/src/server.ts
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
EOF

# --- 5. dedicated cloudflared tunnel + ingress + DNS ---
say "Setting up the '$TUNNEL' tunnel"
cloudflared tunnel create "$TUNNEL" >/dev/null 2>&1 || true   # no-op if it already exists
TID="$(cloudflared tunnel list --output json \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const t=JSON.parse(s).find(x=>x.name===process.argv[1]);if(!t){console.error("tunnel not found");process.exit(1)}process.stdout.write(t.id)})' "$TUNNEL")"
CREDS="$CF_DIR/$TID.json"
[ -f "$CREDS" ] || { echo "missing tunnel credentials $CREDS — was the tunnel created on this host?"; exit 1; }

say "Writing tunnel ingress config: $CFG"
cat > "$CFG" <<EOF
tunnel: $TID
credentials-file: $CREDS
ingress:
  - hostname: $HOST
    service: http://localhost:$PORT
  - service: http_status:404
EOF

say "Routing DNS: $HOST -> $TUNNEL"
cloudflared tunnel route dns "$TUNNEL" "$HOST" || echo "  (route may already exist — continuing)"

say "Installing systemd unit: cloudflared-portless"
sudo tee /etc/systemd/system/cloudflared-portless.service >/dev/null <<EOF
[Unit]
Description=cloudflared (Portless tunnel)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$RUN_USER
ExecStart=$(command -v cloudflared) tunnel --config $CFG run
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
EOF

# --- 6. start ---
say "Starting services"
sudo systemctl daemon-reload
sudo systemctl enable --now portless-api cloudflared-portless

# --- 7. local smoke ---
sleep 2
say "Smoke test (local)"
curl -fsS "http://127.0.0.1:$PORT/health" && echo "  health ok" || echo "  health FAILED — check: journalctl -u portless-api"

cat <<EOF

==> Done. Portless should come up at: https://$HOST  (give DNS/tunnel ~30s)

   IMPORTANT — it is OPEN until you protect it. Put Cloudflare Access in front:
   Zero Trust dashboard -> Access -> Applications -> Add -> Self-hosted
     Application domain: $HOST
     Policy: Allow -> Emails -> your email(s)
   See deploy/README.md for the full walkthrough + the upgrade to per-user auth.

   Logs:   journalctl -u portless-api -f   |   journalctl -u cloudflared-portless -f
   Token:  stored in $ENV_FILE (PORTLESS_TOKEN) — keep it secret.
EOF
