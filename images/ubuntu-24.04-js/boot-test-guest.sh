#!/usr/bin/env bash
# Runs inside the guest that boot-test.sh boots, as a oneshot unit after
# docker.service. It is not part of the image: boot-test.sh copies it into the
# test's own root filesystem. It does what the runner does for a `container:`
# job and a `services:` job, then prints one result line and reboots, which
# ends the VM.
set -uo pipefail

image=erainfra-boot-test-probe:1
network=erainfra-boot-test

finish() {
  echo "ERAINFRA-BOOT-TEST $1"
  systemctl reboot
  exit 0
}
fail() {
  echo "boot-test: $*"
  echo '--- docker.service journal ---'
  journalctl --unit docker.service --no-pager --lines 40 || true
  finish "FAIL: $*"
}

echo "boot-test: kernel $(uname -r)"

# The runtime passes rootflags on the kernel command line (KernelArgs in
# apps/runtime/internal/firecracker/config.go). Check they survived boot,
# including systemd's remount of / from fstab.
root_options=$(findmnt --noheadings --output OPTIONS --target /)
echo "boot-test: root mount options: $root_options"
for option in noatime nobarrier data=writeback journal_async_commit commit=30; do
  case ",$root_options," in
    *",$option,"*) ;;
    *) fail "the root filesystem is not mounted with $option" ;;
  esac
done
for _ in $(seq 120); do
  docker info >/dev/null 2>&1 && break
  sleep 1
done
docker info >/dev/null 2>&1 || fail 'dockerd did not answer within 2 minutes'
echo "boot-test: dockerd $(docker version --format '{{.Server.Version}}')"
echo "boot-test: docker-raw-table.env: $(cat /run/runner-center/docker-raw-table.env 2>/dev/null || echo missing)"
docker info 2>&1 | grep -i 'warning' || true

docker import /opt/erainfra-boot-test/probe-rootfs.tar "$image" >/dev/null ||
  fail 'docker import of the probe image failed'

# The runner's own sequence: a job network, then containers attached to it.
docker network create "$network" >/dev/null || fail 'docker network create failed'
docker run --rm --pull never --network "$network" "$image" /bin/true ||
  fail 'a container on a user-defined network did not start'

# A service container with an alias and a published port, as `services:` makes.
docker run --detach --pull never --name service --network "$network" --network-alias service \
  --publish 8080:8080 "$image" /bin/httpd -f -p 8080 -h /etc >/dev/null ||
  fail 'a service container with a published port did not start'
published=
for _ in $(seq 20); do
  published=$(curl --fail --silent --show-error http://127.0.0.1:8080/hostname 2>/dev/null) && break
  sleep 0.5
done
[ -n "$published" ] || fail 'the published port did not answer from the guest'
by_alias=$(docker run --rm --pull never --network "$network" "$image" \
  /bin/wget -q -O - http://service:8080/hostname) ||
  fail 'a job container could not reach the service by its alias'
[ "$by_alias" = "$published" ] ||
  fail "the alias reached $by_alias, the published port $published"

# And the default bridge, which a plain `docker run` in a step uses.
docker run --rm --pull never "$image" /bin/true ||
  fail 'a container on the default bridge did not start'

finish PASS
