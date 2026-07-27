#!/usr/bin/env bash
set -euo pipefail

: "${RUNNER_NAME:?RUNNER_NAME is required}"
: "${JIT_CONFIG:?JIT_CONFIG is required}"

# GitHub deprecates old runner versions aggressively; keep this current.
IMAGE="${IMAGE:-${RUNNER_IMAGE:-ghcr.io/actions/actions-runner:2.336.0}}"

exec docker run --rm --name "$RUNNER_NAME" \
  "$IMAGE" \
  ./run.sh --jitconfig "$JIT_CONFIG"
