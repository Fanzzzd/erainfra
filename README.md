# EraInfra

Run GitHub Actions on your own machines — each job in its own microVM, scheduled by a control
plane that needs no public IP anywhere.

EraInfra turns Linux and Apple Silicon machines you already own into a self-hosted CI fleet.
Workflows target a stable **Profile** such as `rc-linux-js` and never name a host: the platform
decides which Worker runs each job, prepares an isolated environment for exactly that job, and
destroys it afterwards. Machines dial out to the control plane, so a Worker behind NAT, a home
router, or a corporate firewall participates like any other.

**Why it holds up:**

- **A hardware boundary per job.** Untrusted Linux jobs get a fresh Firecracker microVM — its
  own guest kernel, copy-on-write root, point-to-point network, and single-use credentials —
  torn down on every exit path, including Worker crashes.
- **Verified, not assumed.** The isolation boundary is checked by the runtime itself: a Worker
  whose network policy drifts from its Profile stops being ready, and a daily canary exercises
  scheduling through the executor's in-job isolation probes. Live Firecracker boot and post-job
  teardown remain part of issue #17's production gate.
- **Immutable by construction.** Images are pinned by digest, the agent release is pinned by
  checksum, and nothing writable survives a job. Warm state comes from prewarmed images, not
  shared caches.
- **Drop-in adoption.** `runs-on: <profile>` is the entire workflow change, with an optional
  fallback to GitHub-hosted runners when the fleet has no capacity.

The design combines:

- GitHub's official Runner Scale Set Client for demand, JIT registration, and lifecycle events;
- Convex for the durable control plane, scheduler, authentication, and dashboard;
- one constrained, ephemeral Docker container per trusted Linux job during bootstrap;
- one ephemeral Firecracker microVM per Linux job;
- one copy-on-write Tart VM per macOS job;
- digest-pinned, prewarmed Image Releases;
- shared admission control for CI Runs and operator Experiments.

Fireactions is the main Linux execution reference, not a second control plane. ARC remains the
better choice when the whole fleet already runs Kubernetes. The decision and source comparison
are in [ADR 0001](docs/adr/0001-use-scale-sets-with-platform-executors.md); the isolation boundary,
network policy and cache contract are in
[ADR 0002](docs/adr/0002-verify-the-job-isolation-boundary.md).

## Product contract

| Name          | Meaning                                                                                    |
| ------------- | ------------------------------------------------------------------------------------------ |
| Profile       | Stable workflow-facing contract: executor, immutable image, CPU, memory, and scale bounds. |
| Worker        | A registered physical host. Workers discover compatible Profiles automatically.            |
| Image Release | OCI/Tart image pinned by `sha256`; mutable tags are rejected.                              |
| Attempt       | One durable, isolated GitHub runner lifecycle. Retry creates a new Attempt.                |
| Experiment    | Operator-authored, time-bounded command using the same Profile and capacity as CI.         |

Scheduling first requires an exact ready Profile/Image Release match, then admits work within the
Worker slot limit, a 90% CPU/memory envelope, and snapshot-storage headroom. Among candidates with
equal resource pressure, a Profile's `balanced`, `cpu`, `network`, or `io` fit policy ranks fresh
Worker benchmarks. Missing or seven-day-stale observations score neutrally and never exclude a
Worker. Linux automatic capacity is bounded at 16 slots, macOS at two Tart VMs, and Windows at one;
measured bottlenecks can reduce that resource ceiling, while a fixed `--slots` override remains the
operator's explicit effective capacity. The 90% envelope deliberately uses a full host dimension
when its total CPU or memory is no greater than one work item's request: an exactly sized small host
can run one item instead of becoming unusable, while an undersized host still fails admission.

## Support status

| Platform            | Executor                           | Status                                                                |
| ------------------- | ---------------------------------- | --------------------------------------------------------------------- |
| Linux x64/ARM64     | Docker                             | Bootstrap path for trusted repositories; digest-pinned and ephemeral. |
| Linux x64/ARM64     | Firecracker + containerd devmapper | Strong isolation path; requires KVM and dedicated runtime storage.    |
| Apple Silicon macOS | Tart                               | Supported execution path, capped at two guests by default.            |
| Windows x64         | Hyper-V                            | One-command onboarding; execution preview, never advertised ready.    |

