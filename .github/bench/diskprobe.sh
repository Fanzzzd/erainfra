#!/usr/bin/env bash
# Measures how a fresh install's write burst slows a synchronous load of many
# small modules, the shape of a test that loads a bundler's whole
# configuration at once. Run by .github/workflows/disk-probe.yml.
#
#   bash .github/bench/diskprobe.sh <variant>
#
# <variant> is one or more of these words joined by `+`:
#
#   base     change nothing
#   noatime  remount / with noatime
#   dirty    set vm.dirty_background_bytes and vm.dirty_bytes low
#   tmpfs    put the pnpm store and the install directory on tmpfs
#
# Phases, each marked in phases.log:
#
#   install   pnpm install --frozen-lockfile with an empty store
#   pick      choose about 750 modules and load them once (the first read)
#   copy<N>   delete node_modules and import it again from the store by copy,
#             writing a new copy of every file
#   fresh<N>  load the modules straight after copy<N>, while it is flushed
#   again<N>  load the same files a second time, with no atime update due
#   quiet     load after sync, nothing pending
#   cold<N>   load after dropping the page cache
#
# A sampler records PSI, Dirty and Writeback once a second, and vmstat runs
# beside it. The summary prints load times and the peak pressure per phase.
set -euo pipefail

variant=${1:?usage: diskprobe.sh <variant>}
repeats=${PROBE_REPEATS:-3}
target=${PROBE_MODULES:-750}
here=$(cd "$(dirname "$0")" && pwd)
out=${RUNNER_TEMP:-/tmp}/diskprobe
# /var/tmp is on the root filesystem on a guest and on a hosted runner; a
# hosted runner mounts a separate disk at /mnt.
base=/var/tmp/diskprobe
repo=$base/repo
mkdir -p "$out"
: >"$out/phases.log"
: >"$out/loads.log"

now() { date +%s.%N; }
mark() { printf '%s %s\n' "$(now)" "$1" >>"$out/phases.log"; }

has() { case "+$variant+" in *"+$1+"*) return 0 ;; *) return 1 ;; esac; }

echo "variant=$variant repeats=$repeats target=$target"
uname -r
nproc
free -m
findmnt -no SOURCE,FSTYPE,OPTIONS /
for key in dirty_background_bytes dirty_bytes dirty_background_ratio dirty_ratio dirty_expire_centisecs dirty_writeback_centisecs; do
  printf 'vm.%s=%s\n' "$key" "$(cat /proc/sys/vm/$key)"
done
cat /sys/block/vda/queue/scheduler 2>/dev/null || true
if sudo -n true 2>/dev/null; then echo "sudo=yes"; else echo "sudo=no"; fi

if has noatime; then sudo mount -o remount,noatime /; fi
if has dirty; then
  sudo sysctl -q -w vm.dirty_background_bytes=$((64 << 20)) vm.dirty_bytes=$((256 << 20))
fi
sudo mkdir -p "$base"
if has tmpfs; then sudo mount -t tmpfs -o size=12g,mode=1777 tmpfs "$base"; fi
sudo chown "$(id -u):$(id -g)" "$base"
findmnt -no SOURCE,FSTYPE,OPTIONS /
findmnt -no SOURCE,FSTYPE,OPTIONS -T "$base"
sysctl vm.dirty_background_bytes vm.dirty_bytes

# The sampler: epoch, io some/full avg10 and total, cpu some avg10 and total,
# Dirty and Writeback in KiB.
(
  while :; do
    io=$(awk '{ for (i = 2; i <= NF; i++) { split($i, kv, "="); printf "%s ", kv[2] } }' /proc/pressure/io)
    cpu=$(awk 'NR == 1 { split($2, a, "="); split($5, t, "="); printf "%s %s", a[2], t[2] }' /proc/pressure/cpu)
    mem=$(awk '$1 == "Dirty:" { d = $2 } $1 == "Writeback:" { w = $2 } END { printf "%s %s", d, w }' /proc/meminfo)
    printf '%s %s%s %s\n' "$(now)" "$io" "$cpu" "$mem"
    sleep 1
  done
) >"$out/samples.log" 2>/dev/null &
sampler=$!
vmstat -n -t 1 >"$out/vmstat.log" 2>&1 &
vmstatpid=$!
trap 'kill "$sampler" "$vmstatpid" 2>/dev/null || true' EXIT

