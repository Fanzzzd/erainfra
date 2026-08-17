#!/usr/bin/env bash
# One ephemeral Tart VM per job.
#
# The VM is cloned from an immutable base image, booted without graphics, given
# a pinned and checksum-verified GitHub Actions runner, and deleted again when
# the runner exits -- on success, failure, timeout or signal.
#
# Secret handling
#   The JIT configuration is read from *stdin*, never from argv and never from
#   the environment, so it cannot appear in `ps` output on the host. It is
#   staged in a mode-600 file inside a mode-700 private work directory, streamed
#   into the guest over the encrypted SSH channel into another mode-600 file,
#   and that file is deleted by the guest before the runner starts. The runner
#   itself is handed the value through ACTIONS_RUNNER_INPUT_JITCONFIG, which is
#   the only non-argv input the upstream runner accepts; see SECURITY NOTES at
#   the bottom of this file for the residual exposure that implies.
#
# Environment
#   RUNNER_NAME              (required) also the VM name
#   IMAGE / BASE_IMAGE       base image, defaults to the pinned Sequoia digest
#   TART                     tart binary, defaults to /opt/homebrew/bin/tart
#   SSHPASS                  sshpass binary, defaults to /opt/homebrew/bin/sshpass
#   RC_HOME                  state directory, defaults to ~/.runner-center
#   RC_MAC_RUNNER_VERSION    pinned actions/runner release, see default below
#   RC_MAC_RUNNER_SHA256     SHA-256 of the osx-arm64 tarball for that release
#   RC_MAC_GUEST_USER        guest account, defaults to "admin"
#   RC_MAC_GUEST_PASSWORD    guest password, defaults to "admin"
#   RC_BOOT_TIMEOUT_S        boot + SSH readiness budget, defaults to 300
#   RC_JOB_TIMEOUT_S         overall runner budget, defaults to 21600 (6h);
#                            exceeding it exits 124 on every OS
#   RC_MAC_ATTEST_TIMEOUT_S  guest-agent host key attestation budget, default 60
#
#   RC_MAC_BOOT_TIMEOUT_S and RC_MAC_JOB_TIMEOUT_S are accepted as compatibility
#   fallbacks for the two shared names above.
#   RC_MAC_MAX_CONCURRENT_VMS  licensing guard rail, defaults to 2
#
# Stdin
#   The base64 JIT configuration, with or without a trailing newline.

set -euo pipefail

# --- Pinned upstream artifacts ----------------------------------------------
# actions/runner osx-arm64. The checksum is the one published in the release
# body of https://github.com/actions/runner/releases/tag/v2.336.0 and matches
# the asset digest reported by the GitHub releases API. Bump both together.
RC_RUNNER_VERSION_DEFAULT="2.336.0"
RC_RUNNER_SHA256_DEFAULT="8e8839c49b7060b6b2154f4931f815df330c27f167d53ef2239ee3dfce28b079"

# Pinned by digest for the same reason the runner tarball is: `:latest` moves.
# This is the image the end-to-end runs were executed against, and it must track
# the macos-15/rc-mac entries in packages/backend/convex/catalog.ts. It is only a
# fallback -- a catalog-backed command always passes IMAGE explicitly.
RC_DEFAULT_IMAGE="ghcr.io/cirruslabs/macos-sequoia-base@sha256:fdd8b72a6ee46fc8ad35dc1b9f3b1f162b6607b82a584947d20bb28d3dcb99ed"

# --- Mutable run state ------------------------------------------------------
WORKDIR=""
VM_NAME=""
VM_PID=""
VM_CLONED=0
WATCHDOG_PID=""
JOB_PID=""
TIMED_OUT=0
SLOT_DIR=""

log() { printf '%s\n' "$*"; }
warn() { printf 'warning: %s\n' "$*" >&2; }
die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

# ---------------------------------------------------------------------------
# Cleanup
# ---------------------------------------------------------------------------

# Nothing on the teardown path may use `wait`, and nothing on it may be
# unbounded.
#
# `wait` is unusable here because bash's job table can outlive the process it
# describes. When a child exits in the same instant it signals this shell --
# which is exactly what the watchdog does, `kill -TERM "$parent"` and then
# straight to its own exit -- the SIGCHLD can be lost against the trap that
# signal fires. `jobs` then still reports the watchdog as Running when `kill -0`
# already reports it gone, and `wait` blocks in waitpid(2) for an exit that has
# already happened. It is a race, so it is intermittent and load-dependent, and
# it strands the shell in cleanup() with everything below the `wait` unreached.
#
# Unbounded is unacceptable independently of that: this function's whole job is
# to make progress when the thing it is cleaning up will not. So teardown asks
# the kernel rather than bash -- `kill -0` is never stale -- and every poll below
# has a deadline after which the caller carries on regardless.
TEARDOWN_GRACE_S=2

