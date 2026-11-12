# Workers

A Worker is a machine that runs CI jobs. This page covers adding one, the commands on it, how it
measures itself, and what each platform needs before it can run jobs.

## Add Workers

From **Machines → Add machine**, pick the host's OS and run the generated command. The installer:

1. detects OS, architecture, CPU, memory, and a conservative slot count;
2. downloads the exact product release and verifies both published and deployment-pinned SHA-256;
3. registers once, installs a user service, and keeps the previous release for rollback;
4. starts the Worker, which discovers Profiles and prewarms their exact Image Releases;
5. advertises readiness only after the executor and image pass local checks.

The installer reports that prewarming continues in the background and points to `rc logs -f` and
the dashboard for live detail. A Profile that has never passed its exact executor/image contract is
`failed`; one that passed before but fails a later check is `degraded`. Both states withdraw that
Profile from scheduling. Failed and degraded checks retry every five minutes, while healthy
capacity keeps the six-hour verification cadence; the dashboard retains the last successful time.

Useful commands:

```bash
rc status
rc doctor
rc benchmark
rc logs -f
rc restart
rc update
```

Where the [`erainfra` CLI](cli.md) is installed on the Worker,
`erainfra worker <command>` runs the same commands: it runs `~/.runner-center/bin/rc` with the same
arguments, output and exit code. `rc` keeps working unchanged and stays the stable path for scripts.

A Worker that stops reporting for 10 minutes during a job may only have lost its link to Convex,
so its job is not stopped. Its Attempt shows as `Retiring` in `erainfra jobs view`, and the
controller deletes the Runner from GitHub once the job ends. When the Worker reports again, the
retirement is called off and the job runs to its end as usual. The reconciler ends a retirement
on its own only after six hours, and only when nothing else can settle it: no controller reports
for the Profile, and the Attempt is not running on a Worker that reports.

The Worker runs a bounded benchmark at enrollment and daily while idle: SHA-256 CPU throughput,
memory copy throughput, write/read/fsync plus a 512-file package-link fan-out on
`~/.runner-center/benchmarks`, and unauthenticated
GitHub/GHCR/npm latency and throughput. It downloads at most 1 MiB per target, uses no job slot or
credentials, and reports raw observations plus measurement metadata. `rc benchmark` reruns and
publishes the same transparent measurements on demand. The dashboard shows raw results, normalized
scores, configured/resource/recommended/effective slots, and each assigned run's selection reason.
For automatic capacity, a fresh benchmark reduces the resource slot ceiling to
`max(1, floor(resource slots × (0.25 + 0.75 × weakest measured score / 100)))`, where the weakest
score is taken over CPU, memory and disk only; at seven days old it is stale and no longer affects
slot reduction or candidate ranking. The network score ranks Workers for a `network` fit policy and
never reduces slots: one 1 MiB fetch per endpoint measures how far the Worker is from GitHub, not how
many jobs it can carry.

## Linux Worker prerequisites

For a trusted-only Docker Profile, Docker 28+, enough local image storage and the kernel settings
below are what a host needs. The Worker pulls the exact manifest digest before becoming schedulable;
jobs then use `--pull=never`, explicit CPU/memory/process limits, an unprivileged container user, and
no host mounts or volumes. This is the fastest path to add an existing Linux machine without
privileged host reconfiguration.

