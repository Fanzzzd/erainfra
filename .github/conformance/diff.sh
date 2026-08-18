#!/bin/sh
# Compare two environment fingerprints and fail on any difference that is not
# on the allowlist.
#
#   sh .github/conformance/diff.sh <allowlist> \
#       <baseline-label> <baseline-file> <candidate-label> <candidate-file>
#
# Exit status:
#   0  the candidate conforms to the baseline
#   1  it does not, or the allowlist itself is invalid
#   2  the two fingerprints cannot be compared at all (missing, malformed, or
#      produced by different schema versions)
#
# Every finding names the key, both values, and which side is which, because
# the operator reading a red job at 03:00 should not have to open two logs to
# learn what moved.
#
# The allowlist carries four directives; `allowlist.txt` documents them and
# `conformance.test.sh` proves each one can fail.
#
#   allow <key-or-glob>            # a difference in this key is intended
#   require <key>=<value>          # this key must hold this value on BOTH sides
#   never-allow <key-or-glob>      # `allow` may never name this key
#   pending <key>=<value> <date>   # seen, owned by an issue, and time-boxed
#
# `pending` exists because "intended" and "unexamined" are different claims and
# only one of them belongs in an allowlist. A difference that is a real defect,
# or one nobody has decided about yet, is not intended; writing `allow` for it
# launders an open question into a settled decision, and that is the single way
# this file could become worse than useless. A `pending` entry instead pins the
# value that was measured, names the issue that owns it, and carries the date
# its grace runs out -- so it cannot quietly become permanent, a divergence that
# gets WORSE still fails, and the record says the difference was seen rather
# than missed.
#
# `never-allow` blocks `allow` for a key. It deliberately does not block
# `pending`: refusing to call #80 intended is the point, and refusing to record
# that #80 is currently true would just be a different kind of lying.
#
# `require` exists because this job is differential, and a differential job is
# structurally blind to a defect that both sides share: if `ubuntu-latest` and
# a Profile were both misreporting their own size, the keys would agree and
# the diff would go green. The two facts that #80 was made of are asserted
# absolutely, on every leg, difference or not.
#
# `never-allow` exists because the tempting entry is the wrong one. "Our
# machines are bigger, so the CPU count differs" is true, and allowlisting
# `cpu_visible_count` on that reasoning is how #80 survives this job. The
# derived agreement keys are not allowlistable at all, and the attempt is a
# hard failure rather than a comment nobody reads.
set -eu

if [ "$#" -ne 5 ]; then
  printf 'usage: diff.sh <allowlist> <baseline-label> <baseline-file> %s\n' \
    '<candidate-label> <candidate-file>' >&2
  exit 2
fi

ALLOWLIST=$1
BASE_LABEL=$2
BASE_FILE=$3
CAND_LABEL=$4
CAND_FILE=$5

WORK=$(mktemp -d "${TMPDIR:-/tmp}/rc-conformance-XXXXXX")
trap 'rm -rf "$WORK"' EXIT
trap 'rm -rf "$WORK"; exit 130' INT
trap 'rm -rf "$WORK"; exit 143' TERM
trap 'rm -rf "$WORK"; exit 129' HUP

TAB=$(printf '\t')

# Findings accumulate in FILES rather than shell variables. Several of the
# loops below run in subshells, and a subshell cannot write back to its
# parent: `deploy/infra/rename.test.sh` shipped with exactly that bug, counted
# its failures into a discarded copy, and exited 0 with four assertions
# failing. A conformance job that reports success while failing is worse than
# no conformance job, so the tally lives somewhere every subshell shares.
FAIL_CONFIG="$WORK/fail-config"
FAIL_DIFF="$WORK/fail-diff"
FAIL_REQUIRE="$WORK/fail-require"
INTENDED="$WORK/intended"
WARN="$WORK/warn"
ALLOW="$WORK/allow"
NEVER="$WORK/never"
REQUIRE="$WORK/require"
PENDING="$WORK/pending"
OWNED="$WORK/owned"
USED="$WORK/used"
for scratch in "$FAIL_CONFIG" "$FAIL_DIFF" "$FAIL_REQUIRE" "$INTENDED" "$WARN" \
  "$ALLOW" "$NEVER" "$REQUIRE" "$PENDING" "$OWNED" "$USED"; do
  : >"$scratch"
done