# True while $1 is live. $1 is a pid, or -pgid for a whole process group.
#
# Zombies are explicitly not alive. A process that has exited but has not been
# reaped still answers `kill -0`, and a process group answers `kill -0` for as
# long as ANY member exists at all, zombies included. Bash reaps its own
# children promptly whether or not anybody waits, but a pipeline member that
# forked and then died before reaping leaves an orphan for init to collect, and
# that can outlast the grace below. Counting those as alive made every teardown
# spend its whole budget and then SIGKILL a job that had already died politely.
still_alive() {
  local states
  case "$1" in
    -*)
      kill -0 "$1" 2>/dev/null || return 1
      states="$(ps -A -o pgid=,state= 2>/dev/null | awk -v g="${1#-}" '$1 == g { print $2 }')"
      # If ps cannot say, fail safe and call it alive: the poll is bounded
      # anyway, and the alternative would skip the escalation.
      if [ -z "$states" ]; then
        return 0
      fi
      printf '%s\n' "$states" | grep -qv '^Z'
      ;;
    *)
      kill -0 "$1" 2>/dev/null || return 1
      case "$(ps -o state= -p "$1" 2>/dev/null | tr -d ' ')" in
        Z*) return 1 ;;
      esac
      ;;
  esac
}

# Polls for at most $2 seconds. Non-zero means $1 outlived that budget.
await_exit() {
  local target="$1" ticks=$(($2 * 10))
  while [ "$ticks" -gt 0 ]; do
    still_alive "$target" || return 0
    sleep 0.1
    ticks=$((ticks - 1))
  done
  ! still_alive "$target"
}

# TERM $1, a short grace, then KILL $1, then give up and let the caller
# continue. Two seconds is plenty: everything reaped here is either the
# watchdog, which has already done its work, or a host-side process whose guest
# is about to be deleted out from under it anyway.
#
# $1 may be a negated process group, which is how the whole SSH chain is torn
# down at once.
#
# Deliberately always succeeds. Under `set -e` a best-effort teardown step that
# reported failure would abort the rest of cleanup, which is the same class of
# mistake as blocking in it.
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

# `--timeout 15` is tart's own bound on the guest's graceful shutdown, not a
# bound on the tart binary, so the client gets a host-side deadline as well.
# Its status is discarded either way; the delete that follows is what matters.
stop_vm() {
  "$TART" stop "$VM_NAME" --timeout 15 >/dev/null 2>&1 &
  local stopper=$!
  await_exit "$stopper" 20 || kill -KILL "$stopper" 2>/dev/null || true
}

# Deletes the VM and wipes the private work directory. Safe to call more than
# once and safe to call before the VM exists.
cleanup() {
  local exit_code=$?
  trap - EXIT

  if [ -n "$WORKDIR" ] && [ -f "$WORKDIR/timed-out" ]; then
    TIMED_OUT=1
  fi

  # The guest is destroyed first, before anything that merely refuses to die
  # gets a chance to stand in front of it. It is the only thing here that costs
  # money to leak: a surviving Tart VM holds its Profile slot until an operator
  # notices, and macOS has no equivalent of recoverFirecrackerOrphans to find it
  # on the next run. The host-side processes below are cheap by comparison, so
  # they are reaped afterwards -- their order relative to the delete never
  # mattered, and putting them first is what made the delete unreachable.
  if [ -n "$VM_PID" ] && still_alive "$VM_PID"; then
    stop_vm
    reap "$VM_PID"
  fi

  if [ "$VM_CLONED" = "1" ]; then
    "$TART" delete "$VM_NAME" >/dev/null 2>&1 || true
  fi

  if [ -n "$WATCHDOG_PID" ]; then
    reap "$WATCHDOG_PID"
  fi

  kill_job_group

  if [ -n "$WORKDIR" ] && [ -d "$WORKDIR" ]; then
    rm -rf "$WORKDIR" 2>/dev/null || true
  fi

  if [ -n "$SLOT_DIR" ]; then
    rm -f "$SLOT_DIR/pid" 2>/dev/null || true
    rmdir "$SLOT_DIR" 2>/dev/null || true
  fi

  if [ "$TIMED_OUT" = "1" ]; then
    printf 'error: the job exceeded RC_JOB_TIMEOUT_S; the VM was destroyed.\n' >&2
    exit 124
  fi
  exit "$exit_code"
}

