#!/usr/bin/env bash
# Measures how a write burst like a cold pnpm install slows a synchronous load
# of many small modules, the shape of a test that loads a bundler's whole
# configuration at once. Run by .github/workflows/disk-probe.yml.
#
#   bash .github/disk-probe/probe.sh <variant>
#
# <variant> is one or more of these words joined by `+`:
#
#   base     change nothing
#   noatime  remount / with noatime
#   dirty    set vm.dirty_background_bytes and vm.dirty_bytes low
#   tmpfs    put the pnpm store and the install directory on tmpfs
#   lazy     defer writeback: dirty ratios 50/80, expire after an hour, so
#            data deleted or never flushed before the VM ends never reaches
#            the Worker's disk
#
# Other words are labels and change nothing, so a matrix can repeat a
# variant as base+r2.
#
# The first dispatch showed that a load whose files are in the guest's page
# cache takes the same 0.5 s during a burst as after it, and that a load whose
# files must be read from the disk took 15 s while the Worker flushed the
# burst. So every load here is timed twice: `hit` with the files cached, and
# `miss` after posix_fadvise(DONTNEED) evicts node_modules and the store from
# the page cache. The node binary stays cached.
#
# Phases, each marked in phases.log:
#
#   install   pnpm install --frozen-lockfile with an empty store
#   pick      choose about 750 modules and load them once
#   calm      a miss and a hit load before any burst
#   burst<N>  copy the pnpm store until about 2 GiB of small files are written
#   now<N>    a miss and a hit load straight after burst<N>
#   late<N>   a miss load 10 s later, while the Worker flushes the burst
#   sync      a timed sync; the last burst is kept so sync pays for it
#   quiet     a miss load after sync and 20 s of rest
#
# The probe syncs once after `pick` so evicted files are clean. Every variant
# pays that flush of the install; `wrote` lines report the root disk's writes
# from `calm` to the final sync, and during it.
#
# A sampler records the root disk's counters, Dirty, Writeback and, where the
# kernel has it, io PSI, once a second.
set -euo pipefail

variant=${1:?usage: probe.sh <variant>}
repeats=${PROBE_REPEATS:-3}
target=${PROBE_MODULES:-750}
burst_mib=${PROBE_BURST_MIB:-2048}
here=$(cd "$(dirname "$0")" && pwd)
out=${RUNNER_TEMP:-/tmp}/diskprobe
# /var/tmp is on the root filesystem on a guest and on a hosted runner; a
# hosted runner mounts a separate disk at /mnt.
base=/var/tmp/diskprobe
repo=$base/repo
store=$base/store
mkdir -p "$out"
: >"$out/phases.log"
echo "variant $variant" >"$out/loads.log"

now() { date +%s.%N; }
since() { awk -v a="$1" -v b="$(now)" 'BEGIN { printf "%.1f", b - a }'; }
mark() { printf '%s %s\n' "$(now)" "$1" >>"$out/phases.log"; }
has() { case "+$variant+" in *"+$1+"*) return 0 ;; *) return 1 ;; esac; }

# The root block device's stat file; on a guest /dev/vda, on a hosted runner
# a partition of the boot disk.
disk=${PROBE_DISK:-/sys/class/block/$(basename "$(findmnt -no SOURCE /)")/stat}

echo "variant=$variant repeats=$repeats target=$target burst_mib=$burst_mib"
uname -r
nproc
free -m
findmnt -no SOURCE,FSTYPE,OPTIONS /
echo "disk=$disk"
for key in dirty_background_bytes dirty_bytes dirty_background_ratio dirty_ratio dirty_expire_centisecs dirty_writeback_centisecs; do
  printf 'vm.%s=%s\n' "$key" "$(cat /proc/sys/vm/$key)"
done
if [ -r /proc/pressure/io ]; then echo "psi=yes"; else echo "psi=no"; fi
if sudo -n true 2>/dev/null; then echo "sudo=yes"; else echo "sudo=no"; fi

