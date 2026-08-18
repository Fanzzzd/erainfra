#!/bin/sh
# Turn the four tier snapshots and the capture log into one table and one
# verdict, in Markdown so it can go straight into $GITHUB_STEP_SUMMARY.
#
# It never exits non-zero on a negative result. "The runner's injection wins" is
# an answer, and an answer that fails the job is one nobody will run twice.

# Everything below prints Markdown, and Markdown uses backticks and the literal
# string $GITHUB_ENV as prose. Single quotes are what keep them literal, so SC2016
# fires on the prose rather than on an expansion this script wanted.
# shellcheck disable=SC2016

set -eu

dir=${1:?usage: verdict.sh <directory holding t0..t3.txt and capture.jsonl>}

tier_value() {
  # $1 tier file, $2 variable name. Prints the rendering, or "not measured" when
  # the step that would have written it never ran.
  if [ ! -f "$dir/$1" ]; then
    printf 'not measured'
    return 0
  fi
  awk -F '\t' -v want="$2" '$1 == want { print $2; found = 1 } END { if (!found) print "not measured" }' \
    "$dir/$1"
}

cell() {
  value=$(tier_value "$1" "$2")
  # A pipe inside a Markdown table cell splits it; a URL cannot contain one, but
  # this table prints whatever the runner handed us and that is not the same
  # promise.
  printf '%s' "$value" | sed 's/|/\\|/g'
}

printf '## Cache environment probe\n\n'
printf 'Runner `%s`, %s.\n\n' "${RUNNER_NAME:-unknown}" "$(uname -s -m)"
printf '| variable | T0 container | T1 runner injection | T2 step `env:` | T3 `$GITHUB_ENV` |\n'
printf '| --- | --- | --- | --- | --- |\n'
for name in ACTIONS_CACHE_URL ACTIONS_RESULTS_URL ACTIONS_CACHE_SERVICE_V2 ACTIONS_RUNTIME_TOKEN; do
  printf '| `%s` | %s | %s | %s | %s |\n' \
    "$name" \
    "$(cell t0.txt "$name")" \
    "$(cell t1.txt "$name")" \
    "$(cell t2.txt "$name")" \
    "$(cell t3.txt "$name")"
done
printf '\n'

# A tier won if the value a step ended up seeing is the probe's own URL. Nothing
# else can produce that string, so this is evidence rather than inference.
tier_verdict() {
  seen=$(tier_value "$1" ACTIONS_CACHE_URL)
  case $seen in
    *"/$2"*) printf 'the value set at this tier SURVIVED' ;;
    'not measured') printf 'not measured' ;;
    *) printf 'OVERWRITTEN by the runner (a step saw `%s`)' "$seen" ;;
  esac
}

# Read straight out of the step's own environment, so it stands on its own: it
# says nothing about whether any client then used the value, and the client
# section below says nothing about the tier. Conflating the two is how an
# unrelated client failure would be reported as an overwritten tier.
printf '### Which tier wins\n\n'
printf -- '- **T2**, a step-level `env:` block: %s\n' "$(tier_verdict t2.txt t2)"
printf -- '- **T3**, written through `$GITHUB_ENV`: %s\n' "$(tier_verdict t3.txt t3)"
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
    printf -- '- **%s**: the client HONOURED this tier -- %s request(s), generation(s) %s (client step: %s)\n' \
      "$tier" "$hits" "$generations" "$outcome"
    return 0
  fi
  case $outcome in
    success)
      printf -- '- **%s**: the client WENT ELSEWHERE -- it completed a restore and not one request reached the probe (client step: success)\n' \
        "$tier"
      ;;
    *)
      printf -- '- **%s**: INCONCLUSIVE -- no request reached the probe and the client step did not complete (client step: %s), so the silence says nothing about this tier either way\n' \
        "$tier" "$outcome"
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
client_line t2
client_line t3
printf '\n'

printf '### What this decides\n\n'
printf 'T0 is the tier `apps/action-runner-agent` writes when it composes the\n'
printf 'container environment, and it is the only tier that exists before the\n'
printf 'runner starts. T3 is the only tier that exists after a job is bound to a\n'
printf 'repository, so it is the one a token minted at `JobStarted` would have to\n'
printf 'use. ADR 0007 leans on one of these being available; this run says which.\n'
printf '\n'
printf 'Read the two sections above as two separate claims. "Which tier wins" is\n'
printf 'read out of the step environment itself and settles what a client WOULD\n'
printf 'see. The capture section settles what a client DID -- and when it says\n'
printf 'INCONCLUSIVE, the client never reached the point of sending a request, so\n'
printf 'it is evidence about the client and about nothing else.\n'
