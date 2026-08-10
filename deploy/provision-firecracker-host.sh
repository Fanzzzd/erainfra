#!/usr/bin/env bash
# Provision a Linux host so it can run Runner Center's strong-isolation
# executor: one ephemeral Firecracker microVM per job, on a copy-on-write root,
# behind a verified job network policy.
#
# Everything this installs is namespaced under runner-center: its own CNI plugin
# and configuration directories, its own containerd instance, its own
# device-mapper thin-pool and its own nftables table. A host that already runs
# Docker or Kubernetes keeps every one of those untouched, and --uninstall
# reverses exactly what was added.
#
# The network policy is not written by this script. It is rendered by the same
# runner-center-runtime build that later verifies it, so an installed host can
# never drift from what readiness demands.
#
#   sudo ./provision-firecracker-host.sh \
#     --runtime-binary ./runner-center-runtime \
#     --data-device /dev/nvme1n1 --meta-device /dev/nvme2n1 \
#     --worker-user "$USER"
#
# Rollback:
#
#   sudo ./provision-firecracker-host.sh --uninstall

set -euo pipefail

FIRECRACKER_VERSION='v1.16.1'
FIRECRACKER_SHA256_x86_64='382a02a869e4d6d5cb14c40577f9545e8458021ea8b0b2d3fc10ec14d9c242e6'
FIRECRACKER_SHA256_aarch64='8d0e69f6d6f9a1724551f607f18504052c16c1828ee3d4d7b6e6c73380871e0e'

CNI_VERSION='v1.9.1'
CNI_SHA256_amd64='b98f74a0f8522f0a83867178729c1aa70f2158f90c45a2ca8fa791db1c76b303'
CNI_SHA256_arm64='56171987d3947707c3563db2f4001bccaf50fd63468611b9f3cbecb1375ee7ec'

# tc-redirect-tap publishes no release binaries. Pinning a commit and building it
# through the Go module proxy still gives a verified supply chain: the proxy and
# the public checksum database both attest the source for that exact revision.
TC_REDIRECT_TAP_COMMIT='34bf829e9a5c99df47318c7feeb637576df239fc'

# Firecracker's published guest kernels. 6.1 is the newest series Firecracker
# tests against for this release line.
GUEST_KERNEL_SERIES='v1.13'
GUEST_KERNEL_VERSION='6.1.141'
GUEST_KERNEL_SHA256_x86_64='b36a4a1b10f33b9cfdcde3d1a787d9c090556a3edb211cd06d1f3f9a6c7e8724'
GUEST_KERNEL_SHA256_aarch64='69aa3308219ec1a070bc9a8e7f80c3b34056fed8ae05efb44e55f73b31adde44'

RC_LIB_DIR='/usr/local/lib/runner-center'
RC_ETC_DIR='/etc/runner-center'
RC_STATE_DIR='/var/lib/runner-center'
RC_CNI_BIN_DIR='/opt/runner-center/cni/bin'
RC_CNI_CONFIG_DIR="$RC_ETC_DIR/cni/net.d"
RC_RUNTIME_ENV="$RC_ETC_DIR/runtime.env"
RC_GROUP='runner-center'
THIN_POOL='runner-center-thinpool'
CONTAINERD_UNIT='runner-center-containerd.service'
THINPOOL_UNIT='runner-center-thinpool.service'
RUNTIME_UNIT='runner-center-runtime.service'
CONTAINERD_STATE='/run/runner-center-containerd'
CONTAINERD_ROOT="$RC_STATE_DIR/containerd"
CONTAINERD_SOCKET="$CONTAINERD_STATE/containerd.sock"

RUNTIME_BINARY=''
DATA_DEVICE=''
META_DEVICE=''
FILE_POOL_GIB=''
WORKER_USER=''
EGRESS_MODE=''
EGRESS_ALLOW=''
NAMESERVERS=''
NETWORK_SUBNET=''
MIN_POOL_FREE_MIB=''
BASE_IMAGE_SIZE='24GB'
RUNTIME_UNIT_FILE=''
UNINSTALL=0
TMP_DIR=''

fail() {
  printf 'error: %s\n' "$1" >&2
  exit 1
}