Both Linux executors use the new Profile and scale-set protocol. Docker deliberately has no host
bind mounts, privileged mode, Docker socket, or shared volume, but it shares the host kernel and
the Docker daemon can inspect container state. That is why Docker Profiles are restricted to
mutually trusted jobs and should map to one trust domain. Use Firecracker for untrusted code. The
dashboard shows the real boundary -- `guest kernel` or `shared kernel` -- next to every Profile. The
old `workflow_job` webhook scheduler remains temporarily for migration; the dashboard labels its
Jobs view and GitHub App setup as legacy.

### The job isolation contract

For a Firecracker Profile, each Attempt gets:

- a fresh guest kernel and a copy-on-write root prepared from the Image Release's chain ID; no host
  path, socket, volume or device is shared, and the snapshot is discarded on exit;
- a point-to-point job network whose policy is rendered and verified by the runtime itself. Traffic
  to the host, to other guests, and to RFC1918, CGNAT, link-local and other special-purpose ranges
  is dropped; an operator adds destinations explicitly, or switches a Profile to allowlist-only
  egress. A Worker whose nftables table no longer matches its Profile stops being ready;
- single-use JIT credentials over MMDSv2, never in argv, an image layer, a host environment or a
  log;
- teardown on success, failure, cancellation, timeout, and controller reconciliation. After an Agent
  crash, its service supervisor restarts it and startup recovery reconciles the privileged runtime
  before the Worker advertises readiness or accepts replacement work. If that supervisor is disabled
  and the Agent never restarts, a guest can remain alive until its job or runtime timeout exits it;
- CPU, memory and thin-pool admission before the Attempt is placed, and one process-bounded runtime
  service per host.

For a Docker Profile, each Attempt additionally gets **its own range of the Worker's CPUs**. The
Agent reserves `vcpus` cores per Attempt, disjoint from every other Attempt and Experiment running
on that Worker, and passes them to `--cpuset-cpus` beside the `--cpus` quota. Without the cpuset the
quota is invisible: `nproc`, `os.availableParallelism()`, `runtime.NumCPU()` and
`Runtime.availableProcessors()` all read the affinity mask through `sched_getaffinity(2)` and never
the quota, so an 8-vCPU job on a 64-core Worker told every autosizing build tool it owned 64 cores
and each one over-subscribed by 8x. Reservations are released on every teardown path, and a Worker
whose Agent was killed outright reconciles them against the running containers before it advertises
readiness again. A Worker with no free range refuses the Attempt rather than running it
over-subscribed, and a Profile asking for more vCPUs than the Worker has CPUs fails its
`cpu-capacity` readiness check instead of being scheduled onto.

None of that is taken on trust. Before a Worker advertises a Docker Profile as ready it runs one
throwaway container with that Profile's exact limit flags, on a range borrowed from the same
allocator that pins a real Attempt, and asserts the container agrees about its own size: `nproc`
equals `vcpus`, `RC_VCPUS` and `RC_MEMORY_MIB` hold the right numbers, and `RC_MEMORY_MIB` is the
limit the memory cgroup actually enforces. That is the `job-resource-visibility` check, and its
detail carries the measured numbers on a pass as well as a failure. A Worker that cannot give a job
an honest view of its own size does not accept work, which is the rule the network policy already
follows.

A cpuset does not fix every CPU-count interface, so **`RC_VCPUS` in the job environment is the
authoritative limit.** `/proc/cpuinfo` is not filtered and still lists every host CPU, which leaves
Node's `os.cpus().length` reporting the Worker. Python's `os.cpu_count()` depends on the C library —
musl answers it from the affinity mask, glibc from the online-CPU count — and the Linux Image
Release is glibc, so Python jobs need `len(os.sched_getaffinity(0))`, `os.process_cpu_count()` on
3.13+, or `RC_VCPUS`.

**Memory is not made honest by that, and the container is told so explicitly.** `free`,
`/proc/meminfo` and `os.totalmem()` still report the host's RAM, because the cgroup limit is not
reflected there without LXCFS — which needs a host daemon, its own readiness evidence, and a bind
mount into a container whose contract forbids one. Every Docker job therefore receives `RC_VCPUS`
and `RC_MEMORY_MIB` in its environment, holding the limits actually enforced on it. Anything that
sizes a heap or a worker pool from total RAM — `--max-old-space-size` is the usual one — should read
`RC_MEMORY_MIB` rather than believe `free`.

