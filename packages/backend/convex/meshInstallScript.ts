// Embedded in the Node role only. With no release pin --mesh refuses before changing a host.
export const MESH_INSTALL_FUNCTIONS = String.raw`
node_mesh_digest() {
  case "$1" in
__MESH_DIGESTS__
    *) printf '' ;;
  esac
}
node_mesh_prepare() {
  [ "$NODE_MESH" -eq 1 ] || return 0
  NODE_MESH_ASSET="erainfra-mesh-$NODE_TARGET"
  NODE_MESH_URL="https://github.com/$NODE_REPO/releases/download/v$NODE_VERSION/$NODE_MESH_ASSET"
  if [ -n "$NODE_MESH_SOURCE" ]; then
    case "$NODE_MESH_SOURCE" in */) NODE_MESH_URL="$NODE_MESH_SOURCE$NODE_MESH_ASSET" ;; *) NODE_MESH_URL=$NODE_MESH_SOURCE ;; esac
  fi
  NODE_MESH_DOWNLOAD="$NODE_TMP_DIR/$NODE_MESH_ASSET"
  node_fetch "$NODE_MESH_URL" "$NODE_MESH_DOWNLOAD"
  node_fetch "$NODE_MESH_URL.sha256" "$NODE_MESH_DOWNLOAD.sha256"
  NODE_MESH_PUBLISHED=$(awk 'NR==1 {print $1}' "$NODE_MESH_DOWNLOAD.sha256")
  NODE_MESH_ACTUAL=$(node_sha256_file "$NODE_MESH_DOWNLOAD")
  [ "$NODE_MESH_PUBLISHED" = "$NODE_MESH_EXPECTED" ] && [ "$NODE_MESH_ACTUAL" = "$NODE_MESH_EXPECTED" ] ||
    node_fail 'Mesh checksum verification failed against the deployment pin and published sidecar. Nothing was installed.'
  node_log "Verified $NODE_MESH_ASSET against both release and deployment checksums."
}
node_mesh_install() {
  [ "$NODE_MESH" -eq 1 ] || return 0
  if [ "$NODE_OS_NAME" = linux ] && command -v systemctl >/dev/null 2>&1 && $NODE_SUDO test -d /run/systemd/system; then
    NODE_MESH_UNIT=erainfra-mesh.service
    NODE_MESH_SOCKET=/run/erainfra-mesh/control.sock
    NODE_MESH_UNIT_REQUIRES=Requires=erainfra-mesh.service
    NODE_MESH_UNIT_AFTER=After=erainfra-mesh.service
    NODE_MESH_SERVICE_ENV=Environment=ERAINFRA_MESH_SOCKET=/run/erainfra-mesh/control.sock
    NODE_MESH_SERVICE_CONTROL=Environment=ERAINFRA_MESH_CONTROL_DIR=/var/lib/erainfra/mesh-control
    NODE_MESH_SERVICE_GROUP=SupplementaryGroups=erainfra-mesh
    id -u erainfra-mesh >/dev/null 2>&1 || $NODE_SUDO useradd --system --home-dir /var/lib/erainfra-mesh --shell /usr/sbin/nologin erainfra-mesh
    $NODE_SUDO install -d -m 755 /usr/local/lib/erainfra
    $NODE_SUDO install -m 755 "$NODE_MESH_DOWNLOAD" /usr/local/lib/erainfra/erainfra-mesh.new
    $NODE_SUDO mv /usr/local/lib/erainfra/erainfra-mesh.new /usr/local/lib/erainfra/erainfra-mesh
    $NODE_SUDO install -d -m 700 -o erainfra-mesh -g erainfra-mesh /var/lib/erainfra-mesh
    $NODE_SUDO install -d -m 750 -o erainfra-mesh -g erainfra-mesh /run/erainfra-mesh
    $NODE_SUDO tee /etc/systemd/system/erainfra-mesh.service >/dev/null <<'ERAINFRA_MESH_UNIT'
[Unit]
Description=EraInfra authenticated Node mesh
After=network-online.target
Wants=network-online.target
[Service]
User=erainfra-mesh
Group=erainfra-mesh
UMask=0077
StateDirectory=erainfra-mesh
StateDirectoryMode=0700
RuntimeDirectory=erainfra-mesh
RuntimeDirectoryMode=0750
Environment=TOKIO_WORKER_THREADS=2
ExecStartPre=/bin/sh -ec 'if test -e /var/lib/erainfra-mesh/endpoint.key; then /usr/local/lib/erainfra/erainfra-mesh id --key /var/lib/erainfra-mesh/endpoint.key >/dev/null; else /usr/local/lib/erainfra/erainfra-mesh init --key /var/lib/erainfra-mesh/endpoint.key >/dev/null; fi'
ExecStart=/usr/local/lib/erainfra/erainfra-mesh daemon --key /var/lib/erainfra-mesh/endpoint.key --socket /run/erainfra-mesh/control.sock --state /var/lib/erainfra-mesh/state
Restart=on-failure
RestartSec=3
TimeoutStopSec=10
LimitNOFILE=4096
TasksMax=32
MemoryMax=256M
CPUQuota=200%
NoNewPrivileges=yes
CapabilityBoundingSet=
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
PrivateDevices=yes
ProtectKernelTunables=yes
ProtectControlGroups=yes
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK
[Install]
WantedBy=multi-user.target
ERAINFRA_MESH_UNIT
    $NODE_SUDO systemctl daemon-reload
    $NODE_SUDO systemctl enable erainfra-mesh >/dev/null
    $NODE_SUDO systemctl restart erainfra-mesh
    $NODE_SUDO systemctl is-active --quiet erainfra-mesh || node_fail 'Mesh service did not start; the Infra Agent was not replaced.'
  else
    [ "$(id -u)" -ne 0 ] || node_fail '--mesh without systemd must run as an ordinary user; root mesh children are refused.'
    NODE_MESH_BIN="$NODE_BIN_DIR/erainfra-mesh"
    install -m 755 "$NODE_MESH_DOWNLOAD" "$NODE_MESH_BIN"
  fi
}
`;
