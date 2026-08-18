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
# dependency caching belongs outside this boundary, in GitHub's own
# repository-scoped and authenticated cache service.
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
docker run --rm --pull=never --init --name "$RUNNER_NAME" \
  --cpus "$RC_VCPUS" \
  --cpuset-cpus "$RC_CPUSET_CPUS" \
  --memory "${RC_MEMORY_MIB}m" \
  --shm-size "${RC_SHM_MIB}m" \
  --pids-limit 4096 \
  --user runner \
  --workdir /opt/runner \
  --label "runner-center.profile=$RC_PROFILE" \
  --env-file "$WORKDIR/runner.env" \
  --env "RC_VCPUS=$RC_VCPUS" \
  --env "RC_MEMORY_MIB=$RC_MEMORY_MIB" \
  --env ACTIONS_RUNNER_RETURN_VERSION_DEPRECATED_EXIT_CODE=1 \
  --env ACTIONS_RUNNER_ACTION_ARCHIVE_CACHE=/opt/action-cache \
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