fail_config() { printf '%s\n' "$*" >>"$FAIL_CONFIG"; }
warn() { printf '%s\n' "$*" >>"$WARN"; }
count() { wc -l <"$1" | tr -d ' '; }

pad() (
  text=$1
  while [ "${#text}" -lt "$2" ]; do
    text="$text "
  done
  printf '%s' "$text"
)

trim() (
  printf '%s' "$1" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//'
)

# ---------------------------------------------------------------------------
# Read the two fingerprints
# ---------------------------------------------------------------------------
read_fingerprint() { # read_fingerprint <label> <file> <destination>
  if [ ! -f "$2" ]; then
    printf 'diff.sh: %s produced no fingerprint at %s\n' "$1" "$2" >&2
    printf 'diff.sh: a leg that did not run is not a leg that passed.\n' >&2
    exit 2
  fi
  if [ ! -s "$2" ]; then
    printf 'diff.sh: %s produced an EMPTY fingerprint at %s\n' "$1" "$2" >&2
    exit 2
  fi
  malformed=$(grep -vE '^[a-z0-9_]+=[^=]*$' "$2" || true)
  if [ -n "$malformed" ]; then
    printf 'diff.sh: %s produced a malformed fingerprint:\n%s\n' "$1" "$malformed" >&2
    exit 2
  fi
  # awk rather than `sed 's/=/\t/'`: whether a sed replacement understands \t
  # is a GNU-versus-BSD question, and this file is read on a developer's macOS
  # checkout as well as on the Linux legs.
  awk '{ at = index($0, "="); print substr($0, 1, at - 1) "\t" substr($0, at + 1) }' \
    "$2" | LC_ALL=C sort >"$3"
}

read_fingerprint "$BASE_LABEL" "$BASE_FILE" "$WORK/base.tsv"
read_fingerprint "$CAND_LABEL" "$CAND_FILE" "$WORK/cand.tsv"

schema_of() ( awk -F'\t' '$1 == "fingerprint_schema" { print $2; exit }' "$1" )
base_schema=$(schema_of "$WORK/base.tsv")
cand_schema=$(schema_of "$WORK/cand.tsv")
if [ -z "$base_schema" ] || [ -z "$cand_schema" ]; then
  printf 'diff.sh: a fingerprint carries no fingerprint_schema key.\n' >&2
  exit 2
fi
if [ "$base_schema" != "$cand_schema" ]; then
  printf 'diff.sh: schema %s (%s) cannot be compared with schema %s (%s).\n' \
    "$base_schema" "$BASE_LABEL" "$cand_schema" "$CAND_LABEL" >&2
  printf 'diff.sh: these were produced by two different scripts. Re-run both legs.\n' >&2
  exit 2
fi

# ---------------------------------------------------------------------------
# Read the allowlist
# ---------------------------------------------------------------------------
if [ ! -f "$ALLOWLIST" ]; then
  printf 'diff.sh: no allowlist at %s\n' "$ALLOWLIST" >&2
  exit 2
fi

