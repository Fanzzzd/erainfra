#!/usr/bin/env bash
# Trusted-repository fallback: one digest-pinned container per scale-set Attempt.
# Firecracker remains the isolation boundary for untrusted code. This executor
# exists so a host can join without root storage/network provisioning first.

set -euo pipefail

: "${RUNNER_NAME:?RUNNER_NAME is required}"
: "${RC_PROFILE:?RC_PROFILE is required}"
: "${IMAGE:?IMAGE is required}"
: "${RC_VCPUS:?RC_VCPUS is required}"
: "${RC_MEMORY_MIB:?RC_MEMORY_MIB is required}"
: "${RC_CPUSET_CPUS:?RC_CPUSET_CPUS is required}"

case "$RUNNER_NAME" in
  *[!A-Za-z0-9._-]* | "")
    printf 'error: RUNNER_NAME must match [A-Za-z0-9._-]+.\n' >&2
    exit 2
    ;;
esac
case "$RC_PROFILE" in
  *[!A-Za-z0-9._-]* | "")
    printf 'error: RC_PROFILE must match [A-Za-z0-9._-]+.\n' >&2
    exit 2
    ;;
esac
digest="${IMAGE##*@sha256:}"
if [ "$digest" = "$IMAGE" ] || [ "${#digest}" -ne 64 ]; then
  printf 'error: IMAGE must be pinned by sha256 digest.\n' >&2
  exit 2
fi
case "$digest" in
  *[!0-9a-f]*) printf 'error: IMAGE sha256 digest must be lowercase hexadecimal.\n' >&2; exit 2 ;;
esac
for value in "$RC_VCPUS" "$RC_MEMORY_MIB"; do
  case "$value" in
    "" | *[!0-9]* | 0) printf 'error: Docker resource limits must be positive integers.\n' >&2; exit 2 ;;
  esac
done

# The per-Attempt core range the Agent reserved, disjoint from every other
# Attempt on this Worker. --cpus alone sets the CFS bandwidth quota and leaves
# the affinity mask covering the whole host, so nproc(1),
# os.availableParallelism(), runtime.NumCPU() and Runtime.availableProcessors()
# all report the host's core count and each build tool over-subscribes by the
# ratio between them (#80). There is no quota-only fallback: a container that
# silently reads the wrong number is the defect being fixed.
if [[ ! $RC_CPUSET_CPUS =~ ^[0-9]+(-[0-9]+)?(,[0-9]+(-[0-9]+)?)*$ ]]; then
  printf 'error: RC_CPUSET_CPUS must be a CPU list such as 0-3 or 0,2,4-5.\n' >&2
  exit 2
fi
# A cpuset whose width is not RC_VCPUS tells the job a different wrong number,
# so the two are checked against each other here rather than trusted.
cpuset_width=0
IFS=',' read -r -a cpuset_ranges <<<"$RC_CPUSET_CPUS"
for range in "${cpuset_ranges[@]}"; do
  first="10#${range%%-*}"
  last="10#${range##*-}"
  if [ "$((last))" -lt "$((first))" ]; then
    printf 'error: RC_CPUSET_CPUS range %s runs backwards.\n' "$range" >&2
    exit 2
  fi
  cpuset_width=$((cpuset_width + last - first + 1))
done
if [ "$cpuset_width" -ne "$RC_VCPUS" ]; then
  printf 'error: RC_CPUSET_CPUS covers %s CPUs but RC_VCPUS is %s.\n' \
    "$cpuset_width" "$RC_VCPUS" >&2
  exit 2
fi
# Summing the ranges is not enough: overlapping ones add up to the right width
# while covering fewer CPUs, so `0-1,1-2` would pass for RC_VCPUS=4 and Docker
# would hand the job three. Count the distinct ids too. The expansion below is
# bounded by the width check above, so a range like 0-999999 is already gone.
cpuset_distinct=$(
  for range in "${cpuset_ranges[@]}"; do
    first="10#${range%%-*}"
    last="10#${range##*-}"
    for ((cpu = first; cpu <= last; cpu++)); do printf '%s\n' "$cpu"; done
  done | sort -nu | wc -l | tr -d ' '
)
if [ "$cpuset_distinct" -ne "$RC_VCPUS" ]; then
  printf 'error: RC_CPUSET_CPUS ranges overlap: %s distinct CPUs, not %s.\n' \
    "$cpuset_distinct" "$RC_VCPUS" >&2
  exit 2
