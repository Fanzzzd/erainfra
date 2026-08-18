#!/bin/sh
# Turn the tier snapshots and the capture log into one table and one verdict, in
# Markdown so it can go straight into $GITHUB_STEP_SUMMARY.
#
# It never exits non-zero on a negative result. "The runner's injection wins" is
# an answer, and an answer that fails the job is one nobody will run twice.

# Everything below prints Markdown, and Markdown uses backticks and the literal
# string $GITHUB_ENV as prose. Single quotes are what keep them literal, so SC2016
# fires on the prose rather than on an expansion this script wanted.
# shellcheck disable=SC2016

set -eu

dir=${1:?usage: verdict.sh <directory holding the tier snapshots and capture.jsonl>}

# Tier file, then the label it prints under. Two kinds of step read every tier
# that has both, because they are not the same environment and the difference is
# the finding: a `run:` step is a script the runner launches, and an action step
# is what every real cache client is.
TIERS='t0.txt|T0 container, `/proc/1/environ`
t1.txt|T1 script step, no override
t1a.txt|T1 **action** step, no override
t2.txt|T2 script step, step-level `env:`
t2a.txt|T2 **action** step, step-level `env:`
t3.txt|T3 script step, after `$GITHUB_ENV`
t3a.txt|T3 **action** step, after `$GITHUB_ENV`'

tier_value() {
  # $1 tier file, $2 variable name. "not measured" when the step that would have
  # written it never ran, which is not the same as the variable being unset.
  if [ ! -f "$dir/$1" ]; then
    printf 'not measured'
    return 0
  fi
  awk -F '\t' -v want="$2" '$1 == want { print $2; found = 1 } END { if (!found) print "not measured" }' \
    "$dir/$1"
}

cell() {
  # A pipe inside a Markdown table cell splits it. A URL cannot contain one, but
  # this table prints whatever the runner handed us and that is not the same
  # promise.
  tier_value "$1" "$2" | sed 's/|/\\|/g'
}

printf '## Cache environment probe\n\n'
printf 'Runner `%s`, %s.\n\n' "${RUNNER_NAME:-unknown}" "$(uname -s -m)"
printf '| tier | `ACTIONS_CACHE_URL` | `ACTIONS_RESULTS_URL` | `ACTIONS_CACHE_SERVICE_V2` | `ACTIONS_RUNTIME_TOKEN` |\n'
printf '| --- | --- | --- | --- | --- |\n'
printf '%s\n' "$TIERS" | while IFS='|' read -r file label; do
  printf '| %s | %s | %s | %s | %s |\n' \
    "$label" \
    "$(cell "$file" ACTIONS_CACHE_URL)" \
    "$(cell "$file" ACTIONS_RESULTS_URL)" \
    "$(cell "$file" ACTIONS_CACHE_SERVICE_V2)" \
    "$(cell "$file" ACTIONS_RUNTIME_TOKEN)"
done
printf '\n'

# A tier won if the value a step ended up seeing is the probe's own URL. Nothing
# else can produce that string, so this is evidence rather than inference.
tier_state() {
  seen=$(tier_value "$1" ACTIONS_CACHE_URL)
  case $seen in
    *"/$2/"*) printf 'SURVIVED' ;;
    'not measured') printf 'not-measured' ;;
    unset) printf 'OVERWRITTEN-TO-UNSET' ;;
    *) printf 'OVERWRITTEN' ;;
  esac
}

