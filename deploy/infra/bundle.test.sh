#!/bin/sh
# Stage 0's route test, re-run against the ASSEMBLED BUNDLE instead of a checkout.
#
#   sh deploy/infra/build-hub-bundle.sh && sh deploy/infra/bundle.test.sh [bundle-dir]
#
# apps/hub/test/installer-paths.test.ts pins server.ts's four import.meta.dirname defaults as they
# resolve from a repository. It cannot see this: the bundle is what a hub container mounts now, and
# every one of those four paths resolves somewhere else inside it. Both halves of that suite's
# reason for existing apply here with more force —
#
#   * all four lookups fail SOFT. A missing file is a 404 whose body a shell dutifully executes as
#     a no-op, so `curl <hub>/agent.sh | sh` silently does nothing and reports success. Nothing
#     throws, nothing 5xxs, and a hub that boots cleanly is not evidence of anything.
#   * so this boots the bundle for real and asserts on the served bodies, not on the exit code of
#     `docker run`.
#
# Runs with every PORTLESS_* variable unset on purpose: what is under test is the bundle's own
# layout. hub.sh sets PORTLESS_WEB_DIR / PORTLESS_CLI_FILE / PORTLESS_DEPLOY_DIR anyway, and the
# two agreeing is the point — an override that silently became load-bearing is a trap waiting for
# the first operator who edits hub.env.
set -eu

HERE=$(CDPATH= cd "$(dirname "$0")" && pwd)
REPO=$(CDPATH= cd "$HERE/../.." && pwd)
BUNDLE=${1:-dist/hub}
case "$BUNDLE" in /*) ;; *) BUNDLE="$REPO/$BUNDLE" ;; esac

FAILED=0
ok() { printf '  \033[32mok\033[0m %s\n' "$*" >&2; }
# A count, not a flag: the per-route "ok" lines below compare it before and after, and a flag that
# is already 1 from an earlier route would report the next failing one as a pass.
fail() { printf '\033[31mFAIL\033[0m %s\n' "$*" >&2; FAILED=$((FAILED + 1)); }
die() { printf '\033[31m%s\033[0m\n' "$*" >&2; exit 1; }

[ -f "$BUNDLE/.hub-bundle" ] ||
  die "no hub bundle at $BUNDLE — run: sh deploy/infra/build-hub-bundle.sh"
command -v curl >/dev/null || die "curl is required"

# shellcheck disable=SC2046 # word splitting is the point: unset every name the env matched.
unset $(env | sed -n 's/^\(PORTLESS_[A-Za-z0-9_]*\)=.*/\1/p') 2>/dev/null || true

WORK=$(mktemp -d)
LOG="$WORK/hub.log"
PID=""
# Save $? first and exit with it explicitly: an EXIT trap whose last command succeeds otherwise
# hands back ITS status, which would turn every failure below into a green exit code — the exact
# shape of silent pass this file exists to prevent.
cleanup() {
  status=$?
  if [ -n "$PID" ]; then kill "$PID" 2>/dev/null || true; fi
  rm -rf "$WORK"
  exit "$status"
}
trap cleanup EXIT INT TERM

# PORT=0 → the kernel picks a free port and server.ts prints the one it got, so this never collides
# with a hub already running on the box. TMPDIR keeps portless.db and the secret key in the scratch
# dir; in the container that same variable points at the portless-data volume.
(cd "$BUNDLE" && TMPDIR="$WORK" PORT=0 exec node --experimental-strip-types apps/hub/src/server.ts) \
  >"$LOG" 2>&1 &
PID=$!

BASE=""
i=0
while [ "$i" -lt 30 ]; do
  BASE=$(sed -n 's|.*listening on \(http://127\.0\.0\.1:[0-9]*\).*|\1|p' "$LOG" | head -1)
  [ -n "$BASE" ] && break
  kill -0 "$PID" 2>/dev/null || { cat "$LOG" >&2; die "the bundled hub exited before it listened"; }
  i=$((i + 1))
  sleep 1
done
[ -n "$BASE" ] || { cat "$LOG" >&2; die "the bundled hub never printed a listen address"; }
printf 'bundle %s serving at %s (no PORTLESS_* set)\n' "$BUNDLE" "$BASE" >&2

