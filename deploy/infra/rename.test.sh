#!/bin/sh
# Stage 1 of retiring the "Portless" name (ADR 0004; CONTEXT.md rule 4), shell half.
#
#   sh deploy/infra/rename.test.sh
#
# The five installer scripts here are the part of the migration CI has never run: they are curl'd
# and piped to sh on a customer's machine, so each carries its own copy of dual_env rather than
# sourcing one. Five copies is five chances to get it wrong, and `${NEW:-${OLD}}` looks correct
# while quietly turning "set to empty" into "unset" — hence a test that reads the real functions
# out of the real files instead of restating them.
#
# What this CANNOT test is hub.sh's volume handling: it needs a Docker daemon with real volumes on
# it, and the whole point of that code is that it refuses rather than acts. That gap is deliberate
# and is stated in the PR body — CI never runs hub.sh, which is precisely why the volumes are
# detect-and-report and not a fallback.
set -eu

HERE=$(CDPATH= cd "$(dirname "$0")" && pwd)
FAILED=0
ok()   { printf '  \033[32mok\033[0m %s\n' "$*" >&2; }
fail() { printf '\033[31mFAIL\033[0m %s\n' "$*" >&2; FAILED=$((FAILED + 1)); }
eq()   { [ "$2" = "$3" ] && ok "$1" || fail "$1: got '$2', want '$3'"; }

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT INT TERM

# Lift dual_env / dual_prefix out of a script and into this shell, so what is under test is the
# function the customer's machine actually runs. sed rather than sourcing the whole file: these
# scripts install things when executed.
extract() { # extract <script> <first-function>
  sed -n "/^$2() {/,/^}$/p" "$HERE/$1"
}

# ---------------------------------------------------------------------------------------------
# Every installer must carry the helper. A script that quietly lost it would keep working today —
# it only breaks once something starts setting the new names — so assert the presence directly.
for s in agent.sh cli.sh image.sh registry.sh hub.sh; do
  if grep -q '^dual_env() {' "$HERE/$s"; then
    ok "$s carries dual_env"
  else
    fail "$s has no dual_env — it cannot accept the renamed variables"
  fi
done

# ---------------------------------------------------------------------------------------------
# The four cases, against agent.sh's copy.
eval "$(extract agent.sh dual_env)"

(
  ERAINFRA_TOKEN=new PORTLESS_TOKEN=old
  export ERAINFRA_TOKEN PORTLESS_TOKEN
  eq "both set → the new name wins" "$(dual_env ERAINFRA_TOKEN PORTLESS_TOKEN 2>/dev/null)" "new"
)
(
  ERAINFRA_TOKEN=new; export ERAINFRA_TOKEN
  unset PORTLESS_TOKEN 2>/dev/null || true
  eq "new name only → used" "$(dual_env ERAINFRA_TOKEN PORTLESS_TOKEN 2>/dev/null)" "new"
  eq "new name only → silent" "$(dual_env ERAINFRA_TOKEN PORTLESS_TOKEN 2>&1 >/dev/null)" ""
)
(
  PORTLESS_TOKEN=old; export PORTLESS_TOKEN
  unset ERAINFRA_TOKEN 2>/dev/null || true
  # THE property: this is every box in the field.
  eq "old name only → still sufficient" "$(dual_env ERAINFRA_TOKEN PORTLESS_TOKEN 2>/dev/null)" "old"
  warning=$(dual_env ERAINFRA_TOKEN PORTLESS_TOKEN 2>&1 >/dev/null)
  case "$warning" in
    *PORTLESS_TOKEN*ERAINFRA_TOKEN*) ok "old name only → warns, naming both" ;;
    *) fail "old name only → warning was '$warning'" ;;
  esac
)
(
  unset ERAINFRA_TOKEN PORTLESS_TOKEN 2>/dev/null || true
  # The case that breaks a box silently: the call site's own default has to survive.
  eq "neither set → the default" "$(dual_env ERAINFRA_REG_PORT PORTLESS_REG_PORT 61050 2>/dev/null)" "61050"
  eq "neither set → empty when there is no default" "$(dual_env ERAINFRA_TOKEN PORTLESS_TOKEN 2>/dev/null)" ""
  eq "neither set → silent" "$(dual_env ERAINFRA_TOKEN PORTLESS_TOKEN 61050 2>&1 >/dev/null)" ""
)
(
  # An empty value is "absent" here, matching the ${VAR:-default} the call sites replaced. Asserted
  # rather than assumed, because the TypeScript and Go halves deliberately do the opposite (they
  # read a variable, not a `:-` expression) and the difference has to be a decision, not a drift.
  ERAINFRA_TOKEN='' PORTLESS_TOKEN=old
  export ERAINFRA_TOKEN PORTLESS_TOKEN
  eq "new name set to empty → falls through, as \${NEW:-\${OLD}} always did" \
    "$(dual_env ERAINFRA_TOKEN PORTLESS_TOKEN 2>/dev/null)" "old"
)