step() {
  printf '\n==> %s\n' "$1"
}

note() {
  printf '    %s\n' "$1"
}

cleanup() {
  if [ -n "$TMP_DIR" ] && [ -d "$TMP_DIR" ]; then
    rm -rf "$TMP_DIR"
  fi
}
trap cleanup EXIT

usage() {
  cat <<'USAGE'
Usage:
  provision-firecracker-host.sh --runtime-binary PATH
                                (--data-device DEV --meta-device DEV
                                 | --file-backed-pool GIB)
                                [--worker-user NAME]
                                [--network-subnet CIDR]
                                [--egress-mode public|allowlist]
                                [--egress-allow CIDR[,CIDR...]]
                                [--nameservers IP[,IP...]]
                                [--min-pool-free-mib N]
                                [--base-image-size SIZE]
                                [--runtime-unit PATH]
  provision-firecracker-host.sh --uninstall

  --runtime-binary     runner-center-runtime for this host's architecture,
                       already verified against its published .sha256 sidecar.
  --data-device        Dedicated block device for thin-pool data. Its contents
                       are destroyed.
  --meta-device        Dedicated block device for thin-pool metadata. Its
                       contents are destroyed. 1 GiB is ample.
  --file-backed-pool   Evaluation only: back the thin-pool with sparse files on
                       the root filesystem instead of dedicated devices. Never
                       use this in production; a full root filesystem then fails
                       every running job at once.
  --worker-user        Unprivileged account running the Runner Center Worker.
                       It is added to the runner-center group so it can reach
                       the runtime socket. Log out and back in afterwards.
USAGE
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --runtime-binary) [ "$#" -ge 2 ] || fail "$1 requires a value"; RUNTIME_BINARY=$2; shift 2 ;;
    --data-device) [ "$#" -ge 2 ] || fail "$1 requires a value"; DATA_DEVICE=$2; shift 2 ;;
    --meta-device) [ "$#" -ge 2 ] || fail "$1 requires a value"; META_DEVICE=$2; shift 2 ;;
    --file-backed-pool) [ "$#" -ge 2 ] || fail "$1 requires a value"; FILE_POOL_GIB=$2; shift 2 ;;
    --worker-user) [ "$#" -ge 2 ] || fail "$1 requires a value"; WORKER_USER=$2; shift 2 ;;
    --network-subnet) [ "$#" -ge 2 ] || fail "$1 requires a value"; NETWORK_SUBNET=$2; shift 2 ;;
    --egress-mode) [ "$#" -ge 2 ] || fail "$1 requires a value"; EGRESS_MODE=$2; shift 2 ;;
    --egress-allow) [ "$#" -ge 2 ] || fail "$1 requires a value"; EGRESS_ALLOW=$2; shift 2 ;;
    --nameservers) [ "$#" -ge 2 ] || fail "$1 requires a value"; NAMESERVERS=$2; shift 2 ;;
    --min-pool-free-mib) [ "$#" -ge 2 ] || fail "$1 requires a value"; MIN_POOL_FREE_MIB=$2; shift 2 ;;
    --base-image-size) [ "$#" -ge 2 ] || fail "$1 requires a value"; BASE_IMAGE_SIZE=$2; shift 2 ;;
    --runtime-unit) [ "$#" -ge 2 ] || fail "$1 requires a value"; RUNTIME_UNIT_FILE=$2; shift 2 ;;
    --uninstall) UNINSTALL=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; fail "unknown option: $1" ;;
  esac
done

[ "$(id -u)" -eq 0 ] || fail 'this provisioner must run as root'

case "$(uname -m)" in
  x86_64|amd64) HOST_ARCH='x86_64'; CNI_ARCH='amd64' ;;
  aarch64|arm64) HOST_ARCH='aarch64'; CNI_ARCH='arm64' ;;
  *) fail "unsupported architecture: $(uname -m)" ;;
esac

sha256_of() {
  sha256sum "$1" | cut -d ' ' -f 1
}

