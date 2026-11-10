#!/usr/bin/env bash
# Build on a disposable x86_64 Ubuntu host. Never run on a Worker.
set -euo pipefail
repo=$(cd "$(dirname "$0")/../.." && pwd)
here=$repo/images/ubuntu-24.04-full
work=${FULL_IMAGE_WORKDIR:?set FULL_IMAGE_WORKDIR to an empty build directory}
[ "$(id -u)" = 0 ] && [ "$(uname -m)" = x86_64 ]
[ -c /dev/kvm ] || { echo 'KVM is required for validation' >&2; exit 1; }
mkdir -p "$work"
[ -z "$(ls -A "$work")" ] || { echo 'build directory must be empty' >&2; exit 1; }
mkdir -p "$work/evidence" "$work/download" "$work/upstream" "$work/root"
started=$(date +%s)
lock=$here/upstream.json
commit=$(jq -r .commit "$lock")
root=$work/root
machine=erainfra-image-build
cleanup() {
  # Keep per-script timings and the apt failure ledger when a build fails.
  cp "$root/erainfra-build/timings.tsv" "$root/erainfra-build/apt-failures.tsv" "$work/evidence/" 2>/dev/null || true
  machinectl terminate "$machine" 2>/dev/null || true
  mountpoint -q "$root" && umount --recursive "$root" || true
}
trap cleanup EXIT
# One sparse ext4 filesystem serves as the build root and Firecracker disk.
# No Docker layer store, export tree, or second ext4 copy of the full image.
truncate -s 96G "$work/rootfs.ext4"
mkfs.ext4 -q -F -m 0 -L root "$work/rootfs.ext4"
mount -o loop "$work/rootfs.ext4" "$root"
curl -fL --retry 5 "$(jq -r .rootfs_url "$lock")" -o "$work/download/root.tar.xz"
printf '%s  %s\n' "$(jq -r .rootfs_sha256 "$lock")" "$work/download/root.tar.xz" | sha256sum -c -
tar -xJpf "$work/download/root.tar.xz" -C "$root" --numeric-owner
rm "$work/download/root.tar.xz"
git -C "$work/upstream" init -q
git -C "$work/upstream" fetch -q --depth=1 https://github.com/actions/runner-images.git "$commit"
git -C "$work/upstream" checkout -q FETCH_HEAD
[ "$(git -C "$work/upstream" rev-parse HEAD)" = "$commit" ]
printf '%s  %s\n' "$(jq -r .toolset_sha256 "$lock")" "$work/upstream/$(jq -r .toolset "$lock")" | sha256sum -c -
python3 -I "$here/recipe.py" verify "$work/upstream" "$here/scripts.txt"
for patch in "$here"/patches/*.patch; do
  git -C "$work/upstream" apply --check "$patch"
  git -C "$work/upstream" apply "$patch"
done
git -C "$work/upstream" diff > "$work/evidence/upstream.patch"
cp "$lock" "$work/evidence/upstream.json"
install -d "$root/imagegeneration" "$root/erainfra-build" "$root/erainfra-src"
cp -a "$work/upstream/images/ubuntu/scripts/helpers" "$root/imagegeneration/helpers"
cp -a "$work/upstream/images/ubuntu/scripts/build" "$root/imagegeneration/installers"
cp -a "$work/upstream/images/ubuntu/scripts/tests" "$root/imagegeneration/tests"
cp -a "$work/upstream/images/ubuntu/scripts/docs-gen" "$root/imagegeneration/SoftwareReport"
cp -a "$work/upstream/helpers/software-report-base/." "$root/imagegeneration/SoftwareReport/"
cp -a "$work/upstream/images/ubuntu/assets/post-gen" "$root/imagegeneration/post-generation"
cp "$work/upstream/$(jq -r .toolset "$lock")" "$root/imagegeneration/installers/toolset.json"
cp "$here"/{install.sh,finish.sh,recipe.py,scripts.txt,upstream.json,apt-failures.allow} "$root/erainfra-build/"
# Disable cloud provisioning; nspawn supplies a private network and DNS at build time.
touch "$root/etc/cloud/cloud-init.disabled"
printf 'erainfra-image-build\n' > "$root/etc/hostname"
printf '127.0.0.1 localhost\n127.0.1.1 erainfra-image-build\n::1 ip6-localhost ip6-loopback\n' > "$root/etc/hosts"
rm -f "$root/etc/machine-id" "$root/var/lib/dbus/machine-id"
printf 'PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/usr/games:/usr/local/games:/snap/bin"\n' > "$root/etc/environment"
# Install scripts expect Packer's non-root account and passwordless sudo.
chroot "$root" useradd -m -u 1000 -s /bin/bash packer
printf 'packer ALL=(ALL) NOPASSWD:ALL\n' > "$root/etc/sudoers.d/packer"
chmod 0440 "$root/etc/sudoers.d/packer"
printf 'APT::Get::Assume-Yes "true";\n' > "$root/etc/apt/apt.conf.d/90assumeyes"
# An explicit network namespace keeps nested Docker away from host networking.
ip netns add erainfra-image
ip link add erainfra-host type veth peer name eth0 netns erainfra-image
ip addr add 192.0.2.1/30 dev erainfra-host
ip link set erainfra-host up
ip netns exec erainfra-image ip addr add 192.0.2.2/30 dev eth0
ip netns exec erainfra-image ip link set eth0 up
ip netns exec erainfra-image ip link set lo up
ip netns exec erainfra-image ip route add default via 192.0.2.1
sysctl -w net.ipv4.ip_forward=1
iptables -t nat -A POSTROUTING -s 192.0.2.2/32 -j MASQUERADE
iptables -I FORWARD -i erainfra-host -j ACCEPT
iptables -I FORWARD -o erainfra-host -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
# Do not let guest networkd or resolved replace this build-only configuration.
chroot "$root" systemctl mask systemd-networkd.service systemd-networkd.socket systemd-resolved.service
rm -f "$root/etc/resolv.conf"
cp /run/systemd/resolve/resolv.conf "$root/etc/resolv.conf"
systemd-run --unit=erainfra-image-container --collect --service-type=notify \
  --property=NotifyAccess=all \
  systemd-nspawn --quiet --boot --notify-ready=yes --directory="$root" --machine="$machine" \
  --network-namespace-path=/run/netns/erainfra-image --resolv-conf=off \
  --capability=all --system-call-filter='add_key keyctl bpf' \
  --bind-ro="$repo:/erainfra-src"
# machinectl shell does not propagate the command's exit status. systemd-run does.
# systemctl --wait blocks on startup rather than polling the container.
systemctl --machine="$machine" is-system-running --wait || true
systemd-run --machine="$machine" --pipe --wait --collect --service-type=exec \
  /bin/bash /erainfra-build/install.sh 2>&1 | tee "$work/evidence/install.log"
systemd-run --machine="$machine" --pipe --wait --collect --service-type=exec \
  /bin/bash /erainfra-build/finish.sh 2>&1 | tee "$work/evidence/finish.log"
cp -a "$root/imagegeneration/software-report."* "$work/evidence/"
cp "$root/etc/erainfra/runner-environment.json" "$work/evidence/"
cp "$root/erainfra-build/timings.tsv" "$root/erainfra-build/apt-failures.tsv" "$work/evidence/"
systemctl --machine="$machine" poweroff
# Wait for nspawn to exit before packing a filesystem its services can mutate.
systemctl stop erainfra-image-container.service
ip netns del erainfra-image
iptables -D FORWARD -i erainfra-host -j ACCEPT
iptables -D FORWARD -o erainfra-host -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
iptables -t nat -D POSTROUTING -s 192.0.2.2/32 -j MASQUERADE
# Remove build identity, logs, and temporary files after shutdown.
rm -rf "$root/erainfra-build" "$root/erainfra-src" "$root/tmp/"* "$root/var/tmp/"* "$root/root/.cache"
find "$root/var/log" -type f -exec truncate -s 0 {} +
truncate -s 0 "$root/etc/machine-id"
rm -f "$root/var/lib/dbus/machine-id"
python3 -I "$here/recipe.py" pack "$root" "$work/oci" "$work/evidence" "$repo"
printf '%s\n' "$(( $(date +%s) - started ))" > "$work/evidence/build-seconds.txt"
umount "$root"
trap - EXIT
printf 'OCI image: %s/oci:candidate\n' "$work"
