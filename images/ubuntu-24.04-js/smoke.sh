#!/usr/bin/env bash
set -euo pipefail

test -x /opt/runner/run.sh
test -x /usr/local/bin/runner-center-guest
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
ldconfig -p | grep -Fq 'libatomic.so.1'
node --version | grep -Fxq 'v22.23.2'
pnpm --version | grep -Fxq '11.21.0'
test "$(sudo -u runner HOME=/home/runner pnpm config get store-dir)" = '/runner-cache/pnpm'
test "$(stat -c '%U:%G' /runner-cache/pnpm)" = 'runner:docker'
test "$(stat -c '%a' /etc/sudoers.d/runner)" = 440
! getent shadow root | cut -d: -f2 | grep -Eq '^([^!*]|$)'
