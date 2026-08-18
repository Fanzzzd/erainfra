#!/bin/sh
# The probe's own self-test, run on every pull request.
#
# cache-env-probe.yml is dispatched by hand against a live Profile, so nothing
# in CI ever executes it and a probe that silently measured nothing would look
# exactly like a probe that had not been run yet. This drives the capture
# endpoint with a real HTTP client, checks each answer against the shape ADR
# 0007's capture measured, and proves the verdict renders BOTH outcomes --
# including the negative one, which is the outcome the probe exists to be able
# to report.

# The greps at the end match Markdown the verdict prints, so backticks and the
# literal string $GITHUB_ENV appear inside single quotes on purpose: they are the
# text being searched for, not an expansion.
# shellcheck disable=SC2016

set -eu

root=$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd)
work=$(mktemp -d "${TMPDIR:-/tmp}/erainfra-probe-test-XXXXXXXX")
server_pid=""

cleanup() {
  if [ -n "$server_pid" ]; then
    kill "$server_pid" 2>/dev/null || true
  fi
  rm -rf "$work"
}
trap cleanup EXIT

fail() {
  printf 'probe self-test: %s\n' "$1" >&2
  exit 1
}

# Two sentinels, because two different things must never reach the log and they
# arrive by different routes. Values that cannot occur by accident, so each
# check is against a string only this test could have produced.
#
#   credential -- sent as the bearer token, the way a client sends the runner's
#                 own ACTIONS_RUNTIME_TOKEN.
#   cache key  -- sent in the v1 `keys=` query parameter, which is where a real
#                 restore puts a lockfile hash or a branch name. The capture log
#                 is printed into a job summary, so a key that survived into it
#                 would be a private repository's key in a public place.
sentinel=probe-self-test-credential-2f4b9c
key_sentinel=probe-self-test-cache-key-7d10ae
version_sentinel=probe-self-test-version-c33b91

PROBE_LOG="$work/capture.jsonl" PROBE_URL_FILE="$work/url" \
  node "$root/.github/probes/cache-capture-server.mjs" > "$work/server.out" 2>&1 &
server_pid=$!

tries=50
while [ ! -s "$work/url" ] && [ "$tries" -gt 0 ]; do
  sleep 0.1
  tries=$((tries - 1))
done
[ -s "$work/url" ] || fail "the capture endpoint never bound a port"
base=$(cat "$work/url")

status() {
  # $1 method, $2 path, $3.. curl extras. Prints the status code alone.
  method=$1
  path=$2
  shift 2
  curl --silent --output "$work/body" --write-out '%{http_code}' \
    --max-time 10 --request "$method" \
    --header "Authorization: Bearer $sentinel" \
    "$@" "${base%/}$path"
}

# v1 restore, carrying a cache key and a version the way a real one does. 204
# and NEVER 404: a 404 is what makes actions/cache print a warning instead of
# taking a silent miss (capture L001, L121).
code=$(status GET \
  "/t2/_apis/artifactcache/cache?keys=$key_sentinel&version=$version_sentinel")
[ "$code" = "204" ] || fail "v1 restore answered $code, not 204"
[ ! -s "$work/body" ] || fail "the 204 carried a body"

# v1 reserve. Refused, so a save stops before it uploads anything.
code=$(status POST "/t2/_apis/artifactcache/caches" --data '{"key":"probe","version":"1"}')
[ "$code" = "409" ] || fail "v1 reserve answered $code, not 409"

# v2 miss: the twirp call SUCCEEDS and ok is false (capture L007).
code=$(status POST \
  "/t3/twirp/github.actions.results.api.v1.CacheService/GetCacheEntryDownloadURL" \
  --data '{"key":"probe"}')
[ "$code" = "200" ] || fail "v2 restore answered $code, not 200"
grep -q '"ok":false' "$work/body" || fail "v2 restore did not answer ok:false"

# The artifact service shares ACTIONS_RESULTS_URL with the cache service, and
# this probe does not implement it. Recording that rather than answering it is
# how the collision stays visible.
code=$(status POST \
  "/t3/twirp/github.actions.results.api.v1.ArtifactService/CreateArtifact" --data '{}')
[ "$code" = "404" ] || fail "an artifact call answered $code, not 404"
grep -q '"generation":"other"' "$work/capture.jsonl" ||
  fail "an artifact call was not recorded as a non-cache request"

