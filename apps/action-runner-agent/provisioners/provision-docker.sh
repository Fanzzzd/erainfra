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
  kill -0 "$1" 2>/dev/null
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
docker run --rm --pull=never --init --name "$RUNNER_NAME" \
  --cpus "$RC_VCPUS" \
  --memory "${RC_MEMORY_MIB}m" \
  --pids-limit 4096 \
  --user runner \
  --workdir /opt/runner \
  --label "runner-center.profile=$RC_PROFILE" \
  --env-file "$WORKDIR/runner.env" \
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