Nothing writable survives a job on either Linux executor. Warm state comes from the immutable Image
Release; cross-job dependency caching belongs to GitHub's own cache service, which is authenticated
and scoped by repository, branch and key, and is reachable over allowed egress. See
[ADR 0002](docs/adr/0002-verify-the-job-isolation-boundary.md) for why EraInfra does not run a
second cache service of its own.

## Develop locally

Requirements: Node.js 22+, pnpm 11, Go 1.25.3+, and a Convex account or local deployment.

```bash
pnpm install
pnpm dev
```

Validation:

```bash
pnpm check
go test ./...
go vet ./...
```

`pnpm check` is the JavaScript gate for the whole workspace: lint, formatting, type checking, and
tests. CI also runs the production build, tests and vets the Go module, compiles both shipped Linux
architectures, asserts that the Infra Agent still links exactly one dependency, refuses any rename of
an identifier a customer's machine already holds, and verifies that the npm lockfile used by
installed Workers is current.

## Deploy the control plane

Deploy the Convex backend and static dashboard:

```bash
pnpm run deploy:control-plane
```

Set these deployment variables before production use:

| Variable           | Purpose                                                          |
| ------------------ | ---------------------------------------------------------------- |
| `SITE_URL`         | Canonical HTTPS dashboard origin.                                |
| `BOOTSTRAP_SECRET` | One-time first-admin bootstrap.                                  |
| `CONTROLLER_TOKEN` | Long random bearer token shared only with scale-set controllers. |
| `ALLOWED_REPOS`    | Legacy webhook allowlist; omit when that path is unused.         |

The dashboard creates short-lived, single-use Worker enrollment commands. Machine credentials are
stored in `~/.runner-center/agent/.env` with mode `600`; JIT configurations travel from Convex to the
Worker once and enter its runtime client through stdin, then cross a mode-`0660` Unix socket in an
HTTP request body. They never appear in argv or a host environment variable.

## Publish an Image Release

`images/ubuntu-24.04-js` is the first minimal Linux Profile. It contains:

- Ubuntu 24.04 and systemd;
- actions/runner 2.336.0, checksum verified;
- Node.js 22.23.2 in the hosted-toolcache layout;
- an official runner action-archive cache seeded with the exact checkout, pnpm, setup-node, and
  setup-go commits used by the workflows;
- pnpm 11.21.0, Git, Docker, build tools, `libatomic1`, and common archive tools;
- the small MMDSv2 guest bootstrap;
- a locked root password and no SSH service.

Run the **Runner image** workflow. It builds both Linux architectures, publishes to GHCR, emits
SBOM/provenance attestations, and reports the immutable manifest digest. Use that full
`ghcr.io/...@sha256:...` reference in the controller. The workflow deliberately does not upload a
BuildKit cache to GitHub Actions storage.

This Profile promises its explicit smoke-tested tools, not complete GitHub-hosted image parity.
See [the image research](docs/research/blacksmith-runner-images.md) for why GitHub's minimal runner
container and hosted `ubuntu-24.04` VM are different products.

Exactly _how_ it differs is measured rather than described. The **environment conformance** workflow
runs one fingerprint script on `ubuntu-latest` and on every Linux Profile, then diffs the two and
fails on any difference that is not on [an explicit, commented
allowlist](.github/conformance/allowlist.txt). That file is the written record of every way this
environment is deliberately not GitHub's, and everything not on it is a bug — a job that reads a
different CPU count from the one it may use, a tool present there and missing here, a scratch
directory mounted `noexec`. It runs daily and on every change to the provisioners, the images or
the readiness code, because those are the three inputs that can move it.

## Run a Profile controller

One lightweight controller process owns one Profile. It can run on a small always-on host; it does
not execute jobs or require KVM. A repository, organization, or enterprise URL is accepted.