fi

JOB_TIMEOUT_S="${RC_JOB_TIMEOUT_S:-21600}"
case "$JOB_TIMEOUT_S" in
  "" | *[!0-9]* | 0) printf 'error: RC_JOB_TIMEOUT_S must be a positive integer.\n' >&2; exit 2 ;;
esac

# The job cache endpoint, or nothing. Both are unset on a fleet that has not
# configured one, and then not one flag below reaches the command line: a Worker
# without a cache composes exactly the environment it composed before.
#
# The rename lives here, next to every other --env decision, so one place
# decides what a job is told. What an operator sets is ERAINFRA_CACHE_*; what a
# container receives is what the cache clients actually read.
#
# ACTIONS_RESULTS_URL and ACTIONS_RUNTIME_TOKEN are NOT written here and must
# not be added. Probe run 32109974600 measured the artifact service living at
# the same ACTIONS_RESULTS_URL behind the same ACTIONS_RUNTIME_TOKEN, so
# repointing either to carry cache traffic takes actions/upload-artifact away
# from every job on this Worker. Serving v2 needs an answer to that, not a line
# in this list.
cache_flags=()
if [ -n "${ERAINFRA_CACHE_URL:-}" ]; then
  case "$ERAINFRA_CACHE_URL" in
    http://* | https://*) ;;
    *)
      printf 'error: ERAINFRA_CACHE_URL must be an absolute http(s) URL.\n' >&2
      exit 2
      ;;
  esac
  # A value with whitespace or a control character in it is not a URL, and it is
  # the shape that turns one --env into two arguments somewhere downstream.
  case "$ERAINFRA_CACHE_URL" in
    *[[:space:]]* | *[[:cntrl:]]*)
      printf 'error: ERAINFRA_CACHE_URL must not contain whitespace.\n' >&2
      exit 2
      ;;
  esac
  cache_flags+=(--env "ACTIONS_CACHE_URL=$ERAINFRA_CACHE_URL")
fi
if [ -n "${ERAINFRA_CACHE_SERVICE_V2:-}" ]; then
  case "$ERAINFRA_CACHE_SERVICE_V2" in
    true | false) ;;
    *)
      printf 'error: ERAINFRA_CACHE_SERVICE_V2 must be exactly "true" or "false".\n' >&2
      exit 2
      ;;
  esac
  cache_flags+=(--env "ACTIONS_CACHE_SERVICE_V2=$ERAINFRA_CACHE_SERVICE_V2")
fi

# The resolver a job gets. Docker hands a container whatever the daemon
# inherited from the host, and when the host's own resolvers are loopback the
# daemon silently substitutes its built-in public ones -- so on the fleet the
# shape a job resolves through (#96: two nameservers, no options, no search
# domain) was picked three layers away and by nobody here. `ubuntu-latest` is
# not the target: its single 127.0.0.53 stub belongs to systemd-resolved inside
# that VM and cannot be reproduced across a network namespace. What has to go is
# the inheritance, so the servers are named explicitly on the command line and
# the shape is decided below.
#
# RC_DNS_SERVERS names them outright. Otherwise they are read from the host, and
# systemd-resolved's upstream file is preferred over /etc/resolv.conf because on
# such a host /etc/resolv.conf holds only the 127.0.0.53 stub, which a container
# in its own network namespace cannot reach.
RESOLV_SOURCES=(/run/systemd/resolve/resolv.conf /etc/resolv.conf)

# A resolver a container can actually reach. A hostname is refused because
# resolving it needs the resolver being configured, and loopback is refused
# because 127.0.0.53 inside a container's own network namespace is the
# container's empty loopback, not the host's stub.
reachable_resolver() {
  case "$1" in
    127.* | ::1 | 0:0:0:0:0:0:0:1) return 1 ;;
  esac
  if [[ $1 =~ ^([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})$ ]]; then
    local octet
    for octet in "${BASH_REMATCH[@]:1}"; do
      [ "$((10#$octet))" -le 255 ] || return 1
    done
    return 0
  fi
  # An IPv6 literal: hex groups separated by colons, either compressed with ::
  # or written out in full. Anything else -- a hostname, a URL, a shell
  # metacharacter -- is not a resolver and does not reach the command line.
  if [[ $1 =~ ^[0-9a-fA-F:]+$ && $1 == *::* ]]; then return 0; fi
  if [[ $1 =~ ^([0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}$ ]]; then return 0; fi
  return 1
}

