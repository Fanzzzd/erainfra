#!/bin/sh
# The EraInfra environment fingerprint: one script, run identically on
# `ubuntu-latest` and on every Linux Profile, so `diff.sh` can compare them.
#
#   sh .github/conformance/fingerprint.sh [output-file]
#
# Output is `key=value`, one per line, sorted by key under LC_ALL=C. Two rules
# decide what belongs in it.
#
# 1. Record what the job SEES *and* what it is actually ALLOWED. #80 lived
#    entirely in the gap between those two: `nproc` reported 64 while the CFS
#    quota allowed 8, and every build tool that autosizes reads the former. A
#    dimension that records only the visible half is blind to that whole bug
#    class, which is why the derived `*_matches_allowed` keys exist and why
#    `allowlist.txt` refuses to let anyone excuse them.
#
# 2. Be deterministic. Anything that moves between two runs on the same
#    machine -- uptime, a hostname, a container id, an address, free bytes to
#    the byte, a timestamp -- is normalised or left out; `allowlist.txt` lists
#    what was left out and why. Both the self-test and the workflow run this
#    twice and require byte-identical output, because a fingerprint that is
#    not stable against itself turns every diff into noise, and a noisy
#    conformance job is one everybody learns to ignore -- which is worse than
#    not having one at all.
#
# Every probe answers with a value. A probe that cannot read its interface
# emits `unavailable`, `absent` or `none`; it never emits nothing. A key that
# vanishes on one side is indistinguishable from a probe that silently died,
# and this file is compared key by key.
set -eu

# Bumped whenever a key is added, removed, or given a new meaning. Two
# fingerprints carrying different schema numbers were produced by two
# different scripts and are not comparable; diff.sh refuses to compare them
# rather than reporting the script's own evolution as fleet drift.
FINGERPRINT_SCHEMA=1

CGROUP_ROOT=/sys/fs/cgroup

OUT=$(mktemp "${TMPDIR:-/tmp}/rc-fingerprint-XXXXXX")
trap 'rm -f "$OUT"' EXIT
trap 'rm -f "$OUT"; exit 130' INT
trap 'rm -f "$OUT"; exit 143' TERM
trap 'rm -f "$OUT"; exit 129' HUP

# Values are flattened to a single space-separated line so the `key=value`
# format cannot be broken by an interface that answers with a tab (the
# sysctls do) or with several lines. An empty answer becomes `unavailable`,
# never an empty value: "the probe found nothing" and "the probe did not run"
# have to be distinguishable in the diff.
emit() {
  emit_value=$(printf '%s' "${2:-}" | tr '\t\n' '  ' | sed 's/  */ /g; s/^ //; s/ $//')
  if [ -z "$emit_value" ]; then
    emit_value=unavailable
  fi
  printf '%s=%s\n' "$1" "$emit_value" >>"$OUT"
}

have() { command -v "$1" >/dev/null 2>&1; }

# The first line of a file, or nothing when it cannot be read. Never fails: an
# unreadable /proc or /sys entry is a fact about this environment, not an
# error in this script.
slurp() {
  if [ -r "$1" ]; then
    head -n 1 "$1" 2>/dev/null || true
  fi
}

yes_no() {
  if [ "$1" = 0 ]; then printf 'yes'; else printf 'no'; fi
}

# Helpers are subshell functions -- `f() ( ... )` rather than `f() { ... }` --
# so their working variables cannot leak into the next probe. `local` is a
# bashism and this file is POSIX sh.

# The sorted, comma-terminated names of a directory's immediate children.
list_names() (
  find "$1" -mindepth 1 -maxdepth 1 2>/dev/null |
    sed 's|.*/||' | LC_ALL=C sort | tr '\n' ',' || true
)

# The number of CPUs named by a kernel CPU list such as `0-7,16`.
count_cpu_list() (
  total=0
  IFS=,
  # shellcheck disable=SC2086  # splitting on IFS=, is exactly the point here.
  for part in $1; do
    case "$part" in
      '') ;;
      *-*)
        lo=${part%%-*}
        hi=${part##*-}
        case "$lo$hi" in
          *[!0-9]*) ;;
          *) total=$((total + hi - lo + 1)) ;;
        esac
        ;;
      *[!0-9]*) ;;
      *) total=$((total + 1)) ;;
    esac
  done
  printf '%s' "$total"
)