# Four requests, four records, and not one of them carrying the credential the
# client sent. The log is printed into a job summary, so this is the property
# that keeps a runner token out of it.
lines=$(wc -l < "$work/capture.jsonl" | tr -d ' ')
[ "$lines" = "4" ] || fail "the capture log holds $lines records, not 4"
if grep -q "$sentinel" "$work/capture.jsonl"; then
  fail "the capture log carried the Authorization value"
fi
if grep -q "$key_sentinel" "$work/capture.jsonl"; then
  fail "the capture log carried the cache key"
fi
if grep -q "$version_sentinel" "$work/capture.jsonl"; then
  fail "the capture log carried the cache version"
fi
grep -q '"authorization":"present"' "$work/capture.jsonl" ||
  fail "the capture log did not record that a credential was sent"
# Dropping the query must not cost the evidence that there WAS one: "a restore
# arrived and it carried keys" is the finding, and the keys are not.
grep -q '"query":"present"' "$work/capture.jsonl" ||
  fail "the capture log did not record that the request carried a query string"
grep -q '"path":"/t2/_apis/artifactcache/cache"' "$work/capture.jsonl" ||
  fail "the capture log did not record the bare pathname"

kill "$server_pid"
server_pid=""


# The two renderers. tiers.sh reads a script step's environment in shell and
# env-action reads an action step's in Node, and the verdict puts their output
# in one table -- so they have to agree character for character on every shape,
# including the two that are easy to conflate (unset and set-but-empty) and the
# one that must never print a value.
# Every one of the four names is controlled explicitly, because this test also
# runs inside a GitHub job where some of them are already set.
env -u ACTIONS_CACHE_SERVICE_V2 \
  ACTIONS_CACHE_URL="http://127.0.0.1:9/t2/" \
  ACTIONS_RESULTS_URL="" \
  ACTIONS_RUNTIME_TOKEN="0123456789" \
  sh -c 'cd "$1" && . ./.github/probes/tiers.sh && snapshot_tier "$2"' \
  _ "$root" "$work/render-shell.txt"

env -u ACTIONS_CACHE_SERVICE_V2 \
  ACTIONS_CACHE_URL="http://127.0.0.1:9/t2/" \
  ACTIONS_RESULTS_URL="" \
  ACTIONS_RUNTIME_TOKEN="0123456789" \
  INPUT_OUT="$work/render-action.txt" \
  node "$root/.github/probes/env-action/index.mjs" > /dev/null

cmp -s "$work/render-shell.txt" "$work/render-action.txt" ||
  fail "the shell and action renderers disagree:
$(diff -u "$work/render-shell.txt" "$work/render-action.txt" || true)"
grep -q 'ACTIONS_CACHE_SERVICE_V2	unset' "$work/render-shell.txt" ||
  fail "an absent variable was not rendered as unset"
grep -q 'ACTIONS_RESULTS_URL	set-but-empty' "$work/render-shell.txt" ||
  fail "a variable set to the empty string was not distinguished from an absent one"
grep -q 'ACTIONS_RUNTIME_TOKEN	present, 10 bytes' "$work/render-shell.txt" ||
  fail "the runtime token was not rendered by length"
if grep -q '0123456789' "$work/render-action.txt"; then
  fail "the action renderer wrote the runtime token's value"
fi

# Now the verdict. The first fixture is this iteration's whole reason for
# existing: an override that holds in a script step and loses in an action step.
# Every real cache client is an action step, so those two are not the same
# finding and the verdict has to say so out loud.
github=https://acghubeus1.actions.githubusercontent.com/x/
printf 'ACTIONS_CACHE_URL\tunset\nACTIONS_RUNTIME_TOKEN\tunset\n' > "$work/t0.txt"
printf 'ACTIONS_CACHE_URL\tunset\nACTIONS_RUNTIME_TOKEN\tunset\n' > "$work/t1.txt"
printf 'ACTIONS_CACHE_URL\t%s\nACTIONS_RUNTIME_TOKEN\tpresent, 812 bytes\n' "$github" \
  > "$work/t1a.txt"
printf 'ACTIONS_CACHE_URL\t%st2/\n' "$base" > "$work/t2.txt"
printf 'ACTIONS_CACHE_URL\t%s\n' "$github" > "$work/t2a.txt"
printf 'ACTIONS_CACHE_URL\t%st3/\n' "$base" > "$work/t3.txt"
printf 'ACTIONS_CACHE_URL\t%st3/\n' "$base" > "$work/t3a.txt"
for tier in t2 t2tok t3 t3tok; do
  printf 'success\n' > "$work/$tier-client.txt"