dns_servers=()
if [ -n "${RC_DNS_SERVERS:-}" ]; then
  IFS=',' read -r -a dns_candidates <<<"$RC_DNS_SERVERS"
  for candidate in "${dns_candidates[@]}"; do
    if ! reachable_resolver "$candidate"; then
      printf 'error: RC_DNS_SERVERS entry %s is not an IP address a container can reach.\n' \
        "$candidate" >&2
      exit 2
    fi
    dns_servers+=("$candidate")
  done
  if [ "${#dns_servers[@]}" -eq 0 ]; then
    printf 'error: RC_DNS_SERVERS is set but names no address.\n' >&2
    exit 2
  fi
else
  for resolv in "${RESOLV_SOURCES[@]}"; do
    [ -r "$resolv" ] || continue
    while read -r keyword address _rest; do
      [ "$keyword" = "nameserver" ] || continue
      reachable_resolver "$address" || continue
      dns_servers+=("$address")
    done <"$resolv"
    [ "${#dns_servers[@]}" -gt 0 ] && break
  done
fi
if [ "${#dns_servers[@]}" -eq 0 ]; then
  # There is no inherit-and-hope fallback, for the same reason there is no
  # quota-only fallback above: a job silently resolving through whatever the
  # daemon guessed is the defect being fixed. One environment variable, named in
  # the message, is the way out.
  printf 'error: no container-reachable nameserver in %s; set RC_DNS_SERVERS.\n' \
    "${RESOLV_SOURCES[*]}" >&2
  exit 2
fi
# glibc reads at most MAXNS (3) nameservers and ignores the rest, so passing
# more would write lines into the container's resolv.conf that no lookup will
# ever use.
if [ "${#dns_servers[@]}" -gt 3 ]; then
  dns_servers=("${dns_servers[@]:0:3}")
fi
dns_flags=()
for address in "${dns_servers[@]}"; do
  dns_flags+=(--dns "$address")
done
# edns0 lets the stub advertise a UDP payload larger than 512 bytes, so an
# answer that would otherwise come back truncated and be retried over TCP fits
# in one datagram. `ubuntu-latest` sets it; large TXT and SRV answers and
# DNSSEC-signed zones are the ones that notice.
dns_flags+=(--dns-option edns0)
# `trust-ad` is deliberately NOT set even though ubuntu-latest has it. It tells
# the stub to believe the AD bit in a reply, which is only sound when the
# resolver is trusted and local -- there it is systemd-resolved on 127.0.0.53,
# and here it is whatever the Worker's network provides.
#
# `--dns-search .` is the documented way to ask Docker for no search domain at
# all, and the empty search list a container happened to inherit becomes a
# decision. A search domain is not wanted: it makes a bare name in a workflow
# resolve through a suffix the Worker's network supplies, so `registry` could
# reach an operator's internal host on one Worker and NXDOMAIN on the next.
dns_flags+=(--dns-search .)

if [ -t 0 ]; then
  printf 'error: the JIT configuration must be piped on stdin.\n' >&2
  exit 2
fi
ACTIONS_RUNNER_INPUT_JITCONFIG="$(cat)"
if [ -z "$ACTIONS_RUNNER_INPUT_JITCONFIG" ]; then
  printf 'error: read an empty JIT configuration from stdin.\n' >&2
  exit 2
fi
if printf '%s' "$ACTIONS_RUNNER_INPUT_JITCONFIG" | LC_ALL=C grep -q '[^A-Za-z0-9+/=]'; then
  printf 'error: the JIT configuration read from stdin is not base64.\n' >&2
  exit 2
fi

WORKDIR="$(mktemp -d "${TMPDIR:-/tmp}/rc-docker-XXXXXXXX")"
chmod 700 "$WORKDIR"
DOCKER_PID=""
WATCHDOG_PID=""
ENV_WRITER_PID=""