process_group_of() {
  ps -o pgid= -p "$1" 2>/dev/null | tr -d ' '
}

# The job runs in its own process group (see run_job), so the whole chain --
# subshell, sshpass, ssh -- can be torn down together. Killing only the pipeline
# leaves the SSH client behind, still waiting on a guest that is about to be
# deleted out from under it.
kill_job_group() {
  if [ -z "$JOB_PID" ] || ! still_alive "$JOB_PID"; then
    return 0
  fi

  local job_group target
  job_group="$(process_group_of "$JOB_PID")"

  # Falling back to the bare pid is what keeps this from ever signalling the
  # Agent's own group when the setpgid did not take.
  if [ -n "$job_group" ] && [ "$job_group" != "$(process_group_of $$)" ]; then
    target="-$job_group"
  else
    target="$JOB_PID"
  fi

  # A job that ignores TERM -- a runner with its own handler, or one wedged in
  # an uninterruptible read -- is exactly the case this has to survive, so the
  # grace is short and the escalation to KILL is unconditional.
  reap "$target"
}

# `exit` from a signal trap runs the EXIT trap, which is what deletes the VM.
install_traps() {
  trap cleanup EXIT
  trap 'exit 129' HUP
  trap 'exit 130' INT
  trap 'exit 131' QUIT
  trap 'exit 143' TERM
}

# ---------------------------------------------------------------------------
# SSH
# ---------------------------------------------------------------------------

# Options shared by every SSH invocation. Host key policy is decided by
# attest_host_key(); everything else is fixed.
#
# Notably absent: StrictHostKeyChecking=no and UserKnownHostsFile=/dev/null,
# which disable host authentication outright.
ssh_common_options() {
  printf '%s\n' \
    -o "UserKnownHostsFile=$WORKDIR/known_hosts" \
    -o "GlobalKnownHostsFile=/dev/null" \
    -o "HostKeyAlias=$HOST_KEY_ALIAS" \
    -o "StrictHostKeyChecking=$SSH_STRICTNESS" \
    -o "HostKeyAlgorithms=ssh-ed25519" \
    -o "PreferredAuthentications=password" \
    -o "PubkeyAuthentication=no" \
    -o "KbdInteractiveAuthentication=no" \
    -o "NumberOfPasswordPrompts=1" \
    -o "ConnectTimeout=10" \
    -o "ServerAliveInterval=30" \
    -o "ServerAliveCountMax=6" \
    -o "LogLevel=ERROR"
}

# Runs ssh through sshpass. The password comes from a mode-600 file rather than
# `sshpass -p`, which would put it in the host process listing.
guest_ssh() {
  local options=()
  while IFS= read -r option; do
    options+=("$option")
  done < <(ssh_common_options)

  "$SSHPASS" -f "$WORKDIR/guest-password" ssh "${options[@]}" \
    "$GUEST_USER@$IP" "$@"
}

# ---------------------------------------------------------------------------
# Preflight
# ---------------------------------------------------------------------------

require_executable() {
  local path="$1" name="$2" hint="$3"
  if [ ! -x "$path" ]; then
    die "$name is required but was not executable at $path. $hint"
  fi
}

require_on_path() {
  local name="$1" hint="$2"
  if ! command -v "$name" >/dev/null 2>&1; then
    die "$name is required but was not found on PATH. $hint"
  fi
}

require_positive_integer() {
  local name="$1" value="$2"
  case "$value" in
    "" | *[!0-9]* | 0) die "$name must be a positive integer; got '$value'." ;;
  esac
}

require_nonnegative_integer() {
  local name="$1" value="$2"
  case "$value" in
    "" | *[!0-9]*) die "$name must be a non-negative integer; got '$value'." ;;
  esac
}

# mkdir is the portable atomic lock available on macOS. The backend also caps
# Worker slots, but this host-side boundary prevents a second Agent process or
# an operator mistake from exceeding the configured Tart guest allowance.
acquire_tart_slot() {
  local root="$RC_HOME/tart-slots" slot=1 candidate owner
  mkdir -p "$root"
  chmod 700 "$root"
  while [ "$slot" -le "$MAX_CONCURRENT_VMS" ]; do
    candidate="$root/slot-$slot"
    if mkdir "$candidate" 2>/dev/null; then
      printf '%s\n' "$$" >"$candidate/pid"
      SLOT_DIR="$candidate"
      return 0
    fi
    owner="$(cat "$candidate/pid" 2>/dev/null || true)"
    if [ -z "$owner" ] || ! kill -0 "$owner" 2>/dev/null; then
      rm -f "$candidate/pid" 2>/dev/null || true
      rmdir "$candidate" 2>/dev/null || true
      if mkdir "$candidate" 2>/dev/null; then
        printf '%s\n' "$$" >"$candidate/pid"
        SLOT_DIR="$candidate"
        return 0
      fi
    fi
    slot=$((slot + 1))
  done
  die "All $MAX_CONCURRENT_VMS Tart VM slots are occupied; wait for a guest to finish."
}

