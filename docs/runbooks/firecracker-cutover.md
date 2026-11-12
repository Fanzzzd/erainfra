# Runbook: cut `rc-linux-js` over to Firecracker

This cutover ran on 2026-08-20 under the Profile's old name. `rc-linux-js` is now
`erainfra-4vcpu-ubuntu-2404`
([ADR 0010](../adr/0010-name-profiles-the-way-runner-vendors-name-labels.md)). To cut over another
Profile, put its name wherever `rc-linux-js` appears below.

Moving a Profile from the trusted-only Docker executor to the strong Firecracker executor. Every
command here is meant to be run as written. Nothing in it is reversible only forwards: the last
section rolls the whole thing back.

Roles:

- **Worker host**: the machine that runs jobs. Needs `/dev/kvm`, root, containerd 1.7+, `nft`,
  `dmsetup`, `thin_check` from thin-provisioning-tools, and two dedicated block devices for the
  thin-pool.
- **Controller host**: the small always-on machine running
  `runner-center-controller@rc-linux-js`. Needs no KVM.

---

## 1. Confirm the Worker host can provide a guest-kernel boundary

```bash
ls -l /dev/kvm                     # must exist
grep -oE 'vmx|svm' /proc/cpuinfo | head -n 1   # must print vmx or svm
systemd-detect-virt                # bare metal prints "none"; a nested guest may still work
containerd --version               # 1.7 or newer
command -v nft dmsetup thin_check  # all required
lsblk                              # pick two devices for the thin-pool
```

A nested guest without exposed virtualization extensions cannot run Firecracker. There is no
software fallback that preserves the boundary, and Docker is not one. See
[ADR 0002](../adr/0002-verify-the-job-isolation-boundary.md).

## 2. Provision the Worker host

The one-command form does all of this section in a single verified step: it downloads the agent
archive this deployment pins, checks it against the pinned SHA-256, and hands the runtime inside to
the provisioner that travels embedded in the script itself:

```bash
curl -fsSL https://<your-deployment>.convex.site/install | sudo bash -s -- --role worker-host \
  --pool-gib 200 --pool-dir /path/on/a/roomy/filesystem
```

`--worker-user` defaults to whoever ran sudo; `--data-device`/`--meta-device` swap the file-backed
pool for dedicated devices (destroyed, as below); `--uninstall` mirrors the rollback section.

Re-running it on a live Worker, to move the runtime to a newer release, refuses while any
Firecracker VM runs on the host. That includes the idle warm VMs the runtime keeps parked for the
next job, so a Worker with no jobs still refuses. Provisioning reloads the job network policy and
restarts the runtime, which would end those VMs. Drain first, as the refusal lists: wait until the
dashboard shows nothing running on the Worker (for a Profile's only Worker, follow
[take-the-only-worker-away.md](take-the-only-worker-away.md)), run
`sudo systemctl stop runner-center-runtime`, check that `pgrep -x firecracker` prints nothing, then
re-run. Run by hand, `deploy/provision-firecracker-host.sh --force-network-reload` provisions anyway
and ends every running job; the one-command form has no such option.

Everything after this paragraph is the same provisioning done by hand, for air-gapped hosts, for
a runtime built from source, or to read what the one command does.

Download the runtime asset for the release you are running and verify it against its published
sidecar before it touches the host:

```bash
version=v0.3.0            # the EraInfra release you are deploying
case "$(uname -m)" in    # release assets say arm64 where uname -m says aarch64
  x86_64) arch=x86_64 ;;
  aarch64) arch=arm64 ;;
esac
base="https://github.com/Fanzzzd/erainfra/releases/download/$version"
curl -fsSLO "$base/runner-center-runtime-linux-$arch"
curl -fsSLO "$base/runner-center-runtime-linux-$arch.sha256"
sha256sum -c "runner-center-runtime-linux-$arch.sha256"
chmod +x "runner-center-runtime-linux-$arch"
```

Then provision. `--data-device` and `--meta-device` belong to the thin-pool from then on; name the
devices you chose in step 1, not a partition holding data. A new pair must be zero-filled in full
before the first provision. Thin-pool setup never erases either device: it reopens valid metadata,
initializes a pair it has read back as entirely zero, and refuses anything else.

```bash
sudo deploy/provision-firecracker-host.sh \
  --runtime-binary "./runner-center-runtime-linux-$arch" \
  --data-device /dev/nvme1n1 \
  --meta-device /dev/nvme2n1 \
  --worker-user "$USER"
```

For an evaluation host with no spare devices, swap both device flags for `--file-backed-pool 60`,
adding `--pool-dir /path/on/a/roomy/filesystem` when the root filesystem is tight. That backs the
pool with sparse files, so filling their filesystem fails every running job at once. The provisioner
refuses a filesystem that cannot hold the whole pool, but that check is a floor, not a licence: do
not ship it.

The provisioner ends by printing the readiness report. Every check must pass. If one does not, the
report names it; `journalctl -u runner-center-runtime -n 50 --no-pager` has the detail.

Log out and back in so the `runner-center` group membership takes effect, then:

```bash
rc doctor
sudo /usr/local/lib/runner-center/runner-center-runtime verify-network
```

## 3. Enrol or restart the Worker

If this is the Profile's only Worker, its consumers have been queuing since step 2 began and will
keep queuing until readiness is green. [Take the only Worker out of service](take-the-only-worker-away.md)
says what to tell them before starting and what to set back afterwards.

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
