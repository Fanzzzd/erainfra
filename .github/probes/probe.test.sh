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

# Now the verdict. Two fixtures: one where the runner overwrote a tier, and one
# where the tier survived. Both have to render, and neither may fail the job.
printf 'ACTIONS_CACHE_URL\tunset\nACTIONS_RUNTIME_TOKEN\tunset\n' > "$work/t0.txt"
printf 'ACTIONS_CACHE_URL\thttps://github.example/_apis/artifactcache/\n' > "$work/t1.txt"
printf 'ACTIONS_CACHE_URL\thttps://github.example/_apis/artifactcache/\n' > "$work/t2.txt"
printf 'ACTIONS_CACHE_URL\t%st3/\nACTIONS_RUNTIME_TOKEN\tpresent, 812 bytes\n' "$base" \
  > "$work/t3.txt"

printf 'success\n' > "$work/t2-client.txt"
printf 'success\n' > "$work/t3-client.txt"

sh "$root/.github/probes/verdict.sh" "$work" > "$work/verdict.md" ||
  fail "the verdict exited non-zero on a measured result"

grep -q 'T2\*\*, a step-level `env:` block: OVERWRITTEN' "$work/verdict.md" ||
  fail "the verdict did not report the overwritten tier"
grep -q 'T3\*\*, written through `\$GITHUB_ENV`: the value set at this tier SURVIVED' \
  "$work/verdict.md" || fail "the verdict did not report the surviving tier"
grep -q 'ACTIONS_RESULTS_URL. | not measured' "$work/verdict.md" ||
  fail "a variable no tier measured was not reported as unmeasured"

# The client result is a SEPARATE claim from the tier snapshot above, and it has
# three shapes rather than two. The requests driven at the top of this file went
# to both prefixes, so both tiers read as honoured here.
grep -q '\*\*t2\*\*: the client HONOURED this tier' "$work/verdict.md" ||
  fail "the verdict did not report that a client reached the t2 prefix"
grep -q '\*\*t3\*\*: the client HONOURED this tier' "$work/verdict.md" ||
  fail "the verdict did not report that a client reached the t3 prefix"

# The other two shapes, and the distinction that matters: an empty capture log
# means the client went elsewhere ONLY if the client actually ran. A client step
# that never completed -- both are continue-on-error -- proves nothing about the
# environment, and reporting that as an overwritten tier would be inventing a
# measurement.
: > "$work/capture.jsonl"
printf 'success\n' > "$work/t2-client.txt"
printf 'failure\n' > "$work/t3-client.txt"
sh "$root/.github/probes/verdict.sh" "$work" > "$work/verdict-empty.md" ||
  fail "the verdict exited non-zero when nothing reached the endpoint"
grep -q 'The capture log is empty' "$work/verdict-empty.md" ||
  fail "an empty capture log was not reported"
grep -q '\*\*t2\*\*: the client WENT ELSEWHERE' "$work/verdict-empty.md" ||
  fail "a client that ran and sent nothing to the probe was not reported as such"
grep -q '\*\*t3\*\*: INCONCLUSIVE' "$work/verdict-empty.md" ||
  fail "a client step that never completed was reported as a measurement"
if grep -q '\*\*t3\*\*: the client WENT ELSEWHERE' "$work/verdict-empty.md"; then
  fail "an incomplete client step was reported as evidence about the tier"
fi

# The tier snapshot must be unchanged by any of that: it is read from the step
# environment and does not depend on a client at all.
grep -q 'T3\*\*, written through `\$GITHUB_ENV`: the value set at this tier SURVIVED' \
  "$work/verdict-empty.md" ||
  fail "the tier verdict changed when the client result did"

# Nothing recorded at all -- the job died before the outcomes were written -- is
# inconclusive too, and must not read as "the client went elsewhere".
rm -f "$work/t2-client.txt" "$work/t3-client.txt"
sh "$root/.github/probes/verdict.sh" "$work" > "$work/verdict-unrecorded.md" ||
  fail "the verdict exited non-zero with no client outcome recorded"
grep -q '\*\*t2\*\*: INCONCLUSIVE' "$work/verdict-unrecorded.md" ||
  fail "an unrecorded client outcome was not reported as inconclusive"

echo "probe self-test OK"
