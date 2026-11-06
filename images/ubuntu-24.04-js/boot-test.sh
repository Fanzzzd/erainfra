#!/usr/bin/env bash
# Boots an Image Release in Firecracker on the guest kernel a Worker runs, and
# checks that the guest's dockerd can start containers on a user-defined
# network, the way the runner does for every `container:` and `services:` job.
#
#   sudo images/ubuntu-24.04-js/boot-test.sh <image-ref>
#
# It needs an x86_64 or aarch64 Linux host with /dev/kvm, Docker holding (or
# able to pull) <image-ref>, curl and mkfs.ext4. GitHub's hosted x86_64 runners
# qualify; the images workflow runs it there before anything is published.
#
# smoke.sh runs inside the image build, where there is no kernel of the
# guest's own and no dockerd. That is why it could pass while every container
# job on the fleet failed at `docker start`: the guest kernel has no iptables
# raw table, which Docker 28+ needs, and only that kernel can say so. This
# script boots that kernel. The Firecracker binary, the kernel and its command
# line are read from the files a Worker gets them from
# (deploy/provision-firecracker-host.sh and the runtime's config.go), so a pin
# bump there is tested here without a second copy to keep in step.
#
# The guest gets no network interface: the check loads its one container image
# from a tarball and needs nothing outside the VM. runner-center-guest is
# masked, since without MMDS it would only wait for a claim that never comes.
#
# BOOT_TEST_WORKDIR picks the scratch directory (the root image is a few GiB);
# it defaults to a fresh mktemp -d.
set -euo pipefail

if [ "$#" -ne 1 ]; then
  echo "usage: $0 <image-ref>" >&2
  exit 2
fi
image=$1

here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/../.." && pwd)
provisioner=$repo/deploy/provision-firecracker-host.sh
runtime_config=$repo/apps/runtime/internal/firecracker/config.go

fail() {
  echo "boot-test: $*" >&2
  exit 1
}

[ "$(id -u)" -eq 0 ] || fail 'run as root: it unpacks a root filesystem with its owners and opens /dev/kvm'
[ -c /dev/kvm ] || fail '/dev/kvm is missing; this host cannot run Firecracker'

arch=$(uname -m)
case "$arch" in
  x86_64 | aarch64) ;;
  *) fail "unsupported architecture $arch" ;;
esac

# A pin is one shell assignment with a single-quoted value in the provisioner.
pin() {
  local value
  value=$(sed -n "s/^$1='\\([^']*\\)'\$/\\1/p" "$provisioner")
  [ -n "$value" ] || fail "no $1 in $provisioner"
  printf '%s' "$value"
}
firecracker_version=$(pin FIRECRACKER_VERSION)
firecracker_sha256=$(pin "FIRECRACKER_SHA256_$arch")
kernel_series=$(pin GUEST_KERNEL_SERIES)
kernel_version=$(pin GUEST_KERNEL_VERSION)
kernel_sha256=$(pin "GUEST_KERNEL_SHA256_$arch")
kernel_args=$(sed -n 's/^[[:space:]]*KernelArgs:[[:space:]]*"\([^"]*\)",$/\1/p' "$runtime_config")
[ -n "$kernel_args" ] || fail "no KernelArgs in $runtime_config"

# The container the guest starts. Pinned by index digest so a moved tag cannot
# turn this red on a day the image did not change.
probe_image='docker.io/library/busybox:1.37.0@sha256:a7dbc319b1438115a207e11930dc4bb3e643dcb3ec0bdd694bb36cd8fad289ec'

work=${BOOT_TEST_WORKDIR:-$(mktemp -d)}
mkdir -p "$work"
container=
firecracker_pid=
cleanup() {
  if [ -n "$firecracker_pid" ]; then kill "$firecracker_pid" 2>/dev/null || true; fi
  if [ -n "$container" ]; then docker rm --force "$container" >/dev/null 2>&1 || true; fi
  rm -rf "$work/rootfs" "$work/rootfs.ext4"
}
trap cleanup EXIT

download_verified() {
  local url=$1 destination=$2 expected=$3
  curl --fail --silent --show-error --location --retry 5 --output "$destination" "$url"
  echo "$expected  $destination" | sha256sum --check --strict --quiet ||
    fail "checksum mismatch for $url"
}

echo "boot-test: Firecracker $firecracker_version, guest kernel $kernel_version ($kernel_series), $arch"
download_verified \
  "https://github.com/firecracker-microvm/firecracker/releases/download/$firecracker_version/firecracker-$firecracker_version-$arch.tgz" \
  "$work/firecracker.tgz" "$firecracker_sha256"