# Everything that can be checked before a VM is cloned, so failures cost
# seconds instead of a full boot cycle.
preflight() {
  require_positive_integer RC_BOOT_TIMEOUT_S "$BOOT_TIMEOUT_S"
  # Zero is useful for local harnesses and explicitly disables the watchdog;
  # production Agents always pass their bounded Profile timeout.
  require_nonnegative_integer RC_JOB_TIMEOUT_S "$JOB_TIMEOUT_S"
  require_positive_integer RC_MAC_ATTEST_TIMEOUT_S "$ATTEST_TIMEOUT_S"
  require_positive_integer RC_MAC_MAX_CONCURRENT_VMS "$MAX_CONCURRENT_VMS"

  case "$RUNNER_NAME" in
    *[!A-Za-z0-9._-]* | "")
      die "RUNNER_NAME must match [A-Za-z0-9._-]+ because it becomes the Tart VM name; got '$RUNNER_NAME'."
      ;;
  esac

  require_executable "$TART" "tart" "Install it with: brew install cirruslabs/cli/tart"
  require_executable "$SSHPASS" "sshpass" "Install it with: brew install cirruslabs/cli/sshpass"
  require_on_path ssh "It ships with macOS; check that /usr/bin is on PATH."
  require_on_path curl "It ships with macOS; check that /usr/bin is on PATH."
  require_on_path shasum "It ships with macOS; check that /usr/bin is on PATH."

  if [ "$(uname -m)" != "arm64" ]; then
    die "Tart requires Apple Silicon; this host reports $(uname -m)."
  fi

  # `--quiet` prints one name per line. The JSON form escapes forward slashes,
  # so image references never match there.
  local vm_names
  vm_names="$("$TART" list --quiet 2>/dev/null || true)"

  if printf '%s\n' "$vm_names" | grep -qxF "$VM_NAME"; then
    die "A Tart VM named $VM_NAME already exists. Delete it with: $TART delete $VM_NAME"
  fi

  local running
  running="$("$TART" list --format json 2>/dev/null |
    grep -c '"Running"[[:space:]]*:[[:space:]]*true' || true)"
  if [ "$running" -ge "$MAX_CONCURRENT_VMS" ]; then
    die "$running Tart VMs are already running; the configured allowance is $MAX_CONCURRENT_VMS."
  fi

  if ! printf '%s\n' "$vm_names" | grep -qxF "$IMAGE"; then
    log "Base image $IMAGE is not in the local Tart cache; it will be pulled now (tens of GB). Pre-pull it with: $TART pull $IMAGE"
    # ghcr.io/v2/ answers 401 to an anonymous request, which still proves it is
    # reachable, so this deliberately does not use curl --fail.
    if ! curl -sS -m 15 -o /dev/null "https://ghcr.io/v2/" 2>/dev/null; then
      die "Base image $IMAGE is not cached locally and ghcr.io is unreachable. Restore outbound HTTPS or pre-pull the image on a connected network."
    fi
  fi

  local free_gb
  free_gb="$(df -g "$HOME" 2>/dev/null | awk 'NR==2 {print $4}')"
  if [ -n "${free_gb:-}" ] && [ "$free_gb" -lt 40 ]; then
    warn "Only ${free_gb}GiB free under $HOME. A Tart clone is copy-on-write but a busy job can still fill the disk."
  fi
}

# One line of "<arch> <tar|-> <shasum|-> <free GiB>" describing the guest.
guest_probe_script() {
  cat <<'GUEST'
printf '%s %s %s %s\n' \
  "$(uname -m)" \
  "$(command -v tar || echo -)" \
  "$(command -v shasum || echo -)" \
  "$(df -g "$HOME" | awk 'NR==2 {print $4}')"
GUEST
}