# ---------------------------------------------------------------------------------------------
# The prefix directory: dual-READ, never dual-create.
eval "$(extract registry.sh dual_prefix)"
(
  unset ERAINFRA_PREFIX PORTLESS_PREFIX 2>/dev/null || true
  HOME="$WORK/fresh"; export HOME
  mkdir -p "$HOME"
  # A fresh machine has neither directory and must land on the frozen path — inventing ~/.erainfra
  # here is how a box ends up with two prefixes and an agent in the wrong one.
  eq "neither directory → the frozen ~/.portless" "$(dual_prefix)" "$HOME/.portless"
  mkdir -p "$HOME/.portless"
  eq "only ~/.portless → ~/.portless" "$(dual_prefix)" "$HOME/.portless"
  mkdir -p "$HOME/.erainfra"
  eq "both directories → the renamed one wins" "$(dual_prefix)" "$HOME/.erainfra"
)
(
  ERAINFRA_PREFIX="$WORK/explicit"; export ERAINFRA_PREFIX
  unset PORTLESS_PREFIX 2>/dev/null || true
  eq "an explicit ERAINFRA_PREFIX overrides both directories" "$(dual_prefix)" "$WORK/explicit"
)
(
  PORTLESS_PREFIX="$WORK/legacy"; export PORTLESS_PREFIX
  unset ERAINFRA_PREFIX 2>/dev/null || true
  eq "an explicit PORTLESS_PREFIX is still honoured" "$(dual_prefix 2>/dev/null)" "$WORK/legacy"
)

# ---------------------------------------------------------------------------------------------
# The frozen identifiers these scripts still write. This is the negative half of the PR and the one
# a reviewer most needs pinned: stage 1 renames NOTHING that a running system holds.
grep -q 'agent-bin/portless-agent-' "$HERE/agent.sh" ||
  fail "agent.sh no longer downloads the frozen agent-bin path"
grep -q 'agent-bin/portless-agent-windows' "$HERE/agent.ps1" ||
  fail "agent.ps1 no longer downloads the frozen agent-bin path"
grep -q '/etc/systemd/system/portless-agent.service' "$HERE/agent.sh" ||
  fail "agent.sh no longer installs the frozen systemd unit name"
grep -q 'v portless-data:/data' "$HERE/hub.sh" ||
  fail "hub.sh no longer mounts the portless-data volume — a renamed volume comes up EMPTY"
grep -q 'name portless-registry' "$HERE/hub.sh" ||
  fail "hub.sh no longer names the portless-registry container"
grep -q 'v portless-registry:/var/lib/registry' "$HERE/hub.sh" ||
  fail "hub.sh no longer mounts the portless-registry volume"
grep -q 'name portless-hub' "$HERE/hub.sh" ||
  fail "hub.sh no longer names the portless-hub container"
grep -q 'portless-tunnel' "$HERE/hub.sh" ||
  fail "hub.sh no longer manages the portless-tunnel unit"
grep -q 'portless-agent-\${os}-\${arch}' "$HERE/build-agents.sh" ||
  fail "build-agents.sh no longer produces the frozen binary names"
ok "every frozen identifier these scripts write is still written unchanged"

# build-agents.sh must still emit all five targets under their frozen names.
targets=$(sed -n 's/^for t in \(.*\); do$/\1/p' "$HERE/build-agents.sh")
eq "build-agents.sh still cross-compiles five targets" "$(printf '%s' "$targets" | wc -w | tr -d ' ')" "5"

[ "$FAILED" = 0 ] || {
  printf '\033[31mrename.test.sh: %s assertion(s) failed\033[0m\n' "$FAILED" >&2
  exit 1
}
printf '\033[32m✅ rename.test.sh ok\033[0m — the installers read both names and rename nothing\n' >&2