# This process's own cgroup v2 directory. `/proc/self/cgroup` reports the path
# as the *host* sees it, which is not where a namespaced /sys/fs/cgroup mounts
# it, so callers walk from here up to the root and take whichever ancestor
# they can actually read.
cgroup_v2_leaf() (
  rel=$(sed -n 's|^0::||p' /proc/self/cgroup 2>/dev/null | head -n 1 || true)
  rel=${rel%/}
  printf '%s%s' "$CGROUP_ROOT" "$rel"
)

# The CPU bandwidth this process is actually allowed, in thousandths of a CPU,
# or nothing for unlimited. A quota written on an ancestor cgroup binds a
# process exactly as tightly as one written on its own, and container runtimes
# disagree about which one they write, so the minimum over the chain is the
# only reading that is true under all of them.
cgroup_cpu_milli() (
  best=
  dir=$(cgroup_v2_leaf)
  hops=0
  while [ "$hops" -lt 32 ]; do
    hops=$((hops + 1))
    if [ -r "$dir/cpu.max" ]; then
      quota=
      period=
      read -r quota period <"$dir/cpu.max" 2>/dev/null || true
      case "$quota$period" in
        '' | *[!0-9]*) ;;
        *)
          if [ "$period" -gt 0 ]; then
            milli=$((quota * 1000 / period))
            if [ -z "$best" ] || [ "$milli" -lt "$best" ]; then best=$milli; fi
          fi
          ;;
      esac
    fi
    case "$dir" in
      "$CGROUP_ROOT" | / | .) break ;;
    esac
    dir=$(dirname "$dir")
  done
  # cgroup v1 splits the same fact across two files and spells "unlimited" as
  # -1. Docker mounts the controller as `cpu,cpuacct` and usually symlinks
  # `cpu` to it, but not on every distribution, so try both names.
  for cpudir in "$CGROUP_ROOT/cpu" "$CGROUP_ROOT/cpu,cpuacct"; do
    quota=$(slurp "$cpudir/cpu.cfs_quota_us")
    period=$(slurp "$cpudir/cpu.cfs_period_us")
    case "$quota$period" in
      '' | *[!0-9]*) continue ;;
    esac
    if [ "$period" -gt 0 ]; then
      milli=$((quota * 1000 / period))
      if [ -z "$best" ] || [ "$milli" -lt "$best" ]; then best=$milli; fi
    fi
  done
  printf '%s' "$best"
)

# The memory ceiling in bytes, or nothing for unlimited. cgroup v1 spells
# "unlimited" as a 19-digit sentinel near 2^63, so any value that long is
# treated as absent rather than fed into shell arithmetic.
cgroup_memory_bytes() (
  best=
  dir=$(cgroup_v2_leaf)
  hops=0
  while [ "$hops" -lt 32 ]; do
    hops=$((hops + 1))
    value=$(slurp "$dir/memory.max")
    case "$value" in
      '' | *[!0-9]*) ;;
      *)
        if [ "${#value}" -le 15 ] && { [ -z "$best" ] || [ "$value" -lt "$best" ]; }; then
          best=$value
        fi
        ;;
    esac
    case "$dir" in
      "$CGROUP_ROOT" | / | .) break ;;
    esac
    dir=$(dirname "$dir")
  done
  value=$(slurp "$CGROUP_ROOT/memory/memory.limit_in_bytes")
  case "$value" in
    '' | *[!0-9]*) ;;
    *)
      if [ "${#value}" -le 15 ] && { [ -z "$best" ] || [ "$value" -lt "$best" ]; }; then
        best=$value
      fi
      ;;
  esac
  printf '%s' "$best"
)

