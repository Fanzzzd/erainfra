#!/bin/sh
# A local-only disk workload shaped like a pnpm install from a warm store, so
# one guest alone and several guests at once can be compared on the same
# Worker. No network: the uplink must not move the numbers.
#
#   sh .github/bench/contention.sh <label>
#
# Steps, each printed as `contention.<label>.<step>=<seconds>`:
#
#   write   40,000 files of 4 KiB in 2,000 directories (a package store)
#   link    three hardlink copies of that tree (pnpm's node_modules import)
#   sync    flush everything written so far
#   remove  delete the three copies and the store
#   seq     1 GiB sequential write, then fsync
#
# `started` is the wall-clock epoch the workload began, so a reader can check
# that the parallel legs really overlapped.
set -eu

label=${1:?usage: contention.sh <label>}
scratch=${RUNNER_TEMP:-${TMPDIR:-/tmp}}/rc-contention-$$
mkdir -p "$scratch"
trap 'rm -rf "$scratch"' EXIT

now() { date +%s.%N; }
elapsed() { awk -v a="$1" -v b="$2" 'BEGIN { printf "%.2f", b - a }'; }
report() {
  printf 'contention.%s.%s=%s\n' "$label" "$1" "$2"
  if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
    printf '| %s | %s | %s |\n' "$label" "$1" "$2" >>"$GITHUB_STEP_SUMMARY"
  fi
}

if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  printf '\n| leg | step | seconds |\n|---|---|---|\n' >>"$GITHUB_STEP_SUMMARY"
fi

report host "$(uname -m)/$(uname -r)/nproc=$(nproc)"
report started "$(date +%s)"

t0=$(now)
python3 - "$scratch/store" <<'PY'
import os, sys
root = sys.argv[1]
block = os.urandom(4096)
for d in range(2000):
    path = os.path.join(root, f"{d:04d}")
    os.makedirs(path)
    for f in range(20):
        with open(os.path.join(path, f"{f:02d}.js"), "wb") as fh:
            fh.write(block)
PY
report write "$(elapsed "$t0" "$(now)")"

t0=$(now)
for copy in 1 2 3; do cp -al "$scratch/store" "$scratch/nm$copy"; done
report link "$(elapsed "$t0" "$(now)")"

t0=$(now); sync; report sync "$(elapsed "$t0" "$(now)")"

t0=$(now); rm -rf "$scratch/nm1" "$scratch/nm2" "$scratch/nm3" "$scratch/store"; sync
report remove "$(elapsed "$t0" "$(now)")"

t0=$(now); dd if=/dev/zero of="$scratch/seq" bs=1M count=1024 conv=fsync 2>/dev/null
report seq "$(elapsed "$t0" "$(now)")"
