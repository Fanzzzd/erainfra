#!/bin/sh
# The conformance job's own test.
#
#   sh .github/conformance/conformance.test.sh
#
# A green conformance job that has never been observed failing is
# indistinguishable from one that is vacuous, and this repository has already
# been bitten by exactly that: deploy/infra/rename.test.sh exited 0 while four
# assertions failed, because the counter was incremented inside a subshell and
# thrown away on the closing paren. So this file does two things, and the
# second is the important one.
#
#   It proves the fingerprint is stable against itself. Two runs on this
#   machine must be byte-identical. A fingerprint that disagrees with itself
#   makes every diff noise, and a noisy job is one everybody learns to ignore.
#
#   It proves the diff can go RED, once per failure mode it claims to have,
#   including the one the real allowlist would hide -- an entry is removed from
#   the checked-in allowlist and the job is required to fail. Every case
#   asserts the failing OUTPUT too, not just the exit status: a failure nobody
#   can read at 03:00 is barely better than no failure at all.
#
# The failure counter lives in a FILE, for the reason above, and the last case
# in this file proves that mechanism still works.
set -eu

HERE=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)

WORK=$(mktemp -d "${TMPDIR:-/tmp}/rc-conformance-test-XXXXXX")
trap 'rm -rf "$WORK"' EXIT
trap 'rm -rf "$WORK"; exit 130' INT
trap 'rm -rf "$WORK"; exit 143' TERM

FAILURES="$WORK/failures"
: >"$FAILURES"
ok() { printf '  \033[32mok\033[0m %s\n' "$*" >&2; }
fail() {
  printf '\033[31mFAIL\033[0m %s\n' "$*" >&2
  printf '%s\n' "$*" >>"$FAILURES"
}
eq() {
  if [ "$2" = "$3" ]; then ok "$1"; else fail "$1: got '$2', want '$3'"; fi
}
failed() { wc -l <"$FAILURES" | tr -d ' '; }

# `sed -i` is neither POSIX nor spelled the same on GNU and BSD, and this file
# runs on both a developer's macOS checkout and the Linux legs.
tweak() { # tweak <file> <sed-expression>
  sed "$2" "$1" >"$1.tweaked" && mv "$1.tweaked" "$1"
}

LABEL_A="ubuntu-latest (GitHub-hosted)"
LABEL_B="rc-e2e (EraInfra Profile)"
DIFF_STATUS=0

# Not a subshell function: it reports back through DIFF_STATUS.
run_diff() { # run_diff <allowlist> <baseline> <candidate>
  DIFF_STATUS=0
  sh "$HERE/diff.sh" "$1" "$LABEL_A" "$2" "$LABEL_B" "$3" >"$WORK/out" 2>&1 || DIFF_STATUS=$?
}

says() { # says <case> <substring>
  if grep -Fq "$2" "$WORK/out"; then
    ok "$1"
  else
    fail "$1: the report never mentions '$2'"
    sed 's/^/      | /' "$WORK/out" >&2
  fi
}

# The two labels are padded to a common width so the values line up in a log,
# so the side and its value are asserted as one line rather than one string.
says_pair() { # says_pair <case> <label> <value>
  if grep -F "$2" "$WORK/out" | grep -Fq "= $3"; then
    ok "$1"
  else
    fail "$1: no line of the report reads '$2 ... = $3'"
    sed 's/^/      | /' "$WORK/out" >&2
  fi
}

# Two cases below put REAL fingerprints of this machine through the REAL
# allowlist, and what they prove is that the differ finds nothing to complain
# about. They cannot assert `DIFF_STATUS = 0` to do it: that allowlist carries
# `require cpu_visible_matches_allowed=yes` and `require
# mem_visible_matches_allowed=yes`, diff.sh asserts a `require` per leg whether
# or not anything differs, and both are `no` on any machine whose own cgroup is
# narrower than its visible CPU or memory -- a container, a devcontainer, a
# Worker. The exit status there is a fact about the host running the test, and
# the case would fail while naming something it never set out to measure.
no_unallowlisted() { # no_unallowlisted <case>
  # Status 2 is the differ refusing to run at all -- a schema mismatch, an
  # empty or malformed fingerprint. No report line can appear then, so the
  # grep below would pass a case in which nothing was ever compared.
  if [ "$DIFF_STATUS" -ge 2 ]; then
    fail "$1: the differ itself failed (status $DIFF_STATUS) instead of comparing"
    sed 's/^/      | /' "$WORK/out" >&2
  elif grep -Fq 'FAIL  unallowlisted differences' "$WORK/out"; then
    fail "$1: the report raises an unallowlisted difference"
    sed 's/^/      | /' "$WORK/out" >&2
  else
    ok "$1"
  fi
}