```bash
export RC_CONVEX_URL=https://<deployment>.convex.site
export RC_CONTROLLER_TOKEN_FILE=/etc/runner-center/controller-token
export RC_GITHUB_CONFIG_URL=https://github.com/OWNER/REPOSITORY
export RC_PROFILE=rc-linux-js
export RC_EXECUTOR=docker # bootstrap trusted CI; promote to firecracker after host provisioning
export RC_IMAGE_RELEASE=ghcr.io/OWNER/runner-center-ubuntu-24.04-js@sha256:<digest>
export RC_VCPUS=4
export RC_MEMORY_MIB=8192
export RC_WARM_POOL=2 # Firecracker only; 0 disables resident warm capacity
export RC_FIT_POLICY=balanced # balanced, cpu, network, or io
export RC_MIN_RUNNERS=0
export RC_MAX_RUNNERS=16

# Prefer a GitHub App. A PAT is supported for an initial repository-scoped canary.
export RC_GITHUB_APP_CLIENT_ID=<client-id>
export RC_GITHUB_APP_INSTALLATION_ID=<installation-id>
export RC_GITHUB_APP_PRIVATE_KEY_FILE=/etc/runner-center/github-app.pem

runner-center-controller
```

`RC_WARM_POOL` is an explicit Firecracker-only performance opt-in. Its target
counts both parked and currently claimed single-use microVMs, and each one
reserves a Worker slot, vCPUs, memory, a CNI address, and devmapper headroom.
Start small and validate it on the issue #17 KVM host using
[ADR 0003](docs/adr/0003-warm-microvm-capacity.md); Docker, Tart, and Hyper-V
Profiles must leave it at zero.

Use a process supervisor such as systemd with `Restart=always`, a private `EnvironmentFile`, and a
dedicated unprivileged service account. Controller releases are static Linux/macOS x64/ARM64
binaries with SHA-256 sidecars and provenance attestations. They can safely run on a small Oracle
VM; execution Workers cannot if the VM has no `/dev/kvm`.

The release includes `runner-center-controller@.service`. Install the binary and unit in root-owned
paths, create the unprivileged `runner-center-controller` account, and put one mode-`0600` file per
Profile at `/etc/runner-center/profiles/<profile>.env`; enabling
`runner-center-controller@rc-linux-js` then keeps that Profile's listener online independently of
any Worker.

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

The Worker runs a bounded benchmark at enrollment and daily while idle: SHA-256 CPU throughput,
memory copy throughput, write/read/fsync plus a 512-file package-link fan-out on
`~/.runner-center/benchmarks`, and unauthenticated
GitHub/GHCR/npm latency and throughput. It downloads at most 1 MiB per target, uses no job slot or
credentials, and reports raw observations plus measurement metadata. `rc benchmark` reruns and
publishes the same transparent measurements on demand. The dashboard shows raw results, normalized
scores, configured/resource/recommended/effective slots, and each assigned run's selection reason.
For automatic capacity, a fresh benchmark reduces the resource slot ceiling to
`max(1, floor(resource slots × (0.25 + 0.75 × weakest measured score / 100)))`; at seven days old it
is stale and no longer affects slot reduction or candidate ranking.

### Linux Worker prerequisites

For a trusted-only Docker Profile, Docker 28+ and enough local image storage are sufficient. The
Worker pulls the exact manifest digest before becoming schedulable; jobs then use `--pull=never`,
explicit CPU/memory/process limits, an unprivileged container user, and no host mounts or volumes.
This is the fastest path to add an existing Linux machine without privileged host reconfiguration.

For repositories that run fork PRs or other untrusted code, use Firecracker. It needs system-level
provisioning, and `deploy/provision-firecracker-host.sh` does all of it. The host must have Linux
x64 or ARM64 with hardware virtualization and `/dev/kvm`, containerd 1.7+, `nft`, `dmsetup`, and a
dedicated block device pair for the device-mapper thin-pool. The Worker Agent itself stays
unprivileged: Firecracker, CNI and devmapper are owned by a separate root service.

Download the matching `runner-center-runtime-linux-<arch>` release asset, verify its `.sha256`
sidecar, then:

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
`--egress-mode allowlist` with `--egress-allow CIDR,CIDR` denies every destination a Profile has not
declared; `--network-subnet` moves the guest range if it collides with the host's.

Log out and back in after the group change, then run `rc doctor`. The user-owned release binary is
only a socket client; the systemd service never executes files from `~/.runner-center`. Two operator
commands are worth knowing:

```bash
# after any host firewall change, and whenever readiness reports job-network-policy
sudo /usr/local/lib/runner-center/runner-center-runtime verify-network
# the full readiness report, one line per prerequisite
/usr/local/lib/runner-center/runner-center-runtime preflight
```