# The first readable value of a cgroup v2 file between this cgroup and the
# root, for facts that are not numeric minima (a cpuset list, a pids ceiling).
cgroup_v2_nearest() (
  dir=$(cgroup_v2_leaf)
  hops=0
  while [ "$hops" -lt 32 ]; do
    hops=$((hops + 1))
    value=$(slurp "$dir/$1")
    if [ -n "$value" ]; then
      printf '%s' "$value"
      return 0
    fi
    case "$dir" in
      "$CGROUP_ROOT" | / | .) break ;;
    esac
    dir=$(dirname "$dir")
  done
)

# Free space rounded down to a power of two gibibytes. Free bytes move between
# any two runs; the bucket does not, and "is there room for a build" is the
# only question this dimension was ever able to answer.
free_gib_pow2() (
  kib=$(df -P -k "$1" 2>/dev/null | awk 'NR == 2 { print $4 }' || true)
  case "$kib" in
    '' | *[!0-9]*) return 0 ;;
  esac
  gib=$((kib / 1048576))
  bucket=0
  next=1
  while [ "$next" -le "$gib" ]; do
    bucket=$next
    next=$((next * 2))
  done
  printf '%s' "$bucket"
)

# Whether a binary written to this directory can be executed from it. A
# `noexec` scratch mount is invisible to every other probe here and breaks
# anything that unpacks and runs a helper -- which is most build tooling.
exec_allowed() (
  probe=$(mktemp "$1/rc-fingerprint-exec-XXXXXX" 2>/dev/null) || return 0
  printf '#!/bin/sh\nexit 0\n' >"$probe" 2>/dev/null || true
  chmod 0700 "$probe" 2>/dev/null || true
  if "$probe" >/dev/null 2>&1; then
    result=yes
  else
    result=no
  fi
  rm -f "$probe"
  printf '%s' "$result"
)

# The version a tool reports, reduced to its first dotted number so the value
# is the version and nothing else. stderr is folded in because `ssh -V` and
# friends print there.
tool_version() (
  "$1" "$2" </dev/null 2>&1 | head -n 3 |
    grep -oE '[0-9]+(\.[0-9]+)+' | head -n 1 || true
)

# The actions/runner release this job is running under. GitHub-hosted lays the
# runner out as `.../runners/<version>/bin`, which names it directly; our
# Image Release installs it at a fixed path, so fall back to the version
# stamped into the listener's dependency manifest. `unknown` when neither
# answers -- which is a recorded fact, not a silent omission.
runner_version() (
  if [ -n "${RUNNER_VERSION:-}" ]; then
    printf '%s' "$RUNNER_VERSION"
    return 0
  fi
  pid=$$
  hops=0
  while [ "$hops" -lt 8 ]; do
    hops=$((hops + 1))
    exe=$(readlink "/proc/$pid/exe" 2>/dev/null || true)
    case "$exe" in
      */bin/Runner.Worker | */bin/Runner.Listener)
        root=${exe%/bin/*}
        base=${root##*/}
        case "$base" in
          [0-9]*.[0-9]*.[0-9]*)
            printf '%s' "$base"
            return 0
            ;;
        esac
        stamped=$(grep -o '"Runner\.Listener/[0-9][0-9.]*"' \
          "$root/bin/Runner.Listener.deps.json" 2>/dev/null | head -n 1 || true)
        stamped=${stamped#\"Runner.Listener/}
        stamped=${stamped%\"}
        if [ -n "$stamped" ]; then
          printf '%s' "$stamped"
          return 0
        fi
        break
        ;;
    esac
    ppid=$(awk '/^PPid:/ { print $2 }' "/proc/$pid/status" 2>/dev/null || true)
    case "$ppid" in
      '' | 0 | *[!0-9]*) break ;;
    esac
    pid=$ppid
  done
  printf 'unknown'
)

emit fingerprint_schema "$FINGERPRINT_SCHEMA"

# ---------------------------------------------------------------------------
# Kernel, distribution, boundary
# ---------------------------------------------------------------------------
emit kernel_name "$(uname -s)"
emit kernel_release "$(uname -r)"
emit kernel_arch "$(uname -m)"
emit os_id "$(sed -n 's/^ID=//p' /etc/os-release 2>/dev/null | head -n 1 | tr -d '"' || true)"
emit os_version_id \
  "$(sed -n 's/^VERSION_ID=//p' /etc/os-release 2>/dev/null | head -n 1 | tr -d '"' || true)"

