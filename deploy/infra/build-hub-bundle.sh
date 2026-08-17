#!/bin/sh
# Assemble the Hub as a self-contained bundle — everything the hub container serves and nothing
# else — so hub.sh can mount THIS instead of the repository checkout.
#
#   sh deploy/infra/build-hub-bundle.sh [outdir]        # default: dist/hub
#
# WHY: `docker run -v "$REPO":/srv/portless` gave a container that runs continuously behind a
# public Cloudflare tunnel a read-write view of the whole platform, including
# packages/backend/convex — the control plane's source and its GitHub App configuration — on a box
# the customer owns. Scoping the install (`--filter "@erainfra/hub..."`) shrank what that mount
# carried; only replacing the mount closes it. ADR 0006's Correction is the other half of the
# reason: the mount has two jobs, and retiring hub-side cross-compilation removes only one of them
# — the Hub process itself runs from the mounted tree, so the tree has to come from somewhere.
#
# LAYOUT — the bundle keeps the repository's directory depths on purpose:
#
#   apps/hub/{package.json,src,node_modules}   the Hub and its production dependency closure
#   apps/hub-web/dist                          the built Hub UI            (PORTLESS_WEB_DIR)
#   packages/cli/portless.mjs                  the CLI that cli.sh serves  (PORTLESS_CLI_FILE)
#   deploy/infra                               the installer scripts       (PORTLESS_DEPLOY_DIR)
#
# server.ts falls back to import.meta.dirname-relative defaults for all four when those overrides
# are unset, and every one of those lookups fails SOFT: a missing file is a 404 whose body a shell
# dutifully executes as a no-op, so `curl <hub>/agent.sh | sh` silently does nothing and reports
# success. Flattening the bundle would leave all four defaults dangling one directory outside it.
# Keeping the depths identical means they resolve inside the bundle instead, so the trap cannot
# reopen if an override is ever dropped — and it means an existing box's hub.env, which already
# says PORTLESS_WEB_DIR=/srv/portless/apps/hub-web/dist, keeps pointing at a real directory across
# the upgrade. hub.sh sets all three overrides anyway; this is the belt under those braces.
#
# Requires pnpm and a built apps/hub-web/dist. hub.sh runs this inside the node image, so a hub box
# needs neither on the host.
set -eu

HERE=$(CDPATH= cd "$(dirname "$0")" && pwd)
REPO=$(CDPATH= cd "$HERE/../.." && pwd)
OUT=${1:-dist/hub}
case "$OUT" in /*) ;; *) OUT="$REPO/$OUT" ;; esac
MARKER="$OUT/.hub-bundle"

log() { printf '\033[36m[bundle]\033[0m %s\n' "$*" >&2; }
die() { printf '\033[31m[bundle] %s\033[0m\n' "$*" >&2; exit 1; }

command -v pnpm >/dev/null || die "pnpm is required"
[ -d "$REPO/apps/hub-web/dist" ] ||
  die "apps/hub-web/dist missing — build the dashboard first (pnpm --filter @erainfra/hub-web build)"
[ -f "$REPO/packages/cli/portless.mjs" ] || die "packages/cli/portless.mjs missing"

# Rebuild from scratch so a bundle never keeps files a later revision stopped shipping. Only ever
# delete a directory this script wrote — the marker is what says so, and it is written before any
# of the slow steps so an interrupted build is reclaimable rather than wedged.
if [ -e "$OUT" ]; then
  [ -f "$MARKER" ] || die "$OUT exists and is not a hub bundle — refusing to delete it"
  rm -rf "$OUT"
fi
mkdir -p "$OUT/apps/hub-web" "$OUT/packages/cli" "$OUT/deploy"
{
  printf 'erainfra hub bundle — assembled by deploy/infra/build-hub-bundle.sh\n'
  (cd "$REPO" && git rev-parse HEAD 2>/dev/null) || true
} >"$MARKER"

# --prod drops devDependencies. --legacy because pnpm 10+ refuses its newer deploy implementation
# on a workspace without inject-workspace-packages; @erainfra/hub depends on no workspace package,
# so injection has nothing to do here either way.
log "pnpm deploy @erainfra/hub → $OUT/apps/hub"
(cd "$REPO" && pnpm deploy --filter=@erainfra/hub --prod --legacy --frozen-lockfile "$OUT/apps/hub")

# The Hub's own tests and the verify harnesses are developer tooling that runs from a checkout.
# The point of this bundle is that a customer's box holds what the Hub serves and nothing else.
rm -rf "$OUT/apps/hub/test" "$OUT/apps/hub/scripts" \
  "$OUT/apps/hub/tsconfig.json" "$OUT/apps/hub/drizzle.config.ts"

cp -R "$REPO/apps/hub-web/dist" "$OUT/apps/hub-web/dist"
cp "$REPO/packages/cli/portless.mjs" "$OUT/packages/cli/portless.mjs"
cp -R "$REPO/deploy/infra" "$OUT/deploy/infra"

# /agent-bin/<target> is still the only way to onboard a Node — ADR 0006 retires it only behind
# four platform proofs — and build-agents.sh writes its cross-compiled binaries into
# deploy/infra/bin on the HOST, from Go source this bundle does not carry. hub.sh mounts that host
# directory in separately (PORTLESS_AGENT_BIN_DIR), so binaries an operator builds are served
# immediately without reassembling the bundle. Carrying a copy here would only go stale.
rm -rf "$OUT/deploy/infra/bin"

PKGS=$(find "$OUT/apps/hub/node_modules/.pnpm" -mindepth 1 -maxdepth 1 -type d ! -name node_modules |
  wc -l | tr -d ' ')
log "bundle ready → $OUT ($PKGS packages, $(du -sh "$OUT" | cut -f1))"