# Teardown never uses `wait` and never runs unbounded. Bash's job table can
# outlive the process it describes -- a child that exits in the same instant it
# signals this shell can leave `jobs` reporting it as Running after `kill -0`
# already reports it gone, and `wait` then blocks in waitpid(2) for an exit that
# has already happened. That is a race, so it is intermittent, and in a function
# whose job is to release a resource it is unacceptable regardless: `kill -0`
# asks the kernel instead, and every poll below has a deadline.
# See the same primitives, and the trace that found them, in provision-mac.sh.
TEARDOWN_GRACE_S=2

# shellcheck disable=SC2317,SC2329  # reached only from the EXIT trap, via reap
still_alive() {
  kill -0 "$1" 2>/dev/null || return 1
  # A process that has exited but has not been reaped still answers `kill -0`.
  # Treating a zombie as alive would make every poll below spend its whole
  # budget and escalate to SIGKILL against something that already died.
  case "$(ps -o state= -p "$1" 2>/dev/null | tr -d ' ')" in
    Z*) return 1 ;;
  esac
}

# Polls for at most $2 seconds. Non-zero means $1 outlived that budget.
# shellcheck disable=SC2317,SC2329  # reached only from the EXIT trap, via reap
await_exit() {
  local target="$1" ticks=$(($2 * 10))
  while [ "$ticks" -gt 0 ]; do
    still_alive "$target" || return 0
    sleep 0.1
    ticks=$((ticks - 1))
  done
  ! still_alive "$target"
}

# TERM, a short grace, then KILL, then carry on regardless. Always succeeds: a
# best-effort teardown step that reported failure would abort the rest of
# cleanup under `set -e`, which is the same class of mistake as blocking in it.
# shellcheck disable=SC2317,SC2329
reap() {
  local target="$1"
  still_alive "$target" || return 0
  kill -TERM "$target" 2>/dev/null || true
  if await_exit "$target" "$TEARDOWN_GRACE_S"; then
    return 0
  fi
  kill -KILL "$target" 2>/dev/null || true
  await_exit "$target" 1 || true
}