# A minimal pair of fingerprints. Every case starts from these and perturbs
# exactly one thing, so a case that goes red names its own cause. The keys that
# look inert -- the two *_matches_allowed, node_heap_within_allowed_mem, the
# three *_free_meets_floor, the map_count floor -- are the ones the REAL
# allowlist `require`s, and they are here so that the cases running against it
# measure the differ rather than the machine the test happens to be on.
base_fingerprint() {
  cat >"$1" <<'FINGERPRINT'
cpu_visible_matches_allowed=yes
dev_shm_size_mib=8192
fingerprint_schema=1
kernel_release=6.11.0-1018-azure
mem_visible_matches_allowed=yes
node_heap_within_allowed_mem=yes
root_free_meets_floor=yes
scratch_free_meets_floor=yes
sysctl_vm_max_map_count_meets_floor=yes
tool_git_version=2.43.0
workspace_free_meets_floor=yes
FINGERPRINT
}

test_allowlist() {
  cat >"$1" <<'TEST_ALLOWLIST'
allow kernel_release  # the two sides pin different kernels deliberately
allow tool_*_version  # our image pins its toolchain and GitHub's floats
require cpu_visible_matches_allowed=yes  # the #80 invariant
require mem_visible_matches_allowed=yes  # the other half of #80
never-allow cpu_visible_matches_allowed  # sizes may differ; a machine disagreeing with itself may not
TEST_ALLOWLIST
}

A="$WORK/a.txt"
B="$WORK/b.txt"
LIST="$WORK/allowlist.txt"

# ---------------------------------------------------------------------------
# Every shipped script is POSIX sh and passes shellcheck
# ---------------------------------------------------------------------------
if command -v shellcheck >/dev/null 2>&1; then
  for script in fingerprint.sh diff.sh conformance.test.sh; do
    if shellcheck -s sh "$HERE/$script" >"$WORK/shellcheck.out" 2>&1; then
      ok "$script passes shellcheck"
    else
      fail "$script fails shellcheck"
      sed 's/^/      | /' "$WORK/shellcheck.out" >&2
    fi
  done
else
  ok "shellcheck is not installed here; CI runs it"
fi
for script in fingerprint.sh diff.sh conformance.test.sh; do
  if sh -n "$HERE/$script"; then
    ok "$script parses as POSIX sh"
  else
    fail "$script does not parse as POSIX sh"
  fi
done

# ---------------------------------------------------------------------------
# The fingerprint is stable against itself
# ---------------------------------------------------------------------------
# This is the whole game. The workflow repeats it on every leg, on the real
# platform; running it here as well means a determinism regression is caught
# by `pnpm check` rather than by a red conformance job a week later.
if [ "$(uname -s)" = Linux ]; then
  sh "$HERE/fingerprint.sh" "$WORK/run1.txt"
  sh "$HERE/fingerprint.sh" "$WORK/run2.txt"
  if cmp -s "$WORK/run1.txt" "$WORK/run2.txt"; then
    ok "two runs of fingerprint.sh on this machine are byte-identical"
  else
    fail "fingerprint.sh is not deterministic on this machine"
    diff -u "$WORK/run1.txt" "$WORK/run2.txt" | sed 's/^/      | /' >&2 || true
  fi
  if [ -s "$WORK/run1.txt" ]; then
    ok "fingerprint.sh emitted $(wc -l <"$WORK/run1.txt" | tr -d ' ') keys"
  else
    fail "fingerprint.sh emitted nothing"
  fi
  run_diff "$HERE/allowlist.txt" "$WORK/run1.txt" "$WORK/run2.txt"
  no_unallowlisted "the checked-in allowlist compares a fingerprint against itself cleanly"
