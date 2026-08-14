# EraInfra

EraInfra is the infrastructure arm of the Era family, alongside
[EraDB](https://github.com/Fanzzzd/eradb) and EraOS. Today it is a small self-hosted GitHub
Actions platform for owned Linux and Apple Silicon machines; workflows target a stable Profile
such as `rc-linux-js` and never name a host. The [`portless/`](portless/) directory carries the
imported portless project — deploy-to-your-own-machines over an iroh mesh with no public IP —
which EraInfra absorbs so one product can both run CI and manage the machines it runs on
(integration tracked in the repository issues).

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
operator's explicit effective capacity.

## Support status

| Platform            | Executor                           | Status                                                                |
| ------------------- | ---------------------------------- | --------------------------------------------------------------------- |
| Linux x64/ARM64     | Docker                             | Bootstrap path for trusted repositories; digest-pinned and ephemeral. |
| Linux x64/ARM64     | Firecracker + containerd devmapper | Strong isolation path; requires KVM and dedicated runtime storage.    |
| Apple Silicon macOS | Tart                               | Supported execution path, capped at two guests by default.            |
| Windows             | Hyper-V                            | Preview only; not advertised ready by the Worker.                     |

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

`pnpm check` is the repository gate: lint, formatting, type checking, and tests. CI also runs the
production build and verifies that the npm lockfile used by installed Workers is current.

## Deploy the control plane

Deploy the Convex backend and static dashboard:

```bash
pnpm deploy
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
export RC_FIT_POLICY=balanced # balanced, cpu, network, or io
export RC_MIN_RUNNERS=0
export RC_MAX_RUNNERS=16

# Prefer a GitHub App. A PAT is supported for an initial repository-scoped canary.
export RC_GITHUB_APP_CLIENT_ID=<client-id>
export RC_GITHUB_APP_INSTALLATION_ID=<installation-id>
export RC_GITHUB_APP_PRIVATE_KEY_FILE=/etc/runner-center/github-app.pem

runner-center-controller
```

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

From **Machines → Add machine**, run the generated command on a Linux or macOS host. The installer:

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
matches Apple's macOS virtualization license constraint.

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

## Experiments

The **Experiments** page runs a shell command in the selected Linux Profile. An Experiment:

- copies the current immutable Profile contract at creation;
- waits in the same fair queue and reserves the same CPU/memory/slot capacity as CI;
- executes as the unprivileged `runner` user in a fresh Firecracker microVM;
- has a 1–21,600 second timeout and is cancellable;
- records Worker, timestamps, exit code, and failure reason;
- is reconciled after Worker loss and cannot keep a slot stuck indefinitely.

This is intentionally non-interactive. Interactive workspaces need a separate image and audited
control channel; weakening the CI image with SSH would make both products less safe.

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
Tagging `v<version>` runs the release workflow, revalidates the repository, rebuilds the agent archive
twice byte-for-byte, checks the deployment pin, attests the artifacts, and publishes:

- `erainfra-agent-<version>.tar.gz` plus SHA-256;
- Controller binaries and SHA-256 sidecars for Linux/macOS x64/ARM64;
- Runtime binaries and SHA-256 sidecars for Linux x64/ARM64, plus the runtime and controller
  systemd units.

A version containing a hyphen is published as a GitHub prerelease. Release assets are never
overwritten; a correction is a new version.

## Repository layout

```text
apps/agent       Worker daemon and Tart/legacy provisioners
apps/controller  official scale-set listener adapter
apps/runtime     Firecracker host runtime, job network policy, and guest bootstrap
deploy           host provisioner and systemd units
apps/dashboard   React dashboard
packages/backend Convex control plane
packages/release deterministic release packager
images           immutable Profile image definitions
```

Contributions are welcome. Keep platform lifecycle logic behind the executor boundary, preserve
single-use secret handling, and run `pnpm check`, `go test ./...`, and `go vet ./...` before opening
a pull request.
