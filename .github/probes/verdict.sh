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

printf '### Which tier wins\n\n'
printf -- '- **T2**, a step-level `env:` block: %s\n' "$(tier_verdict t2.txt t2)"
printf -- '- **T3**, written through `$GITHUB_ENV`: %s\n' "$(tier_verdict t3.txt t3)"
printf '\n'

printf '### What the capture endpoint saw\n\n'
if [ ! -s "$dir/capture.jsonl" ]; then
  printf 'No request reached the probe. Every cache client in this job went\n'
  printf 'somewhere else, which is the same finding as an overwritten tier and\n'
  printf 'is the reason this file is checked before the table above is believed.\n\n'
else
  printf '```json\n'
  cat "$dir/capture.jsonl"
  printf '```\n\n'
  for tier in t2 t3; do
    hits=$(grep -c "\"path\":\"/$tier/" "$dir/capture.jsonl" || true)
    generations=$(
      grep "\"path\":\"/$tier/" "$dir/capture.jsonl" 2>/dev/null |
        sed -n 's/.*"generation":"\([^"]*\)".*/\1/p' | sort -u | tr '\n' ' ' | sed 's/ *$//'
    )
    printf -- '- **%s**: %s request(s), generation(s): %s\n' \
      "$tier" "${hits:-0}" "${generations:-none}"
  done
  printf '\n'
fi

printf '### What this decides\n\n'
printf 'T0 is the tier `apps/action-runner-agent` writes when it composes the\n'
printf 'container environment, and it is the only tier that exists before the\n'
printf 'runner starts. T3 is the only tier that exists after a job is bound to a\n'
printf 'repository, so it is the one a token minted at `JobStarted` would have to\n'
printf 'use. ADR 0007 leans on one of these being available; this run says which.\n'