code() { curl -s -o "$WORK/body" -w '%{http_code}' "$BASE$1"; }
ctype() { curl -s -o /dev/null -w '%{content_type}' "$BASE$1"; }

[ "$(code /health)" = 200 ] || fail "GET /health did not return 200"

# The five installer scripts a customer machine curls during onboarding. PORTLESS_DEPLOY_DIR's
# default has to land on the bundle's deploy/infra for any of these to be anything but a no-op.
for s in agent.sh agent.ps1 cli.sh image.sh registry.sh; do
  before=$FAILED
  c=$(code "/$s")
  [ "$c" = 200 ] || fail "GET /$s → $c (want 200) — the bundle's deploy dir does not resolve"
  [ -s "$WORK/body" ] || fail "GET /$s → 200 with an empty body"
  if grep -q '<hub>' "$WORK/body"; then fail "GET /$s → served with an untemplated <hub> in it"; fi
  grep -qF "$BASE" "$WORK/body" || fail "GET /$s → hub base was not templated in"
  case "$s" in
    *.ps1) want="text/plain" ;;
    *) want="text/x-shellscript" ;;
  esac
  got=$(ctype "/$s")
  case "$got" in
    "${want}"*) ;;
    *) fail "GET /$s → content-type '$got' (want '${want}' and a charset)" ;;
  esac
  if [ "$before" = "$FAILED" ]; then
    ok "GET /$s → 200, $(wc -c <"$WORK/body" | tr -d ' ') bytes, hub base templated"
  fi
done

# cli.sh's payload. Separate default (PORTLESS_CLI_FILE), so it breaks independently of the five.
c=$(code /cli/portless.mjs)
[ "$c" = 200 ] || fail "GET /cli/portless.mjs → $c (want 200) — the bundle's CLI path does not resolve"
if cmp -s "$WORK/body" "$BUNDLE/packages/cli/portless.mjs"; then
  ok "GET /cli/portless.mjs → 200, byte-identical to the bundle's packages/cli/portless.mjs"
else
  fail "GET /cli/portless.mjs → body is not the bundle's packages/cli/portless.mjs"
fi

# /agent-bin/ rides the same deploy dir. The binaries are built on the host and mounted in
# separately, so an empty answer is expected here — what must survive is the DIFFERENCE between
# "not built yet, run build-agents.sh" and an indistinguishable 404, because that message is the
# only thing that tells an operator which of the two they are looking at.
c=$(code /agent-bin/portless-agent-linux-amd64)
if [ "$c" = 200 ]; then
  ok "GET /agent-bin/portless-agent-linux-amd64 → 200 (binaries are mounted in)"
elif [ "$c" = 404 ] && grep -q 'not built — run .*build-agents\.sh' "$WORK/body"; then
  ok "GET /agent-bin/portless-agent-linux-amd64 → 404 'not built', not a generic 404"
else
  fail "GET /agent-bin/portless-agent-linux-amd64 → $c: $(head -c 200 "$WORK/body")"
fi
c=$(code /agent-bin/hub.sh)
[ "$c" = 400 ] || fail "GET /agent-bin/hub.sh → $c (want 400) — the filename allowlist is not holding"

# The Hub UI. PORTLESS_WEB_DIR's default is the one path that points at a build output, and
# server.ts only mounts the static plugin when the directory EXISTS — a bundle that dropped it
# would serve the API with no dashboard and no error at all.
c=$(code /)
[ "$c" = 200 ] || fail "GET / → $c (want 200) — the bundle's apps/hub-web/dist does not resolve"
if cmp -s "$WORK/body" "$BUNDLE/apps/hub-web/dist/index.html"; then
  ok "GET / → 200, the bundle's apps/hub-web/dist/index.html"
else
  fail "GET / → body is not the bundle's apps/hub-web/dist/index.html"
fi

[ "$FAILED" = 0 ] ||
  die "bundle.test.sh: $FAILED assertion(s) failed — the assembled bundle does not serve what it must"
printf '\033[32m✅ bundle.test.sh ok\033[0m — %s serves every onboarding route on its own defaults\n' \
  "$BUNDLE" >&2