else
  ok "fingerprint.sh reads /proc and /sys; determinism is proven on the Linux legs"
fi

# ---------------------------------------------------------------------------
# cgroup v1 and cgroup v2 must reduce to the same keys
# ---------------------------------------------------------------------------
# The fleet's Workers are cgroup v1 hybrid and `ubuntu-latest` is cgroup v2, so
# one leg answers from cpu.cfs_quota_us plus cpu.cfs_period_us and the other
# from cpu.max. If the fingerprint carried where it read a limit, every run
# would fail on the hierarchy version rather than on a limit that actually
# differs -- a red job that says nothing, which is the fastest possible way to
# teach everyone to ignore it. These build both layouts with identical limits
# and require identical keys out of them.
make_cgroup_v2() (
  mkdir -p "$1"
  : >"$1/cgroup.controllers"
  printf '6400000 100000\n' >"$1/cpu.max"
  printf '1099511627776\n' >"$1/memory.max"
  printf '0-63\n' >"$1/cpuset.cpus.effective"
  printf '4096\n' >"$1/pids.max"
)
make_cgroup_v1() (
  mkdir -p "$1/cpu" "$1/memory" "$1/cpuset" "$1/pids"
  printf '6400000\n' >"$1/cpu/cpu.cfs_quota_us"
  printf '100000\n' >"$1/cpu/cpu.cfs_period_us"
  printf '1099511627776\n' >"$1/memory/memory.limit_in_bytes"
  printf '0-63\n' >"$1/cpuset/cpuset.effective_cpus"
  printf '4096\n' >"$1/pids/pids.max"
)

make_cgroup_v2 "$WORK/cgv2"
make_cgroup_v1 "$WORK/cgv1"
# A hybrid host keeps the v1 controllers at the root and mounts the unified
# hierarchy beside them, which a root-only probe reads as plain v1.
make_cgroup_v1 "$WORK/cghybrid"
mkdir -p "$WORK/cghybrid/unified"
: >"$WORK/cghybrid/unified/cgroup.controllers"

limits_of() ( # limits_of <cgroup-root> <fingerprint-destination>
  RC_FINGERPRINT_CGROUP_ROOT=$1 sh "$HERE/fingerprint.sh" "$2"
  grep -E '^(cpu_cgroup_quota_millicpu|cpu_cgroup_cpuset_count|mem_cgroup_limit_mib|pids_cgroup_max)=' "$2"
)
v2_limits=$(limits_of "$WORK/cgv2" "$WORK/fp-v2.txt")
v1_limits=$(limits_of "$WORK/cgv1" "$WORK/fp-v1.txt")
hybrid_limits=$(limits_of "$WORK/cghybrid" "$WORK/fp-hybrid.txt")

eq "a cgroup v1 hierarchy yields the same limit keys as cgroup v2" "$v1_limits" "$v2_limits"
eq "a v1 HYBRID hierarchy, which is what a Worker runs, yields them too" \
  "$hybrid_limits" "$v2_limits"
eq "and the limits are the ones that were set" "$v2_limits" \
  "cpu_cgroup_cpuset_count=64
cpu_cgroup_quota_millicpu=64000
mem_cgroup_limit_mib=1048576
pids_cgroup_max=4096"
eq "a v1 hierarchy is reported as v1" \
  "$(grep '^cgroup_version=' "$WORK/fp-v1.txt")" cgroup_version=v1
eq "a hybrid hierarchy is reported as hybrid rather than as v1" \
  "$(grep '^cgroup_version=' "$WORK/fp-hybrid.txt")" cgroup_version=hybrid

