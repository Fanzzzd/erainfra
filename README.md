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
  whose live nftables table drifts from the policy its runtime rendered stops being ready, and a
  daily canary exercises scheduling through the executor's in-job isolation probes. The fleet has
  run its Linux Profiles in Firecracker microVMs since 2026-08-20, when the live boot and teardown
  validation in issue #17 closed.
- **Immutable by construction.** Images are pinned by digest, the agent release is pinned by
  checksum, and nothing writable survives a job on the Worker. Warm state on the Worker comes
  from prewarmed images; dependency caches live off the Worker, in GitHub's cache or in
  [EraInfra's job cache](#the-job-cache).
- **Drop-in adoption.** `runs-on: <profile>` is the entire workflow change. An optional router
  job sends a run to GitHub-hosted runners instead when the Profile has no ready Worker or no
  free slot ([below](#fall-back-to-github-hosted-runners)).

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

| Platform            | Executor                           | Status                                                                  |
| ------------------- | ---------------------------------- | ----------------------------------------------------------------------- |
| Linux x64/ARM64     | Docker                             | Bootstrap path for trusted repositories; digest-pinned and ephemeral.   |
| Linux x64/ARM64     | Firecracker + containerd devmapper | Strong isolation path; requires KVM and dedicated runtime storage.      |
| Apple Silicon macOS | Tart                               | Supported execution path, capped at two guests by default.              |
| Windows x64         | Hyper-V                            | One-command onboarding; advertised ready once readiness proves Hyper-V. |

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
  is dropped. The guest's link carries only IPv4 from the guest's own address: IPv6 and borrowed
  source addresses are dropped as they arrive, even from root writing raw frames, and the host side
  of the link has IPv6 turned off in the kernel as well. A Worker whose nftables table no longer
  matches, or whose guest link has IPv6 back on, stops being ready. If the table is reloaded under
  a running guest, which empties the guest's sets, the runtime writes them back within 10 seconds
  and readiness fails if it cannot; drain the Worker before reloading (see
  [Restrict job egress](docs/runbooks/restrict-job-egress.md));
- the egress its Profile publishes, enforced on the host, never inside the guest (see
  [Egress policy](#egress-policy));
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

Nothing writable survives a job on either Linux executor, so the only warm state on a Worker is
the immutable Image Release. Dependency caches are kept off the Worker, in GitHub's cache or in
EraInfra's job cache.

### The job cache

A Firecracker Profile can have its GitHub Actions cache served by EraInfra's own cache service,
`apps/cache-service`, which stores entries in an S3-compatible bucket the operator picks
([ADR 0007](docs/adr/0007-serve-the-actions-cache-protocol-from-an-s3-compatible-store.md),
[ADR 0009](docs/adr/0009-a-store-is-plugged-in-not-wired-in.md)). Workflows do not change. When a
Worker's runtime is configured with a cache, the guest pins GitHub's cache host,
`results-receiver.actions.githubusercontent.com`, in its `/etc/hosts` to an interceptor inside the
guest. The interceptor terminates TLS with a CA minted for that boot, sends cache calls to the cache
service, and forwards artifact calls and everything else to GitHub
([ADR 0008](docs/adr/0008-win-the-cache-endpoint-below-the-environment.md),
[ADR 0012](docs/adr/0012-pin-the-cache-host-by-name-and-reach-containers-by-verified-trust.md)).
The caches of `actions/cache`, `setup-node` and `setup-go` all take this path.

- **Scope.** Entries are stored per repository and ref. The guest's token names only the runner.
  At `JobStarted` the controller reads the job's workflow run from GitHub, works out which refs the
  job may read and the one it may write, and pushes those facts to the cache service, which applies
  them to every request. The rules follow GitHub's own cache restrictions: a branch or tag job reads
  its own ref, then the default branch; a pull request reads `refs/pull/<n>/merge`, then its base
  branch, then the default branch, and writes only to its merge ref; a pull request from a fork
  writes nothing; a sibling branch is never readable. A lookup that fails or takes over 3 s gives
  the job a cold cache, never a wider one. The exact table is in
  [the runbook](docs/runbooks/operate-the-job-cache.md#one-key-three-holders).
- **Failure.** A cache service or store that cannot answer in time turns into a cache miss or a
  request forwarded to GitHub. A guest whose redirect does not come up talks to GitHub directly. A
  cache failure makes the cache step warn; it does not fail the job.
- **Passthrough.** The cache host also serves Artifacts v4 (`upload-artifact` and
  `download-artifact` v4+). The interceptor serves only the cache path. Every other request,
  artifacts included, goes to GitHub with its method, path, query, headers and body unchanged, and
  GitHub's reply comes back the same way.
- **Coverage.** Every process on the guest is redirected, as any user. Docker containers have their
  own hosts file and an image does not trust the guest's CA, so a container is redirected only when
  it opts in. A buildx builder for `type=gha` adds one `driver-opts` line, and a `container:` job
  mounts the CA. Both are in
  [the runbook](docs/runbooks/operate-the-job-cache.md#docker-builds-and-container-jobs).
  Containers that do not opt in, service containers among them, use GitHub's cache. Docker, Tart
  and Hyper-V Profiles have no interceptor and use GitHub's cache too.
- **Trust.** Every client the redirect reaches must trust the guest's CA, or its cache and artifact
  calls fail TLS. While the redirect is installed, the guest covers these clients with no workflow
  change, as the runner user and through `sudo`: OpenSSL, Go, .NET and curl through the system store
  `update-ca-certificates` rebuilds; Node through `NODE_EXTRA_CA_CERTS`; Python `requests` and `pip`
  through `REQUESTS_CA_BUNDLE`; and `httpx` and conda's OpenSSL through `SSL_CERT_FILE`. The last two
  point at the rebuilt system bundle. The JVM is not covered, because it reads its own truststore and
  has no variable for a PEM file. Neither is a binary with a compiled-in root list, such as a Rust
  tool built with `webpki-roots`. A job whose JVM calls the cache host itself (a Gradle build cache
  plugin backed by the Actions cache, for example) adds one step after `setup-java`, and that step
  does nothing where no cache is configured:

  ```bash
  f=/usr/local/share/ca-certificates/erainfra-cache.crt; [ -f "$f" ] && keytool -importcert -noprompt -cacerts -storepass changeit -alias erainfra-cache -file "$f"
  ```

  Any job can instead send its own cache and artifact traffic straight to GitHub for the rest of
  the job: `sudo sed -i '/# erainfra-cache-interceptor$/d' /etc/hosts`.

- **Build-system caches.** The same service backs Turborepo's remote cache and Go's build cache
  ([ADR 0018](docs/adr/0018-serve-build-system-caches-through-a-guest-proxy.md)). The guest runs a
  proxy on `127.0.0.1:7457` that presents the runner's bearer, and hands the runner `TURBO_API`,
  `TURBO_TEAM` and a placeholder `TURBO_TOKEN`, so `turbo run` caches remotely with no workflow
  change. Go opts in with one line, `GOCACHEPROG: erainfra-gocacheprog`, which the image ships.
  Turborepo artifacts and Go outputs are ordinary entries: the same scope rules, quota, eviction
  and admin commands apply, and a fork pull request reads them without writing. A workflow that
  sets its own `TURBO_API` keeps its own remote cache. turbo ranks the guest's `TURBO_API` above
  `remoteCache.apiUrl` in `turbo.json`, so a repository that names its cache only there, or that
  sets only `TURBO_TOKEN` for Vercel, must also set `TURBO_API` in the workflow
  (`https://vercel.com/api` for Vercel). Until it does, the proxy forwards that token nowhere,
  turbo prints one `check TURBO_TOKEN` warning and builds uncached. The proxy answers only
  requests addressed to `127.0.0.1:7457` that carry no browser `Origin`. If the cache service is
  down, turbo prints one warning and the Go helper one line, and both build uncached.
  `container:` jobs and `docker build` do not reach the proxy. Details are in
  [the runbook](docs/runbooks/operate-the-job-cache.md#10-build-system-caches-turborepo-and-go).
- **Registry mirror.** Workers can also give guests a Docker Hub pull-through mirror
  ([runbook](docs/runbooks/operate-the-registry-mirror.md)). dockerd and buildx builders use it
  with no workflow change, and fall back to Docker Hub when it is down.
- **Git checkout mirror.** With `RC_GIT_MIRROR=on`, a job's `actions/checkout` of its own
  repository fetches from GitHub only the objects missing from the repository's seed, a git bundle
  an earlier job saved in the cache service under the cache's own scope rules. The guest's git
  reaches `https://github.com/` through a proxy in the guest, which checks the job's credential with
  GitHub before every fetch it answers and forwards everything else unchanged. On this repository a
  depth-1 checkout drops from 2.4 MB to 34 KB with a seed one commit old. A checkout still contacts
  GitHub every time, so it does not avoid ubuntu0's SYN stalls (#149). Any failure sends the fetch
  to GitHub. Details, measurements and limits are in
  [the runbook](docs/runbooks/operate-the-job-cache.md#11-git-checkout-mirror).
- **Activation.** The cache is off until an operator deploys the service and its bucket and turns
  the interception on, following
  [docs/runbooks/operate-the-job-cache.md](docs/runbooks/operate-the-job-cache.md). Until every
  step there is done, jobs use GitHub's cache exactly as before.

Blacksmith's cache paths, and what serves each one here on a Firecracker Profile with the cache on:

| Blacksmith                                               | EraInfra                                                                                                                                           | workflow change               |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| Actions cache (`actions/cache`, `setup-*` caching)       | cache service through the in-guest interceptor                                                                                                     | none                          |
| Docker layer cache (`setup-docker-builder`)              | BuildKit `type=gha` against the same service                                                                                                       | one buildx `driver-opts` line |
| Container image caching                                  | Docker Hub pull-through registry mirror                                                                                                            | none                          |
| Turborepo build cache                                    | Turborepo Remote Cache API through the guest's build proxy                                                                                         | none                          |
| Go build cache (`GOCACHEPROG`)                           | `erainfra-gocacheprog`, local disk first, then the service                                                                                         | one `env` line                |
| Bazel and Buck2 remote cache                             | not served                                                                                                                                         | —                             |
| Git checkout cache (`useblacksmith/checkout`, git proxy) | git checkout mirror with `RC_GIT_MIRROR=on`: the job's own repository over HTTPS, seeded from the service                                          | none                          |
| Sticky disks (`useblacksmith/stickydisk`)                | not served: a writable disk that outlives the job breaks the per-Attempt boundary ([ADR 0002](docs/adr/0002-verify-the-job-isolation-boundary.md)) | —                             |

### Egress policy

Egress is part of the Profile, like its executor and size. The controller publishes it from
`ERAINFRA_EGRESS_MODE`, `ERAINFRA_EGRESS_PRESETS` and `ERAINFRA_EGRESS_ALLOW` in its environment
(the `RC_` names still work; see [Environment variable names](#environment-variable-names)), and every Worker
renders and verifies it for that Profile's guests. Three modes exist:

| Mode        | What a guest can reach                                     | What is recorded per Attempt                      |
| ----------- | ---------------------------------------------------------- | ------------------------------------------------- |
| `public`    | the internet; host, private ranges and other guests denied | nothing                                           |
| `audit`     | the same as `public`                                       | every DNS name queried and every new IP:port flow |
| `allowlist` | only the listed domains and CIDRs                          | the same, with each refused name and flow marked  |

A Profile without the setting is `public`, which is what every Profile was before.
`ERAINFRA_EGRESS_ALLOW` takes domains (`registry.npmjs.org`, `*.example.com`) and IPv4 CIDRs or
addresses. `ERAINFRA_EGRESS_PRESETS=github` expands to the domains GitHub lists for
[self-hosted runner communication](https://docs.github.com/en/actions/reference/runners/self-hosted-runners#communication-requirements),
plus `*.githubusercontent.com`. The Worker's cache service and Docker Hub registry mirror, when it has them, are always allowed.

Enforcement happens on the host. Each audit or allowlist guest's DNS, to whatever server it names,
is redirected to a resolver in the runtime daemon. For an allowlist guest the resolver answers only
allowed names, and before it replies it adds the answer's addresses to that guest's nftables set
with a timeout of the record's TTL. The kernel then forwards new TCP and UDP flows only to set
members and the Profile's CIDRs; a direct connection to any other address is dropped and recorded.
Because the set follows DNS, an allowed name that moves to a new address keeps working, and a CNAME
chain behind an allowed name is followed. The record comes from the resolver and from a kernel set
the forward chain fills, so nothing in it depends on the guest.

The host operator's `RC_EGRESS_MODE` and `RC_EGRESS_ALLOW` in `runtime.env` (or their `ERAINFRA_`
names) still apply, and the
stricter layer wins: the effective mode is the stricter of the two, a host allowlist keeps denying
everything it does not list, and a Profile cannot open a private or host range unless the operator
lists it too. A Worker that cannot run the resolver or write the per-guest sets fails its
`egress-policy` check and is not ready for audit or allowlist Profiles; its public Profiles keep
running. The [egress runbook](docs/runbooks/restrict-job-egress.md) walks through moving a Profile
from audit to allowlist, and [ADR 0015](docs/adr/0015-egress-is-a-property-of-the-profile.md)
records the design.

## Develop locally

Requirements: Node.js 22+, pnpm 11, Go 1.27.3+, and a Convex account or local deployment.

```bash
pnpm install
pnpm dev
```

Validation:

```bash
pnpm check
go test ./...
go vet ./...
GOOS=linux golangci-lint run ./...
go install golang.org/x/vuln/cmd/govulncheck@v1.9.0
GOOS=linux govulncheck ./...
```

`pnpm check` is the JavaScript gate for the whole workspace: lint, formatting, type checking, and
tests. The golangci-lint line needs golangci-lint v2.15.0, the version CI pins. It reads
`.golangci.yml`, which adds `noctx` and `nolintlint` to the default linters. `GOOS=linux` lints the
code that ships; the module also lints clean with `GOOS=darwin`. A `//nolint` must name its linter
and give a reason: `//nolint:errcheck // read-only body; a close error loses nothing`.

govulncheck fails when shipped code calls a function with a known vulnerability, in a dependency or
in the Go standard library of the `go` on your PATH. An advisory in a package the code imports but
never calls is listed without failing. CI runs it for every OS a release ships Go binaries for:
`GOOS=linux` and `GOOS=darwin` over `./...`, and `GOOS=windows` over the Infra Agent and the CLI,
the only Windows binaries. The release workflow scans every published binary again with
`govulncheck -mode binary`. Most findings are fixed by moving Go to its newest patch
(`go run ./scripts/pinbump -only go`, or `-go-line 1.N` for a new minor) or by `go get` of the
fixed module version the report names.

CI also runs the production build, lints, tests and vets the Go module, compiles both shipped Linux
architectures, runs govulncheck, refuses any rename of an identifier a customer's machine already
holds, and verifies that the npm lockfile used by installed Workers is current.

`apps/mesh` is a Rust crate with its own gate. rustup installs the compiler that
`apps/mesh/rust-toolchain.toml` pins:

```bash
cd apps/mesh
cargo fmt --check
cargo clippy --locked --all-targets -- -D warnings
cargo test --locked
cargo deny --locked check   # cargo-deny 0.20.2; policy in apps/mesh/deny.toml
```

CI runs the same four and cross-compiles both Linux release targets with cargo-zigbuild.

## Deploy the control plane

Deploy the Convex backend and static dashboard:

```bash
pnpm run deploy:control-plane
```

Set these deployment variables before production use:

| Variable                | Purpose                                                                                                                                           |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SITE_URL`              | Canonical HTTPS dashboard origin.                                                                                                                 |
| `BOOTSTRAP_SECRET`      | One-time first-admin bootstrap.                                                                                                                   |
| `CONTROLLER_TOKEN`      | Long random bearer token shared only with scale-set controllers.                                                                                  |
| `CONTROLLER_TOKEN_NEXT` | Optional second controller token, accepted beside `CONTROLLER_TOKEN` during a rotation ([runbook](docs/runbooks/operate-the-controller-host.md)). |
| `ALLOWED_REPOS`         | Legacy webhook allowlist; omit when that path is unused.                                                                                          |

The dashboard creates short-lived, single-use Worker enrollment commands. Machine credentials are
stored in `~/.runner-center/agent/.env` with mode `600`; JIT configurations travel from Convex to the
Worker once and enter its runtime client through stdin, then cross a mode-`0660` Unix socket in an
HTTP request body. They never appear in argv or a host environment variable.

## Publish an Image Release

`images/ubuntu-24.04-js` is the first minimal Linux Profile. It contains:

- Ubuntu 24.04 and systemd;
- actions/runner 2.338.2, checksum verified;
- Node.js 22.23.2 (the default `node`) and 24.22.1, and Go 1.27.3, in the hosted-toolcache layout,
  each checksum verified, so `setup-node` and `setup-go` resolve them without a download;
- GitHub CLI 2.97.0, checksum verified;
- an official runner action-archive cache seeded with the exact checkout, pnpm, setup-node, and
  setup-go commits used by the workflows;
- pnpm 11.21.0, Git, Docker with the Compose v2 and Buildx plugins, build tools, `libatomic1`, and common archive tools including `zstd`,
  which `actions/cache` shells out to and falls back to gzip without;
- the OpenSSH **client**, `python3`, `pip3`, and `rsync`;
- `LANG=C.UTF-8`, a generated `en_US.UTF-8`, and a `tzdata` database set to `Etc/UTC`, so a named
  zone resolves instead of silently falling back to UTC;
- the small MMDSv2 guest bootstrap;
- a locked root password and no SSH server.

Run the **EraInfra runner images** workflow. It builds both Linux architectures, publishes to GHCR,
emits SBOM/provenance attestations, and reports the immutable manifest digest. Use that full
`ghcr.io/...@sha256:...` reference in the controller. The workflow deliberately does not upload a
BuildKit cache to GitHub Actions storage. It also runs every Monday on `main` without a source
change, so the Ubuntu packages `apt-get` installs pick up the archive's security updates; that
build is tagged `weekly-<YYYYMMDD>` and `edge`. A rebuild publishes a new digest and changes
nothing a Profile runs: a Profile moves only when you repin it.

This Profile promises its explicit smoke-tested tools, not complete GitHub-hosted image parity.
See [the image research](docs/research/blacksmith-runner-images.md) for why GitHub's minimal runner
container and hosted `ubuntu-24.04` VM are different products.

Exactly _how_ it differs is measured rather than described. The **environment conformance** workflow
runs one fingerprint script on `ubuntu-latest` and on every Profile declared in
[`.github/conformance/profiles.txt`](.github/conformance/profiles.txt), then diffs the two and
fails on any difference that is not on [an explicit, commented
allowlist](.github/conformance/allowlist.txt). The allowlist is the written record of every way
this environment is deliberately not GitHub's, and everything not on it is a bug — a job that reads
a different CPU count from the one it may use, a tool present there and missing here, a scratch
directory mounted `noexec`. It runs daily and on every change to the provisioners, the images or
the readiness code, because those are the three inputs that can move it.

A Profile is declarable only once a Worker serves it on _this_ repository. Scale sets are registered
per repository, so a leg for a Profile nobody serves here does not fail — it queues until the
timeout, and a timeout reads exactly like a runner that died. `rc-linux-js` is deliberately not
declared today for that reason, and is therefore not among what the job proves.

### How pins move

The image and the provisioners pin their toolchain by hand, each as a version plus a SHA-256:
actions/runner (the image, `provision-mac.sh`, `build-image.ps1`, and the Docker executor's
`ghcr.io/actions/actions-runner` image, which is pinned by digest), Node.js, Go, the GitHub CLI,
and the four Actions the image pre-downloads. No package manager owns these, so the
**Toolchain pin bump** workflow moves them. Every Monday it runs `scripts/pinbump`, which checks
each pin against upstream and opens one pull request, on branch `automation/pin-bump`, that moves
every pin with a newer release. Each checksum comes from upstream's own checksum source:

| Pin            | Moves to                                         | Checksum source                                                                                                           |
| -------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| actions/runner | the latest release                               | the release asset digest, which must match the SHA-256 table in the release body                                          |
| Node.js        | the newest LTS patch of the major already pinned | `SHASUMS256.txt`, its signature checked with `gpgv` against [nodejs/release-keys](https://github.com/nodejs/release-keys) |
| Go             | the newest patch of the minor in `go.mod`        | the `sha256` in `go.dev/dl/?mode=json`                                                                                    |
| GitHub CLI     | the latest release                               | `checksums.txt`, which must match the release asset digests                                                               |
| Seeded Actions | the newest release of the major already pinned   | none is published; the source archive is hashed once and the image build refuses any other bytes                          |

A major or minor version move (Node.js 26, Go 1.27, `actions/checkout` v8) is never made
automatically; the pull request lists it as a note. Run the same check by hand with
`go run ./scripts/pinbump` (it needs `gpgv`), or limit it with `-only runner`.

The runner pin has a deadline. GitHub's
[self-hosted runner reference](https://docs.github.com/en/actions/reference/runners/self-hosted-runners)
says a runner with automatic updates disabled must be updated within 30 days of a new release, and
"If you do not perform a software update within 30 days, the GitHub Actions service will not
queue jobs to your runner." The controller registers every scale set with automatic updates
disabled (`DisableUpdate` in `apps/controller/internal/githubscale`), because a Runner that
updated itself inside a one-job VM would download the update on every job and then throw it away.
So, within 30 days of an actions/runner release, merge the bump pull request, publish the image
and repin each Firecracker Profile to the new digest, deploy the control plane (the Docker
executor's image is in its catalog), and cut an EraInfra release so Workers receive the new
provisioners.

Dependabot covers everything else weekly, grouped into one pull request per ecosystem and held
for 7 days after a release before it is proposed: Actions used by the workflows, Go modules, the
pnpm workspace, and the Action Runner Agent's own npm lockfile. It skips the four seeded Actions,
which only `scripts/pinbump` can move together with the image.

The bump needs a `PIN_BUMP_TOKEN` repository secret to work fully. Without it the workflow uses
`GITHUB_TOKEN`, and two things change. GitHub does not start workflows for a pull request that
token opens, so CI runs only after a maintainer closes and reopens the pull request; the pull
request body says so. And that token cannot change files under `.github/workflows`, so the seeded
Actions are left alone. To create the secret, make a fine-grained personal access token
(**Settings → Developer settings → Fine-grained tokens**) with this repository as its only
repository and these permissions: Contents read and write, Pull requests read and write, Workflows
read and write. Save it under **Settings → Secrets and variables → Actions** as `PIN_BUMP_TOKEN`,
and replace it before it expires. A GitHub App with the same three permissions also works, but the
workflow would then need a step that mints its installation token.

GitHub pauses scheduled workflows in a public repository after 60 days without activity. If the
Monday pull request stops arriving, re-enable **Toolchain pin bump** under the Actions tab.

## Run a Profile controller

Controllers run on Workers or a dedicated host and need no KVM. For each Profile, Convex leases
job intake to one process; the others stand by. The holder renews every 10 seconds, with a
30-second expiry. Every controller write carries its epoch, and HTTP 412 stops a stale holder's
listener immediately. Dedicated hosts using `CONTROLLER_TOKEN` or `CONTROLLER_TOKEN_NEXT` must
hold the lease too. A fresh network score below 40 delays a Worker candidate by 15 seconds after
the lease frees, giving better-connected Workers the first chance
([ADR 0014](docs/adr/0014-controllers-run-on-the-workers-under-a-lease.md)).

A Worker standby uses its existing machine credential. It reads the Profile's contract from Convex
and gets a short-lived GitHub App installation token from Convex only while holding the lease.
It receives no App key or shared controller token. The job cache is the one setting it cannot read
from Convex, because the signing key stays off the control plane: if the Profile publishes cache
facts, give the standby `--cache-facts-url` and `--cache-signing-key-file` too. Convex refuses the
lease to a standby without them, and its heartbeat shows `incapable`. Install it beside an already
enrolled Worker:

```bash
curl -fsSL https://<deployment>.convex.site/install | sudo bash -s -- --role controller \
  --profile erainfra-4vcpu-ubuntu-2404 --no-prompt
```

The installer reads `<SUDO_USER home>/.runner-center/agent/.env`, or an explicit
`--worker-env-file /absolute/path/.env`, and copies only the machine token into a protected file.
Image, resource and GitHub settings do not belong in a standby's env file. Register the Profile
once from the upgraded dedicated controller before adding standbys. Configure
`CONTROLLER_GITHUB_APP_CLIENT_ID` and `CONTROLLER_GITHUB_APP_PRIVATE_KEY` in Convex, using the
controller App described below. A Profile without its GitHub URL registered remains in standby.
The [controller runbook](docs/runbooks/operate-the-controller-host.md) covers the VM-to-ubuntu0
migration, token setup, takeover checks and rollback. A backend with lease enforcement refuses
old controller binaries; stage the binary upgrade and backend deployment together.

A dedicated host keeps the existing local App or PAT path. `--controller-token-file` selects that
mode, even on a Worker host:

```bash
curl -fsSL https://<deployment>.convex.site/install | sudo bash -s -- --role controller \
  --profile erainfra-4vcpu-ubuntu-2404 \
  --github-config-url https://github.com/OWNER/REPOSITORY \
  --executor firecracker \
  --image-release ghcr.io/OWNER/runner-center-ubuntu-24.04-js@sha256:<digest> \
  --vcpus 4 --memory-mib 16384 --max-runners 16 \
  --controller-token-file "$PWD/controller-token" \
  --github-app-client-id <client-id> --github-app-installation-id <installation-id> \
  --github-app-private-key-file "$PWD/github-app.pem"
```

The installer downloads the controller binary that `AGENT_RELEASE` pins and refuses bytes whose
SHA-256 differs, the same trust root as the other roles
([ADR 0006](docs/adr/0006-one-onboarding-path-with-a-pinned-trust-root.md)). It installs the binary
and `runner-center-controller@.service`, creates the unprivileged `runner-center-controller`
account, copies the secret files to `/etc/runner-center/secrets/<profile>/`, writes
`/etc/runner-center/profiles/<profile>.env` (mode 0600, secrets only as `*_FILE` paths), and starts
`runner-center-controller@<profile>`. It leaves a Worker install on the same host alone.
`--role controller --update` moves every running controller on the host to the pinned release and
keeps the previous binary as `runner-center-controller.bak-<version>`. The controller pin is first
filled at the release after v0.2.0-rc.10; until a deployment pins it, the installer refuses and the
manual steps below apply. Updating, adding and retiring Profiles, rotating secrets, monitoring, back
up and rebuild are in
[Runbook: operate the controller host](docs/runbooks/operate-the-controller-host.md).

The installer's flags map one to one to the environment the controller reads. To run it by hand:

```bash
export ERAINFRA_CONVEX_URL=https://<deployment>.convex.site
export ERAINFRA_CONTROLLER_TOKEN_FILE=/etc/runner-center/controller-token
export ERAINFRA_GITHUB_CONFIG_URL=https://github.com/OWNER/REPOSITORY
export ERAINFRA_PROFILE=erainfra-4vcpu-ubuntu-2404
export ERAINFRA_EXECUTOR=docker # bootstrap trusted CI; promote to firecracker after host provisioning
export ERAINFRA_IMAGE_RELEASE=ghcr.io/OWNER/runner-center-ubuntu-24.04-js@sha256:<digest>
export ERAINFRA_VCPUS=4
export ERAINFRA_MEMORY_MIB=16384 # 4 vCPU and 16 GiB is GitHub's standard Linux runner; a Profile sized to it inherits the same RAM-derived kernel limits
export ERAINFRA_WARM_POOL=2 # Firecracker only; 0 disables resident warm capacity
export ERAINFRA_FIT_POLICY=balanced # balanced, cpu, network, or io
export ERAINFRA_MIN_RUNNERS=0
export ERAINFRA_MAX_RUNNERS=16

# Prefer a GitHub App. An enterprise URL needs ERAINFRA_GITHUB_TOKEN instead (see the permissions below).
export ERAINFRA_GITHUB_APP_CLIENT_ID=<client-id>
export ERAINFRA_GITHUB_APP_INSTALLATION_ID=<installation-id>
export ERAINFRA_GITHUB_APP_PRIVATE_KEY_FILE=/etc/runner-center/github-app.pem

runner-center-controller
```

Each of these is also read under its `RC_` name, which is what the installer writes into
`/etc/runner-center/profiles/<profile>.env` and what every running controller holds; see
[Environment variable names](#environment-variable-names).

Name a new Profile `erainfra-<N>vcpu-<os><version>[-arm]`, for example `erainfra-4vcpu-ubuntu-2404`
([ADR 0010](docs/adr/0010-name-profiles-the-way-runner-vendors-name-labels.md)). The controller
refuses a name GitHub would misread — uppercase, longer than 45 characters, or a GitHub-hosted label
such as `ubuntu-latest` — and warns about a legal name outside the scheme. `rc-linux-js` and `rc-e2e`
predate it and keep working; a Profile is renamed by registering the new name beside the old one,
never in place, because GitHub holds the scale-set name.

### Pin a Profile to some Workers

To send jobs only to the Workers with a GPU, an NVMe pool or a particular site, put a host label on
those Workers and register a Profile pinned to it
([ADR 0017](docs/adr/0017-pin-a-profile-to-workers-by-host-label.md)):

```bash
# On each such Worker: at install, or later with an admin token.
curl -fsSL https://<deployment>.convex.site/install | bash -s -- --token <registration-token> --labels gpu
erainfra workers set-labels hk-worker01 gpu nvme

# A controller for the pinned Profile: the same flags as any dedicated controller, plus the pin.
curl -fsSL https://<deployment>.convex.site/install | sudo bash -s -- --role controller \
  --profile erainfra-4vcpu-ubuntu-2404-gpu --worker-labels gpu ...
```

```yaml
runs-on: erainfra-4vcpu-ubuntu-2404-gpu
```

Only a Worker carrying every label in `ERAINFRA_WORKER_LABELS` (or `RC_WORKER_LABELS`; the
installer's `--worker-labels`) sees the Profile, prepares its image, reports readiness for it and
is scheduled onto for it. The `/runs-on` router, the Profile list, `/metrics` and the alerts count
the same Workers. Removing a label stops new jobs of the pinned Profile from going to that Worker;
running ones finish. `erainfra profiles list` shows the pin under `PINNED TO` and `erainfra workers
list` shows each Worker's `LABELS`. A Worker names its labels once, at registration. After that only
an admin token changes them, because a label decides which jobs a machine may run. Labels are
lowercase letters, digits, `.`, `_` and `-`, up to 16 of them.

actuated's form, `runs-on: [actuated-2cpu-8gb, r2]`, has no equivalent here. GitHub hands a job to
any idle Runner of the scale set it matched, and a Runner is created before the job it will run is
known, so a label cannot choose a Worker inside one Profile. A second scale set that also answers
to `erainfra-4vcpu-ubuntu-2404` would take plain jobs as well, so the control plane refuses a
Profile whose `ERAINFRA_LABELS` include another Profile's name. The pinned Profile also does not
keep an unpinned one off the labelled Workers: they share their slots. To reserve the Workers, pin
the other Profile to a label only the other Workers carry.

A dedicated controller publishes its env contract when it first acquires the lease after startup.
Worker standbys never overwrite it. Existing deployments can keep the dedicated host while adding
standbys, then stop its units once Worker takeover is verified. Enterprise runner registrations
still require a dedicated host with `ERAINFRA_GITHUB_TOKEN` (or `RC_GITHUB_TOKEN`), because GitHub Apps cannot register
enterprise runners.

Stopping a controller does not remove its scale set. GitHub keeps routing `runs-on: <profile>` jobs
to it, and with no listener they wait until GitHub cancels them after 24 hours. Stop its units on
all controller hosts, including Worker standbys, then retire from the dedicated host's saved env:

```bash
sudo systemctl disable --now runner-center-controller@rc-linux-js
sudo sh -c 'set -a; . /etc/runner-center/profiles/rc-linux-js.env; \
  exec /usr/local/lib/runner-center/runner-center-controller retire'        # report only
sudo sh -c 'set -a; . /etc/runner-center/profiles/rc-linux-js.env; \
  exec /usr/local/lib/runner-center/runner-center-controller retire --yes'  # delete and pause
```

`retire --yes` acquires the lease, checks GitHub's activity statistics, pauses the Profile and
deletes the scale set while renewing its lease. Pausing first prevents a standby from recreating
the scale set. It refuses while another controller holds the lease, when GitHub supplies no
activity statistics, or while GitHub counts busy runners or assigned/running jobs. A dry run reports
missing statistics as unknown. `--force` overrides the statistics and busy checks, never the lease.
Starting a dedicated unit intentionally reactivates the Profile; starting a Worker standby does not.

Only the lease holder opens a GitHub message session. GitHub independently refuses a second session
with `409 Conflict`. A new holder whose predecessor died without closing its session retries with
10-to-60-second backoff. GitHub can retain an abandoned session for minutes, so lease expiry does
not promise listening resumes within 30 seconds.

Every controller reports a heartbeat to the control plane every 30 seconds and whenever its
session changes. The Profiles table shows it, and `/metrics` and the alerts read it; see
[Monitor the fleet](#monitor-the-fleet).

`ERAINFRA_WARM_POOL` (or `RC_WARM_POOL`) is an explicit Firecracker-only performance opt-in. Its target
counts both parked and currently claimed single-use microVMs, and each one
reserves a Worker slot, vCPUs, memory, a CNI address, and devmapper headroom.
Start small and validate it on one KVM Worker using
[ADR 0003](docs/adr/0003-warm-microvm-capacity.md); Docker, Tart, and Hyper-V
Profiles must leave it at zero.

### GitHub permissions the controller needs

Registering the scale set takes one GitHub REST call that needs a permission: the controller
creates a runner registration token at the scope `ERAINFRA_GITHUB_CONFIG_URL` names. The scale-set client
exchanges that token for an Actions service session, and every later scale-set operation goes
through that session, not the REST API: creating or updating the scale set, issuing JIT
configurations, removing runners, and polling for jobs. Minting a GitHub App installation token is
signed with the App's own key and needs no permission.

| `ERAINFRA_GITHUB_CONFIG_URL`                | GitHub App                                        | Personal access token                                                          |
| ------------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------ |
| `https://github.com/OWNER/REPOSITORY`       | Repository: Administration, read and write        | fine-grained: the same; classic: `repo`                                        |
| `https://github.com/ORGANIZATION`           | Organization: Self-hosted runners, read and write | fine-grained: the same; classic: `admin:org`                                   |
| `https://github.com/enterprises/ENTERPRISE` | not possible; the controller refuses it at start  | classic only, with `manage_runners:enterprise`, set as `ERAINFRA_GITHUB_TOKEN` |

An organization scale set needs no Administration permission. GitHub gives every App with a
repository permission read-only Metadata. A GitHub Enterprise Server host follows the same path
rules, so `https://ghes.example/ORGANIZATION` is an organization scope.

A controller that pushes cache facts (`ERAINFRA_CACHE_FACTS_URL` set) also reads three repository
endpoints at `JobStarted` for [the job cache](#the-job-cache), with the same credentials. An
organization or enterprise scale set needs these on every repository whose jobs it serves.

| endpoint                                          | why                                                    | GitHub App permission      |
| ------------------------------------------------- | ------------------------------------------------------ | -------------------------- |
| `GET /repos/{owner}/{repo}/actions/runs/{run_id}` | the job's head branch, event, pull requests and fork   | Repository: Actions, read  |
| `GET /repos/{owner}/{repo}`                       | the default branch                                     | Repository: Metadata, read |
| `GET /repos/{owner}/{repo}/git/ref/{ref}`         | whether a reusable workflow's ref is a tag or a branch | Repository: Contents, read |

A fine-grained token needs the same three; a classic token needs `repo` for private repositories.
Without Actions read, every job's lookup fails and reads a cold cache. Without Contents read, jobs
inside reusable workflows on branch and tag events do. The controller logs
`could not establish the job's cache scope; publishing read-only facts` with GitHub's status code in
either case.

Sources, per endpoint: GitHub's
[permissions required for GitHub Apps](https://docs.github.com/en/rest/authentication/permissions-required-for-github-apps)
and
[for fine-grained personal access tokens](https://docs.github.com/en/rest/authentication/permissions-required-for-fine-grained-personal-access-tokens)
(`POST /repos/{owner}/{repo}/actions/runners/registration-token` under Administration,
`POST /orgs/{org}/actions/runners/registration-token` under Self-hosted runners,
`GET /repos/{owner}/{repo}/actions/runs/{run_id}` under Actions,
`GET /repos/{owner}/{repo}` under Metadata, `GET /repos/{owner}/{repo}/git/ref/{ref}` under
Contents);
[the enterprise registration-token endpoint](https://docs.github.com/en/enterprise-cloud@latest/rest/actions/self-hosted-runners#create-a-registration-token-for-an-enterprise)
for `manage_runners:enterprise`; and
[ARC's authentication guide](https://docs.github.com/en/actions/tutorials/use-actions-runner-controller/authenticate-to-the-api),
which uses the same scale-set protocol, for Metadata and for "You cannot authenticate using a
GitHub App for runners at the enterprise level."

The controller App stays separate from the App the dashboard's GitHub App setup creates. Set its
client ID and private key in Convex as `CONTROLLER_GITHUB_APP_CLIENT_ID` and
`CONTROLLER_GITHUB_APP_PRIVATE_KEY` for Worker holders. Dedicated hosts can keep their existing
`RC_GITHUB_APP_*` or `RC_GITHUB_TOKEN` credentials (`ERAINFRA_GITHUB_APP_*` and `ERAINFRA_GITHUB_TOKEN`
are the same settings). Reusing the webhook App would widen its manifest
to organization runner management and Contents read, which its own work does not need.

Convex looks up the controller App's installation for the registered URL and requests only the
permissions above. Repository tokens name only that repository; organization tokens stay within
that installation. Cache-facts read permissions require both the registered Profile setting and
the holder's request. A Worker cannot ask for a different URL or a broader repository set. Tokens
refresh five minutes before expiry. The adapter in `githubscale/token.go` changes the registration
request's bearer without rebuilding the Actions client or dropping its message session; refresh
failure never extends an expired credential. The App key never leaves Convex.

The dashboard App serves the legacy `workflow_job` webhook path. Its manifest
(`packages/backend/convex/githubAppConfig.ts`) asks for Repository: Administration, read and write,
for `POST /repos/{owner}/{repo}/actions/runners/generate-jitconfig`
and `DELETE /repos/{owner}/{repo}/actions/runners/{runner_id}`, and Repository: Actions, read-only,
which GitHub requires before it delivers `workflow_job` events. Its delivery recovery calls
`/app/hook/deliveries`, which takes the App's JWT and no installation permission.

Without the installer, use a process supervisor such as systemd with `Restart=always`, a private
`EnvironmentFile`, and a dedicated unprivileged service account. Controller releases are static Linux/macOS x64/ARM64
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

Where the [`erainfra` CLI](#read-the-fleet-from-the-command-line) is installed on the Worker,
`erainfra worker <command>` runs the same commands: it runs `~/.runner-center/bin/rc` with the same
arguments, output and exit code. `rc` keeps working unchanged and stays the stable path for scripts.

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

### Linux Worker prerequisites

For a trusted-only Docker Profile, Docker 28+, enough local image storage and the kernel settings
below are what a host needs. The Worker pulls the exact manifest digest before becoming schedulable;
jobs then use `--pull=never`, explicit CPU/memory/process limits, an unprivileged container user, and
no host mounts or volumes. This is the fastest path to add an existing Linux machine without
privileged host reconfiguration.

A Docker Attempt is also given explicit resource limits and an explicit resolver, rather than the
Docker daemon's inherited ones: no core dumps into a writable layer the Worker's other Attempts share
a filesystem with, a 16 MiB stack, a 65536 soft descriptor limit with the daemon's million left as
the ceiling a job may raise itself to, an 8 MiB lock limit so a library holding key material in
unswappable pages works, and a process bound of four per MiB of the Profile's memory — which is the
kernel's own RLIMIT_NPROC rule applied to what the job was sold instead of to the Worker's RAM
(#96). The container's nameservers are named on the command line and `edns0` is asked for; no search
domain is set, so a bare name in a workflow cannot resolve through whatever suffix a Worker's network
happens to supply. `ERAINFRA_DNS_SERVERS` or `RC_DNS_SERVERS` (comma-separated) overrides the resolvers the Worker reads from
systemd-resolved or `/etc/resolv.conf`; a host where neither yields an address a container can reach
refuses the Attempt rather than letting the daemon guess one.

**Kernel settings a Docker Profile needs.** A container shares the Worker's kernel, and not one of
the sysctls a CI job cares about is namespaced — `docker run --sysctl vm.max_map_count=262144` is
refused by the daemon outright — so what a job reads is what the host holds. Readiness measures them
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
`--force-network-reload` provisions even with Firecracker VMs running, which the script otherwise
refuses because reloading the table strips their per-guest sets and restarting the runtime ends
them;
`--egress-mode public|audit|allowlist` and `--egress-allow CIDR,CIDR` set the host operator's
override for every guest on this Worker, on top of each Profile's own egress (see
[Egress policy](#egress-policy)); `--network-subnet` moves the guest range if it collides with the
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
network download. `actions/cache` and the `cache:` input of the setup actions work unchanged: on a
Firecracker Worker with [the job cache](#the-job-cache) turned on, EraInfra's cache service answers
them, and everywhere else GitHub's cache does, counted against the repository's Actions storage.
With the job cache on, `turbo run` also caches in EraInfra's cache service with no change, and Go
does with `GOCACHEPROG: erainfra-gocacheprog`
([build-system caches](docs/runbooks/operate-the-job-cache.md#10-build-system-caches-turborepo-and-go)).
Another remote build cache works over allowed egress. Any cache can still be slower than
a warm immutable image, so prefer prewarming the Image Release for anything that changes rarely.
A Profile on allowlist egress needs every cache endpoint a job uses on its list:
`RC_EGRESS_PRESETS=github` covers `actions/cache`, and EraInfra's own cache service is allowed
automatically.

### Move a repository's workflows onto Profiles

`erainfra migrate runs-on` does the label change for a whole repository, the way Blacksmith's
Migration Wizard does it for theirs. Run it in the repository:

```bash
erainfra migrate runs-on                       # print a unified diff, change nothing
erainfra migrate runs-on --write               # apply it
erainfra migrate runs-on --repo ../web --map ubuntu-latest=erainfra-8vcpu-ubuntu-2404 --json
```

It reads `.github/workflows/*.yml` and `*.yaml` and replaces only the text of each label, so
comments, quoting and layout stay as they were and the diff applies with `git apply`. Each
GitHub-hosted label (`ubuntu-latest`, `ubuntu-24.04-arm`, `windows-2025`, `macos-15`, ...) goes to
the active Profile with the same OS, version and architecture: the smallest with at least 4 vCPU,
which is GitHub's standard runner, and the newest version for a `-latest` label. A Blacksmith or
BuildJet label keeps its size (`blacksmith-8vcpu-ubuntu-2404` becomes
`erainfra-8vcpu-ubuntu-2404`), and `rc-linux-js` and `rc-e2e` move to their
[ADR 0010](docs/adr/0010-name-profiles-the-way-runner-vendors-name-labels.md) names once those
are registered. When the CLI is logged in, it proposes only Profiles registered in the control
plane. Logged out, or with `--offline`, it builds names from ADR 0010's scheme without checking
them. If it is logged in and the control plane cannot be read, it stops rather than guess. `--map
<label>=<profile>`, repeatable, wins over every default.

It changes `runs-on` written as a string, a one-item list, or the `labels` of a `group`/`labels`
mapping. In a reusable workflow whose `runs-on` is an input, it changes that input's default and
the `with:` value of each call in the repository. In a [router job](#fall-back-to-github-hosted-runners),
it renames the Profile the router asks about (a `PROFILE` variable or a `profile=` query) and
leaves the router's own `runs-on`, which has to stay GitHub-hosted. It leaves the rest unchanged
and prints a note for each one, on stderr, or under `notes` with `--json`: matrix and other
expressions (the note lists what each matrix value would become), lists of several labels, which
no scale set matches, a runner group with no labels, YAML aliases, Intel macOS and larger-runner
labels, and labels it does not know.

### Fall back to GitHub-hosted runners

GitHub has no runner fallback of its own: a job queued on a Profile label waits for that Profile,
and GitHub cancels a queued self-hosted job only after 24 hours. The control plane answers the
question a workflow needs instead. `GET /runs-on?profile=<name>&fallback=<label>` on the
deployment's site URL returns `{"runs-on": "<name>"}` when a job sent to the Profile now would
start without waiting, and `{"runs-on": "<label>"}` otherwise. A Profile has room when it is
active, at least one Worker is ready for it, its live Attempts are below `maxRunners`, and either
one of its `minRunners` warm Runners is idle or the scheduler would place one more Attempt on a
ready Worker behind everything already queued. Readiness, slots, CPU, memory, disk and warm-pool
rules are the scheduler's own. An unknown or paused Profile, no ready Worker, or a full Profile all answer the
fallback, which defaults to `ubuntu-latest` (`macos-latest` for Tart, `windows-latest` for
Hyper-V).

A small router job at the top of the workflow asks once and every other job reads its answer:

```yaml
jobs:
  route:
    runs-on: ubuntu-latest
    timeout-minutes: 2
    outputs:
      runs-on: ${{ steps.route.outputs.runs-on }}
    steps:
      - id: route
        env:
          CONTROL_PLANE: https://<deployment>.convex.site
          PROFILE: rc-linux-js
          FALLBACK: ubuntu-24.04
        run: |
          # Any failure (control plane down, timeout, unexpected body) routes to FALLBACK.
          label=$(curl --fail --silent --show-error --max-time 10 --retry 2 --get \
            --data-urlencode "profile=$PROFILE" --data-urlencode "fallback=$FALLBACK" \
            "$CONTROL_PLANE/runs-on" | jq -er '."runs-on" | strings') || label=$FALLBACK
          echo "routing to $label"
          echo "runs-on=$label" >> "$GITHUB_OUTPUT"

  test:
    needs: route
    runs-on: ${{ needs.route.outputs.runs-on }}
    steps:
      - uses: actions/checkout@<commit-sha>
      - run: pnpm test
```

The endpoint takes no credential, on purpose. Pull requests from forks get no secrets, so an
authenticated probe would fail exactly where routing matters, or need a token committed to the
workflow. It returns only the Profile's name or the caller's own fallback label, so an anonymous
caller learns whether that Profile has room right now and nothing else; the reason for a fallback
goes to the deployment's log. It makes no GitHub API call, so callers cannot spend the GitHub
App's rate limit, and it reads only indexed rows bounded by live work and Worker count. It
rejects labels outside `[A-Za-z0-9._-]` (up to 100 characters) rather than echo them.

The answer covers one job. Jobs that share it, such as a matrix, all go to the Profile on a "yes"
even when only one slot was free; the rest queue there. The router itself runs on a GitHub-hosted
runner, a few seconds per workflow run.

The older form `/runs-on?labels=rc-linux` still answers for the pre-Profile webhook path, from that
path's machine slots. It knows nothing of Profiles.

Agree on a queue limit with whoever operates the Profile. Before an operation takes a Profile's
only Worker away for longer than that limit, the operator follows
[docs/runbooks/take-the-only-worker-away.md](docs/runbooks/take-the-only-worker-away.md).

## Environment variable names

The controller, the runtime, the Action Runner Agent and its provisioners read every setting under
two names: `ERAINFRA_<NAME>` and the older `RC_<NAME>`, for example `ERAINFRA_PROFILE` and
`RC_PROFILE`. The `_FILE` variants of secrets follow the same rule. In every component:

- `ERAINFRA_<NAME>` wins when both are set.
- An empty value counts as unset, under either name.
- Both set to different values stops the process at startup with an error that names both
  variables. Neither value is printed, because several of these are secrets.

The installers and the Agent still write the `RC_` names, and every machine installed so far holds
them, so an existing Worker or controller needs no change. Use the `ERAINFRA_` names in new
configuration. [Runbook: machine-side rename](docs/runbooks/rename-phase-2.md) covers moving an
existing env file and lists what keeps its `runner-center` name.

Two sets of names are outside this rule. A job still sees `RC_VCPUS` and `RC_MEMORY_MIB` in its own
environment, because workflows read them. The cache service's settings were `ERAINFRA_CACHE_*` from
the start.

## Read the fleet from the command line

`erainfra` is the operator CLI. It reads Profiles, Workers and jobs through the control plane's
operator API, the way the Blacksmith CLI and actuated-cli read theirs, and prints a table or stable
JSON. It also runs infrastructure management against Convex: Nodes, Apps, deploys, env, mesh links
and log tails (`erainfra nodes|apps|deploy|deployments|env|links|logs`; see
[docs/infra-management.md](docs/infra-management.md#operate-from-the-erainfra-cli-phase-3c)). It is a single static binary with no dependencies. `rc` on a Worker remains the tool for that
one machine (`rc status`, `rc logs -f`, `rc update`), and `erainfra worker <command>` runs it from
this CLI on the Worker; [ADR 0011](docs/adr/0011-one-erainfra-cli-over-an-operator-api.md)
explains the split.

Install it from a release (releases after v0.2.0-rc.10; Linux, macOS and Windows, x64 and ARM64
except Windows ARM64), or build it from source:

```bash
gh release download v<version> -R Fanzzzd/erainfra -p 'erainfra-linux-x86_64*'
sha256sum -c erainfra-linux-x86_64.sha256
install -m 0755 erainfra-linux-x86_64 ~/.local/bin/erainfra

go install github.com/Fanzzzd/erainfra/apps/erainfra-cli/cmd/erainfra@latest
```

Create a token in the dashboard under **Settings → API tokens**. The same list holds every token
the control plane accepts, told apart by scope:

| Scope     | `/api/v1` reads | `/api/v1` admin routes | `/metrics` |
| --------- | --------------- | ---------------------- | ---------- |
| `read`    | yes             | no                     | yes        |
| `admin`   | yes             | yes                    | yes        |
| `metrics` | no              | no                     | yes        |

The fleet's admin routes mint Worker registration tokens (`erainfra workers add`) and replace a
Worker's host labels (`erainfra workers set-labels`). The
infrastructure routes add enrolling and revoking Nodes, deploying, removing Apps, setting env,
declaring links and reading log tails; each is in the audit
log with the token's name. The dashboard shows a new token once, stores only its SHA-256, records when each
token was last used (to five minutes), and revokes a token on its next request. No route mints
tokens, so a leaked admin token cannot create its own replacement.

```bash
erainfra auth login --url https://<deployment>.convex.site --token -   # reads the token from stdin
erainfra auth status
erainfra profiles list
erainfra workers list
erainfra workers set-labels hk-worker01 gpu   # admin token; see "Pin a Profile to some Workers"
erainfra jobs list --profile erainfra-4vcpu-ubuntu-2404 --state failed --since 24h
erainfra jobs list --repo acme/web --all --json | jq '.attempts[] | {id, queueWaitMs, durationMs}'
erainfra jobs view <id>
erainfra jobs logs <id>
erainfra rightsize --repo acme/web --since 7d
erainfra rightsize --map > runs-on-map.json
erainfra tests list --repo acme/web --failed --since 24h
erainfra tests flaky --repo acme/web --json | jq '.flakyTests[] | {name, occurrences, evidence}'
erainfra migrate runs-on --repo ../web   # see "Move a repository's workflows onto Profiles"
```

The login is stored in `$XDG_CONFIG_HOME/erainfra/config.json` (default
`~/.config/erainfra/config.json`, `%AppData%\erainfra\config.json` on Windows) with mode 0600.
`ERAINFRA_URL` and `ERAINFRA_TOKEN` together override it, for CI and scripts. Every command takes
`--format table|json` (or `--json`) and `--help`. Exit codes: 0 success, 1 the request failed, 2
usage error or a filter the API refused, 4 not logged in or token refused.

Each `jobs` row is one Attempt. `WAIT` is how long GitHub held the job before a Runner of this fleet
took it, and `DURATION` runs from the job starting to it finishing. The control plane stores no job
or Worker logs: GitHub holds the job log, so `jobs logs` runs `gh run view <run> --log` when the
GitHub CLI is installed and prints the run URL otherwise. A Worker's own Agent log is read on the
Worker with `rc logs`.

The API under `/api/v1` takes the token as `Authorization: Bearer <token>`:

| Route                                      | Scope | Returns                                                                                                         |
| ------------------------------------------ | ----- | --------------------------------------------------------------------------------------------------------------- |
| `GET /api/v1/token`                        | read  | the calling token's name and scope                                                                              |
| `GET /api/v1/profiles`                     | read  | Profiles with ready Workers, free/ready slots, Workers per readiness state, and the host labels pinned to       |
| `GET /api/v1/workers`                      | read  | Workers with host labels, slots, readiness per Profile, last heartbeat and active Attempts                      |
| `GET /api/v1/attempts`                     | read  | Attempts newest first; `profile`, `state`, `repo`, `since` (`24h`, `7d` or RFC 3339), `limit` (1–100), `cursor` |
| `GET /api/v1/attempts/<id>`                | read  | one Attempt with its timeline, queue wait, duration and run URL                                                 |
| `GET /api/v1/rightsize`                    | read  | a Profile recommendation per repository and job, and the `runs-on` map; `repo`, `since` (at most 14 days back)  |
| `POST /api/v1/workers/registration-tokens` | admin | a single-use Worker registration token and the install commands                                                 |
| `GET /api/v1/tests`                        | read  | runs with JUnit results and their failures, newest first; `repo`, `since`, `limit`, `failed`                    |
| `GET /api/v1/tests/flaky`                  | read  | tests seen both failing and passing, latest first; `repo`, `since`, `limit`                                     |
| `PUT /api/v1/workers/<name>/labels`        | admin | replaces the Worker's host labels with `{"labels": [...]}`; `[]` clears them                                    |

The infrastructure routes (`/api/v1/nodes`, `/apps`, `/deployments`, `/links`, `/logs`) are listed
in [docs/infra-management.md](docs/infra-management.md#the-operator-api-routes).

Absent values are `null`, timestamps are RFC 3339 in UTC, durations are milliseconds, and an error
is `{"error": {"code", "message"}}` with 400, 401, 403 or 404. The control plane does not record a
Worker's Agent version, so `workers` does not report one; `rc status` on the Worker prints it.

## Legacy webhook delivery recovery

Minute reconciliation calls `retryStalledDeliveries` for deliveries that reached Convex but remained
pending, retrying them with a bounded attempt count before marking them failed. GitHub App
deployments also repair events that never reached Convex with a separate five-minute scan: it lists
recent failed App deliveries, deduplicates them by their stable delivery GUID, records bounded
retry/backoff state in `webhookRecovery`, and asks GitHub to redeliver only missing, still-useful
events. The dashboard exposes the latest scan and any recovered or abandoned delivery; deployments
using only a legacy PAT can retry received rows but cannot recover events that never arrived.

## Job metrics

Every Linux Attempt gets a CPU, memory, network and disk chart. The **Runs** page shows each run's
summary (for example `peak 11.2/16 GiB · cpu p95 3.6/4`, and any OOM kills); the summary links to the
Attempt page with the charts, the totals and a table of every point.

The Worker measures the boundary from the host and never asks the job:

| Executor    | Source                                                                           | CPU                                   | Memory                                                                          | Network                                                               | Disk                                                   | OOM kills                                                       |
| ----------- | -------------------------------------------------------------------------------- | ------------------------------------- | ------------------------------------------------------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------ | --------------------------------------------------------------- |
| Firecracker | the VMM process, read by the privileged runtime                                  | `utime + stime` in `/proc/<pid>/stat` | `VmRSS`, peak from `VmHWM`                                                      | the VM's tap, through `/proc/<pid>/net/dev`                           | `read_bytes` / `write_bytes` in `/proc/<pid>/io`       | kernel OOM lines on the serial console                          |
| Docker      | the container's cgroup, read by `runner-center-runtime sample` as the Agent user | `cpu.stat` (v2), `cpuacct.usage` (v1) | `memory.current` (v2) or `memory.usage_in_bytes` (v1), less inactive page cache | the container's interfaces except `lo`, through `/proc/<pid>/net/dev` | `io.stat` (v2), `blkio.throttle.io_service_bytes` (v1) | `oom_kill` in `memory.events` (v2) or `memory.oom_control` (v1) |

Tart and Hyper-V Attempts are not measured.

Things to know when reading the charts:

- **Firecracker memory is what the host has backed for the guest.** A guest that touched 12 GiB
  once, page cache included, keeps 12 GiB resident even after it frees it, because nothing balloons
  memory back. The chart answers "how much of the Worker did this job take", which is close to, but
  not the same as, what the guest's own `free` reports.
- **Docker memory is the working set**, the number `docker stats` and Kubernetes report: charged
  memory less inactive page cache, which the kernel reclaims before it OOM-kills anything.
- **The Firecracker OOM count is the one number the guest writes.** The host captures the serial
  console, but the guest kernel prints the line. It covers the guest running dry and a memory cgroup
  inside the job hitting its own limit. A job that forges the line misleads only its own page.
- **Cgroup v1 disk writes are low.** v1 charges buffered writes to the kernel thread that flushes
  them, not the container; reads and direct I/O are exact. cgroup v2 charges both correctly.
- **CPU p95 is over bucket averages.** A burst shorter than one bucket is averaged into it, which
  is why the busiest single sample interval is shown beside it as the maximum. All CPU numbers are
  vCPUs in use against the vCPUs the Profile allots.

How the data moves, and what bounds it:

1. A reading every 5 seconds: a few small procfs or cgroupfs files, no `docker stats`.
2. A bounded series of at most 360 points per Attempt, whatever its length. Buckets start at 5
   seconds and double, with adjacent pairs merged, each time the Attempt outlives 360 of them: a
   10-minute job keeps 5-second points, a 6-hour job ends with 80-second ones. CPU time, traffic and
   disk bytes add up when buckets merge, memory keeps its maximum, and the busiest sample interval
   survives.
3. Every 30 seconds while the series grows, and once when the executor exits, the Agent uploads the
   whole snapshot with `workerApi:reportAttemptMetrics`, authenticated by the Worker's machine token.
   A snapshot is complete, so the upload is idempotent: the control plane keeps the one with the
   most samples, ignores replays and late duplicates, and accepts nothing after the final one or
   later than 15 minutes after the Attempt settled.
4. The control plane stores the series in `attemptMetrics` and its summary in
   `attemptMetricSummaries`, refuses anything over the bounds (360 points per column, non-negative
   integers, offsets on the bucket grid), and an hourly cron deletes both 14 days after the last
   upload.

Measurement never touches the job. The sampler only reads; at most one upload is in flight and only
the newest waiting snapshot is kept behind it; the final collection and upload are bounded and run
beside `reportAttempt`, never in front of it; and a sampler or upload failure is logged once and
costs the chart, not the Attempt.

### Right-size recommendations

The **Rightsize** page and `erainfra rightsize` use these metrics to say which Profile each workflow
job should run on. For every repository, job name and Profile seen in the window (default and
maximum 14 days, the metrics retention), they compare the job's CPU p95 and memory peak with the
Profile and give one of four verdicts: larger, smaller, right size, or not enough data. A
recommendation names a registered, active Profile of the same family (same executor; same OS,
architecture, flavour and canary-ness for [ADR 0010](docs/adr/0010-name-profiles-the-way-runner-vendors-name-labels.md)
names, or the same image for older names). When none fits, it names the Profile to register, for
example `erainfra-8vcpu-ubuntu-2404`. Every recommendation carries a sentence saying why.

The policy leaves a job alone unless the evidence is clear:

- A verdict needs five qualifying Attempts. An Attempt qualifies when its final snapshot arrived, it
  was measured for at least 30 seconds, and no more than 10% of its readings failed.
- CPU p95 across Attempts is the nearest-rank p95 of each Attempt's own p95, so with fewer than 20
  Attempts it is the busiest one.
- Smaller: the Profile must keep that p95 at or under 70% of its vCPUs and hold the memory peak with
  30% to spare. Without an OOM kill or memory pressure the current memory counts as enough, so a
  job can drop vCPUs and keep its memory.
- Larger on CPU: the median Attempt's p95 is at 90% or more of the Profile. The gap between 70% and
  90% keeps a recommendation from flipping back in the next window.
- Larger on memory: any OOM kill, or, on Docker, a working set at 90% or more of the limit. A job
  with an OOM kill is never offered less memory. Firecracker memory is the VM's host-resident
  memory, which fills with page cache, so on Firecracker only an OOM kill asks for more; the peak
  still bounds a move down from above.

Nothing is stored. The report reads at most the newest 2,000 metric summaries in the window and
says so (`truncated`) when there were more. The dashboard reads it on opening and on **Refresh**
rather than live, because live Attempts rewrite their summaries every 30 seconds.

`erainfra rightsize --map` prints only the recommendations that name a registered Profile, as the
`runs-on` rewrite a migration tool can apply. The keys are the repository, the job's name as GitHub
shows it, and the current Profile:

```json
{
  "acme/web": {
    "test": { "erainfra-4vcpu-ubuntu-2404": "erainfra-8vcpu-ubuntu-2404" },
    "lint": { "erainfra-4vcpu-ubuntu-2404": "erainfra-2vcpu-ubuntu-2404" }
  }
}
```

The same object is the `map` field of `GET /api/v1/rightsize` and of `erainfra rightsize --json`.

## Test results

If a job writes JUnit XML into its workspace, the **Tests** page shows it: the runs with failures and
the tests that failed in each, the tests that are flaky, and the slowest tests across recent runs.
Each Attempt page lists that run's failed, errored and flaky tests and its slowest passes.
`erainfra tests list` and `erainfra tests flaky` read the same data. Nothing in the workflow
changes; the job only has to write the file.

The collector looks in each workspace (`_work/<repository>/<repository>`) for these paths, which
cover jest-junit, Vitest's `junit` reporter, pytest's `--junitxml`, gotestsum's `--junitfile`,
Maven Surefire and Failsafe, and Gradle:

```text
**/junit*.xml   **/TEST-*.xml   **/test-results/**/*.xml   **/test-reports/**/*.xml
**/*.junit.xml  **/surefire-reports/*.xml   **/failsafe-reports/*.xml
```

A repository adds its own paths in `.github/erainfra-test-reports`, one glob per line relative to
the workspace, `#` for comments. They add to the defaults. A matching file whose root element is not
`<testsuites>` or `<testsuite>` is skipped. `.git`, `node_modules`, `testdata`, `__fixtures__`,
`vendor`, `.venv`, `.pnpm-store`, `.gradle` and `.m2` are never searched, because the JUnit files in
them belong to dependencies or fixtures, not to this run.

```text
# .github/erainfra-test-reports
build/reports/*.xml
packages/*/results/**/*.xml
```

What counts as what:

- **A test** is identified by its suite (the `classname`, or the enclosing `<testsuite>` when the
  classname is empty or repeats the name, as jest-junit writes it) and its name.
- **Failed** and **errored** follow JUnit's `<failure>` and `<error>`. A test listed more than once
  in a run takes its worst outcome.
- **Flaky** has two kinds of evidence. Within one run, the test runner retried a test into a pass:
  Surefire's `<flakyFailure>`, or a test listed as failed and then passed, which is how gotestsum
  `--rerun-fails` writes it. Across runs, the test failed in one Attempt and passed in another of the
  same commit, such as a workflow rerun or a second job. The commit comes from the workspace's
  `.git`; without one, Attempts of the same workflow run are compared. Flaky tests are found when a
  report arrives, against at most 20 earlier reports of that commit.
- **Slowest** is built from the 50 slowest passing tests each run keeps, grouped by test and ordered
  by mean duration.

Where it runs, and what bounds it:

1. After the runner exits, `runner-center-guest` (root, inside the microVM) walks the workspaces and
   parses the files. The job sees no extra step and cannot skip it. The walk stops at 200,000
   entries, 200 files, 16 MiB per file, 128 MiB in total and 20 seconds, and never follows a symbolic
   link or opens anything that is not a regular file. The report counts every test and lists up to
   500 cases (every failed, errored and flaky one first, then the 50 slowest passes, with messages
   cut to 1 KiB). It also carries a 12-character SHA-256 prefix of every passing test's id, up to
   20,000, which is what lets a later run of the same commit say "this passed before".
2. The guest writes the report to its serial console as gzip and base64 in numbered lines, at most
   512 KiB, the channel the Experiment result already takes. The runtime reads the console after the
   VM exits, checks every bound again, cuts the report to 1 MiB of JSON if it must, and hands it to
   the Agent beside the egress record.
3. The Agent sends it with `workerApi:reportAttemptTests` after `reportAttempt`, so a refused or
   failed upload never touches the Attempt's own result. The control plane checks the bounds a third
   time, refuses control characters, keeps the first report per Attempt, accepts none later than 15
   minutes after the Attempt settled, and deletes reports, and flaky rows not seen since, after 30
   days.

The XML is the job's own output and is treated as hostile. Go's `encoding/xml` resolves no external
entity and fetches no DTD, refuses any entity it does not define (so neither XXE nor entity expansion
works), and refuses encodings other than UTF-8; nesting deeper than 64 elements fails the file. Names
and messages lose control characters before they leave the guest, the dashboard renders them only as
text, and the CLI prints them with control characters replaced.

Only the Firecracker executor collects test results. A Docker Attempt's container is removed with
`--rm` when the runner exits, so its workspace is gone before anything could read it; Tart and
Hyper-V are not covered. An Attempt on an Image Release older than the collector reports none.

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

## Monitor the fleet

The control plane exports fleet state to Prometheus and evaluates its own alert rules. Both are
configured on the dashboard's **Settings** page (the gear in the rail).

### Prometheus metrics

`GET https://<deployment>.convex.site/metrics` serves the Prometheus text format (version 0.0.4).
It needs a bearer token: create a `metrics` token under Settings, Metrics (or Settings, API tokens),
which can scrape and do nothing else. A `read` or `admin` token also scrapes. The token is shown once
and only its SHA-256 is stored. Several tokens can be live at once, so rotate by creating a new
token, reloading Prometheus, and revoking the old one under Settings, API tokens. A revoked or
unknown token gets 401 with no reason.

```yaml
scrape_configs:
  - job_name: erainfra
    scrape_interval: 30s
    scheme: https
    metrics_path: /metrics
    authorization:
      type: Bearer
      credentials_file: /etc/prometheus/erainfra-metrics-token
    static_configs:
      - targets: ["<deployment>.convex.site"]
```

A token rather than a `METRICS_TOKEN` environment variable: an env var takes deploy credentials
to change, allows one value at a time (so rotation has a scrape gap), and sits in the deployment
in plaintext. A minted token can be revoked by any operator from the dashboard.

Every metric is a gauge. The endpoint keeps no process state: each scrape is computed from stored
rows, and finished Attempts are read through a one-hour window. A counter rebuilt from that window
would drop whenever an old Attempt left it, which `rate()` reads as a reset. So outcomes are counts
over the last hour and durations are quantiles over the same hour; use them directly, without
`rate()`. Labels come from small operator-owned sets. No series carries a repository, branch,
workflow, Runner or job id.

| Metric                                              | Labels                                 | Meaning                                                                                                                    |
| --------------------------------------------------- | -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `erainfra_profile_info`                             | `profile`, `executor`, `state`         | Always 1. Join it to add `executor` to any per-Profile series.                                                             |
| `erainfra_profile_runners_min` / `_max`             | `profile`                              | `minRunners` and `maxRunners`.                                                                                             |
| `erainfra_profile_workers`                          | `profile`, `state`                     | Workers by readiness (`preparing`, `ready`, `degraded`, `failed`). A ready report that fails admission counts as degraded. |
| `erainfra_profile_workers_schedulable`              | `profile`                              | Workers the scheduler would use now: ready, admitted, fresh, online. 0 when paused.                                        |
| `erainfra_attempts`                                 | `profile`, `state`                     | Live Attempts. `state="pending"` is the queue of unassigned Attempts.                                                      |
| `erainfra_attempt_queue_oldest_age_seconds`         | `profile`                              | Age of the oldest pending Attempt, 0 when the queue is empty.                                                              |
| `erainfra_recent_attempts_finished`                 | `profile`, `result`                    | Attempts finished in the last hour by `succeeded`, `failed`, `cancelled`, `unknown`.                                       |
| `erainfra_recent_attempt_queue_wait_seconds`        | `profile`, `quantile`                  | p50, p90, p99 and max (`quantile="1"`) of GitHub queue wait over the last hour.                                            |
| `erainfra_recent_attempt_run_duration_seconds`      | `profile`, `quantile`                  | The same quantiles of run time, JobStarted to finish.                                                                      |
| `erainfra_recent_attempts_sample_truncated`         | `profile`                              | 1 when the Profile ran more than 200 Attempts in the hour, so the window gauges cover the newest 200.                      |
| `erainfra_recent_window_seconds`                    |                                        | 3600.                                                                                                                      |
| `erainfra_machine_info`                             | `machine`, `os`, `arch`, `slot_policy` | Always 1.                                                                                                                  |
| `erainfra_machine_online`                           | `machine`                              | 1 when the Worker heartbeated in the last two minutes.                                                                     |
| `erainfra_machine_last_heartbeat_timestamp_seconds` | `machine`                              | Unix time of the last heartbeat. Absent before the first.                                                                  |
| `erainfra_machine_heartbeat_age_seconds`            | `machine`                              | Seconds since that heartbeat, at scrape time.                                                                              |
| `erainfra_machine_slots_configured`                 | `machine`                              | Operator-fixed slots. Absent under the auto policy.                                                                        |
| `erainfra_machine_slots_recommended`                | `machine`                              | Slots the resources and benchmark recommend.                                                                               |
| `erainfra_machine_slots_effective`                  | `machine`                              | Slots the scheduler fills.                                                                                                 |
| `erainfra_machine_slots_used`                       | `machine`                              | Slots in use.                                                                                                              |
| `erainfra_machine_benchmark_score`                  | `machine`, `dimension`                 | Benchmark score, 0 to 100, for `cpu`, `memory`, `disk`, `network`, `balanced`.                                             |
| `erainfra_machine_benchmark_timestamp_seconds`      | `machine`                              | When the benchmark ran. Older than seven days, the scheduler ignores it.                                                   |
| `erainfra_controller_up`                            | `profile`                              | 1 when a controller reported in the last 90 seconds and holds the GitHub session. Absent until the first heartbeat.        |
| `erainfra_controller_last_heartbeat_age_seconds`    | `profile`                              | Seconds since any of the Profile's controllers reported. Absent until the first heartbeat.                                 |
| `erainfra_node_online`                              | `node`                                 | 1 when the Node's Infra Agent heartbeated in `connect-convex` mode in the last two minutes. Absent for Hub-only Nodes.     |
| `erainfra_node_commands_blocked`                    | `node`, `reason`                       | 1 while the Node reports it cannot run commands (`journal_full`, `journal_error`, `command_api`, `command_error`), else 0. |
| `erainfra_node_commands_blocked_seconds`            | `node`, `reason`                       | Seconds since the Node first reported the block. Absent while it can run commands.                                         |
| `erainfra_node_journal_keys` / `_key_limit`         | `node`                                 | Keys in the Node's execution journal, and the limit at which it refuses new builds, deploys and operations.                |
| `erainfra_alerts_firing`                            | `rule`                                 | Firing incidents per enabled alert rule.                                                                                   |
| `erainfra_scrape_truncated`                         |                                        | 1 when a read cap (1,000 Profiles, Workers, readiness rows, or live Attempts per state) was reached.                       |

Cache hit rates are not here: the control plane does not see cache traffic. The cache service
logs it.

Example Prometheus alerting rules, if you prefer Alertmanager to the built-in alerts:

```yaml
groups:
  - name: erainfra
    rules:
      - alert: ErainfraProfileWithoutWorker
        expr: erainfra_profile_workers_schedulable == 0 and on (profile) erainfra_profile_info{state="active"} == 1
        for: 5m
      - alert: ErainfraQueueBacklog
        expr: erainfra_attempt_queue_oldest_age_seconds > 900
      - alert: ErainfraWorkerSilent
        expr: erainfra_machine_heartbeat_age_seconds > 300
      - alert: ErainfraControllerDown
        expr: erainfra_controller_up == 0 and on (profile) erainfra_profile_info{state="active"} == 1
        for: 3m
      - alert: ErainfraNodeOffline
        expr: erainfra_node_online == 0
        for: 3m
      - alert: ErainfraNodeCommandsBlocked
        expr: erainfra_node_commands_blocked_seconds > 600 and on (node) erainfra_node_online == 1
      - alert: ErainfraNodeJournalNearlyFull
        expr: erainfra_node_journal_keys > 0.9 * erainfra_node_journal_key_limit
```

### Alerts

Settings, Alerts holds rules, destinations and incidents. A cron evaluates every enabled rule each
minute against the same fleet state `/metrics` reads.

| Condition                           | Subject        | Fires when                                                                                                                         |
| ----------------------------------- | -------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Worker offline                      | Worker         | No heartbeat for N minutes (2 or more). A Worker that never connected is ignored.                                                  |
| Profile has no ready Worker         | Profile        | An active Profile has no schedulable Worker.                                                                                       |
| Worker readiness degraded or failed | Profile/Worker | A Worker reports degraded or failed readiness for an active Profile.                                                               |
| Queue backlog                       | Profile        | The oldest pending Attempt has waited N minutes.                                                                                   |
| Attempt failure rate                | Profile        | At least P% of Attempts finished in the last W minutes failed, once M have finished. Cancelled Attempts count toward neither side. |
| Consecutive failed Attempts         | Profile        | The newest N finished Attempts (in the last 24 hours, cancellations skipped) all failed.                                           |
| Attempt running too long            | Profile        | An Attempt has been running for N minutes.                                                                                         |
| No controller listening             | Profile        | No controller has held an active Profile's GitHub session for N minutes (2 or more; 3 by default). See below.                      |
| Node unable to run commands         | Node           | A `connect-convex` Node has reported for N minutes that it cannot run commands. See below.                                         |
| Node offline                        | Node           | A `connect-convex` Node has sent no heartbeat for N minutes (2 or more; 5 by default). See below.                                  |

A dead controller creates no Attempts, so without its own signal it looks like an idle Profile.
Every controller reports a heartbeat to the control plane every 30 seconds and whenever its session
state changes, and the **Controller** column on the Profiles table shows the result. A Profile no
controller has ever reported for shows _Not reporting_ and is never alerted on: controllers built
before the heartbeat send none, so the first heartbeat ever received for a Profile is what starts
tracking it. After that, a controller that stops reporting, stops cleanly, or keeps reporting
while GitHub refuses it the session counts as silent. A paused (retired) Profile is not alerted
on.

The two Node rules cover infrastructure Nodes on the Convex transport, which belong to no Profile,
so a Profile scope does not narrow them. **Node offline** watches a Node that has heartbeated at
least once; its floor of two minutes is the silence after which deploys and failover treat the
Node as gone. A Node whose credentials are all revoked (`erainfra nodes revoke`) is retired: it is
left out of both rules and of the `erainfra_node_*` metrics. A Node that stops heartbeating while
**Node unable to run commands** fires stays in breach, judged by how long it was blocked when its
heartbeats stopped, so the incident does not resolve because the Node died. It resolves when the
Node reports again without the block, or is retired.

A rule can be limited to one Profile. Each rule and subject has at most one open incident, so a
condition that keeps holding notifies once. The lifecycle:

- The incident is pending until the condition has held for the rule's pending time, then it fires.
  A condition that clears while pending is dropped without a notification.
- A firing incident notifies every enabled destination on the rule, unless the rule is muted or
  the same rule and subject notified within the cooldown. Either way the incident still shows on
  the dashboard and in `erainfra_alerts_firing`, and it is announced at the first evaluation after
  the mute or cooldown ends, if it is still firing.
- When the condition clears, the incident resolves and a resolved notification goes out, but only
  if the firing one did.
- Disabling a rule closes its incidents without notifying. Resolved incidents are kept 30 days.

Destinations are a Slack incoming webhook (any Slack-compatible receiver works) or a generic
webhook. Both need https. URLs and signing secrets are write-only: the dashboard shows the host
and the last four characters of the path. Each destination has a Test button.

Delivery never blocks evaluation. The cron writes a delivery row and schedules a send. A 2xx is
delivered; 408, 429, 5xx, timeouts (10 seconds) and network errors are retried with exponential
backoff from 30 seconds, plus up to 20% jitter, honouring `Retry-After`, for 8 attempts in about an
hour; any other status fails at once. Delivery is at least once, so dedupe on
`X-EraInfra-Delivery`.

A generic webhook receives:

```json
{
  "version": 1,
  "event": "alert.firing",
  "rule": {
    "id": "…",
    "name": "Queue backlog",
    "kind": "queue-backlog",
    "condition": "Oldest queued Attempt older than 15m",
    "profile": "rc-linux-js"
  },
  "incident": {
    "id": "…",
    "status": "firing",
    "subject": "rc-linux-js",
    "summary": "3 Attempts queued on Profile rc-linux-js; the oldest has waited 16m.",
    "since": "2026-11-05T11:44:00.000Z",
    "firedAt": "2026-11-05T12:00:00.000Z",
    "resolvedAt": null
  },
  "sentAt": "2026-11-05T12:00:00.000Z"
}
```

`event` is `alert.firing`, `alert.resolved` or `alert.test`. The request carries
`X-EraInfra-Event`, `X-EraInfra-Delivery` and `X-EraInfra-Signature: t=<unix seconds>,v1=<hex>`,
where `v1` is HMAC-SHA256 of `<t>.<raw body>` keyed with the whole signing secret (`whsec_…`),
the scheme Stripe uses. The timestamp lets a receiver refuse replays. To verify in Node:

```js
import { createHmac, timingSafeEqual } from "node:crypto";

function verify(secret, header, rawBody, toleranceSeconds = 300) {
  const { t, v1 } = Object.fromEntries(header.split(",").map((part) => part.split("=")));
  if (Math.abs(Date.now() / 1000 - Number(t)) > toleranceSeconds) return false;
  const expected = createHmac("sha256", secret).update(`${t}.${rawBody}`).digest();
  const given = Buffer.from(v1 ?? "", "hex");
  return given.length === expected.length && timingSafeEqual(given, expected);
}
```

The signing secret is shown once when the destination is created or rotated. Rotation takes
effect at once.

## Security and operations

- Every CI Attempt gets a fresh VM and single-use JIT registration.
- The job network policy is rendered and verified by the same runtime build that enforces it; a
  Worker whose live nftables table drifts stops being ready.
- Each Profile can deny all egress except a domain and CIDR allowlist, enforced on the host through
  a host-side resolver and per-guest nftables sets, or audit what its jobs reach first. A Worker
  that cannot prove a Profile's egress is not scheduled for that Profile.
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

EraInfra is one product version: root, Agent, Controller, Runtime and `apps/mesh/Cargo.toml`
versions must match. Tagging `v<version>` runs the release workflow, revalidates the JavaScript and
Go surfaces (including both Linux architectures), rebuilds the agent archive, the Infra Agent
binaries and the `erainfra-mesh` binaries twice byte-for-byte, checks the deployment pin, attests
the artifacts, and publishes:

- `erainfra-agent-<version>.tar.gz` plus SHA-256;
- Controller binaries and SHA-256 sidecars for Linux/macOS x64/ARM64;
- Runtime binaries and SHA-256 sidecars for Linux x64/ARM64, plus the runtime and controller
  systemd units;
- `infra-agent-<os>-<arch>` binaries and SHA-256 sidecars for Linux and macOS x64/ARM64 and
  Windows x64 — the five targets a Node can be;
- `erainfra-cache-service-linux-x86_64` and its SHA-256 sidecar — the cache service (ADR 0009),
  one Linux target because it is a server an operator deploys, not a binary every Node runs;
- `erainfra-<os>-<arch>` binaries and SHA-256 sidecars, the operator CLI, for the same five targets
  as the Infra Agent;
- `erainfra-mesh-<os>-<arch>` binaries and SHA-256 sidecars for the same five targets as the
  Infra Agent: the Node-to-Node sidecar on iroh that replaces dumbpipe (ADR 0016,
  [apps/mesh/README.md](apps/mesh/README.md)). Linux builds are static musl binaries. Services
  require both fleet membership and explicit per-exposure `allowed_peers` grants; omitted or
  empty grants deny access. Nodes opt in with `/install --role node --mesh`. `AGENT_RELEASE.mesh`
  stays empty until the next authorized release, so that path refuses today. Until every Node has
  it, a link with an end that lacks the sidecar stays on legacy dumbpipe, which `portless links`
  marks `legacy-dumbpipe (unauthenticated)`; links move to the mesh as their Nodes upgrade, and
  `ERAINFRA_MESH_REQUIRE=true` on the Hub refuses the rest. See
  [docs/runbooks/secure-node-mesh.md](docs/runbooks/secure-node-mesh.md).

A version containing a hyphen is published as a GitHub prerelease. Release assets are never
overwritten; a correction is a new version.

The other four parts of `AGENT_RELEASE` are pinned on the release commit, before the tag: `sha256` from
the deterministic archive, and `infraAgent`, `cacheService` and `controller` from
`pnpm --filter @erainfra/release build-go-assets` followed by
`pnpm --filter @erainfra/backend print-infra-agent-pin`,
`pnpm --filter @erainfra/backend print-cache-service-pin` and
`pnpm --filter @erainfra/backend print-controller-pin`, which read the digests out of the sidecars so
nobody transcribes them by hand. The workflow refuses to publish a tag whose pin disagrees with the
bytes it just built, or whose Infra Agent, cache-service or controller pin covers only some of its
targets. The controller pin covers the two Linux targets the installer serves; the macOS controller
binaries are published but not pinned. Pinned binaries are stamped with the version only, never the
commit, so a digest does not depend on the commit it is written into.

`AGENT_RELEASE.mesh` is pinned the same way, with one difference: the macOS and Windows sidecars
build on their own runners, so no single machine can produce all five. Run the release workflow by
hand (Actions, EraInfra release, Run workflow) on the commit you are about to pin. That run builds
the five `erainfra-mesh` assets and publishes nothing. The pin commit itself changes no sidecar
source, so its digests carry over to the tag; any change under `apps/mesh` between that run and
the tag invalidates them. The run's artifacts expire after a day. Collect them in one directory
and print the pin:

```bash
gh run download <run-id> --pattern 'mesh-*' --dir dist/mesh-pin
mv dist/mesh-pin/mesh-*/* dist/mesh-pin/
pnpm --filter @erainfra/backend print-mesh-pin dist/mesh-pin
```

The tag run rebuilds the sidecars and refuses to publish if any digest differs from the pin or a
target is missing. On main the map is empty, and `/install --role node --mesh` refuses until a
release pins it.

## Repository layout

```text
apps/action-runner-agent  Worker daemon and Tart/legacy provisioners
apps/controller           official scale-set listener adapter
apps/runtime              Firecracker host runtime, job network policy, and guest bootstrap
apps/infra-agent          Node daemon: outbound WS to the Hub, App deploys, host operations
apps/erainfra-cli         the `erainfra` operator CLI over the control plane's /api/v1
apps/mesh                 erainfra-mesh (Rust): Node-to-Node TCP links over iroh, fleet allowlist
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
