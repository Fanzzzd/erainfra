#!/usr/bin/env bash
# Boot the exact filesystem that was packaged, with only the test unit added.
set -euo pipefail
repo=$(cd "$(dirname "$0")/../.." && pwd)
work=${FULL_IMAGE_WORKDIR:?set FULL_IMAGE_WORKDIR}
provisioner=$repo/deploy/provision-firecracker-host.sh
pin() { sed -n "s/^$1='\([^']*\)'\$/\1/p" "$provisioner"; }
verified() {
  curl -fL --retry 5 "$1" -o "$2"
  printf '%s  %s\n' "$3" "$2" | sha256sum -c -
}
version=$(pin FIRECRACKER_VERSION)
verified "https://github.com/firecracker-microvm/firecracker/releases/download/$version/firecracker-$version-x86_64.tgz" "$work/download/firecracker.tgz" "$(pin FIRECRACKER_SHA256_x86_64)"
tar -xzf "$work/download/firecracker.tgz" -C "$work/download"
verified "https://s3.amazonaws.com/spec.ccfc.min/firecracker-ci/$(pin GUEST_KERNEL_SERIES)/x86_64/vmlinux-$(pin GUEST_KERNEL_VERSION)" "$work/vmlinux" "$(pin GUEST_KERNEL_SHA256_x86_64)"
root=$work/root
mount -o loop "$work/rootfs.ext4" "$root"
trap 'mountpoint -q "$root" && umount "$root" || true' EXIT
mkdir -p "$root/opt/erainfra-boot-test"
probe='docker.io/library/busybox:1.37.0@sha256:a7dbc319b1438115a207e11930dc4bb3e643dcb3ec0bdd694bb36cd8fad289ec'
docker pull "$probe"
container=$(docker create "$probe" /bin/true)
docker export "$container" --output "$root/opt/erainfra-boot-test/probe-rootfs.tar"
docker rm "$container"
install -m 0755 "$repo/images/ubuntu-24.04-js/boot-test-guest.sh" "$root/opt/erainfra-boot-test/check.sh"
ln -sf /dev/null "$root/etc/systemd/system/runner-center-guest.service"
cat > "$root/etc/systemd/system/erainfra-boot-test.service" <<'UNIT'
[Unit]
Description=EraInfra full image boot test
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
ln -sf /etc/systemd/system/erainfra-boot-test.service "$root/etc/systemd/system/multi-user.target.wants/erainfra-boot-test.service"
umount "$root"
trap - EXIT
kernel_args=$(sed -n 's/^[[:space:]]*KernelArgs:[[:space:]]*"\([^"]*\)",$/\1/p' "$repo/apps/runtime/internal/firecracker/config.go")
jq -n --arg kernel "$work/vmlinux" --arg args "$kernel_args" --arg disk "$work/rootfs.ext4" \
  '{"boot-source":{"kernel_image_path":$kernel,"boot_args":$args},"drives":[{"drive_id":"rootfs","path_on_host":$disk,"is_root_device":true,"is_read_only":false}],"machine-config":{"vcpu_count":4,"mem_size_mib":2048}}' > "$work/vm.json"
timeout 600 "$work/download/release-$version-x86_64/firecracker-$version-x86_64" --no-api --config-file "$work/vm.json" > "$work/evidence/boot-console.log" 2>&1
cat "$work/evidence/boot-console.log"
grep -aq 'ERAINFRA-BOOT-TEST PASS' "$work/evidence/boot-console.log"