done

sh "$root/.github/probes/verdict.sh" "$work" > "$work/verdict.md" ||
  fail "the verdict exited non-zero on a measured result"

grep -q 'script step SURVIVED, action step OVERWRITTEN' "$work/verdict.md" ||
  fail "the verdict did not separate the script tier from the action tier"
grep -q 'cannot deliver a cache endpoint to one' "$work/verdict.md" ||
  fail "the verdict did not draw the consequence of an action step losing the override"
grep -q 'T3, written through `\$GITHUB_ENV`\*\*: script step SURVIVED, action step SURVIVED' \
  "$work/verdict.md" || fail "the verdict did not report a tier that survived in both step kinds"
grep -q 'T1 \*\*action\*\* step, no override' "$work/verdict.md" ||
  fail "the action tier is missing from the table"

# T0 has three shapes, and the first one matters most: a run where nothing set
# the container environment must say it measured NOTHING about T0 rather than
# reporting an absence as a result. That is the shape every run takes until an
# operator turns the Agent seam on.
grep -q 'says NOTHING about T0' "$work/verdict.md" ||
  fail "a run that never exercised T0 did not say so"
grep -q 'not exercised -- the container was given no value' "$work/verdict.md" ||
  fail "an unexercised T0 was not labelled as such"

printf 'ACTIONS_CACHE_URL\thttps://cache.lan/erainfra/\nACTIONS_CACHE_SERVICE_V2\tfalse\n' \
  > "$work/t0.txt"
printf 'ACTIONS_CACHE_URL\thttps://cache.lan/erainfra/\nACTIONS_CACHE_SERVICE_V2\tfalse\n' \
  > "$work/t1a.txt"
sh "$root/.github/probes/verdict.sh" "$work" > "$work/verdict-t0-wins.md" ||
  fail "the verdict exited non-zero on a surviving T0"
grep -q 'ACTIONS_CACHE_URL`: SURVIVED into an action step' "$work/verdict-t0-wins.md" ||
  fail "a container value an action step still saw was not reported as surviving"
if grep -q 'says NOTHING about T0' "$work/verdict-t0-wins.md"; then
  fail "an exercised T0 was still reported as unexercised"
fi

# The runner writes the flag as `True` and an EraInfra-set value is `true`, so
# the capitalisation alone is the tell that the value in an action step is the
# runner's own. An equality check that normalised case would miss it.
printf 'ACTIONS_CACHE_URL\t%s\nACTIONS_CACHE_SERVICE_V2\tTrue\n' "$github" > "$work/t1a.txt"
sh "$root/.github/probes/verdict.sh" "$work" > "$work/verdict-t0-loses.md" ||
  fail "the verdict exited non-zero on an overwritten T0"
grep -q 'ACTIONS_CACHE_URL`: OVERWRITTEN in an action step' "$work/verdict-t0-loses.md" ||
  fail "a container value the runner replaced was not reported as overwritten"
grep -q 'ACTIONS_CACHE_SERVICE_V2`: OVERWRITTEN in an action step' "$work/verdict-t0-loses.md" ||
  fail "a flag the runner rewrote from true to True was not reported as overwritten"

# Restore the unexercised fixture for the client-section cases below, which do
# not depend on T0 and should not silently inherit this one.
printf 'ACTIONS_CACHE_URL\tunset\nACTIONS_RUNTIME_TOKEN\tunset\n' > "$work/t0.txt"
printf 'ACTIONS_CACHE_URL\t%s\nACTIONS_RUNTIME_TOKEN\tpresent, 812 bytes\n' "$github" \
  > "$work/t1a.txt"
# A variable no snapshot recorded reads as "not measured", which is not the same
# as "unset": the first says the step never ran, the second is a finding.
grep -q '| not measured |' "$work/verdict.md" ||
  fail "a variable no tier measured was not reported as unmeasured"
grep -q '| unset |' "$work/verdict.md" ||
  fail "a variable a tier measured as absent was not reported as unset"

# The client result is a SEPARATE claim from the tier snapshot, and it has three
# shapes rather than two. The requests driven at the top of this file went to
# the t2 and t3 prefixes, so those read as honoured and the two token variants
# have nothing.
grep -q '\*\*t2\*\* (step `env:`, no runtime token): the client HONOURED this tier' \
  "$work/verdict.md" || fail "the verdict did not report a client reaching the t2 prefix"