# Read straight out of each step's own environment, so this stands on its own:
# it says nothing about whether a client then used the value, and the client
# section below says nothing about the tier. Conflating the two is how an
# unrelated client failure would be reported as an overwritten tier.
printf '### Which tier wins\n\n'
for pair in 't2 T2, a step-level `env:` block' 't3 T3, written through `$GITHUB_ENV`'; do
  tier=${pair%% *}
  label=${pair#* }
  script_state=$(tier_state "$tier.txt" "$tier")
  action_state=$(tier_state "${tier}a.txt" "$tier")
  printf -- '- **%s**: script step %s, action step %s\n' "$label" "$script_state" "$action_state"
  if [ "$script_state" = "SURVIVED" ] && [ "$action_state" = "OVERWRITTEN" ]; then
    printf -- '  - The override holds in a script step and LOSES in an action step. Every\n'
    printf -- '    real cache client -- `actions/cache`, `setup-node`, `setup-go` -- is an\n'
    printf -- '    action step, so this tier cannot deliver a cache endpoint to one.\n'
  fi
done
printf '\n'

# The client steps are `continue-on-error`, so silence has two causes that are
# not the same finding: a client that ran and chose to talk to GitHub, and a
# client that never got as far as a request. Only the first says anything about
# the environment. Without the recorded step outcome the second is
# indistinguishable from it, and reporting either as "the runner overwrote the
# tier" would be inventing a measurement.
client_outcome() {
  if [ -f "$dir/$1-client.txt" ]; then
    tr -d '[:space:]' < "$dir/$1-client.txt"
  else
    printf 'not-recorded'
  fi
}

client_line() {
  tier=$1
  note=$2
  outcome=$(client_outcome "$tier")
  hits=0
  generations=none
  if [ -s "$dir/capture.jsonl" ]; then
    hits=$(grep -c "\"path\":\"/$tier/" "$dir/capture.jsonl" || true)
    found=$(
      grep "\"path\":\"/$tier/" "$dir/capture.jsonl" 2>/dev/null |
        sed -n 's/.*"generation":"\([^"]*\)".*/\1/p' | sort -u | tr '\n' ' ' | sed 's/ *$//'
    )
    [ -z "$found" ] || generations=$found
  fi
  if [ "${hits:-0}" -gt 0 ]; then
    printf -- '- **%s** (%s): the client HONOURED this tier -- %s request(s), generation(s) %s (client step: %s)\n' \
      "$tier" "$note" "$hits" "$generations" "$outcome"
    return 0
  fi
  case $outcome in
    success)
      printf -- '- **%s** (%s): the client WENT ELSEWHERE -- it completed a restore and not one request reached the probe (client step: success)\n' \
        "$tier" "$note"
      ;;
    *)
      printf -- '- **%s** (%s): INCONCLUSIVE -- no request reached the probe and the client step did not complete (client step: %s), so the silence says nothing about this tier either way\n' \
        "$tier" "$note" "$outcome"
      ;;
  esac
}

printf '### What the capture endpoint saw\n\n'
if [ ! -s "$dir/capture.jsonl" ]; then
  printf 'The capture log is empty: no request reached the probe at all.\n\n'
else
  printf '```json\n'
  cat "$dir/capture.jsonl"
  printf '```\n\n'
fi
client_line t2 'step `env:`, no runtime token'
client_line t2tok 'step `env:`, dummy runtime token'
client_line t3 '`$GITHUB_ENV`, no runtime token'
client_line t3tok '`$GITHUB_ENV`, dummy runtime token'
printf '\n'

printf '### What this decides\n\n'
printf 'T0 is the tier `apps/action-runner-agent` writes when it composes the\n'
printf 'container environment, and it is the only tier that exists before the\n'
printf 'runner starts. T3 is the only tier that exists after a job is bound to a\n'
printf 'repository, so it is the one a token minted at `JobStarted` would have to\n'
printf 'use. ADR 0007 leans on one of these being available.\n'
printf '\n'
printf 'Read the sections above as separate claims. "Which tier wins" is read out\n'
printf 'of each step environment and settles what a client WOULD see -- and it\n'
printf 'asks a script step and an action step separately, because the first live\n'
printf 'run found them to be different environments. The capture section settles\n'
printf 'what a client DID; when it says INCONCLUSIVE the client never reached the\n'
printf 'point of sending a request, so it is evidence about the client and about\n'
printf 'nothing else.\n'
