# Runbook: cut `rc-linux-js` over to Firecracker

Moving a Profile from the trusted-only Docker executor to the strong Firecracker executor. Every
command here is meant to be run as written. Nothing in it is reversible only forwards: the last
section rolls the whole thing back.

Roles:

- **Worker host** — the machine that runs jobs. Needs `/dev/kvm`, root, containerd 1.7+, `nft`,
  `dmsetup`, and two dedicated block devices for the thin-pool.
- **Controller host** — the small always-on machine running
  `runner-center-controller@rc-linux-js`. Needs no KVM.

---

## 1. Confirm the Worker host can provide a guest-kernel boundary

```bash
ls -l /dev/kvm                     # must exist
grep -oE 'vmx|svm' /proc/cpuinfo | head -n 1   # must print vmx or svm
systemd-detect-virt                # bare metal prints "none"; a nested guest may still work
containerd --version               # 1.7 or newer
command -v nft dmsetup             # both required
lsblk                              # pick two devices for the thin-pool
```

A nested guest without exposed virtualization extensions cannot run Firecracker. There is no
software fallback that preserves the boundary, and Docker is not one — see
[ADR 0002](../adr/0002-verify-the-job-isolation-boundary.md).

## 2. Provision the Worker host

Download the runtime asset for the release you are running and verify it against its published
sidecar before it touches the host:

```bash
version=v0.3.0            # the Runner Center release you are deploying
arch=x86_64               # or arm64
base="https://github.com/Fanzzzd/runner-center/releases/download/$version"
curl -fsSLO "$base/runner-center-runtime-linux-$arch"
curl -fsSLO "$base/runner-center-runtime-linux-$arch.sha256"
sha256sum -c "runner-center-runtime-linux-$arch.sha256"
chmod +x "runner-center-runtime-linux-$arch"
```

Then provision. `--data-device` and `--meta-device` are **destroyed**; name the devices you chose in
step 1, not a partition holding data.

```bash
sudo deploy/provision-firecracker-host.sh \
  --runtime-binary "./runner-center-runtime-linux-$arch" \
  --data-device /dev/nvme1n1 \
  --meta-device /dev/nvme2n1 \
  --worker-user "$USER"
```

For an evaluation host with no spare devices, swap both device flags for
`--file-backed-pool 60`. That backs the pool with sparse files on the root filesystem, so a full
root filesystem fails every running job at once. Do not ship it.

The provisioner ends by printing the readiness report. Every check must pass. If one does not, the
report names it; `journalctl -u runner-center-runtime -n 50 --no-pager` has the detail.

Log out and back in so the `runner-center` group membership takes effect, then:

```bash
rc doctor
sudo /usr/local/lib/runner-center/runner-center-runtime verify-network
```

## 3. Enrol or restart the Worker

If the host is new, add it from **Machines → Add machine** in the dashboard and run the generated
command. If it is already enrolled, restart the Agent so it re-runs readiness:

```bash
rc restart
rc logs -f       # look for: rc-linux-js readiness: ready (firecracker-microvm, guest-kernel)
```

The dashboard's Profile row for the Worker now shows `guest kernel`, its checks, the measured
hardware, thin-pool headroom, and the job network policy in force.

## 4. Switch the Profile on the controller host

The controller declares the Profile contract. Until this changes, the Profile is still Docker.

```bash
sudo systemctl stop runner-center-controller@rc-linux-js
sudo cp /etc/runner-center/profiles/rc-linux-js.env \
        /etc/runner-center/profiles/rc-linux-js.env.docker-backup
sudo sed -i 's/^RC_EXECUTOR=docker$/RC_EXECUTOR=firecracker/' \
        /etc/runner-center/profiles/rc-linux-js.env
sudo systemctl start runner-center-controller@rc-linux-js
sudo systemctl status runner-center-controller@rc-linux-js --no-pager
```

Workers rediscover the Profile within one subscription update and re-run readiness against the new
contract. A Worker that cannot provide the Firecracker executor simply stops being eligible; it is
never silently downgraded.

Confirm on the dashboard that `rc-linux-js` reads `guest kernel` and has at least one ready Worker,
then run a real workflow:

```yaml
jobs:
  smoke:
    runs-on: rc-linux-js
    steps:
      - run: |
          echo "kernel: $(uname -r)"
          echo "virt:   $(systemd-detect-virt || true)"
          # Every one of these must fail: the job network denies the host,
          # RFC1918 and other guests.
          ! timeout 5 curl -s http://10.241.0.1/ && echo "host denied"
          ! timeout 5 curl -s http://192.168.1.1/ && echo "RFC1918 denied"
          timeout 20 curl -sSf https://api.github.com/zen && echo "egress allowed"
```

`uname -r` prints the pinned guest kernel, not the host's. That is the boundary, visible from
inside the job.

## 5. Roll back

Rolling back the Profile is independent of rolling back the host, and is the faster of the two.

```bash
# Controller host: back to the trusted-only Docker executor.
sudo systemctl stop runner-center-controller@rc-linux-js
sudo mv /etc/runner-center/profiles/rc-linux-js.env.docker-backup \
        /etc/runner-center/profiles/rc-linux-js.env
sudo systemctl start runner-center-controller@rc-linux-js
```

Running Attempts finish; the scheduler places no new ones on a Worker whose readiness no longer
matches the Profile contract.

```bash
# Worker host: remove everything the provisioner installed.
sudo deploy/provision-firecracker-host.sh --uninstall
```

That stops and removes the runtime, containerd and thin-pool services, deletes the `runner-center`
nftables table and CNI configuration, and removes the installed binaries. It deliberately leaves
`/var/lib/runner-center` and the `runner-center` group in place, because they hold the guest
kernel, thin-pool images and pulled image content. Remove those by hand once you are sure:

```bash
sudo rm -rf /var/lib/runner-center && sudo groupdel runner-center
```

Nothing the provisioner installs touches `/etc/containerd/config.toml`, `/opt/cni/bin`,
`/etc/cni/net.d`, or any firewall table other than `inet runner-center`, so Docker and Kubernetes
networking on the same host are unaffected by either direction of this runbook.