# Checks the things that can only be observed once the guest is reachable.
guest_preflight() {
  local report
  report="$(guest_probe_script | guest_ssh "bash -s" 2>/dev/null || true)"

  if [ -z "$report" ]; then
    die "Could not read guest prerequisites over SSH from $IMAGE. The image must allow '$GUEST_USER' to log in over SSH."
  fi

  local arch tar_path shasum_path guest_free
  arch="$(printf '%s' "$report" | awk '{print $1}')"
  tar_path="$(printf '%s' "$report" | awk '{print $2}')"
  shasum_path="$(printf '%s' "$report" | awk '{print $3}')"
  guest_free="$(printf '%s' "$report" | awk '{print $4}')"

  if [ "$arch" != "arm64" ]; then
    die "Guest reports architecture '$arch'; this provisioner installs the osx-arm64 runner build only."
  fi
  if [ "$tar_path" = "-" ] || [ "$shasum_path" = "-" ]; then
    die "Guest image $IMAGE is missing tar and/or shasum, which are required to install the runner."
  fi
  if [ -n "$guest_free" ] && [ "$guest_free" -lt 5 ]; then
    die "Guest has only ${guest_free}GiB free; the runner needs a few GiB before the job even starts."
  fi
}

# ---------------------------------------------------------------------------
# Pinned runner tarball
# ---------------------------------------------------------------------------

runner_download_url() {
  printf 'https://github.com/actions/runner/releases/download/v%s/actions-runner-osx-arm64-%s.tar.gz' \
    "$RUNNER_VERSION" "$RUNNER_VERSION"
}

sha256_of() {
  shasum -a 256 "$1" | awk '{print $1}'
}

# Keeps one verified copy of the pinned tarball per host. A cached file whose
# digest no longer matches is discarded rather than trusted.
ensure_runner_tarball() {
  local cache_dir="$RC_HOME/cache"
  TARBALL="$cache_dir/actions-runner-osx-arm64-$RUNNER_VERSION.tar.gz"

  mkdir -p "$cache_dir"

  if [ -f "$TARBALL" ]; then
    if [ "$(sha256_of "$TARBALL")" = "$RUNNER_SHA256" ]; then
      return 0
    fi
    warn "Cached $TARBALL failed its checksum; re-downloading."
    rm -f "$TARBALL"
  fi

  local url download
  url="$(runner_download_url)"
  download="$TARBALL.$$.part"

  log "Downloading actions/runner $RUNNER_VERSION for osx-arm64"
  if ! curl -fsSL --retry 3 --retry-delay 2 -m 900 -o "$download" "$url"; then
    rm -f "$download"
    die "Failed to download $url. The host needs outbound HTTPS to github.com, or seed the cache manually at $TARBALL."
  fi

  local actual
  actual="$(sha256_of "$download")"
  if [ "$actual" != "$RUNNER_SHA256" ]; then
    rm -f "$download"
    die "Checksum mismatch for actions/runner $RUNNER_VERSION: expected $RUNNER_SHA256, got $actual. Refusing to run an unverified runner."
  fi

  mv "$download" "$TARBALL"
}

# ---------------------------------------------------------------------------
# VM lifecycle
# ---------------------------------------------------------------------------

start_vm() {
  log "Cloning $IMAGE into $VM_NAME"
  "$TART" clone "$IMAGE" "$VM_NAME"
  VM_CLONED=1

  "$TART" run "$VM_NAME" --no-graphics >"$WORKDIR/tart-run.log" 2>&1 &
  VM_PID=$!
}

vm_is_alive() {
  [ -n "$VM_PID" ] && kill -0 "$VM_PID" 2>/dev/null
}

dump_vm_log() {
  if [ -s "$WORKDIR/tart-run.log" ]; then
    printf 'tart run output:\n' >&2
    sed 's/^/  /' "$WORKDIR/tart-run.log" >&2
  fi
}

wait_for_ip() {
  local deadline=$((SECONDS + BOOT_TIMEOUT_S))

  while [ "$SECONDS" -lt "$deadline" ]; do
    if ! vm_is_alive; then
      dump_vm_log
      die "Tart VM $VM_NAME exited before it received an IP address."
    fi
    IP="$("$TART" ip "$VM_NAME" 2>/dev/null || true)"
    if [ -n "$IP" ]; then
      return 0
    fi
    sleep 2
  done

  dump_vm_log
  die "Timed out after ${BOOT_TIMEOUT_S}s waiting for $VM_NAME to receive an IP address. Check that the Tart network is up (see: $TART ip $VM_NAME)."
}

wait_for_ssh() {
  local deadline=$((SECONDS + BOOT_TIMEOUT_S))

  while [ "$SECONDS" -lt "$deadline" ]; do
    if ! vm_is_alive; then
      dump_vm_log
      die "Tart VM $VM_NAME exited before SSH became available."
    fi
    if guest_ssh true </dev/null >/dev/null 2>&1; then
      return 0
    fi
    sleep 2
  done

  dump_vm_log
  die "Timed out after ${BOOT_TIMEOUT_S}s waiting for SSH on $VM_NAME at $IP as '$GUEST_USER'. Custom images must accept that account with the password in RC_MAC_GUEST_PASSWORD."
}