EraInfra does not silently create or wipe a dedicated thin-pool device: selecting that device
is an explicit operator storage decision, and the provisioner destroys only the devices you name.
The official Fireactions installation guide remains a compatible reference for the same components.

### macOS Worker prerequisites

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

### Windows Worker prerequisites

Windows cannot run the bash installer, so the same command comes from `/install.ps1` instead. The
dashboard's OS toggle renders it; run it on an x64 Windows Server host:

```powershell
& ([scriptblock]::Create((irm https://<site>/install.ps1))) -Role worker -Token rcreg_xxx
```

`-Role worker` is explicit because that URL also serves the Node installer and defaults to it. The
supply chain is the bash installer's, unchanged: the pinned `erainfra-agent-<version>.tar.gz`, its
published SHA-256, and this deployment's own pin as the trust root — an archive that matches the
release but not the pin is refused and nothing is installed. `npm ci` runs against the lockfile the
release shipped; nothing is compiled on the machine.

A fresh Windows Server has no Node.js, so the installer fetches the official Node 22 `win-x64`
build from nodejs.org and verifies it against nodejs.org's own `SHASUMS256.txt` before running it —
the same source and the same check the POSIX installer already uses when a host has no runtime.
Everything lands under `%USERPROFILE%\.runner-center`, which is the `RC_HOME` the Hyper-V
provisioner and `build-image.ps1` already default to. `-Update`, `-Version`, `-Sha256`, and rollback
through `agent.previous` work exactly as they do on POSIX, and `rc.ps1` under
`%USERPROFILE%\.runner-center\bin` is the `rc` equivalent.

Persistence is a Scheduled Task registered **for the installing account, at logon** — not a Windows
service, and the reason is a hard constraint rather than a preference. `build-image.ps1` stores the
guest credential with `Export-Clixml`, which is user-scope DPAPI, and `provision-win.ps1` reads it
back with `Import-Clixml`; DPAPI material written by one account cannot be decrypted by another. So
**the account that runs the agent must be the account that built the image**, which rules out
LocalSystem and rules out an S4U task token, neither of which can unlock that account's DPAPI master
key. The cost is that the Worker starts at logon: on a dedicated Worker box, enable automatic logon.
Moving to a boot-time service means first moving that credential to machine-scope DPAPI in both
provisioner scripts.

Hyper-V and its PowerShell module have to be enabled, and a parent VHDX has to exist under
`%RC_HOME%\images\<name>.vhdx` — `provisioners/build-image.ps1` produces one. **Windows catalog
labels remain preview-gated.** Onboarding is supported; execution is not yet validated, and the
control plane still refuses to advertise a Hyper-V Worker as ready, so a Windows Worker enrols and
reports in but is not scheduled onto.

## Target a Profile from GitHub Actions

No router job, machine name, or `.runner-center-migration-meta` file is required:

```yaml
jobs:
  test:
    runs-on: rc-linux-js
    steps:
      - uses: actions/checkout@<commit-sha>
      - uses: pnpm/action-setup@<commit-sha>
      - uses: actions/setup-node@<commit-sha>
        with:
          node-version: 22.23.2
          cache: false
      - run: pnpm install --frozen-lockfile
      - run: pnpm test
```

Node is already in the Image Release's toolcache, so `setup-node` validates/selects it without a
network download. Nothing writable survives a job, so a dependency cache has to come from outside
the guest: `actions/cache` is authenticated and scoped by repository, branch and key, and a remote
build cache such as Turborepo's works the same way. Both consume Actions storage and can be slower
than a warm immutable image, so prefer prewarming the Image Release for anything that changes
rarely. A Profile on allowlist-only egress needs its cache endpoint declared with `--egress-allow`.

## Legacy webhook delivery recovery

Minute reconciliation calls `retryStalledDeliveries` for deliveries that reached Convex but remained
pending, retrying them with a bounded attempt count before marking them failed. GitHub App
deployments also repair events that never reached Convex with a separate five-minute scan: it lists
recent failed App deliveries, deduplicates them by their stable delivery GUID, records bounded
retry/backoff state in `webhookRecovery`, and asks GitHub to redeliver only missing, still-useful
events. The dashboard exposes the latest scan and any recovered or abandoned delivery; deployments
using only a legacy PAT can retry received rows but cannot recover events that never arrived.

## Experiments