if has noatime; then sudo mount -o remount,noatime /; fi
if has dirty; then
  sudo sysctl -q -w vm.dirty_background_bytes=$((64 << 20)) vm.dirty_bytes=$((256 << 20))
fi
if has lazy; then
  sudo sysctl -q -w vm.dirty_background_ratio=50 vm.dirty_ratio=80 \
    vm.dirty_expire_centisecs=360000 vm.dirty_writeback_centisecs=6000
fi
sudo mkdir -p "$base"
if has tmpfs; then sudo mount -t tmpfs -o size=12g,mode=1777 tmpfs "$base"; fi
sudo chown "$(id -u):$(id -g)" "$base"
findmnt -no SOURCE,FSTYPE,OPTIONS /
findmnt -no SOURCE,FSTYPE,OPTIONS -T "$base"
sysctl vm.dirty_background_bytes vm.dirty_bytes vm.dirty_background_ratio vm.dirty_ratio \
  vm.dirty_expire_centisecs vm.dirty_writeback_centisecs

# The sampler: epoch, disk reads, read sectors, read ms, writes, write
# sectors, write ms, in flight, Dirty KiB, Writeback KiB, io some avg10 (-1
# without PSI). Plain sh without -e, so one failed read skips one field.
(
  set +e
  while :; do
    d=$(awk '{ print $1, $3, $4, $5, $7, $8, $9 }' "$disk")
    m=$(awk '$1 == "Dirty:" { d = $2 } $1 == "Writeback:" { w = $2 } END { print d, w }' /proc/meminfo)
    p=$(awk 'NR == 1 { split($2, a, "="); print a[2] }' /proc/pressure/io 2>/dev/null)
    printf '%s %s %s %s\n' "$(now)" "$d" "$m" "${p:--1}"
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

# Evicts node_modules and the store from the page cache. Dirty pages stay;
# the files are clean by the time a miss load runs, because each burst writes
# elsewhere.
evict() {
  python3 - "$repo/node_modules" "$store" <<'PY'
import os, sys
for root in sys.argv[1:]:
    for d, _, files in os.walk(root):
        for f in files:
            try:
                fd = os.open(os.path.join(d, f), os.O_RDONLY | os.O_NOFOLLOW)
            except OSError:
                continue
            os.posix_fadvise(fd, 0, 0, os.POSIX_FADV_DONTNEED)
            os.close(fd)
PY
}

# One load in a fresh Node process. The disk columns are the root device's
# reads during the load and their mean latency.
load() {
  local label=$1 line t0 a b
  a=$(awk '{ print $1, $3, $4 }' "$disk")
  t0=$(now)
  line=$(node "$here/modload.cjs" load "$repo" "$out/list.txt")
  b=$(awk '{ print $1, $3, $4 }' "$disk")
  printf '%s %s wall=%s %s\n' "$label" "$line" "$(awk -v a="$t0" -v b="$(now)" 'BEGIN { printf "%.0f", (b - a) * 1000 }')" \
    "$(echo "$a $b" | awk '{ n = $4 - $1; printf "reads=%d readMiB=%.0f readms_mean=%.1f", n, ($5 - $2) / 2048, (n > 0 ? ($6 - $3) / n : 0) }')" |
    tee -a "$out/loads.log"
}
miss() { evict && load "$1"; }

mark install
t0=$(now)
pnpm install --frozen-lockfile --store-dir "$store" --reporter=silent >"$out/install.log" 2>&1 || {
  tail -30 "$out/install.log"
  exit 1
}
echo "install seconds=$(since "$t0")" | tee -a "$out/loads.log"
echo "store path: $(pnpm store path --store-dir "$store" 2>/dev/null || echo unknown)"
du -sh --apparent-size "$store" "$repo/node_modules" 2>/dev/null || true
echo "store files: $(find "$store" -type f | wc -l)"
# A symlink here means pnpm linked a global virtual store.
ls -l "$repo/node_modules/.pnpm" | sed -n 2,4p

mark pick
t0=$(now)
node "$here/modload.cjs" pick "$repo" "$target" "$out/list.txt" | sed 's/^/pick /' | tee -a "$out/loads.log"
echo "pick seconds=$(since "$t0")" | tee -a "$out/loads.log"
sync

wsect() { awk '{ print $7 }' "$disk"; }
w_calm=$(wsect)
mark calm
miss calm-miss
load calm-hit

store_mib=$(du -sm --apparent-size "$store" | awk '{ print $1 }')
copies=$(((burst_mib + store_mib - 1) / store_mib))
echo "store_mib=$store_mib copies_per_burst=$copies"
for n in $(seq 1 "$repeats"); do
  mark "burst$n"
  t0=$(now)
  for c in $(seq 1 "$copies"); do cp -r "$store" "$base/burst$n-$c"; done
  echo "burst$n seconds=$(since "$t0")" | tee -a "$out/loads.log"
  mark "now$n"
  miss "now$n-miss"
  load "now$n-hit"
  sleep 10
  mark "late$n"
  miss "late$n-miss"
  if [ "$n" -lt "$repeats" ]; then
    mark "clean$n"
    rm -rf "$base/burst$n"-*
  fi
done

w_sync=$(wsect)
mark sync
t0=$(now)
sync
echo "sync seconds=$(since "$t0")" | tee -a "$out/loads.log"
w_end=$(wsect)
awk -v a="$w_calm" -v b="$w_sync" -v c="$w_end" \
  'BEGIN { printf "wrote before_sync_MiB=%.0f sync_MiB=%.0f\n", (b - a) / 2048, (c - b) / 2048 }' |
  tee -a "$out/loads.log"
sleep 20
mark quiet
miss quiet-miss
load quiet-hit
mark end
sleep 2
kill "$sampler" "$vmstatpid" 2>/dev/null || true
wait 2>/dev/null || true

# Per phase: MiB written to and read from the root disk, the peak in-flight
# count, peak Dirty and Writeback in MiB, peak io PSI some avg10.
summary=$(awk '
  NR == FNR { t[NR] = $1; name[NR] = $2; phases = NR; next }
  {
    s = $1
    for (p = 1; p < phases; p++) if (s >= t[p] && s < t[p + 1]) break
    if (p >= phases) next
    if (!(p in w0)) { w0[p] = $6; r0[p] = $3 }
    w1[p] = $6; r1[p] = $3
    if ($8 > fl[p]) fl[p] = $8
    if ($9 > dirty[p]) dirty[p] = $9
    if ($10 > wb[p]) wb[p] = $10
    if (!(p in psi) || $11 > psi[p]) psi[p] = $11
  }
  END {
    printf "%-8s %8s %8s %8s %8s %8s %8s\n", "phase", "wroteMiB", "readMiB", "inflight", "dirtyMiB", "wbMiB", "io_some"
    for (p = 1; p < phases; p++)
      printf "%-8s %8.0f %8.0f %8d %8.0f %8.0f %8.2f\n", name[p], (w1[p] - w0[p]) / 2048, (r1[p] - r0[p]) / 2048, fl[p], dirty[p] / 1024, wb[p] / 1024, psi[p]
  }' "$out/phases.log" "$out/samples.log")

echo "== loads ($variant)"
cat "$out/loads.log"
echo "== disk per phase ($variant)"
echo "$summary"
for kind in miss hit; do
  echo "$kind ms sorted: $(awk -v k="-$kind" 'index($1, k) { sub("ms=", "", $3); print $3 }' "$out/loads.log" | sort -n | tr '\n' ' ')"
done
if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  {
    printf '### %s\n\n```\n' "$variant"
    cat "$out/loads.log"
    printf '\n%s\n```\n' "$summary"
  } >>"$GITHUB_STEP_SUMMARY"
fi