# The end of that argument, inverted by the #17 cutover: the limits
# normalized from the two hierarchies still must not surface -- the eq
# assertions above prove both legs carry identical limit keys -- but the
# hierarchy VERSION now must. The fleet's last v1 host left with the Docker
# executor and `allow cgroup_version` left with it, so a v1 leg reappearing
# is a question for a person, and the report that asks it names the key.
run_diff "$HERE/allowlist.txt" "$WORK/fp-v2.txt" "$WORK/fp-v1.txt"
eq "a v1 leg no longer passes the real diff" "$DIFF_STATUS" 1
says "and the red names the hierarchy, not the limits normalized from it" "cgroup_version"

# ---------------------------------------------------------------------------
# The diff agrees when there is nothing to disagree about
# ---------------------------------------------------------------------------
test_allowlist "$LIST"
base_fingerprint "$A"
base_fingerprint "$B"
run_diff "$LIST" "$A" "$B"
eq "identical fingerprints pass" "$DIFF_STATUS" 0

# ---------------------------------------------------------------------------
# The report does not depend on the locale it was produced under
# ---------------------------------------------------------------------------
# `join` requires its input sorted in the CURRENT locale's collating order, and
# diff.sh sorts under C. glibc's en_US.UTF-8 ignores punctuation on the first
# pass, so two keys fingerprint.sh really emits invert between the two orders:
# `no_new_privs` before `node_heap_limit_mib` under C, after it under
# en_US.UTF-8. Measured on ubuntu:24.04 against diff.sh before it pinned the
# locale, with one leg not emitting one of that pair: join stopped at `input is
# not in sorted order` and `set -eu` took the differ down before it printed
# anything, so the difference that WAS there went unreported and the red named
# a sort order instead of an environment.
#
# So this runs the same comparison twice, once under C and once under a UTF-8
# locale, and requires the two reports byte-identical. Reverting the LC_ALL=C on
# diff.sh's join turns both assertions below red on any host with a glibc
# en_US.UTF-8 -- verified, rather than assumed.
# en_US.UTF-8 specifically, and no C.UTF-8 fallback: C.UTF-8 collates exactly
# like C, so under it the pair below never inverts and the case would pass
# without testing the regression it exists to catch.
utf8_locale=$(locale -a 2>/dev/null | grep -iE '^en_US\.(utf-?8)$' | head -n 1 || true)
if [ -n "$utf8_locale" ]; then
  # Its own files: every case after this one starts from $A and $B, and a case
  # that quietly leaves them somewhere else is how a suite starts lying.
  cat >"$WORK/loc-list.txt" <<'LOCALE_ALLOWLIST'
allow no_new_privs  # the case only needs the pair to be comparable, not to be a real policy
LOCALE_ALLOWLIST
  # The pair that inverts, plus the asymmetry that made the mis-ordered merge
  # fabricate a key: the candidate does not emit no_new_privs at all.
  cat >"$WORK/loc-a.txt" <<'FINGERPRINT'
fingerprint_schema=1
no_new_privs=1
node_heap_limit_mib=512
FINGERPRINT
  cat >"$WORK/loc-b.txt" <<'FINGERPRINT'
fingerprint_schema=1
node_heap_limit_mib=256
FINGERPRINT
  LC_ALL=C sh "$HERE/diff.sh" "$WORK/loc-list.txt" \
    "$LABEL_A" "$WORK/loc-a.txt" "$LABEL_B" "$WORK/loc-b.txt" \
    >"$WORK/out.c" 2>&1 || true
  LC_ALL="$utf8_locale" sh "$HERE/diff.sh" "$WORK/loc-list.txt" \
    "$LABEL_A" "$WORK/loc-a.txt" "$LABEL_B" "$WORK/loc-b.txt" \
    >"$WORK/out.utf8" 2>&1 || true
  if cmp -s "$WORK/out.c" "$WORK/out.utf8"; then
    ok "the report is identical under C and under $utf8_locale"
  else
    fail "the report changes with the ambient locale ($utf8_locale)"
    diff -u "$WORK/out.c" "$WORK/out.utf8" | sed 's/^/      | /' >&2 || true
  fi
  eq "and reports node_heap_limit_mib exactly once under $utf8_locale" \
    "$(grep -c '^  node_heap_limit_mib$' "$WORK/out.utf8" | tr -d ' ')" 1
