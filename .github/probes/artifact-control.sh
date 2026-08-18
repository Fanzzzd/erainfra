#!/bin/sh
# The control experiment, and the reason it is not optional.
#
# The first live probe run found all four cache variables unset in a `run:` step
# on rc-e2e, and the obvious reading -- "this fleet's runner injects nothing, so
# there is nothing for an EraInfra value to collide with" -- would be a large
# design decision resting on one negative. It is also refuted by the same fleet:
# actions/upload-artifact works on rc-e2e, and it cannot upload anything without
# ACTIONS_RESULTS_URL and ACTIONS_RUNTIME_TOKEN. Those credentials exist; a
# script step does not see them.
#
# So every probe run carries its own round trip. A run that reports an empty
# environment AND a working artifact upload has proved the variables are scoped
# to action steps rather than absent, in one place, without anyone having to go
# and read another workflow's history to notice.

# Prose in single quotes; see verdict.sh.
# shellcheck disable=SC2016

set -eu

dir=${1:?usage: artifact-control.sh <directory holding t1a.txt and the outcome files>}

outcome() {
  if [ -f "$dir/$1" ]; then
    tr -d '[:space:]' < "$dir/$1"
  else
    printf 'not-recorded'
  fi
}

value() {
  if [ ! -f "$dir/t1a.txt" ]; then
    printf 'not measured'
    return 0
  fi
  awk -F '\t' -v want="$1" '$1 == want { print $2; found = 1 } END { if (!found) print "not measured" }' \
    "$dir/t1a.txt"
}

upload=$(outcome upload.txt)
download=$(outcome download.txt)
roundtrip=$(outcome roundtrip.txt)

printf '## Artifact control\n\n'
printf 'What an **action** step is given on this Profile with no override at all,\n'
printf 'and whether the credentials it implies actually work.\n\n'
printf '| variable | as an action step sees it |\n'
printf '| --- | --- |\n'
for name in ACTIONS_CACHE_URL ACTIONS_RESULTS_URL ACTIONS_CACHE_SERVICE_V2 ACTIONS_RUNTIME_TOKEN; do
  printf '| `%s` | %s |\n' "$name" "$(value "$name" | sed 's/|/\\|/g')"
done
printf '\n'
printf -- '- upload: **%s**\n' "$upload"
printf -- '- download: **%s**\n' "$download"
printf -- '- round trip byte-identical: **%s**\n' "$roundtrip"
printf '\n'

if [ "$upload" = "success" ] && [ "$roundtrip" = "match" ]; then
  printf 'The artifact path WORKS on this Profile. `actions/upload-artifact`\n'
  printf 'authenticates with `ACTIONS_RUNTIME_TOKEN` against `ACTIONS_RESULTS_URL`,\n'
  printf 'so both exist for an action step here whatever a `run:` step reports --\n'
  printf 'and any claim that this fleet injects nothing has to explain this.\n'
  printf '\n'
  printf 'It also settles the cost of the design: repointing `ACTIONS_RESULTS_URL`\n'
  printf 'or replacing `ACTIONS_RUNTIME_TOKEN` to carry a cache credential takes\n'
  printf 'this away, because the artifact service lives at the same URL behind the\n'
  printf 'same token.\n'
else
  printf 'The artifact path DID NOT complete on this Profile (upload %s, download\n' "$upload"
  printf '%s, round trip %s). If that reproduces it is a parity finding in its own\n' "$download" "$roundtrip"
  printf 'right and a bigger one than the cache: every workflow that uploads an\n'
  printf 'artifact is affected, and it should be filed separately rather than\n'
  printf 'folded into ADR 0007.\n'
fi