download_verified() {
  url=$1
  destination=$2
  expected=$3
  curl -fsSL "$url" -o "$destination" || fail "could not download $url"
  actual=$(sha256_of "$destination")
  [ "$actual" = "$expected" ] ||
    fail "checksum mismatch for $url: expected $expected but got $actual"
}

uninstall() {
  step 'Stopping and removing Runner Center services'
  for unit in "$RUNTIME_UNIT" "$CONTAINERD_UNIT" "$THINPOOL_UNIT"; do
    systemctl disable --now "$unit" >/dev/null 2>&1 || true
    rm -f "/etc/systemd/system/$unit"
  done
  systemctl daemon-reload || true

  step 'Removing the job network policy'
  nft delete table inet runner-center >/dev/null 2>&1 || true
  rm -f "$RC_ETC_DIR/nftables.rc.conf"
  rm -rf "$RC_CNI_CONFIG_DIR"

  step 'Removing the thin-pool'
  dmsetup remove "$THIN_POOL" >/dev/null 2>&1 || true
  for loop in $(losetup -j "$RC_STATE_DIR/thinpool-data.img" 2>/dev/null | cut -d: -f1); do
    losetup -d "$loop" || true
  done
  for loop in $(losetup -j "$RC_STATE_DIR/thinpool-meta.img" 2>/dev/null | cut -d: -f1); do
    losetup -d "$loop" || true
  done

  step 'Removing installed files'
  rm -rf "$RC_CNI_BIN_DIR" "$RC_LIB_DIR"
  rm -f /usr/local/bin/firecracker "$RC_ETC_DIR/thinpool.env" "$RC_RUNTIME_ENV"
  printf '\n'
  note "Left in place on purpose: $RC_STATE_DIR (thin-pool images, guest kernels,"
  note 'containerd content) and the runner-center group. Remove them by hand once'
  note 'you are sure nothing else needs them:'
  note "  sudo rm -rf $RC_STATE_DIR && sudo groupdel $RC_GROUP"
  exit 0
}

if [ "$UNINSTALL" -eq 1 ]; then
  uninstall
fi

[ -n "$RUNTIME_BINARY" ] || { usage >&2; fail '--runtime-binary is required'; }
[ -x "$RUNTIME_BINARY" ] || fail "$RUNTIME_BINARY is not an executable file"
if [ -n "$FILE_POOL_GIB" ]; then
  [ -z "$DATA_DEVICE$META_DEVICE" ] ||
    fail '--file-backed-pool cannot be combined with dedicated devices'
  case "$FILE_POOL_GIB" in
    ''|*[!0-9]*) fail '--file-backed-pool takes a whole number of GiB' ;;
  esac
  [ "$FILE_POOL_GIB" -ge 20 ] || fail '--file-backed-pool needs at least 20 GiB'
else
  [ -n "$DATA_DEVICE" ] && [ -n "$META_DEVICE" ] ||
    fail 'provide --data-device and --meta-device, or --file-backed-pool GIB for an evaluation host'
  [ -b "$DATA_DEVICE" ] || fail "$DATA_DEVICE is not a block device"
  [ -b "$META_DEVICE" ] || fail "$META_DEVICE is not a block device"
fi

step 'Checking host prerequisites'
for tool in curl tar sha256sum dmsetup nft systemctl blockdev; do
  command -v "$tool" >/dev/null 2>&1 || fail "$tool is required; install it first"
done
CONTAINERD_BIN=$(command -v containerd || true)
[ -n "$CONTAINERD_BIN" ] ||
  fail 'containerd 1.7+ is required. Install containerd.io or containerd, then rerun.'
[ -c /dev/kvm ] ||
  fail '/dev/kvm is missing. This host cannot provide guest-kernel isolation; use a bare-metal or nested-virtualization-capable machine.'
note "containerd: $($CONTAINERD_BIN --version)"
note "kvm: $(ls -l /dev/kvm)"

GO_BIN=$(command -v go || true)
if [ -z "$GO_BIN" ] && [ -x /usr/local/go/bin/go ]; then
  GO_BIN=/usr/local/go/bin/go
fi

step 'Loading kernel modules and enabling forwarding'
for module in kvm dm_thin_pool tun veth nf_tables; do
  modprobe "$module" 2>/dev/null || note "module $module is builtin or unavailable"
