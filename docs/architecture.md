# How EraInfra works

EraInfra has three moving parts. The control plane is a Convex deployment: it stores the fleet's
state, schedules work, serves the installers and hosts the dashboard. A controller registers each
Profile with GitHub as a runner scale set and turns GitHub's job demand into Attempts. A Worker runs
the Action Runner Agent, claims Attempts, and creates one isolated environment per Attempt through
its executor. Every machine connects out to Convex, so none needs a public IP or an open port.
[CONTEXT.md](../CONTEXT.md) defines the terms.

## Components

- GitHub's official Runner Scale Set Client, for job demand, JIT registration and lifecycle events
  ([ADR 0001](adr/0001-use-scale-sets-with-platform-executors.md)).
- Convex, for the durable control plane, the scheduler, authentication and the dashboard.
- Controllers that run on Workers under a lease, or on a dedicated host
  ([ADR 0014](adr/0014-controllers-run-on-the-workers-under-a-lease.md)).
- One ephemeral Firecracker microVM per untrusted Linux job.
- One constrained, ephemeral Docker container per trusted Linux job.
- One copy-on-write Tart VM per macOS job, and one Hyper-V VM per Windows job.
- Digest-pinned, prewarmed [Image Releases](images.md).
- Shared admission control for CI Attempts and operator Experiments.

Fireactions is the reference for the Linux executor, not a second control plane. ADR 0001 has the
source comparison, and [ADR 0002](adr/0002-verify-the-job-isolation-boundary.md) the isolation
boundary, network policy and cache contract.

## Scheduling

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

## Executors

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
dashboard shows the real boundary, `guest kernel` or `shared kernel`, next to every Profile. The
old `workflow_job` webhook scheduler remains temporarily for migration; the dashboard labels its
Jobs view and GitHub App setup as legacy.

## Security properties

- Every CI Attempt gets a fresh VM and single-use JIT registration.
- The job network policy is rendered and verified by the same runtime build that enforces it; a
  Worker whose live nftables table drifts stops being ready.
- A daily canary, the `smoke` workflow, runs a job through the scale-set listener, the scheduler
  and the executor's in-job isolation probes.
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

## Setting names

The controller, the runtime, the Action Runner Agent and its provisioners read every setting under
two names: `ERAINFRA_<NAME>` and the older `RC_<NAME>`, for example `ERAINFRA_PROFILE` and
`RC_PROFILE`. The `_FILE` variants of secrets follow the same rule. In every component:

- `ERAINFRA_<NAME>` wins when both are set.
- An empty value counts as unset, under either name.
- Both set to different values stops the process at startup with an error that names both
  variables. Neither value is printed, because several of these are secrets.

The installers and the Agent still write the `RC_` names, and every machine installed so far holds
them, so an existing Worker or controller needs no change. Use the `ERAINFRA_` names in new
configuration. [Runbook: machine-side rename](runbooks/rename-phase-2.md) covers moving an
existing env file and lists what keeps its `runner-center` name.

Two sets of names are outside this rule. A job still sees `RC_VCPUS` and `RC_MEMORY_MIB` in its own
environment, because workflows read them. The cache service's settings were `ERAINFRA_CACHE_*` from
the start.

## Legacy webhook delivery recovery

Minute reconciliation calls `retryStalledDeliveries` for deliveries that reached Convex but remained
pending, retrying them with a bounded attempt count before marking them failed. GitHub App
deployments also repair events that never reached Convex with a separate five-minute scan: it lists
recent failed App deliveries, deduplicates them by their stable delivery GUID, records bounded
retry/backoff state in `webhookRecovery`, and asks GitHub to redeliver only missing, still-useful
events. The dashboard exposes the latest scan and any recovered or abandoned delivery; deployments
using only a legacy PAT can retry received rows but cannot recover events that never arrived.

## Repository layout

```text
apps/action-runner-agent  Worker daemon and its Docker, Tart and Hyper-V provisioners
apps/controller           the scale-set controller (runner-center-controller)
apps/runtime              Firecracker host runtime, job network policy and guest bootstrap
apps/cache-service        the job cache service (erainfra-cache-service)
apps/infra-agent          Node daemon: App deploys and allowlisted host operations
apps/erainfra-cli         the `erainfra` operator CLI over the control plane's /api/v1
apps/mesh                 erainfra-mesh (Rust): Node-to-Node TCP links over iroh
apps/dashboard            React dashboard for the Convex control plane
apps/hub, apps/hub-web    the legacy Hub and its dashboard, kept for Hub-mode Nodes
apps/docs                 the legacy Hub-era documentation site
deploy                    the Firecracker host provisioner and systemd units
deploy/infra              Node, gateway, relay and Hub installers
packages/backend          the Convex control plane
packages/cli              the published `portless` CLI, which talks to the Hub
packages/release          deterministic release packager
packages/platform         the store and runtime seam that runs the control plane on Convex or
                          Cloudflare (ADR 0019)
packages/typescript-config shared tsconfig presets
images                    Image Release definitions
.github/conformance       the environment fingerprint, its diff, and the allowlist of intended
                          differences from `ubuntu-latest`
```
