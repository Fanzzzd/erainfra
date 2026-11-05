#!/usr/bin/env bash
set -euo pipefail

# `cmd | grep -q` under pipefail is a race: grep -q exits at its first match,
# and a cmd that is still writing then dies of SIGPIPE and fails the pipeline
# (exit 141) although the match succeeded. Capture the output first.
out_matches() { local pattern_flags=$1 pattern=$2; shift 2; local out; out=$("$@" 2>&1) || return 1; printf '%s\n' "$out" | grep $pattern_flags -- "$pattern" >/dev/null; }

test -x /opt/runner/run.sh
test -x /usr/local/bin/runner-center-guest
# The guest kernel execs /sbin/init directly; a container that only has systemd
# under /usr/lib panics on boot before anything else in this file matters.
test -x /sbin/init
# The guest kernel has no nf_tables, so dockerd must speak legacy xtables.
out_matches -Fx 'Value: /usr/sbin/iptables-legacy' update-alternatives --query iptables
test -r /opt/action-cache/actions_checkout/3d3c42e5aac5ba805825da76410c181273ba90b1.tar.gz
test -r /opt/action-cache/pnpm_action-setup/0977fd99725f1db4007ccb2928dbb4e90d06cc86.tar.gz
test -r /opt/action-cache/actions_setup-node/e51e5fe84fc33b4c73ebe40526b2694712b5b858.tar.gz
test -r /opt/action-cache/actions_setup-go/b7ad1dad31e06c5925ef5d2fc7ad053ef454303e.tar.gz
test -c /dev/null
command -v git >/dev/null
command -v docker >/dev/null
# ubuntu-latest ships both plugins; a workflow that runs `docker compose up` or
# `docker buildx build` fails outright without them.
docker compose version >/dev/null
docker buildx version >/dev/null
# runner-center-guest applies a registry mirror at claim, after dockerd has
# started, with `systemctl reload docker.service`: dockerd re-reads
# registry-mirrors on SIGHUP, and the unit's ExecReload is what sends it.
grep -Eqs '^ExecReload=.*HUP' /usr/lib/systemd/system/docker.service /lib/systemd/system/docker.service
# The job cache redirect adds its listen address to loopback with ip(8), and
# checks its sudoers drop-in with visudo before sudo can read it.
command -v ip >/dev/null
command -v visudo >/dev/null
command -v node >/dev/null
command -v npm >/dev/null
command -v pnpm >/dev/null
# Seven tools ubuntu-latest has and this image did not, measured by the
# conformance job as tool_*_present. Four come from apt at whatever version the
# archive holds, so answering is the whole promise for those.
command -v ssh >/dev/null
command -v python3 >/dev/null
command -v pip3 >/dev/null
command -v zstd >/dev/null
command -v rsync >/dev/null
command -v gh >/dev/null
command -v go >/dev/null
ssh -V >/dev/null 2>&1
python3 --version >/dev/null
pip3 --version >/dev/null
zstd --version >/dev/null
rsync --version >/dev/null
ldconfig -p | grep -F 'libatomic.so.1' >/dev/null
out_matches -Fx 'v22.23.2' node --version
# The second Node is in the tool cache for setup-node, not on PATH: the default
# above must stay 22, and setup-node only takes 24 without a download if the
# .complete marker is beside it.
ls /opt/hostedtoolcache/node/24.22.1/*.complete >/dev/null
for node24 in /opt/hostedtoolcache/node/24.22.1/*/bin/node; do
  out_matches -Fx 'v24.22.1' "$node24" --version
done
out_matches -Fx '11.21.0' pnpm --version
# A tool answering is not the pinned tool shipping. go and gh are pinned in the
# Dockerfile, so assert the pin rather than that something by that name exists.
out_matches -E '^go version go1\.27\.3 ' go version
out_matches -E '^gh version 2\.97\.0( |$)' gh --version
# actions/setup-go only skips its download if the marker beside the version
# directory is there, which is the whole reason Go lives in the tool cache.
ls /opt/hostedtoolcache/go/1.27.3/*.complete >/dev/null
# The C library answers ASCII unless a locale says otherwise, and each of these
# is a different way a job can arrive: the image's own environment, the systemd
# system manager, a PAM login shell, and the unit that runs every job.
test "${LANG:-unset}" = 'C.UTF-8'
grep -Fxq 'LANG=C.UTF-8' /etc/locale.conf
grep -Fxq 'LANG=C.UTF-8' /etc/default/locale
# The fourth statement lives in the binary that spawns every runner: runnerEnv
# builds the job environment from nothing, and a Go string literal is greppable,
# so assert the spawn path itself carries the value rather than a unit line the
# spawn path is proven to ignore (#110).
grep -q 'LANG=C.UTF-8' /usr/local/bin/runner-center-guest
# Hosted parity for the watcher tunables (#110); the live values are the
# conformance job's to measure, the file that sets them is this image's to ship.
grep -Fxq 'fs.inotify.max_user_watches=655360' /etc/sysctl.d/90-runner-center-hosted-parity.conf
grep -Fxq 'fs.inotify.max_user_instances=1280' /etc/sysctl.d/90-runner-center-hosted-parity.conf
grep -Fxq 'LimitNOFILE=65536' /etc/systemd/system/runner-center-guest.service
grep -Fxq 'LimitSTACK=16777216:infinity' /etc/systemd/system/runner-center-guest.service
# ubuntu-latest leaves LC_ALL unset; setting it here would be a new difference,
# not a fix for this one.
test -z "${LC_ALL:-}"
out_matches -Fx 'UTF-8' locale charmap
# The same test the conformance job's locale_has_en_us_utf8 key runs.
out_matches -iE '^en_US\.(utf-?8)$' locale -a
grep -Fxq 'Etc/UTC' /etc/timezone
test "$(readlink /etc/localtime)" = '/usr/share/zoneinfo/Etc/UTC'
# The point of tzdata is that a NAMED zone resolves rather than falling back to
# UTC. Asia/Tokyo observes no DST, so this is the same answer on every date.
test "$(TZ=Asia/Tokyo date +%z)" = '+0900'
# No store-dir override: pnpm's default store, under the runner's home, is what
# ubuntu-latest has, and actions/cache keys an entry by its path.
store_dir=$(sudo -u runner HOME=/home/runner pnpm config get store-dir)
case "$store_dir" in '' | undefined | /home/runner/*) ;; *) echo "pnpm store-dir is overridden: $store_dir" >&2; exit 1 ;; esac
test ! -e /runner-cache
test "$(stat -c '%a' /etc/sudoers.d/runner)" = 440
root_password=$(getent shadow root | cut -d: -f2)
case "$root_password" in '!'* | '*'*) ;; *) echo 'root has a usable password' >&2; exit 1 ;; esac