done
install -d -m 0755 /etc/modules-load.d
cat > /etc/modules-load.d/runner-center.conf <<'MODULES'
dm_thin_pool
tun
veth
nf_tables
MODULES
install -d -m 0755 /etc/sysctl.d
cat > /etc/sysctl.d/99-runner-center.conf <<'SYSCTL'
# Guests reach the internet through the host, so forwarding is required. Every
# private and host-bound destination is denied by the runner-center nftables
# table, not by leaving forwarding off.
net.ipv4.ip_forward = 1
net.ipv4.conf.all.forwarding = 1
SYSCTL
sysctl --quiet --load /etc/sysctl.d/99-runner-center.conf

step "Creating the $RC_GROUP group and state directories"
getent group "$RC_GROUP" >/dev/null || groupadd --system "$RC_GROUP"
install -d -m 0755 "$RC_LIB_DIR" "$RC_ETC_DIR" "$RC_CNI_BIN_DIR" "$RC_CNI_CONFIG_DIR"
install -d -m 0700 "$RC_STATE_DIR" "$RC_STATE_DIR/kernels" "$RC_STATE_DIR/attempts"
install -d -m 0700 "$RC_STATE_DIR/cni/networks" "$CONTAINERD_ROOT" "$CONTAINERD_ROOT/devmapper"

TMP_DIR=$(mktemp -d /tmp/rc-provision.XXXXXX)

step "Installing Firecracker $FIRECRACKER_VERSION"
if [ -x /usr/local/bin/firecracker ] &&
   /usr/local/bin/firecracker --version 2>/dev/null | grep -Fq "$FIRECRACKER_VERSION"; then
  note 'already at the pinned version'
else
  case "$HOST_ARCH" in
    x86_64) expected=$FIRECRACKER_SHA256_x86_64 ;;
    *) expected=$FIRECRACKER_SHA256_aarch64 ;;
  esac
  archive="$TMP_DIR/firecracker.tgz"
  download_verified \
    "https://github.com/firecracker-microvm/firecracker/releases/download/$FIRECRACKER_VERSION/firecracker-$FIRECRACKER_VERSION-$HOST_ARCH.tgz" \
    "$archive" "$expected"
  tar -xzf "$archive" -C "$TMP_DIR"
  install -o root -g root -m 0755 \
    "$TMP_DIR/release-$FIRECRACKER_VERSION-$HOST_ARCH/firecracker-$FIRECRACKER_VERSION-$HOST_ARCH" \
    /usr/local/bin/firecracker
fi
note "$(/usr/local/bin/firecracker --version | head -n 1)"

step "Installing CNI plugins $CNI_VERSION into $RC_CNI_BIN_DIR"
case "$CNI_ARCH" in
  amd64) expected=$CNI_SHA256_amd64 ;;
  *) expected=$CNI_SHA256_arm64 ;;
esac
archive="$TMP_DIR/cni.tgz"
download_verified \
  "https://github.com/containernetworking/plugins/releases/download/$CNI_VERSION/cni-plugins-linux-$CNI_ARCH-$CNI_VERSION.tgz" \
  "$archive" "$expected"
mkdir -p "$TMP_DIR/cni"
tar -xzf "$archive" -C "$TMP_DIR/cni"
for plugin in ptp firewall host-local; do
  [ -f "$TMP_DIR/cni/$plugin" ] || fail "the CNI archive does not contain $plugin"
  install -o root -g root -m 0755 "$TMP_DIR/cni/$plugin" "$RC_CNI_BIN_DIR/$plugin"
done
note "installed ptp, firewall and host-local"

step 'Installing tc-redirect-tap'
if [ -x "$RC_CNI_BIN_DIR/tc-redirect-tap" ]; then
  note 'already installed'