mkdir -p "$repo"
git -C "${GITHUB_WORKSPACE:-.}" archive HEAD | tar -x -C "$repo"
cd "$repo"
export npm_config_store_dir="$base/store"
sleep 3

load() {
  local label=$1 line t0
  t0=$(now)
  line=$(node "$here/modload.cjs" load "$repo" "$out/list.txt")
  printf '%s %s wall=%s\n' "$label" "$line" "$(awk -v a="$t0" -v b="$(now)" 'BEGIN { printf "%.0f", (b - a) * 1000 }')" |
    tee -a "$out/loads.log"
}

mark install
t0=$(now)
pnpm install --frozen-lockfile --reporter=silent >"$out/install.log" 2>&1 || {
  tail -30 "$out/install.log"
  exit 1
}
printf 'install seconds=%s\n' "$(awk -v a="$t0" -v b="$(now)" 'BEGIN { printf "%.1f", b - a }')" | tee -a "$out/loads.log"

mark pick
node "$here/modload.cjs" pick "$repo" "$target" "$out/list.txt" | sed 's/^/pick /' | tee -a "$out/loads.log"

for n in $(seq 1 "$repeats"); do
  mark "copy$n"
  t0=$(now)
  rm -rf node_modules apps/*/node_modules packages/*/node_modules
  pnpm install --frozen-lockfile --offline --package-import-method=copy --reporter=silent >>"$out/install.log" 2>&1
  printf 'copy%s seconds=%s\n' "$n" "$(awk -v a="$t0" -v b="$(now)" 'BEGIN { printf "%.1f", b - a }')" | tee -a "$out/loads.log"
  mark "fresh$n"
  load "fresh$n"
  mark "again$n"
  load "again$n"
done

mark sync
sync
mark quiet
load quiet
for n in 1 2; do
  sync
  echo 3 | sudo tee /proc/sys/vm/drop_caches >/dev/null
  mark "cold$n"
  load "cold$n"
done
mark end
sleep 2
kill "$sampler" "$vmstatpid" 2>/dev/null || true
wait 2>/dev/null || true

# Per phase: peak io some avg10, peak io full avg10, the share of the phase
# with some task stalled on io (from the total counter), peak cpu some avg10,
# peak Dirty and Writeback in MiB.
summary=$(awk '
  NR == FNR { t[NR] = $1; name[NR] = $2; phases = NR; next }
  {
    s = $1
    for (p = 1; p < phases; p++) if (s >= t[p] && s < t[p + 1]) break
    if (p >= phases) next
    if ($2 > ios[p]) ios[p] = $2
    if ($6 > iof[p]) iof[p] = $6
    if ($10 > cpu[p]) cpu[p] = $10
    if ($12 > dirty[p]) dirty[p] = $12
    if ($13 > wb[p]) wb[p] = $13
    if (!(p in first)) { first[p] = $5; firsts[p] = s }
    last[p] = $5; lasts[p] = s
  }
  END {
    printf "%-8s %8s %8s %8s %8s %8s %8s\n", "phase", "io_some", "io_full", "io_stall", "cpu_some", "dirtyMB", "wbMB"
    for (p = 1; p < phases; p++) {
      span = (lasts[p] - firsts[p]) * 1e6
      stall = span > 0 ? (last[p] - first[p]) / span * 100 : 0
      printf "%-8s %8.2f %8.2f %7.0f%% %8.2f %8.0f %8.0f\n", name[p], ios[p], iof[p], stall, cpu[p], dirty[p] / 1024, wb[p] / 1024
    }
  }' "$out/phases.log" "$out/samples.log")

echo "== loads ($variant)"
cat "$out/loads.log"
echo "== pressure per phase ($variant)"
echo "$summary"
fresh=$(awk '$1 ~ /^fresh/ { sub("ms=", "", $3); print $3 }' "$out/loads.log" | sort -n | tr '\n' ' ')
again=$(awk '$1 ~ /^again/ { sub("ms=", "", $3); print $3 }' "$out/loads.log" | sort -n | tr '\n' ' ')
echo "fresh ms sorted: $fresh"
echo "again ms sorted: $again"
if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  {
    printf '### %s\n\n```\n' "$variant"
    cat "$out/loads.log"
    printf '\n%s\n```\n' "$summary"
  } >>"$GITHUB_STEP_SUMMARY"
fi