# ---------------------------------------------------------------------------
# Host key handling
# ---------------------------------------------------------------------------

pinned_host_key_path() {
  local sanitized
  sanitized="$(printf '%s' "$IMAGE" | tr -c 'A-Za-z0-9._-' '_')"
  printf '%s/known_hosts.d/%s.pub' "$RC_HOME" "$sanitized"
}

# Reads the guest's SSH host key over the Tart guest agent's vsock channel,
# which is not reachable from the network the SSH session travels over. When it
# works there is no first-use trust left to worry about: the key is known before
# the first SSH byte is sent.
attest_host_key_over_vsock() {
  local deadline=$((SECONDS + ATTEST_TIMEOUT_S)) key=""

  while [ "$SECONDS" -lt "$deadline" ]; do
    if ! vm_is_alive; then
      return 1
    fi
    key="$("$TART" exec "$VM_NAME" /bin/cat /etc/ssh/ssh_host_ed25519_key.pub 2>/dev/null || true)"
    key="$(printf '%s' "$key" | awk '/^ssh-ed25519 /{print $1" "$2; exit}')"
    if [ -n "$key" ]; then
      printf '%s' "$key"
      return 0
    fi
    sleep 2
  done

  return 1
}

# Resolves SSH_STRICTNESS and seeds $WORKDIR/known_hosts.
#
# Order of preference:
#   1. key attested over vsock            -> strict, no trust on first use
#   2. key pinned from an earlier run     -> strict, trust carried forward
#   3. neither                            -> accept-new, and say so out loud
attest_host_key() {
  local pin_path attested="" pinned=""
  pin_path="$(pinned_host_key_path)"

  if [ -f "$pin_path" ]; then
    pinned="$(cat "$pin_path")"
  fi

  attested="$(attest_host_key_over_vsock || true)"

  if [ -n "$attested" ] && [ -n "$pinned" ] && [ "$attested" != "$pinned" ]; then
    die "The SSH host key of $IMAGE changed. Expected the key pinned in $pin_path. If you deliberately re-pulled the image, delete that file and re-run; otherwise treat this as a tampered image."
  fi

  local trusted="${attested:-$pinned}"

  if [ -n "$trusted" ]; then
    umask 077
    printf '%s %s\n' "$HOST_KEY_ALIAS" "$trusted" >"$WORKDIR/known_hosts"
    SSH_STRICTNESS="yes"
    if [ -z "$pinned" ]; then
      mkdir -p "$(dirname "$pin_path")"
      printf '%s\n' "$trusted" >"$pin_path"
      log "Pinned the SSH host key of $IMAGE (attested over the Tart guest agent) at $pin_path"
    fi
    return 0
  fi

  : >"$WORKDIR/known_hosts"
  chmod 600 "$WORKDIR/known_hosts"
  SSH_STRICTNESS="accept-new"
  warn "The Tart guest agent did not answer, so the guest's SSH host key could not be attested out of band and no key is pinned for $IMAGE yet. This run trusts the key presented on first contact; it is then pinned for later runs. The exposure is a local attacker on the Tart bridge during this one boot."
}

# Persists a key learned through accept-new so later runs are strict.
persist_learned_host_key() {
  if [ "$SSH_STRICTNESS" = "yes" ]; then
    return 0
  fi

  local pin_path learned
  pin_path="$(pinned_host_key_path)"
  learned="$(awk '/^[^ ]+ ssh-ed25519 /{print $2" "$3; exit}' "$WORKDIR/known_hosts" 2>/dev/null || true)"

  if [ -n "$learned" ] && [ ! -f "$pin_path" ]; then
    mkdir -p "$(dirname "$pin_path")"
    printf '%s\n' "$learned" >"$pin_path"
    log "Pinned the SSH host key of $IMAGE (trusted on first use) at $pin_path"
  fi
}

# ---------------------------------------------------------------------------
# Guest-side scripts
#
# These are piped into `bash -s` over SSH rather than passed as a remote
# command, so nothing they contain reaches the guest's process listing.
# ---------------------------------------------------------------------------