elif [ -n "$GO_BIN" ]; then
  note "building from awslabs/tc-redirect-tap@${TC_REDIRECT_TAP_COMMIT:0:12} through the Go module proxy"
  GOBIN="$TMP_DIR/gobin" GOPATH="$TMP_DIR/gopath" GOCACHE="$TMP_DIR/gocache" HOME="$TMP_DIR" \
    "$GO_BIN" install "github.com/awslabs/tc-redirect-tap/cmd/tc-redirect-tap@$TC_REDIRECT_TAP_COMMIT" ||
    fail 'could not build tc-redirect-tap'
  install -o root -g root -m 0755 "$TMP_DIR/gobin/tc-redirect-tap" "$RC_CNI_BIN_DIR/tc-redirect-tap"
else
  fail 'tc-redirect-tap has no release binaries and Go is not installed.
Install Go 1.23+ (https://go.dev/dl/) and rerun, or copy a tc-redirect-tap built
from commit '"$TC_REDIRECT_TAP_COMMIT"' to '"$RC_CNI_BIN_DIR"'/tc-redirect-tap.'
fi

step "Installing the guest kernel $GUEST_KERNEL_VERSION"
case "$HOST_ARCH" in
  x86_64) expected=$GUEST_KERNEL_SHA256_x86_64 ;;
  *) expected=$GUEST_KERNEL_SHA256_aarch64 ;;
esac
if [ -f "$RC_STATE_DIR/kernels/vmlinux" ] &&
   [ "$(sha256_of "$RC_STATE_DIR/kernels/vmlinux")" = "$expected" ]; then
  note 'already at the pinned kernel'
else
  download_verified \
    "https://s3.amazonaws.com/spec.ccfc.min/firecracker-ci/$GUEST_KERNEL_SERIES/$HOST_ARCH/vmlinux-$GUEST_KERNEL_VERSION" \
    "$TMP_DIR/vmlinux" "$expected"
  install -o root -g root -m 0644 "$TMP_DIR/vmlinux" "$RC_STATE_DIR/kernels/vmlinux"
fi

step "Installing the privileged runtime and its thin-pool setup"
install -o root -g root -m 0755 "$RUNTIME_BINARY" "$RC_LIB_DIR/runner-center-runtime"
note "$("$RC_LIB_DIR/runner-center-runtime" version)"

if [ -n "$FILE_POOL_GIB" ]; then
  cat > "$RC_ETC_DIR/thinpool.env" <<POOLENV
RC_THIN_POOL=$THIN_POOL
RC_POOL_BACKING=file
RC_POOL_DATA_IMAGE=$RC_STATE_DIR/thinpool-data.img
RC_POOL_META_IMAGE=$RC_STATE_DIR/thinpool-meta.img
RC_POOL_DATA_GIB=$FILE_POOL_GIB
POOLENV
  printf '\n'
  note 'WARNING: this pool is backed by sparse files on the root filesystem.'
  note 'It is an evaluation configuration. A full root filesystem will fail every'
  note 'running job at once. Move to dedicated devices before production use.'
else
  cat > "$RC_ETC_DIR/thinpool.env" <<POOLENV
RC_THIN_POOL=$THIN_POOL
RC_POOL_BACKING=device
RC_POOL_DATA_DEVICE=$DATA_DEVICE
RC_POOL_META_DEVICE=$META_DEVICE
POOLENV
fi
chmod 0600 "$RC_ETC_DIR/thinpool.env"

cat > "$RC_LIB_DIR/thinpool-setup.sh" <<'THINPOOL'
#!/usr/bin/env bash
# Bring up the Runner Center device-mapper thin-pool. Idempotent: it is a
# systemd oneshot that must survive reboots and repeated provisioning runs.
set -euo pipefail

. /etc/runner-center/thinpool.env

if dmsetup info "$RC_THIN_POOL" >/dev/null 2>&1; then
  exit 0
fi

if [ "$RC_POOL_BACKING" = 'file' ]; then
  if [ ! -f "$RC_POOL_DATA_IMAGE" ]; then
    truncate -s "${RC_POOL_DATA_GIB}G" "$RC_POOL_DATA_IMAGE"
  fi
  if [ ! -f "$RC_POOL_META_IMAGE" ]; then
    truncate -s 2G "$RC_POOL_META_IMAGE"
  fi
  chmod 600 "$RC_POOL_DATA_IMAGE" "$RC_POOL_META_IMAGE"
  data_device=$(losetup -j "$RC_POOL_DATA_IMAGE" | cut -d: -f1 | head -n 1)
  [ -n "$data_device" ] || data_device=$(losetup --find --show "$RC_POOL_DATA_IMAGE")
  meta_device=$(losetup -j "$RC_POOL_META_IMAGE" | cut -d: -f1 | head -n 1)
  [ -n "$meta_device" ] || meta_device=$(losetup --find --show "$RC_POOL_META_IMAGE")
