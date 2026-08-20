#!/usr/bin/env bash
set -euo pipefail

test -x /opt/runner/run.sh
test -x /usr/local/bin/runner-center-guest
# The guest kernel execs /sbin/init directly; a container that only has systemd
# under /usr/lib panics on boot before anything else in this file matters.
test -x /sbin/init
# The guest kernel has no nf_tables, so dockerd must speak legacy xtables.
update-alternatives --query iptables | grep -Fxq 'Value: /usr/sbin/iptables-legacy'
test -r /opt/action-cache/actions_checkout/3d3c42e5aac5ba805825da76410c181273ba90b1.tar.gz
test -r /opt/action-cache/pnpm_action-setup/0977fd99725f1db4007ccb2928dbb4e90d06cc86.tar.gz
test -r /opt/action-cache/actions_setup-node/e51e5fe84fc33b4c73ebe40526b2694712b5b858.tar.gz
test -r /opt/action-cache/actions_setup-go/b7ad1dad31e06c5925ef5d2fc7ad053ef454303e.tar.gz
test -c /dev/null
command -v git >/dev/null
command -v docker >/dev/null
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
node --version | grep -Fxq 'v22.23.2'
pnpm --version | grep -Fxq '11.21.0'
# A tool answering is not the pinned tool shipping. go and gh are pinned in the
# Dockerfile, so assert the pin rather than that something by that name exists.
go version | grep -Eq '^go version go1\.25\.3 '
gh --version | grep -Eq '^gh version 2\.97\.0( |$)'
# actions/setup-go only skips its download if the marker beside the version
# directory is there, which is the whole reason Go lives in the tool cache.
ls /opt/hostedtoolcache/go/1.25.3/*.complete >/dev/null
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
# ubuntu-latest leaves LC_ALL unset; setting it here would be a new difference,
# not a fix for this one.
test -z "${LC_ALL:-}"
locale charmap | grep -Fxq 'UTF-8'
# The same test the conformance job's locale_has_en_us_utf8 key runs.
locale -a | grep -qiE '^en_US\.(utf-?8)$'
grep -Fxq 'Etc/UTC' /etc/timezone
test "$(readlink /etc/localtime)" = '/usr/share/zoneinfo/Etc/UTC'
# The point of tzdata is that a NAMED zone resolves rather than falling back to
# UTC. Asia/Tokyo observes no DST, so this is the same answer on every date.
test "$(TZ=Asia/Tokyo date +%z)" = '+0900'
test "$(sudo -u runner HOME=/home/runner pnpm config get store-dir)" = '/runner-cache/pnpm'
test "$(stat -c '%U:%G' /runner-cache/pnpm)" = 'runner:docker'
test "$(stat -c '%a' /etc/sudoers.d/runner)" = 440
! getent shadow root | cut -d: -f2 | grep -Eq '^([^!*]|$)'