line_number=0
while IFS= read -r raw_line || [ -n "$raw_line" ]; do
  line_number=$((line_number + 1))
  line=$(trim "$raw_line")
  case "$line" in
    '' | '#'*) continue ;;
  esac
  # An entry with no reason is a bug being hidden, so the reason is part of
  # the syntax rather than a convention.
  case "$line" in
    *'#'*) ;;
    *)
      fail_config "$ALLOWLIST:$line_number: '$line' has no '# reason'."
      continue
      ;;
  esac
  body=$(trim "${line%%#*}")
  reason=$(trim "${line#*#}")
  if [ -z "$reason" ]; then
    fail_config "$ALLOWLIST:$line_number: '$body' has an empty '# reason'."
    continue
  fi
  directive=${body%% *}
  argument=$(trim "${body#"$directive"}")
  if [ -z "$argument" ]; then
    fail_config "$ALLOWLIST:$line_number: '$directive' names nothing."
    continue
  fi
  case "$directive" in
    allow) printf '%s\t%s\n' "$argument" "$reason" >>"$ALLOW" ;;
    never-allow) printf '%s\t%s\n' "$argument" "$reason" >>"$NEVER" ;;
    require)
      case "$argument" in
        *=*)
          printf '%s\t%s\t%s\n' "${argument%%=*}" "${argument#*=}" "$reason" >>"$REQUIRE"
          ;;
        *)
          fail_config "$ALLOWLIST:$line_number: require needs <key>=<value>, got '$argument'."
          ;;
      esac
      ;;
    pending)
      # <key>=<value> <YYYY-MM-DD>. The date is not decoration: an entry that
      # cannot expire is an allow entry wearing a disguise.
      pending_when=${argument##* }
      pending_pair=${argument% *}
      case "$pending_pair" in
        *' '* | *=*) ;;
        *)
          fail_config "$ALLOWLIST:$line_number: pending needs <key>=<value> <YYYY-MM-DD>."
          continue
          ;;
      esac
      case "$pending_when" in
        [0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]) ;;
        *)
          fail_config "$ALLOWLIST:$line_number: '$pending_when' is not a YYYY-MM-DD expiry."
          continue
          ;;
      esac
      case "$pending_pair" in
        *=*) ;;
        *)
          fail_config "$ALLOWLIST:$line_number: pending needs <key>=<value>, got '$pending_pair'."
          continue
          ;;
      esac
      # A defect with no issue is a defect being forgotten, which is the same
      # failure as an entry with no reason and gets the same treatment.
      case "$reason" in
        *'#'[0-9]*) ;;
        *)
          fail_config "$ALLOWLIST:$line_number: pending $pending_pair names no issue (#NNN)."
          continue
          ;;
      esac
      printf '%s\t%s\t%s\t%s\n' \
        "${pending_pair%%=*}" "${pending_pair#*=}" "$pending_when" "$reason" >>"$PENDING"
      ;;
    *)
      fail_config "$ALLOWLIST:$line_number: unknown directive '$directive'."
      ;;
  esac
done <"$ALLOWLIST"

# `date` is the one thing in this file that is not a pure function of its
# inputs, and it is here rather than in fingerprint.sh on purpose: a fingerprint
# has to be deterministic, a grace period has to be able to run out.
TODAY=$(date -u +%Y-%m-%d)
# Compared as an integer, because `test`'s lexicographical > is not POSIX and
# YYYYMMDD orders identically to the date it came from.
TODAY_NUMBER=$(printf '%s' "$TODAY" | sed 's/-//g')

# The `pending` entry for a key, as `value<TAB>expiry<TAB>reason`, or nothing.
pending_for() (
  while IFS="$TAB" read -r key value expiry reason || [ -n "$key" ]; do
    if [ "$key" = "$1" ]; then
      printf '%s\t%s\t%s' "$value" "$expiry" "$reason"
      return 0
    fi
  done <"$PENDING"
  return 1
)

# Returns the first entry whose pattern matches $1, as `pattern<TAB>reason`.
first_match() (
  while IFS="$TAB" read -r pattern reason || [ -n "$pattern" ]; do
    [ -n "$pattern" ] || continue
    # shellcheck disable=SC2254  # $pattern is a glob on purpose: tool_*_version.
    case "$1" in
      $pattern)
        printf '%s\t%s' "$pattern" "$reason"
        return 0
        ;;
    esac
  done <"$2"
  return 1
)

# ---------------------------------------------------------------------------
# Compare
# ---------------------------------------------------------------------------
# -a1 -a2 keeps a key that only one side emitted; -e marks the side that is
# missing it. A key that exists on one side only is a difference, and a large
# one: it usually means a probe could not run at all over there.
join -t"$TAB" -a1 -a2 -e '<key absent>' -o '0,1.2,2.2' \
  "$WORK/base.tsv" "$WORK/cand.tsv" >"$WORK/joined"