else
  ok "SKIPPED: no en_US.UTF-8 here to invert the sort; the Linux legs carry one"
fi

# ---------------------------------------------------------------------------
# ... and goes red, once per way it claims it can
# ---------------------------------------------------------------------------
base_fingerprint "$B"
tweak "$B" 's/^dev_shm_size_mib=.*/dev_shm_size_mib=64/'
run_diff "$LIST" "$A" "$B"
eq "an unallowlisted difference fails" "$DIFF_STATUS" 1
says "the failure names the key" "dev_shm_size_mib"
says_pair "the failure names the baseline side and its value" "$LABEL_A" 8192
says_pair "the failure names the candidate side and its value" "$LABEL_B" 64

base_fingerprint "$B"
tweak "$B" 's/^kernel_release=.*/kernel_release=6.1.141/'
run_diff "$LIST" "$A" "$B"
eq "an allowlisted difference passes" "$DIFF_STATUS" 0
says "an allowlisted difference is still reported, with its reason" \
  "the two sides pin different kernels deliberately"

base_fingerprint "$B"
tweak "$B" 's/^tool_git_version=.*/tool_git_version=2.51.0/'
run_diff "$LIST" "$A" "$B"
eq "a glob allowlist entry matches" "$DIFF_STATUS" 0

base_fingerprint "$B"
grep -v '^kernel_release=' "$B" >"$B.trimmed" && mv "$B.trimmed" "$B"
run_diff "$LIST" "$A" "$B"
eq "a key one side does not emit is a difference" "$DIFF_STATUS" 0
says "a key one side does not emit is reported as absent, not as equal" "<key absent>"
base_fingerprint "$B"
grep -v '^dev_shm_size_mib=' "$B" >"$B.trimmed" && mv "$B.trimmed" "$B"
run_diff "$LIST" "$A" "$B"
eq "an unallowlisted key that vanished on one side fails" "$DIFF_STATUS" 1

# The differential blind spot: both legs broken the same way is not a
# difference, so only `require` can see it.
base_fingerprint "$A"
base_fingerprint "$B"
for side in "$A" "$B"; do
  tweak "$side" 's/^mem_visible_matches_allowed=.*/mem_visible_matches_allowed=no/' 
done
run_diff "$LIST" "$A" "$B"
eq "a defect BOTH legs share still fails, though it is not a difference" "$DIFF_STATUS" 1
says "the shared-defect failure says what was required" "required: yes"
base_fingerprint "$A"
base_fingerprint "$B"

# ---------------------------------------------------------------------------
# `pending` records a defect without calling it intended, and cannot outlive it
# ---------------------------------------------------------------------------
# The whole risk of a grace period is that it becomes permanent. Every property
# that stops that happening is asserted here, because an unproven expiry is the
# same as no expiry.
pending_list() { # pending_list <value> <expiry>
  {
    cat "$LIST"
    printf 'pending cpu_visible_matches_allowed=%s %s  # live on the fleet, #80; fix #83 merged, not yet deployed\n' \
      "$1" "$2"
  } >"$WORK/pending.txt"
}

base_fingerprint "$A"
base_fingerprint "$B"
tweak "$B" 's/^cpu_visible_matches_allowed=.*/cpu_visible_matches_allowed=no/'

pending_list no 2999-01-01
run_diff "$WORK/pending.txt" "$A" "$B"
eq "a live pending entry keeps a known, owned defect from failing the job" "$DIFF_STATUS" 0
says "and reports it as recorded rather than intended" \
  "differences that are recorded and owned, not intended"
says "naming the issue that owns it" "#80"
says "and the date its grace runs out" "pending until 2999-01-01"

pending_list no 2000-01-01
run_diff "$WORK/pending.txt" "$A" "$B"
eq "an EXPIRED pending entry fails" "$DIFF_STATUS" 1
says "and says the grace ran out rather than that the fleet drifted" \
  "the grace period ran out on 2000-01-01"