container_hint=none
if [ -e /run/.containerenv ]; then container_hint=containerenv; fi
if [ -e /.dockerenv ]; then container_hint=dockerenv; fi
emit container_hint "$container_hint"

if have systemd-detect-virt; then
  emit virtualisation "$(systemd-detect-virt 2>/dev/null || true)"
else
  emit virtualisation unavailable
fi

cgroup_version=none
if [ -r "$CGROUP_ROOT/cgroup.controllers" ]; then
  cgroup_version=v2
  if [ -d "$CGROUP_ROOT/memory" ] || [ -d "$CGROUP_ROOT/cpu" ]; then
    cgroup_version=hybrid
  fi
elif [ -d "$CGROUP_ROOT/memory" ] || [ -d "$CGROUP_ROOT/cpu" ]; then
  cgroup_version=v1
fi
emit cgroup_version "$cgroup_version"

# ---------------------------------------------------------------------------
# CPU: what the job sees, and what it is allowed
# ---------------------------------------------------------------------------
affinity_list=$(awk '/^Cpus_allowed_list:/ { print $2 }' /proc/self/status 2>/dev/null || true)
affinity_count=$(count_cpu_list "$affinity_list")
cpuinfo_count=$(grep -c '^processor' /proc/cpuinfo 2>/dev/null || true)
online_count=$(count_cpu_list "$(slurp /sys/devices/system/cpu/online)")

if have nproc; then
  visible_count=$(nproc 2>/dev/null || true)
  emit cpu_nproc_all "$(nproc --all 2>/dev/null || true)"
else
  visible_count=$affinity_count
  emit cpu_nproc_all unavailable
fi
case "$visible_count" in
  '' | *[!0-9]* | 0) visible_count=$affinity_count ;;
esac

emit cpu_visible_count "$visible_count"
emit cpu_affinity_count "$affinity_count"
emit cpu_cpuinfo_count "$cpuinfo_count"
emit cpu_online_count "$online_count"

cpuset_list=$(cgroup_v2_nearest cpuset.cpus.effective)
if [ -z "$cpuset_list" ]; then
  cpuset_list=$(slurp "$CGROUP_ROOT/cpuset/cpuset.effective_cpus")
fi
if [ -n "$cpuset_list" ]; then
  emit cpu_cgroup_cpuset_count "$(count_cpu_list "$cpuset_list")"
else
  emit cpu_cgroup_cpuset_count none
fi

quota_milli=$(cgroup_cpu_milli)
if [ -n "$quota_milli" ]; then
  emit cpu_cgroup_quota_millicpu "$quota_milli"
else
  emit cpu_cgroup_quota_millicpu none
fi

if have node; then
  emit cpu_node_available_parallelism \
    "$(node -p 'require("node:os").availableParallelism()' 2>/dev/null || true)"
else
  emit cpu_node_available_parallelism unavailable
fi

# The number every autosizing tool reads, against the number the kernel will
# actually let it burn. THIS is #80: `cpu_visible_count` said 64 and
# `cpu_cgroup_quota_millicpu` said 8000, so vitest started 64 workers on 8
# CPUs. Neither key alone can express that -- both legitimately differ between
# a GitHub-hosted VM and one of our Workers, and an allowlist entry for either
# is defensible on its own. Their agreement is not: a machine whose visible
# CPU count exceeds its own quota misreports its size to every build tool in
# existence, and there is no fleet on which that is intended.
allowed_milli=$((visible_count * 1000))
if [ -n "$quota_milli" ] && [ "$quota_milli" -lt "$allowed_milli" ]; then
  allowed_milli=$quota_milli
fi
emit cpu_allowed_millicpu "$allowed_milli"
if [ "$((visible_count * 1000))" -le "$allowed_milli" ]; then
  emit cpu_visible_matches_allowed yes
else
  emit cpu_visible_matches_allowed no
fi

# ---------------------------------------------------------------------------
# Memory: same shape, same reason
# ---------------------------------------------------------------------------
mem_total_kib=$(awk '/^MemTotal:/ { print $2 }' /proc/meminfo 2>/dev/null || true)
case "$mem_total_kib" in
  '' | *[!0-9]*) mem_total_kib=0 ;;
