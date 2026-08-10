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
CACHE_VOLUME="runner-center-${RC_PROFILE}-pnpm"
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

# Invoked indirectly by the EXIT trap installed immediately below.
# shellcheck disable=SC2329
cleanup() {
  local code=$?
  trap - EXIT
  if [ -n "$WATCHDOG_PID" ]; then
    kill "$WATCHDOG_PID" 2>/dev/null || true
    wait "$WATCHDOG_PID" 2>/dev/null || true
  fi
  if [ -n "$ENV_WRITER_PID" ]; then
    kill "$ENV_WRITER_PID" 2>/dev/null || true
    wait "$ENV_WRITER_PID" 2>/dev/null || true
  fi
  docker rm -f "$RUNNER_NAME" >/dev/null 2>&1 || true
  if [ -n "$DOCKER_PID" ]; then
    kill "$DOCKER_PID" 2>/dev/null || true
    wait "$DOCKER_PID" 2>/dev/null || true
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

# Readiness already pulled this exact digest and initialized the Profile-local
# pnpm volume. --pull=never prevents a job from changing its Image Release at
# execution time. No host path or Docker socket enters the container. The one
# writable cache is only allowed because Docker Profiles are trusted-only.
docker run --rm --pull=never --init --name "$RUNNER_NAME" \
  --cpus "$RC_VCPUS" \
  --memory "${RC_MEMORY_MIB}m" \
  --pids-limit 4096 \
  --user runner \
  --workdir /opt/runner \
  --mount "type=volume,src=$CACHE_VOLUME,dst=/runner-cache/pnpm" \
  --env-file "$WORKDIR/runner.env" \
  --env ACTIONS_RUNNER_RETURN_VERSION_DEPRECATED_EXIT_CODE=1 \
  --env ACTIONS_RUNNER_ACTION_ARCHIVE_CACHE=/opt/action-cache \
  --env RUNNER_TOOL_CACHE=/opt/hostedtoolcache \
  --env AGENT_TOOLSDIRECTORY=/opt/hostedtoolcache \
  "$IMAGE" ./run.sh &
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