# The divergence getting worse must not be covered by a grace granted for the
# divergence as it was measured.
pending_list definitely-not-this 2999-01-01
run_diff "$WORK/pending.txt" "$A" "$B"
eq "a pending entry does not cover a value it did not record" "$DIFF_STATUS" 1
says "and says so" "this is a DIFFERENT divergence"

{
  cat "$LIST"
  printf 'pending cpu_visible_matches_allowed=no 2999-01-01  # someone will look at it\n'
} >"$WORK/pending-no-issue.txt"
run_diff "$WORK/pending-no-issue.txt" "$A" "$B"
eq "a pending entry that names no issue fails" "$DIFF_STATUS" 1
says "because a defect with no issue is a defect being forgotten" "names no issue"

{
  cat "$LIST"
  printf 'pending cpu_visible_matches_allowed=no soon  # tracked as #80\n'
} >"$WORK/pending-no-date.txt"
run_diff "$WORK/pending-no-date.txt" "$A" "$B"
eq "a pending entry with no real expiry fails" "$DIFF_STATUS" 1

# The two guards must not contradict each other: never-allow refuses to call
# this key intended, and that is exactly why it must still be recordable.
pending_list no 2999-01-01
if grep -q '^never-allow cpu_visible_matches_allowed' "$WORK/pending.txt"; then
  ok "the key pending covers here is one never-allow refuses to let allow name"
else
  fail "the pending test case no longer exercises a never-allow key"
fi

# A pending entry for a defect that has been FIXED covered nothing, which is the
# outcome this job exists to produce, so it warns instead of punishing the fix.
base_fingerprint "$B"
pending_list no 2999-01-01
run_diff "$WORK/pending.txt" "$A" "$B"
eq "a pending entry whose defect is gone does not fail the job" "$DIFF_STATUS" 0
says "but it does say to delete it" "the defect is gone"
base_fingerprint "$A"
base_fingerprint "$B"

# ---------------------------------------------------------------------------
# The allowlist cannot be used to hide the thing it exists to record
# ---------------------------------------------------------------------------
printf 'allow kernel_release\n' >"$WORK/no-reason.txt"
run_diff "$WORK/no-reason.txt" "$A" "$B"
eq "an allowlist entry with no reason fails" "$DIFF_STATUS" 1
says "the no-reason failure says so" "has no '# reason'"

printf 'allow kernel_release  #   \n' >"$WORK/blank-reason.txt"
run_diff "$WORK/blank-reason.txt" "$A" "$B"
eq "an allowlist entry with an empty reason fails" "$DIFF_STATUS" 1

cp "$LIST" "$WORK/forbidden.txt"
printf 'allow cpu_visible_matches_allowed  # our machines are bigger\n' \
  >>"$WORK/forbidden.txt"
run_diff "$WORK/forbidden.txt" "$A" "$B"
eq "allowlisting a never-allow key fails" "$DIFF_STATUS" 1
says "the forbidden-entry failure names both directives" "never-allow cpu_visible_matches_allowed"

printf 'never-allow cpu_visable_matches_allowed  # typo, guards nothing\n' >"$WORK/typo.txt"
run_diff "$WORK/typo.txt" "$A" "$B"
eq "a never-allow that matches no key fails, because it guards nothing" "$DIFF_STATUS" 1

printf 'require kernel_release\n' >"$WORK/bad-require.txt"
run_diff "$WORK/bad-require.txt" "$A" "$B"
eq "a require without a value fails" "$DIFF_STATUS" 1

printf 'permit kernel_release  # not a directive\n' >"$WORK/bad-directive.txt"
run_diff "$WORK/bad-directive.txt" "$A" "$B"
eq "an unknown directive fails" "$DIFF_STATUS" 1

# ---------------------------------------------------------------------------
# A leg that did not run is not a leg that passed
# ---------------------------------------------------------------------------
run_diff "$LIST" "$A" "$WORK/does-not-exist.txt"
eq "a missing fingerprint cannot be compared" "$DIFF_STATUS" 2
says "the missing-leg message says a queued leg is not a pass" \
  "a leg that did not run is not a leg that passed"