esac
mem_visible_mib=$((mem_total_kib / 1024))
emit mem_visible_mib "$mem_visible_mib"
emit mem_swap_total_mib \
  "$(awk '/^SwapTotal:/ { print int($2 / 1024) }' /proc/meminfo 2>/dev/null || true)"

mem_limit_bytes=$(cgroup_memory_bytes)
mem_allowed_mib=$mem_visible_mib
if [ -n "$mem_limit_bytes" ]; then
  mem_limit_mib=$((mem_limit_bytes / 1048576))
  emit mem_cgroup_limit_mib "$mem_limit_mib"
  if [ "$mem_limit_mib" -lt "$mem_allowed_mib" ]; then
    mem_allowed_mib=$mem_limit_mib
  fi
else
  emit mem_cgroup_limit_mib none
fi
emit mem_allowed_mib "$mem_allowed_mib"
if [ "$mem_visible_mib" -le "$mem_allowed_mib" ]; then
  emit mem_visible_matches_allowed yes
else
  emit mem_visible_matches_allowed no
fi

if have node; then
  emit mem_node_totalmem_mib \
    "$(node -p 'Math.round(require("node:os").totalmem() / 1048576)' 2>/dev/null || true)"
  node_heap_mib=$(node -p \
    'Math.round(require("node:v8").getHeapStatistics().heap_size_limit / 1048576)' \
    2>/dev/null || true)
  emit node_heap_limit_mib "$node_heap_mib"
  # Node sizes its default old space from /proc/meminfo, which reports the
  # host. A heap ceiling above the cgroup limit means the process is entitled
  # to grow until the kernel kills it, and the OOM has no stack.
  case "$node_heap_mib" in
    '' | *[!0-9]*) emit node_heap_within_allowed_mem unavailable ;;
    *)
      if [ "$node_heap_mib" -le "$mem_allowed_mib" ]; then
        emit node_heap_within_allowed_mem yes
      else
        emit node_heap_within_allowed_mem no
      fi
      ;;
  esac
else
  emit mem_node_totalmem_mib unavailable
  emit node_heap_limit_mib unavailable
  emit node_heap_within_allowed_mem unavailable
fi

pids_max=$(cgroup_v2_nearest pids.max)
if [ -z "$pids_max" ]; then
  pids_max=$(slurp "$CGROUP_ROOT/pids/pids.max")
fi
case "$pids_max" in
  '' | max) emit pids_cgroup_max none ;;
  *) emit pids_cgroup_max "$pids_max" ;;
esac

# ---------------------------------------------------------------------------
# Resource limits
# ---------------------------------------------------------------------------
# `ulimit -a` prints a different layout in every shell; /proc/self/limits is
# the kernel's own table and covers strictly more. The units column is
# optional, so the value columns are found from the right.
if [ -r /proc/self/limits ]; then
  awk '
    NR > 1 && NF >= 4 {
      n = NF
      if ($n ~ /^(unlimited|[0-9]+)$/) { hard = $n; soft = $(n - 1); last = n - 2 }
      else { hard = $(n - 1); soft = $(n - 2); last = n - 3 }
      if (last < 1) next
      name = ""
      for (i = 1; i <= last; i++) name = name (i > 1 ? "_" : "") tolower($i)
      gsub(/[^a-z0-9_]/, "_", name)
      printf "rlimit_%s_soft=%s\nrlimit_%s_hard=%s\n", name, soft, name, hard
    }
  ' /proc/self/limits >>"$OUT"
else
  emit rlimit_table unavailable
fi

# ---------------------------------------------------------------------------
# Devices
# ---------------------------------------------------------------------------
while IFS= read -r device; do
  [ -n "$device" ] || continue
  device_key=dev_$(printf '%s' "${device#/dev/}" | tr './-' '___')
  if [ -e "$device" ]; then
    emit "$device_key" present
  else
    emit "$device_key" absent
  fi
