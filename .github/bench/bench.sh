#!/bin/sh
# One workload, timed step by step, run identically on `ubuntu-latest`, on a
# Firecracker Profile, and inside the same Image Release under Docker on a
# Worker host. Its only purpose is to attribute a slow CI job to CPU, to disk,
# or to the executor, which a job's total wall clock cannot do.
#
#   sh .github/bench/bench.sh <label>          # from a checkout, after pnpm/node are on PATH
#
# Prints `bench.<label>.<step>=<seconds>` lines to stdout and a Markdown table
# to $GITHUB_STEP_SUMMARY when that is set. Steps:
#
#   install    pnpm install --frozen-lockfile with an empty store: network,
#              then tens of thousands of small file writes
#   typecheck  the TypeScript packages' typecheck: CPU-bound, reads node_modules once
#   test       the TypeScript packages' tests: the shape a consumer's failing
#              step had (#137). The three Go packages are excluded so the
#              workload needs no Go toolchain on any leg
#   seqwrite   1 GiB sequential write through the page cache, then fsync
#
# There is no cold-read probe on purpose: drop_caches inside a guest or a
# container leaves the host's page cache (and a RAID controller's) warm, so
# the number it produces is the cache, not the disk. `install` is the honest
# small-file write; nothing here measures a cold read.
set -eu

label=${1:?usage: bench.sh <label>}
scratch=${RUNNER_TEMP:-${TMPDIR:-/tmp}}/rc-bench-$$
mkdir -p "$scratch"
trap 'rm -rf "$scratch"' EXIT

now() { date +%s.%N; }
elapsed() { awk -v a="$1" -v b="$2" 'BEGIN { printf "%.2f", b - a }'; }
report() {
  printf 'bench.%s.%s=%s\n' "$label" "$1" "$2"
  if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
    printf '| %s | %s | %s |\n' "$label" "$1" "$2" >>"$GITHUB_STEP_SUMMARY"
  fi
}

if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  {
    printf '\n### bench %s\n\n' "$label"
    printf '| leg | step | seconds |\n|---|---|---|\n'
  } >>"$GITHUB_STEP_SUMMARY"
fi

report host "$(uname -m)/$(uname -r)/nproc=$(nproc)"
report node "$(node --version 2>/dev/null || echo absent)"
report pnpm "$(pnpm --version 2>/dev/null || echo absent)"

# A private store so every leg downloads and writes the same bytes; a warm
# store on one leg would measure the cache, not the disk.
export npm_config_store_dir="$scratch/pnpm-store"
t0=$(now); pnpm install --frozen-lockfile >"$scratch/install.log" 2>&1 || { tail -20 "$scratch/install.log"; exit 1; }
report install "$(elapsed "$t0" "$(now)")"

set -- --filter='!@erainfra/cache-service' --filter='!@erainfra/controller' --filter='!@erainfra/runtime'
t0=$(now); pnpm exec turbo run typecheck "$@" --no-cache >"$scratch/typecheck.log" 2>&1 || { tail -20 "$scratch/typecheck.log"; exit 1; }
report typecheck "$(elapsed "$t0" "$(now)")"

# The suite's exit status is recorded, not enforced: one backend file needs
# pwsh at collection time and legs without it fail that file while the rest
# of the suite runs to completion, which is the timing this wants.
t0=$(now); if pnpm exec turbo run test "$@" --no-cache >"$scratch/test.log" 2>&1; then test_exit=0; else test_exit=$?; fi
report test "$(elapsed "$t0" "$(now)")"
report test_exit "$test_exit"

t0=$(now); dd if=/dev/zero of="$scratch/seq" bs=1M count=1024 conv=fsync 2>/dev/null
report seqwrite "$(elapsed "$t0" "$(now)")"