guest_install_script() {
  cat <<GUEST
set -euo pipefail

state="\$HOME/.runner-center"
runner_dir="\$state/runner"
tarball="\$state/runner.tar.gz"

expected="$RUNNER_SHA256"
actual="\$(shasum -a 256 "\$tarball" | awk '{print \$1}')"
if [ "\$actual" != "\$expected" ]; then
  echo "runner tarball digest \$actual does not match the pinned \$expected" >&2
  exit 1
fi

rm -rf "\$runner_dir"
mkdir -p "\$runner_dir"
tar -xzf "\$tarball" -C "\$runner_dir"
rm -f "\$tarball"

if [ ! -x "\$runner_dir/bin/Runner.Listener" ]; then
  echo "actions/runner $RUNNER_VERSION did not unpack a bin/Runner.Listener" >&2
  exit 1
fi
GUEST
}

guest_run_script() {
  cat <<'GUEST'
set -euo pipefail

state="$HOME/.runner-center"
jit_file="$state/jit"
runner_dir="$state/runner"

if [ ! -f "$jit_file" ]; then
  echo "the JIT configuration was not staged in the guest" >&2
  exit 1
fi

# Command substitution strips the trailing newline, and the file is removed
# before the runner starts so the secret has the shortest life we can give it.
ACTIONS_RUNNER_INPUT_JITCONFIG="$(cat "$jit_file")"
export ACTIONS_RUNNER_INPUT_JITCONFIG
rm -f "$jit_file"

# Surface a deprecated runner as exit code 7 instead of a silent exit 0.
export ACTIONS_RUNNER_RETURN_VERSION_DEPRECATED_EXIT_CODE=1

cd "$runner_dir"
# Not ./run.sh: it and run-helper.sh exist to drive a long-lived service, so
# they map "listener exited with a terminated error" onto exit 0 -- stop, do
# not retry. For a one-shot ephemeral runner that turns every startup failure
# into a reported success. Invoke the listener directly and keep its own code.
exec ./bin/Runner.Listener run
GUEST
}

# ---------------------------------------------------------------------------
# Job
# ---------------------------------------------------------------------------

install_runner_in_guest() {
  log "Installing actions/runner $RUNNER_VERSION in $VM_NAME"

  guest_ssh "umask 077; mkdir -p \"\$HOME/.runner-center\"; cat > \"\$HOME/.runner-center/runner.tar.gz\"" \
    <"$TARBALL" ||
    die "Failed to copy the runner tarball into $VM_NAME."

  guest_install_script | guest_ssh "bash -s" ||
    die "Failed to install actions/runner $RUNNER_VERSION inside $VM_NAME."
}

stage_jit_config_in_guest() {
  guest_ssh "umask 077; mkdir -p \"\$HOME/.runner-center\"; cat > \"\$HOME/.runner-center/jit\"" \
    <"$WORKDIR/jit" ||
    die "Failed to stage the JIT configuration inside $VM_NAME."
}

start_watchdog() {
  if [ "$JOB_TIMEOUT_S" -le 0 ]; then
    return 0
  fi

  local parent=$$ marker="$WORKDIR/timed-out"
  (
    # A single long `sleep` becomes an orphan when this subshell is killed and
    # can keep the Agent's output pipes open until the whole timeout elapses.
    # One-second ticks bound cleanup latency without leaving a six-hour child.
    local remaining="$JOB_TIMEOUT_S"
    while [ "$remaining" -gt 0 ]; do
      sleep 1
      remaining=$((remaining - 1))
    done
    : >"$marker"
    kill -TERM "$parent" 2>/dev/null || true
  ) &
  WATCHDOG_PID=$!
}

# Runs the job in the background and waits on it, so a signal arriving during a
# multi-hour job is handled immediately instead of after the job returns.
run_job() {
  log "Starting ephemeral runner in $VM_NAME"

  local runner_exit_code=0

  # Job control puts the pipeline in its own process group so cleanup can signal
  # the SSH client along with it. It is switched back off immediately: the only
  # thing it is wanted for is the setpgid.
  set -m
  guest_run_script | guest_ssh "bash -s" &
  JOB_PID=$!
  set +m

  set +e
  wait "$JOB_PID"
  runner_exit_code=$?
  set -e
  JOB_PID=""

  return "$runner_exit_code"
}

# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