: >"$WORK/empty.txt"
run_diff "$LIST" "$A" "$WORK/empty.txt"
eq "an empty fingerprint cannot be compared" "$DIFF_STATUS" 2

printf 'this is not a fingerprint\n' >"$WORK/garbage.txt"
run_diff "$LIST" "$A" "$WORK/garbage.txt"
eq "a malformed fingerprint cannot be compared" "$DIFF_STATUS" 2

base_fingerprint "$B"
tweak "$B" 's/^fingerprint_schema=.*/fingerprint_schema=2/'
run_diff "$LIST" "$A" "$B"
eq "two schema versions cannot be compared" "$DIFF_STATUS" 2
says "the schema message says to re-run both legs" "Re-run both legs"
base_fingerprint "$B"

# ---------------------------------------------------------------------------
# The checked-in allowlist, tested as the artefact it is
# ---------------------------------------------------------------------------
REAL="$HERE/allowlist.txt"
before_reasons=$(failed)
line_number=0
while IFS= read -r raw || [ -n "$raw" ]; do
  line_number=$((line_number + 1))
  entry=$(printf '%s' "$raw" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')
  case "$entry" in
    '' | '#'*) continue ;;
  esac
  case "$entry" in
    *'#'?*) ;;
    *) fail "allowlist.txt:$line_number has no reason: $entry" ;;
  esac
done <"$REAL"
if [ "$(failed)" = "$before_reasons" ]; then
  ok "every entry in allowlist.txt carries a reason"
fi

# A `require` or `never-allow` on a key fingerprint.sh never emits protects
# nothing while reading like protection.
before_keys=$(failed)
grep -E '^(require|never-allow) ' "$REAL" |
  sed 's/^[a-z-]* //; s/=.*//; s/ .*//' | while IFS= read -r key; do
  [ -n "$key" ] || continue
  if ! grep -q "emit $key " "$HERE/fingerprint.sh"; then
    fail "allowlist.txt guards '$key', which fingerprint.sh does not emit"
  fi
done
if [ "$(failed)" = "$before_keys" ]; then
  ok "every key allowlist.txt guards is one fingerprint.sh actually emits"
fi

# The literal demonstration: take the real allowlist, remove one entry, and
# require the real diff to go red on the difference that entry accounted for.
# Without this the allowlist could quietly stop being consulted and nothing
# here would notice.
grep -v '^allow kernel_release' "$REAL" >"$WORK/real-minus-one.txt"
base_fingerprint "$A"
base_fingerprint "$B"
tweak "$B" 's/^kernel_release=.*/kernel_release=6.1.141/'
run_diff "$REAL" "$A" "$B"
eq "the real allowlist accounts for a kernel difference" "$DIFF_STATUS" 0
run_diff "$WORK/real-minus-one.txt" "$A" "$B"
eq "removing that one entry from the real allowlist turns the job red" "$DIFF_STATUS" 1
says "and the red job names the key it lost" "kernel_release"

# ---------------------------------------------------------------------------
# Self-check
# ---------------------------------------------------------------------------
FAILED=$(failed)
[ "$FAILED" = 0 ] || {
  printf '\033[31mconformance.test.sh: %s assertion(s) failed\033[0m\n' "$FAILED" >&2
  exit 1
}

# The count above is only worth anything if a failure raised inside ( … )
# reaches it, and in deploy/infra/rename.test.sh it once did not: the counter
# was a shell variable, the subshell incremented a copy, and the file reported
# 0 while four assertions were failing. Assert the mechanism rather than the
# absence of failures -- record one from a subshell, check it arrived, and put
# the file back. Without this, a refactor that turns the counter back into a
# variable restores the silent pass and every case above becomes decorative.
(fail "self-check: a failure raised inside a subshell must reach the counter") 2>/dev/null
[ "$(failed)" = 1 ] || {
  printf '\033[31mconformance.test.sh: subshell failures are not counted%s\033[0m\n' \
    ' — every case above is vacuous' >&2
  exit 1
}
: >"$FAILURES"

printf '\033[32m✅ conformance.test.sh ok\033[0m — the fingerprint is stable and the diff can go red\n' >&2
