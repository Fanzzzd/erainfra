#!/usr/bin/env bash
set -euo pipefail

: "${RUNNER_NAME:?RUNNER_NAME is required}"
: "${JIT_CONFIG:?JIT_CONFIG is required}"

BASE_IMAGE="${BASE_IMAGE:-ghcr.io/cirruslabs/macos-sequoia-base:latest}"
VM_NAME="$RUNNER_NAME"
TART="${TART:-/opt/homebrew/bin/tart}"
SSHPASS="${SSHPASS:-/opt/homebrew/bin/sshpass}"
VM_PID=""
IP=""

ssh_options=(
  -o StrictHostKeyChecking=no
  -o UserKnownHostsFile=/dev/null
  -o ConnectTimeout=5
  -o PreferredAuthentications=password
  -o PubkeyAuthentication=no
  -o LogLevel=ERROR
)

cleanup() {
  local exit_code=$?
  trap - EXIT

  if [[ -n "$VM_PID" ]] && kill -0 "$VM_PID" 2>/dev/null; then
    kill "$VM_PID" 2>/dev/null || true
    wait "$VM_PID" 2>/dev/null || true
  fi

  "$TART" delete "$VM_NAME" >/dev/null 2>&1 || true
  exit "$exit_code"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

if [[ ! -x "$TART" ]]; then
  echo "tart is required at $TART" >&2
  exit 1
fi
if [[ ! -x "$SSHPASS" ]]; then
  echo "sshpass is required at $SSHPASS" >&2
  echo "Install it with: brew install cirruslabs/cli/sshpass" >&2
  exit 1
fi

"$TART" clone "$BASE_IMAGE" "$VM_NAME"
"$TART" run "$VM_NAME" --no-graphics &
VM_PID=$!

wait_for_ip() {
  local deadline=$((SECONDS + 120))

  while (( SECONDS < deadline )); do
    if ! kill -0 "$VM_PID" 2>/dev/null; then
      echo "Tart VM $VM_NAME exited before receiving an IP address" >&2
      return 1
    fi

    IP=$("$TART" ip "$VM_NAME" 2>/dev/null || true)
    if [[ -n "$IP" ]]; then
      return 0
    fi
    sleep 2
  done

  echo "Timed out waiting for Tart VM $VM_NAME to receive an IP address" >&2
  return 1
}

wait_for_ssh() {
  local deadline=$((SECONDS + 120))

  while (( SECONDS < deadline )); do
    if ! kill -0 "$VM_PID" 2>/dev/null; then
      echo "Tart VM $VM_NAME exited before SSH became available" >&2
      return 1
    fi

    if "$SSHPASS" -p admin ssh "${ssh_options[@]}" "admin@$IP" true 2>/dev/null; then
      return 0
    fi
    sleep 2
  done

  echo "Timed out waiting for SSH on Tart VM $VM_NAME at $IP" >&2
  return 1
}

wait_for_ip
wait_for_ssh

# Quote the opaque JIT configuration as one argument for the remote shell.
escaped_jit_config=${JIT_CONFIG//\'/\'\\\'\'}
remote_command="~/actions-runner/run.sh --jitconfig '$escaped_jit_config'"

set +e
"$SSHPASS" -p admin ssh "${ssh_options[@]}" "admin@$IP" "$remote_command"
runner_exit_code=$?
set -e

exit "$runner_exit_code"