# Invoked indirectly by the EXIT trap installed immediately below.
# shellcheck disable=SC2317,SC2329
cleanup() {
  local code=$?
  trap - EXIT
  # The container goes first. It is the resource that leaks if this function
  # does not finish, and nothing that merely refuses to die belongs in front of
  # it. Removing it is also what makes the client below exit on its own.
  docker rm -f "$RUNNER_NAME" >/dev/null 2>&1 || true
  if [ -n "$WATCHDOG_PID" ]; then
    reap "$WATCHDOG_PID"
  fi
  if [ -n "$ENV_WRITER_PID" ]; then
    reap "$ENV_WRITER_PID"
  fi
  if [ -n "$DOCKER_PID" ]; then
    reap "$DOCKER_PID"
  fi
  if [ -f "$WORKDIR/timed-out" ]; then
    rm -rf "$WORKDIR"
    printf 'error: the job exceeded RC_JOB_TIMEOUT_S; the container was destroyed.\n' >&2
    exit 124
  fi
  rm -rf "$WORKDIR"
  exit "$code"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 131' QUIT
trap 'exit 143' TERM

# A mode-600 FIFO hands the secret to the Docker API request without putting it
# in the host process environment, argv, or a regular file.
mkfifo "$WORKDIR/runner.env"
chmod 600 "$WORKDIR/runner.env"
(
  printf 'ACTIONS_RUNNER_INPUT_JITCONFIG=%s\n' "$ACTIONS_RUNNER_INPUT_JITCONFIG" \
    >"$WORKDIR/runner.env"
) &
ENV_WRITER_PID=$!

# RC_VCPUS and RC_MEMORY_MIB are handed to the job as well as to Docker. The
# cpuset makes every CPU interface inside the container honest, but memory is
# not fixed by it: /proc/meminfo, free(1) and os.totalmem() report the host's
# RAM, so Node still sizes its default old-space heap from 251 GiB inside an
# 8 GiB cgroup and gets OOM-killed believing it had room. Mounting LXCFS is the
# other answer and is not taken here: it needs a host daemon this Worker does
# not install, readiness evidence to prove it, and a bind mount into the
# container, which this executor's contract and its tests forbid outright. The
# limit is exported instead, so the truth is available to anything that asks
# even though free(1) keeps lying.
#
# Readiness already pulled this exact digest, so --pull=never prevents a job
# from changing its Image Release at execution time. No host path, volume or
# Docker socket enters the container: nothing writable is shared between jobs,
# and warm state comes only from the immutable Image Release. Cross-job
# dependency caching belongs outside this boundary, in a repository-scoped and
# authenticated cache service reached over the network -- GitHub's own by
# default, or the endpoint in ERAINFRA_CACHE_URL when an operator has configured
# one (ADR 0007). Neither is storage on this Worker.
#
# Not ./run.sh: it and run-helper.sh exist to drive a long-lived service, so
# they map "listener exited with a terminated error" onto exit 0 -- stop, do
# not retry. For a one-shot ephemeral runner that turns every startup failure
# into a reported success. Invoke the listener directly and keep its own code.
# Docker's /dev/shm default is 64 MiB no matter what --memory says, while a
# GitHub-hosted runner gives a job half its RAM there (measured: 7995 MiB of
# 15989 in #87). Chromium and friends put renderer shared memory in /dev/shm,
# so at 64 MiB browser tests die with SIGBUS on writes the memory limit was
# sized to allow. Half the job's memory matches the hosted convention, and
# because shm is tmpfs the size is a CAP, not a reservation -- pages count
# against the same cgroup limit either way, so this grants no memory the
# limit did not already promise (#87).
RC_SHM_MIB=$((RC_MEMORY_MIB / 2))
# Resource limits. Every rlimit a container gets is the Docker daemon's, which
# is its systemd unit's, which is the host's -- three layers, none of them this
# repository, and #96 measured the result: no core-dump bound, an 8 MiB stack
# where hosted gives 16, a million file descriptors where hosted gives 65536, a
# 64 KiB lock bound where hosted gives 8 MiB, and no process bound at all. Each
# flag below is a decision; the two limits deliberately left inherited are
# recorded at the end of this block, because "we looked and the default is
# right" and "nobody looked" have to be distinguishable later.
#
# core: a crashing process may not write a core dump. `ubuntu-latest` sets the
# soft limit to 0 for the same reason; the hard limit is 0 here as well, which
# hosted's is not, because a hosted VM's dump lands on a disk that belongs to
# one job and this container's writable layer shares the Worker's filesystem
# with every other Attempt on the machine. A multi-gigabyte dump from one job
# is a disk-full failure for its neighbours.
#
# stack: 16 MiB soft, matching hosted. Docker's 8 MiB default is the number a
# deeply recursive build, a generated parser or a large template instantiation
# overflows -- and it overflows as a SIGSEGV, not as a message anyone can act
# on. The hard limit stays unlimited, as Docker leaves it, so a job that wants
# a bigger thread stack can still raise its own.
#
# nofile: soft 65536, matching hosted, and the hard limit stays at the daemon's
# 1048576. Bigger is not better here: code that closes the whole descriptor
# range across fork/exec -- older Python `subprocess`, some JVM and Ruby paths
# -- walks it one descriptor at a time, and a million takes measurably longer
# than sixty-five thousand for no benefit. Leaving the hard limit high means a
# job that genuinely needs more can raise its own soft limit, which on a hosted
# runner it cannot.
#
# memlock: 8 MiB, matching hosted. Docker's 64 KiB is small enough that a
# library holding key material in unswappable pages -- gnupg, some TLS and
# hardware-token stacks -- either falls back to unlocked memory or refuses to
# start. Locked pages are charged to the same memory cgroup either way, so this
# grants nothing the Profile's --memory did not already promise.
RC_PIDS_LIMIT=4096
# nproc: the kernel's own rule, applied to the Profile instead of the host.
# Linux derives RLIMIT_NPROC as max_threads/2 and max_threads from RAM at one
# thread per 8 stacks, which on a 4 KiB-page, 16 KiB-stack host is 128 KiB per
# thread -- so the default is RAM/256 KiB, i.e. four processes per MiB. That is
# where hosted's 63838 comes from (16 GiB), and applying the same rule to the
# Profile's memory rather than the Worker's 251 GiB is what makes the bound
# scale with what the job was sold.
#
# The bound is a backstop and not the primary one. RLIMIT_NPROC is counted per
# real UID, and every Attempt on this Worker runs as the same `runner` uid in
# the same user namespace, so this ceiling is shared with the other Attempts on
# the machine. --pids-limit is the per-Attempt bound that is actually precise,
# because the cgroup pids controller counts per cgroup. The floor keeps a small
# Profile's share above four Attempts' worth of that bound, so one Attempt
# saturating its own cgroup cannot be what fails its neighbours -- while
# `unlimited`, which is what the daemon handed us, bounded nothing at all.
RC_NPROC_MAX=$((RC_MEMORY_MIB * 4))
if [ "$RC_NPROC_MAX" -lt $((RC_PIDS_LIMIT * 4)) ]; then
  RC_NPROC_MAX=$((RC_PIDS_LIMIT * 4))
fi
# Left inherited on purpose, and this is the record of it:
#
#   sigpending -- the daemon's value follows the host's RAM (#96 measured
#   1029590 against hosted's 63838). It bounds queued real-time signals per
#   uid; no build tool queues them in bulk, lowering it can only produce
#   sigqueue(3) EAGAIN, and because it is per-uid a tighter bound would couple
#   concurrent Attempts together for no measured benefit.
#
#   the sysctls in #96 -- vm.max_map_count, the two fs.inotify limits,
#   vm.swappiness, kernel.threads-max and user.max_user_namespaces. Not one of
#   them is namespaced, so `docker run --sysctl` refuses all six outright
#   ("sysctl '...' is not allowed", verified against Docker 27.5 and 28.1);
#   they are Worker host settings. Readiness measures them per Profile
#   (`host-sysctls`) and README carries the sysctl.d file that sets them.
docker run --rm --pull=never --init --name "$RUNNER_NAME" \
  --cpus "$RC_VCPUS" \
  --cpuset-cpus "$RC_CPUSET_CPUS" \
  --memory "${RC_MEMORY_MIB}m" \
  --shm-size "${RC_SHM_MIB}m" \
  --pids-limit "$RC_PIDS_LIMIT" \
  --ulimit core=0:0 \
  --ulimit stack=16777216:-1 \
  --ulimit nofile=65536:1048576 \
  --ulimit memlock=8388608:8388608 \
  --ulimit "nproc=${RC_NPROC_MAX}:${RC_NPROC_MAX}" \
  "${dns_flags[@]}" \
  --user runner \
  --workdir /opt/runner \
  --label "runner-center.profile=$RC_PROFILE" \
  --env-file "$WORKDIR/runner.env" \
  --env "RC_VCPUS=$RC_VCPUS" \
  --env "RC_MEMORY_MIB=$RC_MEMORY_MIB" \
  --env ACTIONS_RUNNER_RETURN_VERSION_DEPRECATED_EXIT_CODE=1 \
  --env ACTIONS_RUNNER_ACTION_ARCHIVE_CACHE=/opt/action-cache \
  ${cache_flags[@]+"${cache_flags[@]}"} \
  --env RUNNER_TOOL_CACHE=/opt/hostedtoolcache \
  --env AGENT_TOOLSDIRECTORY=/opt/hostedtoolcache \
  "$IMAGE" ./bin/Runner.Listener run &
DOCKER_PID=$!
wait "$ENV_WRITER_PID"
ENV_WRITER_PID=""
ACTIONS_RUNNER_INPUT_JITCONFIG=""

(
  remaining="$JOB_TIMEOUT_S"
  while [ "$remaining" -gt 0 ]; do
    sleep 1
    if ! kill -0 "$DOCKER_PID" 2>/dev/null; then
      exit 0
    fi
    remaining=$((remaining - 1))
  done
  : >"$WORKDIR/timed-out"
  docker stop --time 30 "$RUNNER_NAME" >/dev/null 2>&1 || true
) &
WATCHDOG_PID=$!

set +e
wait "$DOCKER_PID"
runner_exit_code=$?
set -e
DOCKER_PID=""
exit "$runner_exit_code"
