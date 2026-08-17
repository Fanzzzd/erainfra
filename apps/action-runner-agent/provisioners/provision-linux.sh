#!/usr/bin/env bash
# One ephemeral Docker container per job.
#
# The JIT configuration is read from stdin and handed to the container through
# ACTIONS_RUNNER_INPUT_JITCONFIG, which upstream's Runner.Listener accepts in
# place of `--jitconfig`. Passing it on the command line would publish it in
# `ps` output on the host, where it is readable by every local user.
#
# Environment
#   RUNNER_NAME       (required) container name
#   IMAGE             runner image, falls back to RUNNER_IMAGE then the pin below
#   RC_JOB_TIMEOUT_S  overall runner budget, defaults to 21600 (6h); exceeding it
#                     stops the container and exits 124, the same as the other
#                     provisioners. JOB_TIMEOUT_S is a compatibility fallback.
#
# Stdin
#   The base64 JIT configuration.

set -euo pipefail

: "${RUNNER_NAME:?RUNNER_NAME is required}"

# GitHub deprecates old runner versions aggressively; keep this current.
IMAGE="${IMAGE:-${RUNNER_IMAGE:-ghcr.io/actions/actions-runner:2.336.0}}"
JOB_TIMEOUT_S="${RC_JOB_TIMEOUT_S:-${JOB_TIMEOUT_S:-21600}}"

if [ -t 0 ]; then
  echo "The JIT configuration must be piped in on stdin, e.g. printf %s \"\$encoded_jit_config\" | $0" >&2
  exit 1
fi

ACTIONS_RUNNER_INPUT_JITCONFIG="$(cat)"
export ACTIONS_RUNNER_INPUT_JITCONFIG

if [ -z "$ACTIONS_RUNNER_INPUT_JITCONFIG" ]; then
  echo "Read an empty JIT configuration from stdin." >&2
  exit 1
fi

WORKDIR="$(mktemp -d "${TMPDIR:-/tmp}/rc-linux-XXXXXXXX")"
chmod 700 "$WORKDIR"
DOCKER_PID=""
WATCHDOG_PID=""

# `docker run --rm` only removes the container when the client sees it exit, so
# a signalled or timed-out run has to remove it explicitly.
# shellcheck disable=SC2317,SC2329  # old/new ShellCheck codes for trap-only calls
cleanup() {
  local exit_code=$?
  trap - EXIT

  if [ -n "$WATCHDOG_PID" ]; then
    kill "$WATCHDOG_PID" 2>/dev/null || true
    wait "$WATCHDOG_PID" 2>/dev/null || true
  fi

  if [ -n "$DOCKER_PID" ] && kill -0 "$DOCKER_PID" 2>/dev/null; then
    docker rm -f "$RUNNER_NAME" >/dev/null 2>&1 || true
    kill "$DOCKER_PID" 2>/dev/null || true
    wait "$DOCKER_PID" 2>/dev/null || true
  fi

  docker rm -f "$RUNNER_NAME" >/dev/null 2>&1 || true

  if [ -f "$WORKDIR/timed-out" ]; then
    rm -rf "$WORKDIR" 2>/dev/null || true
    printf 'error: the job exceeded RC_JOB_TIMEOUT_S; the container was removed.\n' >&2
    exit 124
  fi

  rm -rf "$WORKDIR" 2>/dev/null || true
  exit "$exit_code"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 131' QUIT
trap 'exit 143' TERM

# `--env NAME` without `=value` forwards the value from this process's
# environment, so it never appears in the docker client's argv.
#
# Not ./run.sh: it and run-helper.sh exist to drive a long-lived service, so
# they map "listener exited with a terminated error" onto exit 0 -- stop, do
# not retry. For a one-shot ephemeral runner that turns every startup failure
# into a reported success. Invoke the listener directly and keep its own code.
docker run --rm --name "$RUNNER_NAME" \
  --env ACTIONS_RUNNER_INPUT_JITCONFIG \
  --env ACTIONS_RUNNER_RETURN_VERSION_DEPRECATED_EXIT_CODE=1 \
  "$IMAGE" \
  ./bin/Runner.Listener run &
DOCKER_PID=$!

if [ "$JOB_TIMEOUT_S" -gt 0 ]; then
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
fi

set +e
wait "$DOCKER_PID"
runner_exit_code=$?
set -e
DOCKER_PID=""

exit "$runner_exit_code"