done <<'DEVICES'
/dev/kvm
/dev/fuse
/dev/net/tun
/dev/vhost-vsock
/dev/loop-control
/dev/dri
DEVICES

# Docker's default /dev/shm is 64 MiB regardless of the container's memory,
# while a GitHub-hosted runner gets half of RAM. Chromium, Playwright and
# several databases fail in ways that never mention shared memory.
emit dev_shm_size_mib "$(df -P -m /dev/shm 2>/dev/null | awk 'NR == 2 { print $2 }' || true)"
emit dev_shm_fstype "$(stat -f -c '%T' /dev/shm 2>/dev/null || true)"

# ---------------------------------------------------------------------------
# Filesystems the job actually writes to
# ---------------------------------------------------------------------------
workspace_dir=${GITHUB_WORKSPACE:-$PWD}
scratch_dir=${RUNNER_TEMP:-${TMPDIR:-/tmp}}
emit workspace_fstype "$(stat -f -c '%T' "$workspace_dir" 2>/dev/null || true)"
emit workspace_free_gib_pow2 "$(free_gib_pow2 "$workspace_dir")"
emit workspace_exec_allowed "$(exec_allowed "$workspace_dir")"
emit scratch_fstype "$(stat -f -c '%T' "$scratch_dir" 2>/dev/null || true)"
emit scratch_free_gib_pow2 "$(free_gib_pow2 "$scratch_dir")"
emit scratch_exec_allowed "$(exec_allowed "$scratch_dir")"
emit root_fstype "$(stat -f -c '%T' / 2>/dev/null || true)"
emit root_free_gib_pow2 "$(free_gib_pow2 /)"

# ---------------------------------------------------------------------------
# Kernel tunables a build can trip over
# ---------------------------------------------------------------------------
while IFS= read -r tunable; do
  [ -n "$tunable" ] || continue
  tunable_path=/proc/sys/$(printf '%s' "$tunable" | tr '.' '/')
  tunable_key=sysctl_$(printf '%s' "$tunable" | tr '.-' '__')
  emit "$tunable_key" "$(slurp "$tunable_path")"
done <<'SYSCTLS'
vm.max_map_count
vm.overcommit_memory
vm.swappiness
fs.file-max
fs.nr_open
fs.inotify.max_user_watches
fs.inotify.max_user_instances
kernel.pid_max
kernel.threads-max
kernel.unprivileged_userns_clone
user.max_user_namespaces
net.core.somaxconn
net.ipv4.ip_local_port_range
net.ipv4.tcp_syncookies
SYSCTLS

# ---------------------------------------------------------------------------
# Identity and privilege
# ---------------------------------------------------------------------------
emit user_name "$(id -un 2>/dev/null || true)"
emit user_uid "$(id -u 2>/dev/null || true)"
emit user_gid "$(id -g 2>/dev/null || true)"
emit user_groups "$(id -Gn 2>/dev/null | tr ' ' '\n' | LC_ALL=C sort | tr '\n' ',' || true)"
emit user_home "${HOME:-unavailable}"
emit user_login_shell "$(getent passwd "$(id -un 2>/dev/null)" 2>/dev/null | cut -d: -f7 || true)"
emit sh_implementation "$(readlink -f /bin/sh 2>/dev/null || true)"
emit umask_value "$(umask)"

if [ "$(id -u 2>/dev/null || echo 1)" = 0 ]; then
  emit user_is_root yes
else
  emit user_is_root no
fi
if have sudo && sudo -n true >/dev/null 2>&1; then
  emit sudo_nopasswd yes
else
  emit sudo_nopasswd no
fi

cap_eff=$(awk '/^CapEff:/ { print $2 }' /proc/self/status 2>/dev/null || true)
emit cap_eff "$cap_eff"
case "$cap_eff" in
  '' | *[!0-9a-fA-F]*) emit cap_sys_admin unavailable ;;
  *)
    # CAP_SYS_ADMIN is bit 21; the same probe the daily smoke canary makes.
    if [ $(((0x$cap_eff >> 21) & 1)) -eq 1 ]; then
      emit cap_sys_admin yes
    else
      emit cap_sys_admin no
    fi
    ;;