label_width=${#BASE_LABEL}
if [ "${#CAND_LABEL}" -gt "$label_width" ]; then
  label_width=${#CAND_LABEL}
fi

identical=0
while IFS="$TAB" read -r key base_value cand_value; do
  [ -n "$key" ] || continue
  never_hit=$(first_match "$key" "$NEVER" || true)
  if [ -n "$never_hit" ]; then
    printf '%s\n' "${never_hit%%"$TAB"*}" >>"$USED.never"
    allow_hit=$(first_match "$key" "$ALLOW" || true)
    if [ -n "$allow_hit" ]; then
      fail_config "$key is named by both allow ${allow_hit%%"$TAB"*} and never-allow ${never_hit%%"$TAB"*} -- ${never_hit#*"$TAB"}"
    fi
  fi
  if [ "$base_value" = "$cand_value" ]; then
    identical=$((identical + 1))
    continue
  fi
  allow_hit=$(first_match "$key" "$ALLOW" || true)
  if [ -n "$allow_hit" ] && [ -z "$never_hit" ]; then
    printf '%s\n' "${allow_hit%%"$TAB"*}" >>"$USED"
    {
      printf '  %s\n' "$key"
      printf '      %s = %s\n' "$(pad "$BASE_LABEL" "$label_width")" "$base_value"
      printf '      %s = %s\n' "$(pad "$CAND_LABEL" "$label_width")" "$cand_value"
      printf '      intended: %s\n' "${allow_hit#*"$TAB"}"
    } >>"$INTENDED"
    continue
  fi
  # Not intended, but perhaps already seen, owned and time-boxed. The pinned
  # value is checked rather than trusted: a grace for "8 CPUs reported as 64"
  # must not silently cover "8 reported as 512".
  pending_hit=$(pending_for "$key" || true)
  if [ -n "$pending_hit" ]; then
    pending_value=${pending_hit%%"$TAB"*}
    pending_rest=${pending_hit#*"$TAB"}
    pending_when=${pending_rest%%"$TAB"*}
    pending_why=${pending_rest#*"$TAB"}
    if [ "$pending_value" != "$cand_value" ]; then
      pending_note="the recorded value was $pending_value; this is a DIFFERENT divergence"
    elif [ "$TODAY_NUMBER" -gt "$(printf '%s' "$pending_when" | sed 's/-//g')" ]; then
      pending_note="the grace period ran out on $pending_when; re-decide it, do not re-date it"
    else
      printf '%s\n' "$key" >>"$OWNED"
      {
        printf '  %s\n' "$key"
        printf '      %s = %s\n' "$(pad "$BASE_LABEL" "$label_width")" "$base_value"
        printf '      %s = %s\n' "$(pad "$CAND_LABEL" "$label_width")" "$cand_value"
        printf '      pending until %s: %s\n' "$pending_when" "$pending_why"
      } >>"$WORK/pending-report"
      continue
    fi
  else
    pending_note=
  fi
  {
    printf '  %s\n' "$key"
    printf '      %s = %s\n' "$(pad "$BASE_LABEL" "$label_width")" "$base_value"
    printf '      %s = %s\n' "$(pad "$CAND_LABEL" "$label_width")" "$cand_value"
    if [ -n "$never_hit" ]; then
      printf '      NOT ALLOWLISTABLE: %s\n' "${never_hit#*"$TAB"}"
    fi
    if [ -n "$pending_note" ]; then
      printf '      a pending entry exists but does not cover this: %s\n' "$pending_note"
    fi
  } >>"$FAIL_DIFF"
done <"$WORK/joined"

# ---------------------------------------------------------------------------
# Facts that must hold on both legs, difference or not
# ---------------------------------------------------------------------------
value_of() ( awk -F'\t' -v want="$2" '$1 == want { print $2; exit }' "$1" )

while IFS="$TAB" read -r key want reason || [ -n "$key" ]; do
  [ -n "$key" ] || continue
  # A live `pending` entry already owns this key: reporting it twice, once as a
  # difference and once as a broken requirement, buries the other findings.
  if grep -qxF "$key" "$OWNED" 2>/dev/null; then
    continue
  fi
  for side in base cand; do
    if [ "$side" = base ]; then
      side_label=$BASE_LABEL
    else
      side_label=$CAND_LABEL
    fi
    got=$(value_of "$WORK/$side.tsv" "$key")
    if [ -z "$got" ]; then
      printf '  %s\n      %s = <key absent>\n      required: %s (%s)\n' \
        "$key" "$(pad "$side_label" "$label_width")" "$want" "$reason" >>"$FAIL_REQUIRE"
    elif [ "$got" != "$want" ]; then
      printf '  %s\n      %s = %s\n      required: %s (%s)\n' \
        "$key" "$(pad "$side_label" "$label_width")" "$got" "$want" "$reason" >>"$FAIL_REQUIRE"
    fi
  done
done <"$REQUIRE"

# ---------------------------------------------------------------------------
# The allowlist's own hygiene
# ---------------------------------------------------------------------------
# A guard that matches no key guards nothing, and a `require` on a key no
# fingerprint emits asserts nothing. Both are typos that read as protection.
while IFS="$TAB" read -r pattern reason || [ -n "$pattern" ]; do
  [ -n "$pattern" ] || continue
  if ! grep -qxF "$pattern" "$USED.never" 2>/dev/null; then
    fail_config "never-allow $pattern matches no key in either fingerprint. ($reason)"
  fi
done <"$NEVER"

# A `pending` entry that covered nothing is the good outcome -- the defect it
# owned is gone -- so it warns rather than fails, exactly like a stale `allow`.
while IFS="$TAB" read -r key value expiry reason || [ -n "$key" ]; do
  [ -n "$key" ] || continue
  if ! grep -qxF "$key" "$OWNED" 2>/dev/null; then
    warn "pending $key=$value ($expiry) covered nothing; the defect is gone. Delete it. ($reason)"
  fi
done <"$PENDING"

# A stale `allow` is only a warning, and a compact one: a difference
# disappearing is the outcome this job exists to produce, so turning it red
# would punish the fix, and printing a paragraph per settled entry would bury
# the findings above it.
while IFS="$TAB" read -r pattern reason || [ -n "$pattern" ]; do
  [ -n "$pattern" ] || continue
  if ! grep -qxF "$pattern" "$USED" 2>/dev/null; then
    printf '%s ' "$pattern" >>"$WORK/stale"
  fi
done <"$ALLOW"
if [ -s "$WORK/stale" ]; then
  warn "these entries matched no difference, so the two legs now agree about them:"
  warn "  $(cat "$WORK/stale")"
  warn "Delete the ones that are settled; the allowlist is a record, and a record"
  warn "nobody prunes stops being read."
fi

# ---------------------------------------------------------------------------
# Report
# ---------------------------------------------------------------------------
report() {
  printf 'Environment conformance\n'
  printf '  baseline  %s  (%s)\n' "$BASE_LABEL" "$BASE_FILE"
  printf '  candidate %s  (%s)\n' "$CAND_LABEL" "$CAND_FILE"
  printf '  allowlist %s\n' "$ALLOWLIST"
  printf '\n'

  if [ -s "$FAIL_CONFIG" ]; then
    printf 'FAIL  the allowlist itself is invalid (%s)\n' "$(count "$FAIL_CONFIG")"
    sed 's/^/  /' "$FAIL_CONFIG"
    printf '\n'
  fi
  if [ -s "$FAIL_DIFF" ]; then
    printf 'FAIL  unallowlisted differences\n'
    cat "$FAIL_DIFF"
    printf '\n'
    printf '  Each of these is a way a build behaves differently here than on the\n'
    printf '  environment every workflow in the world was written against. Fix it, or\n'
    printf '  add an allow line to %s carrying the reason it is intended.\n' "$ALLOWLIST"
    printf '\n'
  fi
  if [ -s "$FAIL_REQUIRE" ]; then
    printf 'FAIL  required facts not held\n'
    cat "$FAIL_REQUIRE"
    printf '\n'
    printf '  These are asserted on every leg rather than diffed, because a\n'
    printf '  differential job cannot see a defect both sides share.\n'
    printf '\n'
  fi
  if [ -s "$WORK/pending-report" ]; then
    printf 'seen  differences that are recorded and owned, not intended (%s)\n' \
      "$(count "$OWNED")"
    cat "$WORK/pending-report"
    printf '\n'
    printf '  These are NOT allowlisted. Each names the issue that owns it and the\n'
    printf '  date its grace runs out; on that date this job goes red again and the\n'
    printf '  question has to be answered rather than re-dated.\n'
    printf '\n'
  fi
  if [ -s "$INTENDED" ]; then
    printf 'ok    intended differences (%s)\n' "$(count "$USED")"
    cat "$INTENDED"
    printf '\n'
  fi
  if [ -s "$WARN" ]; then
    printf 'warn  the allowlist has stale entries\n'
    sed 's/^/  /' "$WARN"
    printf '\n'
  fi
  printf 'ok    %s key(s) identical on both legs\n' "$identical"
}

report | tee "$WORK/report.txt"
if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  {
    printf '## Environment conformance: %s vs %s\n\n' "$BASE_LABEL" "$CAND_LABEL"
    printf '```\n'
    cat "$WORK/report.txt"
    printf '```\n'
  } >>"$GITHUB_STEP_SUMMARY"
fi

if [ -s "$FAIL_CONFIG" ] || [ -s "$FAIL_DIFF" ] || [ -s "$FAIL_REQUIRE" ]; then
  exit 1
fi
exit 0