The **Experiments** page runs a shell command in the selected Linux Profile. An Experiment:

- copies the current immutable Profile contract at creation;
- waits in the same fair queue and reserves the same CPU/memory/slot capacity as CI;
- executes as the unprivileged `runner` user in a fresh Firecracker microVM;
- has a 1–21,600 second timeout and is cancellable;
- records Worker, timestamps, exit code, and failure reason;
- is reconciled after Worker loss and cannot keep a slot stuck indefinitely.

This is intentionally non-interactive. Interactive workspaces need a separate image and audited
control channel; weakening the CI image with SSH would make both products less safe. The current
Experiment image grants the `runner` user passwordless sudo, so Experiment authors are trusted with
root inside their disposable guest. The same image under the shared-kernel Docker executor is only
for mutually trusted jobs in one trust domain; use Firecracker for untrusted workloads.

## Security and operations

- Every CI Attempt gets a fresh VM and single-use JIT registration.
- The job network policy is rendered and verified by the same runtime build that enforces it; a
  Worker whose live nftables table drifts from its Profile stops being ready.
- No host path, socket, volume or device is shared with a job, and nothing writable outlives one.
- Image and product releases are immutable and checksum/provenance verified.
- The Linux guest obtains workload metadata through MMDSv2; it has no host SSH path.
- Worker cancellation terminates the complete executor process group and destroys VM state.
- A minute reconciliation repairs slots across legacy Jobs, scale-set Attempts, and Experiments,
  requeues only unclaimed work, and fails abandoned claimed work.
- Profile readiness expires operationally when a Worker heartbeat is older than two minutes.
- Secrets are never written into workflow files, process arguments, image layers, or logs.

Self-hosted runners execute repository code with the repository's job token and secrets. Keep
Profiles private to trusted repositories, pin Actions by commit SHA, and do not run untrusted fork
pull requests on machines that hold persistent credentials.

## Releases

EraInfra is one product version: root, Agent, Controller, and Runtime versions must match.
Tagging `v<version>` runs the release workflow, revalidates the JavaScript and Go surfaces
(including both Linux architectures), rebuilds the agent archive and the Infra Agent binaries
twice byte-for-byte, checks the deployment pin, attests the artifacts, and publishes:

- `erainfra-agent-<version>.tar.gz` plus SHA-256;
- Controller binaries and SHA-256 sidecars for Linux/macOS x64/ARM64;
- Runtime binaries and SHA-256 sidecars for Linux x64/ARM64, plus the runtime and controller
  systemd units;
- `infra-agent-<os>-<arch>` binaries and SHA-256 sidecars for Linux and macOS x64/ARM64 and
  Windows x64 — the five targets a Node can be.

A version containing a hyphen is published as a GitHub prerelease. Release assets are never
overwritten; a correction is a new version.

Both halves of `AGENT_RELEASE` are pinned on the release commit, before the tag: `sha256` from
the deterministic archive, and `infraAgent` from `pnpm --filter @erainfra/release build-go-assets`
followed by `pnpm --filter @erainfra/backend print-infra-agent-pin`, which reads the digests out
of the sidecars so nobody transcribes five of them by hand. The workflow refuses to publish a tag
whose pin disagrees with the bytes it just built, or whose Infra Agent pin covers only some of the
five targets.

## Repository layout

```text
apps/action-runner-agent  Worker daemon and Tart/legacy provisioners
apps/controller           official scale-set listener adapter
apps/runtime              Firecracker host runtime, job network policy, and guest bootstrap
apps/infra-agent          Node daemon: outbound WS to the Hub, App deploys, host operations
apps/hub                  Hub: Fastify + tRPC control plane for Nodes and Apps
apps/hub-web              the Hub's dashboard
apps/dashboard            React dashboard for the Convex control plane
apps/docs                 the documentation site
deploy                    host provisioner and systemd units
deploy/infra              Hub and Node installers (hub.sh, agent.sh, build-agents.sh, ...)
packages/backend          Convex control plane
packages/cli              the published `portless` CLI
packages/release          deterministic release packager
images                    immutable Profile image definitions
.github/conformance       the environment fingerprint, its diff, and the allowlist of intended
                          differences from `ubuntu-latest`
```

Contributions are welcome. Keep platform lifecycle logic behind the executor boundary, preserve
single-use secret handling, and run the JavaScript and Go gates before opening a pull request.