grep -q '\*\*t3\*\* (`\$GITHUB_ENV`, no runtime token): the client HONOURED this tier' \
  "$work/verdict.md" || fail "the verdict did not report a client reaching the t3 prefix"
grep -q '\*\*t2tok\*\* (step `env:`, dummy runtime token): the client WENT ELSEWHERE' \
  "$work/verdict.md" || fail "the dummy-token client run is not reported"
grep -q '\*\*t3tok\*\*' "$work/verdict.md" ||
  fail "the second dummy-token client run is not reported"

# An empty capture log means the client went elsewhere ONLY if the client
# actually ran. A client step that never completed -- all four are
# continue-on-error -- proves nothing about the environment, and reporting that
# as an overwritten tier would be inventing a measurement.
: > "$work/capture.jsonl"
printf 'success\n' > "$work/t2-client.txt"
printf 'failure\n' > "$work/t3-client.txt"
sh "$root/.github/probes/verdict.sh" "$work" > "$work/verdict-empty.md" ||
  fail "the verdict exited non-zero when nothing reached the endpoint"
grep -q 'The capture log is empty' "$work/verdict-empty.md" ||
  fail "an empty capture log was not reported"
grep -q '\*\*t2\*\* (step `env:`, no runtime token): the client WENT ELSEWHERE' \
  "$work/verdict-empty.md" ||
  fail "a client that ran and sent nothing to the probe was not reported as such"
grep -q '\*\*t3\*\* (`\$GITHUB_ENV`, no runtime token): INCONCLUSIVE' "$work/verdict-empty.md" ||
  fail "a client step that never completed was reported as a measurement"
if grep -q '\*\*t3\*\* (`\$GITHUB_ENV`, no runtime token): the client WENT ELSEWHERE' \
  "$work/verdict-empty.md"; then
  fail "an incomplete client step was reported as evidence about the tier"
fi

# The tier snapshot must be unchanged by any of that: it is read from the step
# environment and does not depend on a client at all.
grep -q 'script step SURVIVED, action step OVERWRITTEN' "$work/verdict-empty.md" ||
  fail "the tier verdict changed when the client result did"

# Nothing recorded at all -- the job died before the outcomes were written -- is
# inconclusive too, and must not read as "the client went elsewhere".
rm -f "$work"/t2-client.txt "$work"/t2tok-client.txt "$work"/t3-client.txt "$work"/t3tok-client.txt
sh "$root/.github/probes/verdict.sh" "$work" > "$work/verdict-unrecorded.md" ||
  fail "the verdict exited non-zero with no client outcome recorded"
grep -q '\*\*t2\*\* (step `env:`, no runtime token): INCONCLUSIVE' "$work/verdict-unrecorded.md" ||
  fail "an unrecorded client outcome was not reported as inconclusive"

# The artifact control. Its whole job is to stop "a script step saw nothing"
# from being read as "this fleet injects nothing", so both of its outcomes have
# to render and the working one has to say what it costs the design.
printf 'success\n' > "$work/upload.txt"
printf 'success\n' > "$work/download.txt"
printf 'match\n' > "$work/roundtrip.txt"
sh "$root/.github/probes/artifact-control.sh" "$work" > "$work/control.md" ||
  fail "the artifact control exited non-zero on a working round trip"
grep -q 'The artifact path WORKS on this Profile' "$work/control.md" ||
  fail "a working artifact round trip was not reported"
grep -q 'same URL behind the' "$work/control.md" ||
  fail "the control did not state what repointing ACTIONS_RESULTS_URL would cost"
grep -q 'present, 812 bytes' "$work/control.md" ||
  fail "the control did not report what an action step is given"
if grep -q "$github" "$work/control.md" && ! grep -q 'ACTIONS_CACHE_URL' "$work/control.md"; then
  fail "the control table is missing its variable column"
fi

printf 'failure\n' > "$work/upload.txt"
printf 'no-match\n' > "$work/roundtrip.txt"
sh "$root/.github/probes/artifact-control.sh" "$work" > "$work/control-broken.md" ||
  fail "the artifact control exited non-zero on a broken round trip"
grep -q 'DID NOT complete on this Profile' "$work/control-broken.md" ||
  fail "a broken artifact round trip was not reported"
grep -q 'filed separately' "$work/control-broken.md" ||
  fail "a broken artifact path was not called out as its own finding"

echo "probe self-test OK"
