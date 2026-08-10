# Runner Center

Runner Center is a small self-hosted GitHub Actions platform for owned Linux and Apple Silicon
machines. Workflows target a stable Profile such as `rc-linux-js`; they never name a host.

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
are in [ADR 0001](docs/adr/0001-use-scale-sets-with-platform-executors.md).

## Product contract

| Name          | Meaning                                                                                    |
| ------------- | ------------------------------------------------------------------------------------------ |
| Profile       | Stable workflow-facing contract: executor, immutable image, CPU, memory, and scale bounds. |
| Worker        | A registered physical host. Workers discover compatible Profiles automatically.            |
| Image Release | OCI/Tart image pinned by `sha256`; mutable tags are rejected.                              |
| Attempt       | One durable, isolated GitHub runner lifecycle. Retry creates a new Attempt.                |
| Experiment    | Operator-authored, time-bounded command using the same Profile and capacity as CI.         |

Scheduling first requires an exact ready Profile/Image Release match, then admits work within both
the Worker slot limit and a 90% CPU/memory envelope. Linux automatic capacity is conservatively
bounded at 16 slots, macOS at two Tart VMs, and Windows at one. A fixed `--slots` override remains
available for operators. Benchmark-based ranking is tracked in
[issue #6](https://github.com/Fanzzzd/runner-center/issues/6); missing scores never bypass hard
compatibility.

## Support status

| Platform            | Executor                           | Status                                                                |
| ------------------- | ---------------------------------- | --------------------------------------------------------------------- |
| Linux x64/ARM64     | Docker                             | Bootstrap path for trusted repositories; digest-pinned and ephemeral. |
| Linux x64/ARM64     | Firecracker + containerd devmapper | Strong isolation path; requires KVM and dedicated runtime storage.    |
| Apple Silicon macOS | Tart                               | Supported execution path, capped at two guests by default.            |
| Windows             | Hyper-V                            | Preview only; not advertised ready by the Worker.                     |

Both Linux executors use the new Profile and scale-set protocol. Docker deliberately has no host
bind mounts, privileged mode, or Docker socket, but it shares the host kernel and the Docker daemon
can inspect container state. Each Docker Profile also has one persistent named volume for pnpm's
content-addressable store. This is why Docker Profiles are restricted to mutually trusted jobs and
should map to one trust domain. Use Firecracker for untrusted code. The old `workflow_job` webhook
scheduler remains temporarily for migration; the dashboard labels its Jobs view and GitHub App
setup as legacy.

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

Useful commands:

```bash
rc status
rc doctor
rc logs -f
rc restart
rc update
```

### Linux Worker prerequisites

For a trusted-only Docker Profile, Docker 28+ and enough local image storage are sufficient. The
Worker pulls the exact manifest digest before becoming schedulable; jobs then use `--pull=never`,
explicit CPU/memory/process limits, an unprivileged container user, and no host mounts. This is the
fastest path to add an existing Linux machine without privileged host reconfiguration. Readiness
also creates and labels the Profile's pnpm cache volume; remove that volume to force a cold cache.

For repositories that run fork PRs or other untrusted code, use Firecracker. It needs system-level
provisioning. Before enrollment, provide:

- Linux x64 or ARM64 with hardware virtualization and `/dev/kvm` available to root;
- Firecracker;
- containerd 1.7+ with the `devmapper` snapshotter;
- a dedicated LVM thin-pool block device for devmapper (50 GiB minimum; do not reuse the root disk);
- CNI `bridge`, `firewall`, `host-local`, and `tc-redirect-tap` plugins;
- a kernel at `/var/lib/runner-center/kernels/vmlinux`;
- IP forwarding and a `runner-center` CNI network;
- enough non-root runtime storage for concurrent writable snapshots.

The Worker Agent stays unprivileged. Firecracker, CNI, and devmapper are owned by a separate root
service whose executable must live in a root-owned directory. After downloading the matching
`runner-center-runtime-linux-<arch>` release asset and verifying its `.sha256` sidecar:

```bash
case "$(uname -m)" in
  x86_64|amd64) runtime_arch=x86_64 ;;
  arm64|aarch64) runtime_arch=arm64 ;;
  *) exit 1 ;;
esac
sudo groupadd --force runner-center
sudo usermod --append --groups runner-center "$USER"
sudo install -D -o root -g root -m 0755 "runner-center-runtime-linux-$runtime_arch" \
  /usr/local/lib/runner-center/runner-center-runtime
sudo install -o root -g root -m 0644 deploy/systemd/runner-center-runtime.service \
  /etc/systemd/system/runner-center-runtime.service
sudo systemctl daemon-reload
sudo systemctl enable --now runner-center-runtime.service
```

Log out and back in after the group change, then run `rc doctor`. The user-owned release binary is
only a socket client; the systemd service never executes files from `~/.runner-center`.

`rc doctor` verifies the exact prerequisites the executor uses. Runner Center does not silently
create or wipe a thin-pool device: selecting that device is an explicit operator storage decision.
The official Fireactions installation guide is a compatible reference for Firecracker,
containerd-devmapper, CNI, kernel, and sysctl setup.

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
network download. Be deliberate with GitHub-hosted dependency caches: self-hosted compute does not
consume hosted Actions minutes, but `actions/cache` and artifacts still consume Actions storage and
can be slower than a warm local image. Prefer immutable image prewarming and Turborepo Remote Cache;
never share a writable dependency cache across untrusted repositories.

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

Runner Center is one product version: root, Agent, Controller, and Runtime versions must match.
Tagging `v<version>` runs the release workflow, revalidates the repository, rebuilds the agent archive
twice byte-for-byte, checks the deployment pin, attests the artifacts, and publishes:

- `runner-center-agent-<version>.tar.gz` plus SHA-256;
- Controller binaries and SHA-256 sidecars for Linux/macOS x64/ARM64;
- Runtime binaries and SHA-256 sidecars for Linux x64/ARM64, plus the runtime and controller
  systemd units.

A version containing a hyphen is published as a GitHub prerelease. Release assets are never
overwritten; a correction is a new version.

## Repository layout

```text
apps/agent       Worker daemon and Tart/legacy provisioners
apps/controller  official scale-set listener adapter
apps/runtime     Firecracker host runtime and guest bootstrap
apps/dashboard   React dashboard
packages/backend Convex control plane
packages/release deterministic release packager
images           immutable Profile image definitions
```

Contributions are welcome. Keep platform lifecycle logic behind the executor boundary, preserve
single-use secret handling, and run `pnpm check`, `go test ./...`, and `go vet ./...` before opening
a pull request.
