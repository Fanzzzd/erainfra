#!/usr/bin/env bash
set -euo pipefail
repo=/erainfra-src
small=$repo/images/ubuntu-24.04-js
export DEBIAN_FRONTEND=noninteractive TARGETARCH=amd64
# These are guest integration dependencies, not a substitute for upstream tools.
apt-get update
apt-get install -y haveged libatomic1 systemd-sysv iptables locales tzdata kmod
getent group docker >/dev/null
useradd --create-home --uid 1001 --gid docker --shell /bin/bash runner
usermod --append --groups sudo,adm,systemd-journal,users runner
printf 'runner ALL=(ALL:ALL) NOPASSWD:ALL\n' > /etc/sudoers.d/runner
chmod 0440 /etc/sudoers.d/runner
passwd --lock root
# One copy of the runner and action archive pins: the existing image Dockerfile.
python3 -I /erainfra-build/recipe.py overlay "$small/Dockerfile" /erainfra-build/overlay-install.sh
bash /erainfra-build/overlay-install.sh
# Keep upstream's larger action cache as well as EraInfra's hash-pinned entries.
cp -an /opt/actionarchivecache/. /opt/action-cache/
chmod -R a-w /opt/action-cache
chown -R runner:docker /home/runner /home/linuxbrew /opt/runner
# Toolset installers assigned their cache to Packer. The job account replaces it.
find /opt/hostedtoolcache -uid 1000 -exec chown runner:docker {} +
# The report and tests ran as packer. userdel refuses while it owns a process.
pkill -KILL -u packer || true
timeout 30 sh -c 'while pgrep -u packer >/dev/null; do sleep 1; done'
userdel --remove packer
rm -f /etc/sudoers.d/packer
# Finalize the same user-dependent variables as upstream's post-generation hook,
# but name the user instead of assuming the last passwd entry is the runner.
sed -i 's|\$HOME|/home/runner|g' /etc/environment
mkdir -p /etc/erainfra
python3 -I /erainfra-build/recipe.py environment /etc/environment /etc/erainfra/runner-environment.json
chmod 0644 /etc/erainfra/runner-environment.json
# The guest loads this file before it starts the runner. Apply the same
# validation now, because the boot test does not start the guest service.
"$repo/build/full-image/runner-center-guest" --check-runner-environment /etc/erainfra/runner-environment.json
locale-gen en_US.UTF-8
printf 'LANG=C.UTF-8\n' > /etc/locale.conf
printf 'LANG=C.UTF-8\n' > /etc/default/locale
ln -sfn /usr/share/zoneinfo/Etc/UTC /etc/localtime
printf 'Etc/UTC\n' > /etc/timezone
update-alternatives --set iptables /usr/sbin/iptables-legacy
update-alternatives --set ip6tables /usr/sbin/ip6tables-legacy
install -m 0755 "$repo/build/full-image/runner-center-guest" /usr/local/bin/
install -m 0755 "$repo/build/full-image/erainfra-gocacheprog" /usr/local/bin/
install -d /usr/local/lib/runner-center /etc/systemd/system/docker.service.d
install -m 0644 "$small/runner-center-guest.service" /etc/systemd/system/
install -m 0755 "$small/docker-raw-table.sh" /usr/local/lib/runner-center/
install -m 0644 "$small/docker-raw-table.conf" /etc/systemd/system/docker.service.d/10-runner-center-raw-table.conf
install -m 0644 "$small/sysctl-hosted-parity.conf" /etc/sysctl.d/90-runner-center-hosted-parity.conf
# Preserve installed software. Disable only services that configure cloud hardware.
systemctl disable ssh.service ssh.socket systemd-networkd-wait-online.service || true
# These fail on every Firecracker boot and leave the system "degraded": the
# guest kernel has no nf_tables (Docker and the guest use iptables-legacy),
# and a microVM has no multipath or NVMe-over-Fabrics devices.
systemctl disable nftables.service multipathd.service multipathd.socket nvmf-autoconnect.service || true
systemctl enable docker.service haveged.service runner-center-guest.service
# Canonical's cloud archive names cloudimg-rootfs. containerd does not preserve
# filesystem labels when unpacking OCI, so use Firecracker's root block device.
printf '/dev/vda / ext4 defaults 0 1\n' > /etc/fstab
# Firecracker has no cloud-init and no systemd-resolved stub. The guest writes DNS.
rm -f /etc/resolv.conf
: > /etc/resolv.conf
mkdir -p /home/runner/work
chown runner:docker /home/runner/work
apt-get clean
# Software presence is covered by every upstream install test and the full rerun.
# These assertions cover the EraInfra integration that upstream does not know.
test -x /opt/runner/bin/Runner.Listener
test -x /usr/local/bin/runner-center-guest
test -d /home/runner/.rustup/toolchains
test -x /home/runner/.cargo/bin/rustup
test -e /usr/lib/x86_64-linux-gnu/libatomic.so.1
grep -qx 'LimitNOFILE=65536' /etc/systemd/system/runner-center-guest.service
grep -qx 'LimitSTACK=16777216:infinity' /etc/systemd/system/runner-center-guest.service
sudo -u runner env -i HOME=/home/runner PATH=/home/runner/.cargo/bin:/usr/local/bin:/usr/bin:/bin rustc --version
