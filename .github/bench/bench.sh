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
#   smallread  cold read of 20 000 4 KiB files after drop_caches: seek latency
#   seqwrite   1 GiB sequential write through the page cache, then fsync
#   seqread    the same file read back cold: throughput
#
# drop_caches needs root. Every leg this runs on has passwordless sudo (a
# hosted runner, the guest's `runner` account, a Docker container started
# with --privileged); when it does not, the cold reads are reported as warm
# and flagged.
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

drop_caches() {
  sync
  if sudo -n sh -c 'echo 3 > /proc/sys/vm/drop_caches' 2>/dev/null; then
    return 0
  fi
  return 1
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
if drop_caches; then report cold_reads yes; else report cold_reads "NO (no root: reads below are warm)"; fi

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

# 20 000 files of 4 KiB in 200 directories: the shape of node_modules, and of
# what vitest's transform and import phases read.
tree="$scratch/tree"
mkdir -p "$tree"
i=0
while [ "$i" -lt 200 ]; do
  mkdir -p "$tree/d$i"
  j=0
  while [ "$j" -lt 100 ]; do
    head -c 4096 /dev/urandom >"$tree/d$i/f$j"
    j=$((j + 1))
  done
  i=$((i + 1))
done
drop_caches || true
t0=$(now); find "$tree" -type f -exec cat {} + >/dev/null
report smallread "$(elapsed "$t0" "$(now)")"

t0=$(now); dd if=/dev/zero of="$scratch/seq" bs=1M count=1024 conv=fsync 2>/dev/null
report seqwrite "$(elapsed "$t0" "$(now)")"
drop_caches || true
t0=$(now); dd if="$scratch/seq" of=/dev/null bs=1M 2>/dev/null
report seqread "$(elapsed "$t0" "$(now)")"