esac
emit no_new_privs "$(awk '/^NoNewPrivs:/ { print $2 }' /proc/self/status 2>/dev/null || true)"
emit seccomp_mode "$(awk '/^Seccomp:/ { print $2 }' /proc/self/status 2>/dev/null || true)"
emit lsm_profile "$(tr -d '\000' </proc/self/attr/current 2>/dev/null || true)"

# ---------------------------------------------------------------------------
# Time, locale, shell environment
# ---------------------------------------------------------------------------
tz_name=$(slurp /etc/timezone)
if [ -z "$tz_name" ]; then
  tz_link=$(readlink -f /etc/localtime 2>/dev/null || true)
  case "$tz_link" in
    */zoneinfo/*) tz_name=${tz_link#*/zoneinfo/} ;;
  esac
fi
emit tz_name "$tz_name"
emit tz_abbreviation "$(date +%Z 2>/dev/null || true)"
emit tz_utc_offset "$(date +%z 2>/dev/null || true)"
emit locale_lang "${LANG:-unset}"
emit locale_lc_all "${LC_ALL:-unset}"
emit locale_charmap "$(locale charmap 2>/dev/null || true)"
if have locale && locale -a 2>/dev/null | grep -qiE '^en_US\.(utf-?8)$'; then
  emit locale_has_en_us_utf8 yes
else
  emit locale_has_en_us_utf8 no
fi
emit env_path "${PATH:-unset}"

if [ -n "${HTTP_PROXY:-}${HTTPS_PROXY:-}${http_proxy:-}${https_proxy:-}" ]; then
  emit env_proxy_set yes
else
  emit env_proxy_set no
fi

# ---------------------------------------------------------------------------
# Tooling a workflow may reasonably assume
# ---------------------------------------------------------------------------
while IFS=' ' read -r tool flag; do
  [ -n "$tool" ] || continue
  tool_key=$(printf '%s' "$tool" | tr '.+-' '___')
  if have "$tool"; then
    emit "tool_${tool_key}_present" yes
    emit "tool_${tool_key}_version" "$(tool_version "$tool" "$flag")"
  else
    emit "tool_${tool_key}_present" no
    emit "tool_${tool_key}_version" absent
  fi
done <<'TOOLS'
bash --version
git --version
node --version
npm --version
pnpm --version
python3 --version
pip3 --version
go version
docker --version
gh --version
tar --version
unzip -v
zip -v
xz --version
zstd --version
curl --version
wget --version
jq --version
make --version
gcc --version
openssl version
ssh -V
rsync --version
sudo --version
TOOLS

# A Docker CLI that cannot reach a daemon is not the same environment as one
# that can, and `docker build` in a workflow does not care which of the two it
# was promised.
if have docker && docker version --format '{{.Server.Version}}' >/dev/null 2>&1; then
  emit docker_daemon_reachable yes
  emit docker_server_version \
    "$(docker version --format '{{.Server.Version}}' 2>/dev/null || true)"
else
  emit docker_daemon_reachable no
  emit docker_server_version absent
fi

# ---------------------------------------------------------------------------
# Runner and tool cache
# ---------------------------------------------------------------------------
emit runner_environment "${RUNNER_ENVIRONMENT:-unset}"
emit runner_os "${RUNNER_OS:-unset}"
emit runner_arch "${RUNNER_ARCH:-unset}"
emit runner_version "$(runner_version)"
emit runner_image_os "${ImageOS:-unset}"
if [ -n "${ACTIONS_RUNNER_ACTION_ARCHIVE_CACHE:-}" ]; then
  emit runner_action_archive_cache set
else
  emit runner_action_archive_cache unset
fi

tool_cache=${RUNNER_TOOL_CACHE:-}
if [ -n "$tool_cache" ] && [ -d "$tool_cache" ]; then
  emit toolcache_tools "$(list_names "$tool_cache")"
  emit toolcache_node_versions "$(list_names "$tool_cache/node")"
else
  emit toolcache_tools unavailable
  emit toolcache_node_versions unavailable
fi