else
  data_device=$RC_POOL_DATA_DEVICE
  meta_device=$RC_POOL_META_DEVICE
fi

# A thin-pool refuses to start against metadata from another pool, so wipe the
# first sectors of a metadata device that has never held this pool.
if ! dmsetup table 2>/dev/null | grep -q "$RC_THIN_POOL"; then
  dd if=/dev/zero of="$meta_device" bs=4096 count=1 conv=notrunc status=none || true
fi

sectors=$(blockdev --getsz "$data_device")
# 128 sectors (64 KiB) data blocks and a 32768-sector low-water mark are the
# values containerd's devmapper snapshotter documents.
dmsetup create "$RC_THIN_POOL" \
  --table "0 $sectors thin-pool $meta_device $data_device 128 32768 1 skip_block_zeroing"
THINPOOL
chmod 0755 "$RC_LIB_DIR/thinpool-setup.sh"

cat > "/etc/systemd/system/$THINPOOL_UNIT" <<UNIT
[Unit]
Description=Runner Center device-mapper thin-pool
Documentation=https://github.com/Fanzzzd/runner-center
DefaultDependencies=no
After=local-fs.target
Before=$CONTAINERD_UNIT

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=$RC_LIB_DIR/thinpool-setup.sh

[Install]
WantedBy=multi-user.target
UNIT

step 'Configuring the dedicated containerd instance'
# A separate containerd keeps the devmapper snapshotter, the image content store
# and the namespace away from whatever else this host runs. Nothing here touches
# /etc/containerd/config.toml, so Docker on the same machine is unaffected.
cat > "$RC_ETC_DIR/containerd.toml" <<CONTAINERD
version = 2
root = "$CONTAINERD_ROOT"
state = "$CONTAINERD_STATE"
disabled_plugins = ["io.containerd.grpc.v1.cri"]

[grpc]
  address = "$CONTAINERD_SOCKET"

[plugins."io.containerd.snapshotter.v1.devmapper"]
  pool_name = "$THIN_POOL"
  root_path = "$CONTAINERD_ROOT/devmapper"
  base_image_size = "$BASE_IMAGE_SIZE"
  discard_blocks = true
CONTAINERD
chmod 0600 "$RC_ETC_DIR/containerd.toml"

cat > "/etc/systemd/system/$CONTAINERD_UNIT" <<UNIT
[Unit]
Description=Runner Center containerd (devmapper snapshotter)
Documentation=https://github.com/Fanzzzd/runner-center
After=network.target $THINPOOL_UNIT
Requires=$THINPOOL_UNIT

[Service]
Type=notify
ExecStart=$CONTAINERD_BIN --config $RC_ETC_DIR/containerd.toml
Restart=always
RestartSec=5s
Delegate=yes
KillMode=process
LimitNOFILE=1048576
TasksMax=infinity
OOMScoreAdjust=-999

[Install]
WantedBy=multi-user.target
UNIT

step 'Writing the runtime environment'
{
  printf '# Generated by provision-firecracker-host.sh. Rerun it after editing.\n'
  printf 'RC_CONTAINERD_ADDRESS=%s\n' "$CONTAINERD_SOCKET"
  printf 'RC_CNI_BIN_DIR=%s\n' "$RC_CNI_BIN_DIR"
  printf 'RC_CNI_CONFIG_DIR=%s\n' "$RC_CNI_CONFIG_DIR"
  printf 'RC_THIN_POOL=%s\n' "$THIN_POOL"
  [ -n "$NETWORK_SUBNET" ] && printf 'RC_NETWORK_SUBNET=%s\n' "$NETWORK_SUBNET"
  [ -n "$EGRESS_MODE" ] && printf 'RC_EGRESS_MODE=%s\n' "$EGRESS_MODE"
  [ -n "$EGRESS_ALLOW" ] && printf 'RC_EGRESS_ALLOW=%s\n' "$EGRESS_ALLOW"
  [ -n "$NAMESERVERS" ] && printf 'RC_NAMESERVERS=%s\n' "$NAMESERVERS"
  [ -n "$MIN_POOL_FREE_MIB" ] && printf 'RC_MIN_POOL_FREE_MIB=%s\n' "$MIN_POOL_FREE_MIB"
  true
} > "$RC_RUNTIME_ENV"
chmod 0644 "$RC_RUNTIME_ENV"