A Docker Attempt is also given explicit resource limits and an explicit resolver, rather than the
Docker daemon's inherited ones: no core dumps into a writable layer the Worker's other Attempts share
a filesystem with, a 16 MiB stack, a 65536 soft descriptor limit with the daemon's million left as
the ceiling a job may raise itself to, an 8 MiB lock limit so a library holding key material in
unswappable pages works, and a process bound of four per MiB of the Profile's memory, which is the
kernel's own RLIMIT_NPROC rule applied to what the job was sold instead of to the Worker's RAM
(#96). The container's nameservers are named on the command line and `edns0` is asked for; no search
domain is set, so a bare name in a workflow cannot resolve through whatever suffix a Worker's network
happens to supply. `ERAINFRA_DNS_SERVERS` or `RC_DNS_SERVERS` (comma-separated) overrides the resolvers the Worker reads from
systemd-resolved or `/etc/resolv.conf`; a host where neither yields an address a container can reach
refuses the Attempt rather than letting the daemon guess one.

**Kernel settings a Docker Profile needs.** A container shares the Worker's kernel, and not one of
the sysctls a CI job cares about is namespaced (the daemon refuses
`docker run --sysctl vm.max_map_count=262144` outright), so what a job reads is what the host holds. Readiness measures them
per Profile as the `host-sysctls` check, publishes every number as evidence, and refuses to advertise
a Docker Profile on a host below what a job needs. Apply them once:

```bash
sudo tee /etc/sysctl.d/60-erainfra-worker.conf >/dev/null <<'EOF'
# Elasticsearch and OpenSearch refuse to start below 262144 and say so in a
# startup error; the JVM and mmap-heavy builds degrade more quietly. The 5.4
# kernel default is 65530 and ubuntu-latest ships 262144. Required.
vm.max_map_count = 262144
# Watch exhaustion in a bundler, a test watcher or a file-watching dev server
# surfaces as an opaque ENOSPC that has nothing to do with disk. The default is
# 128 and ubuntu-latest ships 1280. Required.
fs.inotify.max_user_instances = 1280
# The same subsystem one level up. Recommended, not required.
fs.inotify.max_user_watches = 655360
# ubuntu-latest's value. 100 makes the host readier to swap a job out under
# pressure, which costs latency rather than failing a job. Recommended.
vm.swappiness = 60
EOF
sudo sysctl --system
```

The two marked required are the two a job fails on rather than merely notices, so a Worker without
them reports `host-sysctls` failed and stops accepting Docker work until `sysctl --system` has run.

For repositories that run fork PRs or other untrusted code, use Firecracker. It needs system-level
provisioning, and `deploy/provision-firecracker-host.sh` does all of it. The host must have Linux
x64 or ARM64 with hardware virtualization and `/dev/kvm`, containerd 1.7+, `nft`, `dmsetup`, and a
dedicated block device pair for the device-mapper thin-pool. The Worker Agent itself stays
unprivileged: Firecracker, CNI and devmapper are owned by a separate root service.

The control plane serves this provisioner. Run it as root on the host, before the Worker install:

```bash
curl -fsSL https://<deployment>.convex.site/install | sudo bash -s -- --role worker-host \
  --data-device /dev/nvme1n1 --meta-device /dev/nvme2n1
```

The `worker-host` role downloads the runtime from the release this deployment pins, checks its
SHA-256 against the pin, and runs the same `deploy/provision-firecracker-host.sh` with it. The
account that ran `sudo` becomes the Worker account unless `--worker-user` names another. Without
`--data-device` and `--meta-device` it backs the thin-pool with a 200 GiB sparse file
(`--pool-gib`, `--pool-dir`), which is for evaluation only, for the reason under the flags below.
`--uninstall` reverses it.

`--data-device` and `--meta-device` belong to the thin-pool from then on, so never name a partition
holding data. A new pair must be zero-filled in full before the first provision.
Thin-pool setup never erases either device: it reopens valid metadata, initializes a pair it has
read back as entirely zero, and refuses anything else.

To run the script from a checkout instead, download the matching
`runner-center-runtime-linux-<arch>` release asset, verify its `.sha256` sidecar, then:

```bash
sudo deploy/provision-firecracker-host.sh \
  --runtime-binary ./runner-center-runtime-linux-x86_64 \
  --data-device /dev/nvme1n1 --meta-device /dev/nvme2n1 \
  --worker-user "$USER"
```

It installs a checksum-pinned Firecracker, the CNI plugins, a pinned guest kernel, the thin-pool, a
containerd instance dedicated to EraInfra, the rendered job network policy, and the privileged
runtime service, then runs readiness and prints the report. Everything lands under
`/opt/runner-center`, `/etc/runner-center` and `/var/lib/runner-center`, so a host that also runs
Docker or Kubernetes keeps its own containerd configuration, CNI directory and firewall tables.
`sudo deploy/provision-firecracker-host.sh --uninstall` reverses it.

Useful flags: `--file-backed-pool GIB` (32 minimum) backs the thin-pool with sparse files for
evaluation only (never in production: a full backing filesystem then fails every running job at
once), and `--pool-dir PATH` puts those files on a data filesystem when the root filesystem is
nearly full;
`--force-network-reload` provisions even with Firecracker VMs running, which the script otherwise
refuses because reloading the table strips their per-guest sets and restarting the runtime ends
them;
`--egress-mode public|audit|allowlist` and `--egress-allow CIDR,CIDR` set the host operator's
override for every guest on this Worker, on top of each Profile's own egress (see
[Egress policy](job-isolation.md#egress-policy)); `--network-subnet` moves the guest range if it collides with the
host's.

Log out and back in after the group change, then run `rc doctor`. The user-owned release binary is
only a socket client; the systemd service never executes files from `~/.runner-center`. Two operator
commands are worth knowing:

```bash
# after any host firewall change, and whenever readiness reports job-network-policy
sudo /usr/local/lib/runner-center/runner-center-runtime verify-network
# the full readiness report, one line per prerequisite
/usr/local/lib/runner-center/runner-center-runtime preflight
```

### Re-provision a live Worker

Re-running the `worker-host` role or the provisioner on a live Worker, to move the runtime to a
newer release or to apply a `runtime.env` change, refuses while any Firecracker VM runs on the
host. That includes the idle warm VMs the runtime keeps parked for the next job, so a Worker with no
jobs still refuses. Provisioning reloads the job network policy and restarts the runtime, which
would end those VMs. Drain first, as the refusal lists:

1. Wait until the dashboard's Attempts page shows nothing running on the Worker. For a Profile's
   only Worker, follow [take the only Worker out of service](runbooks/take-the-only-worker-away.md).
2. `sudo systemctl stop runner-center-runtime`, which ends the idle warm VMs.
3. `pgrep -x firecracker` must print nothing. Then re-run.

`deploy/provision-firecracker-host.sh --force-network-reload` provisions anyway, and every running
job ends when it restarts the runtime. The `worker-host` role has no such option.

### Old Image Releases

Each repin pulls a new Image Release into the runtime's containerd, about 10 GiB unpacked for the
full image. Once an hour, after a readiness pass, the Agent sends the runtime the Image Releases
of this Worker's Firecracker Profiles. The runtime keeps those, its warm pools' and the other
one a VM booted from most recently, so a rollback to the previous release needs no pull, and
deletes the rest. Each boot stamps `erainfra.io/last-used` on the image record. An image no VM
booted counts from its pull, so a canary candidate pulled after the release the other Profiles ran
does not take the rollback slot. It logs each
deletion as `deleted an Image Release no Profile uses`. A running Attempt or parked guest holds
a containerd lease on its own snapshot, so deleting its image's name never breaks it.
`runner-center-runtime prune-images` does the same by hand; it reads the Image Releases to keep
as a JSON array on stdin and refuses an empty one.

### Start budget

Every guest on a Worker shares its disk. ubuntu0's thin pool sits on a RAID1 of two SATA SSDs
behind a RAID controller with write-through cache. Six Attempts starting together there held the
host's I/O stall (io "some") at 40 to 60% for minutes, and every job on the Worker slowed. The runtime therefore spaces starts out. An Attempt waits in `Start`, warm claims
included, while either limit is reached:

| Setting (`ERAINFRA_` or `RC_`) | Default | Limit                                                    |
| ------------------------------ | ------- | -------------------------------------------------------- |
| `MAX_STARTING`                 | 2       | Attempts still in their start window                     |
| `START_WINDOW_S`               | 60      | Seconds an admitted Attempt counts as starting           |
| `IO_PRESSURE_LIMIT`            | 30      | io "some" avg10 percentage at or above which starts wait |
| `MAX_START_HOLD_S`             | 120     | Longest wait; the Attempt then starts anyway             |

Attempts start in arrival order. A 0 turns that limit off. Set them on
`runner-center-runtime.service` and restart it. The wait counts against `RC_BOOT_TIMEOUT_S`
(300 seconds), so keep `MAX_START_HOLD_S` well below it. The runtime logs each hold as
`held Attempt for the start budget`. `runner-center-runtime admission` prints the current state,
which the Agent forwards every 30 seconds; `/runs-on` answers the fallback while every ready
Worker is over budget ([workflows](workflows.md)).

EraInfra does not silently create or wipe a dedicated thin-pool device: selecting that device
is an explicit operator storage decision, and the provisioner destroys only the devices you name.
The official Fireactions installation guide remains a compatible reference for the same components.

### Guest writeback

A guest's root drive is a snapshot the runtime deletes when the Attempt ends, so the guest keeps
a job's writes in memory instead of sending them to the shared disk. `runner-center-guest` sets
`vm.dirty_background_ratio=50`, `vm.dirty_ratio=80`, `vm.dirty_expire_centisecs=360000` and
`vm.dirty_writeback_centisecs=6000` at boot. When the runner exits, it resets the VM without the
sync and unmount. On ubuntu0 a job writing about 2.5 GiB of small files sent 102 MiB to its drive
instead of 9015 MiB, and the host's io "some" stayed under 5% instead of reaching 42%
([#351](https://github.com/Fanzzzd/erainfra/pull/351)). Memory pressure still writes pages back,
so a job that writes more than the guest's memory holds runs as before; nothing caps its space.
A job that calls `sync` pays for its own dirty pages.

## macOS Worker prerequisites

```bash
brew install cirruslabs/cli/tart cirruslabs/cli/sshpass
```

The Worker pulls the digest-pinned Tart base before it reports ready. Every job clones it with
copy-on-write, pins the attested guest SSH host key, streams a checksum-verified runner tarball into
the guest, and deletes the VM on exit, timeout, signal, or cancellation. The default two-slot limit
matches Apple's macOS virtualization license constraint. Host-key pinning prefers out-of-band
attestation over Tart's guest-agent vsock; if that channel does not answer and this Image Release has
no earlier pin, the first connection uses trust on first use (`accept-new`) and saves the presented
key, so later runs are strict. That fallback exposes only the first boot to a local attacker on the
Tart bridge and is not used when an earlier pin is available. An attacker present on that first boot
can poison the persisted pin, and later strict checks do not authenticate it; verify the file under
`~/.runner-center/known_hosts.d` through a trusted guest console or working vsock, and if it is wrong,
restore attestation, remove the pin, and rerun the job to enroll the attested key.

## Windows Worker prerequisites

Windows cannot run the bash installer, so the same command comes from `/install.ps1` instead. The
dashboard's OS toggle renders it; run it on an x64 Windows Server host:

```powershell
& ([scriptblock]::Create((irm https://<site>/install.ps1))) -Role worker -Token rcreg_xxx
```

`-Role worker` is explicit because that URL also serves the Node installer and defaults to it. The
supply chain is the bash installer's, unchanged: the pinned `erainfra-agent-<version>.tar.gz`, its
published SHA-256, and this deployment's own pin as the trust root. An archive that matches the
release but not the pin is refused and nothing is installed. `npm ci` runs against the lockfile the
release shipped; nothing is compiled on the machine.

A fresh Windows Server has no Node.js, so the installer fetches the official Node 22 `win-x64`
build from nodejs.org and verifies it against nodejs.org's own `SHASUMS256.txt` before running it.
This is the same source and the same check the POSIX installer already uses when a host has no runtime.
Everything lands under `%USERPROFILE%\.runner-center`, which is the `ERAINFRA_HOME` (or `RC_HOME`) the Hyper-V
provisioner and `build-image.ps1` already default to. `-Update`, `-Version`, `-Sha256`, and rollback
through `agent.previous` work exactly as they do on POSIX, and `rc.ps1` under
`%USERPROFILE%\.runner-center\bin` is the `rc` equivalent.

Persistence is a Scheduled Task registered **for the installing account, at logon**, not a Windows
service. The task runs as the account whose `%USERPROFILE%` holds `RC_HOME` and the images. The
cost is that the Worker starts at logon: on a dedicated Worker box, enable automatic logon.

`build-image.ps1` stores the guest credential machine-scope DPAPI in `<name>.cred.json`, ACLed to
SYSTEM and Administrators, so the agent does not have to run as the account that built the image
(#89). An image built before that change carries a user-scope `<name>.cred.xml`; `provision-win.ps1`
and the readiness probe still read it, and readiness decrypts it as the agent's own account so a
credential written by a different account fails there with its true cause. Rebuild the image to get
the machine-scope file.

Hyper-V and its PowerShell module have to be enabled, and a parent VHDX has to exist under
`%RC_HOME%\images\<name>.vhdx`; `provisioners/build-image.ps1` produces one. The control plane
advertises a Hyper-V Profile ready once the Worker's readiness probe has proved the module, the VM
switch, the parent VHDX and the guest credential; a Worker missing any of them enrols and reports the
failed check but is not scheduled onto.