# ---------------------------------------------------------------------------
# Network
# ---------------------------------------------------------------------------
default_dev=$(ip -4 route show default 2>/dev/null |
  awk 'NR == 1 { for (i = 1; i < NF; i++) if ($i == "dev") { print $(i + 1); exit } }' || true)
if [ -n "$default_dev" ]; then
  emit net_default_mtu "$(slurp "/sys/class/net/$default_dev/mtu")"
else
  emit net_default_mtu unavailable
fi
emit net_ipv6_disabled "$(slurp /proc/sys/net/ipv6/conf/all/disable_ipv6)"

emit dns_nameserver_count "$(grep -c '^nameserver' /etc/resolv.conf 2>/dev/null || true)"
if grep -qE '^nameserver[[:space:]]+127\.' /etc/resolv.conf 2>/dev/null; then
  emit dns_nameserver_loopback yes
else
  emit dns_nameserver_loopback no
fi
emit dns_search_domain_count \
  "$(awk '/^search/ { print NF - 1; exit } END { print 0 }' /etc/resolv.conf 2>/dev/null |
    head -n 1 || true)"
emit dns_options \
  "$(awk '/^options/ { $1 = ""; print }' /etc/resolv.conf 2>/dev/null |
    tr ' ' '\n' | grep -v '^$' | LC_ALL=C sort | tr '\n' ',' || true)"

# Resolution and reachability are retried, because a single transient failure
# would make this file disagree with itself between the two determinism runs
# and burn the job's credibility on a fact that was never in question.
while IFS= read -r host; do
  [ -n "$host" ] || continue
  host_key=dns_resolves_$(printf '%s' "$host" | tr '.-' '__')
  resolved=no
  attempt=0
  while [ "$attempt" -lt 3 ]; do
    attempt=$((attempt + 1))
    if getent hosts "$host" >/dev/null 2>&1; then
      resolved=yes
      break
    fi
  done
  emit "$host_key" "$resolved"
done <<'DNS_HOSTS'
github.com
api.github.com
ghcr.io
objects.githubusercontent.com
DNS_HOSTS

http_reachable() (
  if ! have curl; then
    printf 'unavailable'
    return 0
  fi
  code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 20 \
    --retry 3 --retry-delay 2 --retry-connrefused "$1" 2>/dev/null || true)
  case "$code" in
    '' | 000) printf 'blocked' ;;
    *) printf 'ok' ;;
  esac
)

emit egress_api_github_com "$(http_reachable https://api.github.com)"
emit egress_ghcr_io "$(http_reachable https://ghcr.io/v2/)"
emit egress_registry_npmjs_org "$(http_reachable https://registry.npmjs.org/)"

# The Actions cache endpoint is handed to the job in an environment variable
# whose path carries a per-run identifier, so only its reachability is
# recorded. A Profile on allowlist-only egress that cannot reach it turns
# every `actions/cache` step into a silent miss.
cache_endpoint=${ACTIONS_RESULTS_URL:-${ACTIONS_CACHE_URL:-}}
if [ -n "$cache_endpoint" ]; then
  emit actions_cache_endpoint set
  emit actions_cache_reachable "$(http_reachable "$cache_endpoint")"
else
  emit actions_cache_endpoint unset
  emit actions_cache_reachable unavailable
fi

# ---------------------------------------------------------------------------
# Emit
# ---------------------------------------------------------------------------
# A duplicate key would appear in the sorted output twice and be diffed
# against itself, so it is a bug in this script rather than a fact about the
# machine. Same for a line this file's own format cannot round-trip.
malformed=$(grep -vE '^[a-z0-9_]+=[^=]*$' "$OUT" || true)
if [ -n "$malformed" ]; then
  printf 'fingerprint.sh: emitted a malformed line:\n%s\n' "$malformed" >&2
  exit 1
fi
duplicates=$(cut -d= -f1 "$OUT" | LC_ALL=C sort | uniq -d)
if [ -n "$duplicates" ]; then
  printf 'fingerprint.sh: emitted these keys more than once:\n%s\n' "$duplicates" >&2
  exit 1
fi

if [ "$#" -ge 1 ]; then
  LC_ALL=C sort "$OUT" >"$1"
else
  LC_ALL=C sort "$OUT"
fi