step 'Rendering and installing the job network policy'
# Both halves come from the runtime binary itself, which is also what verifies
# them during readiness. There is no second source of truth to drift from.
set -a
# shellcheck disable=SC1090
. "$RC_RUNTIME_ENV"
set +a
network_name=${RC_CNI_NAME:-runner-center}
"$RC_LIB_DIR/runner-center-runtime" render-cni > "$TMP_DIR/conflist" ||
  fail 'the runtime could not render the CNI configuration'
install -o root -g root -m 0644 "$TMP_DIR/conflist" \
  "$RC_CNI_CONFIG_DIR/10-$network_name.conflist"
"$RC_LIB_DIR/runner-center-runtime" render-nftables > "$TMP_DIR/nftables" ||
  fail 'the runtime could not render the nftables ruleset'
install -o root -g root -m 0644 "$TMP_DIR/nftables" "$RC_ETC_DIR/nftables.rc.conf"
nft -f "$RC_ETC_DIR/nftables.rc.conf" || fail 'could not load the nftables ruleset'
note "loaded table inet runner-center and $RC_CNI_CONFIG_DIR/10-$network_name.conflist"

# The table lives in the kernel, so it has to be reloaded on boot. A drop-in on
# the runtime unit keeps the policy and the service that depends on it together.
install -d -m 0755 "/etc/systemd/system/$RUNTIME_UNIT.d"
cat > "/etc/systemd/system/$RUNTIME_UNIT.d/10-network-policy.conf" <<UNIT
[Service]
ExecStartPre=/usr/sbin/nft -f $RC_ETC_DIR/nftables.rc.conf
UNIT

step 'Installing the privileged runtime service'
unit_source=$RUNTIME_UNIT_FILE
if [ -z "$unit_source" ]; then
  unit_source=$(dirname "$0")/systemd/runner-center-runtime.service
fi
[ -f "$unit_source" ] || fail "could not find the runtime unit at $unit_source.
It ships beside this script in the repository and as its own release asset
(runner-center-runtime.service). Download it from the same release and pass
--runtime-unit ./runner-center-runtime.service."
install -o root -g root -m 0644 "$unit_source" "/etc/systemd/system/$RUNTIME_UNIT"
systemctl daemon-reload
systemctl enable --now "$THINPOOL_UNIT"
systemctl enable --now "$CONTAINERD_UNIT"
# containerd needs a moment before its introspection API answers.
for _ in 1 2 3 4 5 6 7 8 9 10; do
  [ -S "$CONTAINERD_SOCKET" ] && break
  sleep 1
done
systemctl restart "$RUNTIME_UNIT"
systemctl enable "$RUNTIME_UNIT" >/dev/null 2>&1 || true

if [ -n "$WORKER_USER" ]; then
  step "Granting $WORKER_USER access to the runtime socket"
  id "$WORKER_USER" >/dev/null 2>&1 || fail "user $WORKER_USER does not exist"
  usermod --append --groups "$RC_GROUP" "$WORKER_USER"
  note "$WORKER_USER must log out and back in before the new group takes effect"
fi

step 'Verifying readiness'
sleep 2
if "$RC_LIB_DIR/runner-center-runtime" preflight; then
  printf '\n✅ This host can run Runner Center Firecracker Profiles.\n'
else
  printf '\n❌ Readiness failed. The report above names every broken check.\n' >&2
  printf '   journalctl -u %s -n 50 --no-pager\n' "$RUNTIME_UNIT" >&2
  exit 1
fi