main() {
  RUNNER_NAME="${RUNNER_NAME:-}"
  [ -n "$RUNNER_NAME" ] || die "RUNNER_NAME is required."

  IMAGE="${IMAGE:-${BASE_IMAGE:-$RC_DEFAULT_IMAGE}}"
  VM_NAME="$RUNNER_NAME"
  TART="${TART:-/opt/homebrew/bin/tart}"
  SSHPASS="${SSHPASS:-/opt/homebrew/bin/sshpass}"
  RC_HOME="${RC_HOME:-$HOME/.runner-center}"
  RUNNER_VERSION="${RC_MAC_RUNNER_VERSION:-$RC_RUNNER_VERSION_DEFAULT}"
  RUNNER_SHA256="${RC_MAC_RUNNER_SHA256:-$RC_RUNNER_SHA256_DEFAULT}"
  GUEST_USER="${RC_MAC_GUEST_USER:-admin}"
  GUEST_PASSWORD="${RC_MAC_GUEST_PASSWORD:-admin}"
  BOOT_TIMEOUT_S="${RC_BOOT_TIMEOUT_S:-${RC_MAC_BOOT_TIMEOUT_S:-300}}"
  ATTEST_TIMEOUT_S="${RC_MAC_ATTEST_TIMEOUT_S:-60}"
  JOB_TIMEOUT_S="${RC_JOB_TIMEOUT_S:-${RC_MAC_JOB_TIMEOUT_S:-21600}}"
  MAX_CONCURRENT_VMS="${RC_MAC_MAX_CONCURRENT_VMS:-2}"
  HOST_KEY_ALIAS="rc-tart-$(printf '%s' "$IMAGE" | tr -c 'A-Za-z0-9._-' '_')"
  SSH_STRICTNESS="accept-new"
  IP=""
  TARBALL=""

  install_traps

  WORKDIR="$(mktemp -d "${TMPDIR:-/tmp}/rc-mac-XXXXXXXX")"
  chmod 700 "$WORKDIR"

  umask 077
  printf '%s' "$GUEST_PASSWORD" >"$WORKDIR/guest-password"

  # The JIT configuration only ever arrives on stdin.
  if [ -t 0 ]; then
    die "The JIT configuration must be piped in on stdin, e.g. printf %s \"\$encoded_jit_config\" | $0"
  fi
  cat >"$WORKDIR/jit"
  if [ ! -s "$WORKDIR/jit" ]; then
    die "Read an empty JIT configuration from stdin."
  fi
  if LC_ALL=C grep -q '[^A-Za-z0-9+/=[:space:]]' "$WORKDIR/jit"; then
    die "The JIT configuration read from stdin is not base64. Pipe the value of encoded_jit_config verbatim."
  fi

  preflight
  acquire_tart_slot
  ensure_runner_tarball

  start_vm
  wait_for_ip
  attest_host_key
  wait_for_ssh
  persist_learned_host_key
  guest_preflight

  install_runner_in_guest
  stage_jit_config_in_guest

  start_watchdog

  local runner_exit_code=0
  run_job || runner_exit_code=$?

  log "Ephemeral runner in $VM_NAME exited with code $runner_exit_code"
  exit "$runner_exit_code"
}

# Sourced by the test suite with RC_PROVISION_MAC_LIB_ONLY=1 to exercise the
# functions above without booting anything.
if [ "${RC_PROVISION_MAC_LIB_ONLY:-0}" != "1" ]; then
  main "$@"
fi

# --- SECURITY NOTES ---------------------------------------------------------
#
# JIT configuration
#   Host side it never touches argv or the environment: the agent pipes it in
#   on stdin and it lives in a mode-600 file inside a mode-700 directory that
#   cleanup() removes. Guest side it is written to a mode-600 file over the SSH
#   channel and deleted by guest_run_script before the runner starts.
#
#   The last hop is unavoidable: upstream's Runner.Listener reads the value
#   either from `--jitconfig` on the command line or from
#   ACTIONS_RUNNER_INPUT_JITCONFIG, and nothing else (see
#   src/Runner.Listener/CommandSettings.cs). The environment variable is the
#   better of the two -- argv is world readable through `ps`, whereas `ps -E`
#   only reveals the environment of processes with the same uid -- but it does
#   mean a workflow step can read the listener's environment for the life of
#   the job. That is not a privilege escalation: the runner also writes the same
#   credentials to .credentials_rsaparams inside its own directory, the guest is
#   single-tenant and destroyed after one job, and the configuration is issued
#   for that one job. The listener additionally clears the variable from its own
#   environment and registers it with the secret masker as soon as it reads it.
#
# SSH host authentication
#   The cirruslabs base images ship a fixed SSH host key and the well-known
#   `admin` password, so neither authenticates the guest against someone who has
#   also pulled the image. What host key pinning does buy is detecting a guest
#   that is not the image we cloned. attest_host_key() prefers reading the key
#   over the Tart guest agent's vsock channel, which does not traverse the
#   bridge the SSH session uses, and only falls back to trust-on-first-use when
#   the guest agent is unavailable -- in which case it says so and pins the key
#   for subsequent runs.