tar -xzf "$work/firecracker.tgz" -C "$work"
firecracker=$work/release-$firecracker_version-$arch/firecracker-$firecracker_version-$arch
download_verified \
  "https://s3.amazonaws.com/spec.ccfc.min/firecracker-ci/$kernel_series/$arch/vmlinux-$kernel_version" \
  "$work/vmlinux" "$kernel_sha256"

echo "boot-test: unpacking $image"
docker image inspect "$image" >/dev/null 2>&1 || docker pull --quiet "$image" >/dev/null
container=$(docker create "$image")
mkdir "$work/rootfs"
docker export "$container" | tar --extract --numeric-owner --directory "$work/rootfs"
docker rm "$container" >/dev/null
container=
# `docker export` leaves the marker Docker puts in every container, and systemd
# reads it as "running in a container" and skips units a VM boot runs.
rm -f "$work/rootfs/.dockerenv"

ln -sf /dev/null "$work/rootfs/etc/systemd/system/runner-center-guest.service"
install -d "$work/rootfs/opt/erainfra-boot-test"
# A flat filesystem tarball, which the guest turns into an image with `docker
# import`. That needs no registry, no manifest and no platform matching between
# this host's image store and the guest's.
docker pull --quiet "$probe_image" >/dev/null
container=$(docker create "$probe_image" /bin/true)
docker export "$container" --output "$work/rootfs/opt/erainfra-boot-test/probe-rootfs.tar"
docker rm "$container" >/dev/null
container=
install -m 0755 "$here/boot-test-guest.sh" "$work/rootfs/opt/erainfra-boot-test/check.sh"
cat >"$work/rootfs/etc/systemd/system/erainfra-boot-test.service" <<'UNIT'
[Unit]
Description=EraInfra image boot test
# Wants, not Requires: if dockerd fails, the check still runs and says so.
Wants=docker.service
After=docker.service

[Service]
Type=oneshot
ExecStart=/opt/erainfra-boot-test/check.sh
StandardOutput=journal+console
StandardError=journal+console

[Install]
WantedBy=multi-user.target
UNIT
ln -sf /etc/systemd/system/erainfra-boot-test.service \
  "$work/rootfs/etc/systemd/system/multi-user.target.wants/erainfra-boot-test.service"

# Room for dockerd's data and a few containers on top of the image itself.
size_mib=$(( $(du -sm "$work/rootfs" | cut -f1) + 3072 ))
truncate --size "${size_mib}M" "$work/rootfs.ext4"
mkfs.ext4 -q -F -L root -d "$work/rootfs" "$work/rootfs.ext4"
rm -rf "$work/rootfs"

cat >"$work/vm.json" <<JSON
{
  "boot-source": {
    "kernel_image_path": "$work/vmlinux",
    "boot_args": "$kernel_args"
  },
  "drives": [
    {
      "drive_id": "rootfs",
      "path_on_host": "$work/rootfs.ext4",
      "is_root_device": true,
      "is_read_only": false
    }
  ],
  "machine-config": {
    "vcpu_count": 2,
    "mem_size_mib": 2048
  }
}
JSON

# The check reboots the guest when it is done, and with reboot=k on the kernel
# command line that ends the Firecracker process.
echo "boot-test: booting; the guest console follows"
console=$work/console.log
"$firecracker" --no-api --config-file "$work/vm.json" </dev/null >"$console" 2>&1 &
firecracker_pid=$!
tail --follow --pid="$firecracker_pid" "$console" &
deadline=$((SECONDS + 600))
while kill -0 "$firecracker_pid" 2>/dev/null; do
  if [ "$SECONDS" -ge "$deadline" ]; then
    fail 'the guest did not finish within 10 minutes'
  fi
  # journald prefixes each console line with a timestamp and the unit's
  # process, so the marker is matched anywhere on the line.
  if grep -Eaq 'ERAINFRA-BOOT-TEST (PASS|FAIL)' "$console"; then
    # Give the reboot a moment, then stop waiting for it.
    sleep 10
    break
  fi
  sleep 2
done
kill "$firecracker_pid" 2>/dev/null || true
wait "$firecracker_pid" 2>/dev/null || true
firecracker_pid=

grep -aq 'ERAINFRA-BOOT-TEST PASS' "$console" ||
  fail "the guest's container check failed; the console above says where"
echo 'boot-test: PASS'
