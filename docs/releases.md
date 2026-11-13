# Releases

How a maintainer versions, tags and publishes EraInfra, and what each release contains. Released
versions are on the [releases page](https://github.com/Fanzzzd/erainfra/releases).

EraInfra is one product version: root, Agent, Controller, Runtime and `apps/mesh/Cargo.toml`
versions must match. Nobody edits them by hand. Pull requests carry changesets
([.changeset/README.md](../.changeset/README.md)), and the release branch runs
`GITHUB_TOKEN=$(gh auth token) pnpm release:version`. That runs `changeset version`, which bumps the
fixed product group and writes the CHANGELOGs, then copies the version to the root `package.json`,
the mesh crate, the agent lockfile and `AGENT_RELEASE.version`. Tagging `v<version>` runs the release workflow, revalidates the JavaScript and
Go surfaces (including both Linux architectures), rebuilds the agent archive, the Infra Agent
binaries and the `erainfra-mesh` binaries twice byte-for-byte, checks the deployment pin, attests
the artifacts, and publishes:

- `erainfra-agent-<version>.tar.gz` plus SHA-256;
- Controller binaries and SHA-256 sidecars for Linux/macOS x64/ARM64;
- Runtime binaries and SHA-256 sidecars for Linux x64/ARM64, plus the runtime and controller
  systemd units;
- `infra-agent-<os>-<arch>` binaries and SHA-256 sidecars for Linux and macOS x64/ARM64 and
  Windows x64, the five targets a Node can be;
- `erainfra-cache-service-linux-x86_64` and its SHA-256 sidecar: the cache service (ADR 0009),
  one Linux target because it is a server an operator deploys, not a binary every Node runs;
- `erainfra-<os>-<arch>` binaries and SHA-256 sidecars, the operator CLI, for the same five targets
  as the Infra Agent;
- `erainfra-mesh-<os>-<arch>` binaries and SHA-256 sidecars for the same five targets as the
  Infra Agent: the Node-to-Node sidecar on iroh (ADR 0016,
  [apps/mesh/README.md](../apps/mesh/README.md)). Linux builds are static musl binaries. Services
  require both fleet membership and explicit per-exposure `allowed_peers` grants; omitted or
  empty grants deny access. `/install --role node` installs it on every Node and refuses when
  `AGENT_RELEASE.mesh` pins no build for the Node's target. See
  [docs/runbooks/secure-node-mesh.md](runbooks/secure-node-mesh.md).

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
target is missing. `/install --role node` refuses a target the map does not pin.

## Rehearse a release on a staging Worker

CI proves that a release builds and passes its tests. It does not run the release on a Worker.
v0.2.0-rc.22 passed CI, and its Action Runner Agent then marked every Firecracker Profile with
`warmPool` 0 as degraded; ubuntu0 took no jobs for 55 minutes. `scripts/release-rehearsal` runs a
release on a real Worker against the dev Convex deployment first:

```bash
scripts/release-rehearsal --candidate          # the release commit, before tagging
scripts/release-rehearsal v0.2.0-rc.23         # a published tag
```

It runs five steps and stops at the first failure:

1. **source**: checks the ref out in a scratch worktree. A tag must be published with its agent
   archive. A candidate is built with `pnpm release:package`. When the build differs from the
   committed `AGENT_RELEASE` pin, the scratch copy is pinned to the build, so any commit can be
   rehearsed. The summary says whether the committed pin matched.
2. **control plane**: pushes the version's Convex functions to the dev deployment with
   `npx convex dev --once`, then checks that its `/install` serves that version and archive pin.
3. **worker**: runs the served installer twice on the Worker, `--role worker-host` and then the
   Worker role (register once, `--update` afterwards). Both must report the version.
4. **profiles**: registers `rehearsal-2vcpu-wp0` (`warmPool` 0) and `rehearsal-2vcpu-wp1`
   (`warmPool` 1) and waits until both report `ready` from a readiness check made after the
   Action Runner Agent restarted. Both must then stay ready for `--settle` seconds (120 by
   default). A `degraded` or `failed` state fails the rehearsal and prints the failed checks.
5. **job**: with `--job-repo OWNER/NAME`, installs a controller for `rehearsal-2vcpu-wp0` on the
   Worker and waits until its listener polls GitHub. GitHub offers a job only to an open message
   session; a job queued before the session opened waited 14 minutes for a second offer on
   2026-11-13. It then dispatches `.github/workflows/erainfra-rehearsal.yml` in that repository
   with `runs-on: rehearsal-2vcpu-wp0` and requires the run to succeed within `--queue-budget`
   seconds (300 by default) of queue time. It writes the workflow with a `[skip ci]` commit when
   it is missing or differs from the script's copy. The job retries its Docker Hub pull three times,
   because a staging uplink can drop one request. Without `--job-repo` the step is skipped.

The script exits non-zero on any failure, prints at most 20 lines, and writes the full log to a
scratch directory it names on the last line. Afterwards it pauses both staging Profiles and stops
the Worker; `--keep` leaves both running.

### What it touches

It reads the dev deployment's name from `CONVEX_DEPLOYMENT=dev:<name>` in the main checkout's
`packages/backend/.env.local` and refuses any other value. It never passes `--prod`, names the dev
deployment on every `npx convex` command that accepts `--deployment`, and ignores
`CONVEX_DEPLOY_KEY`. `npx convex deploy` is never run, because it targets production even with a
dev `.env.local`. Set `RELEASE_REHEARSAL_DEPLOYMENT=<name>` to make it also refuse a different dev
deployment. Step 5 sets `CONTROLLER_TOKEN` on the dev deployment when it has none.

Secrets (registration token, controller token, `gh auth token`) travel over SSH on stdin. The
controller installer copies the two controller secrets under `/etc/runner-center/secrets/` inside
the Worker, and the script deletes them when it ends.

### The Worker host

`--host` (default `omarchy`, or `RELEASE_REHEARSAL_HOST`) is any Linux machine with Docker,
`/dev/kvm` and an SSH login in the `docker` group; no sudo is needed. The Worker is an Ubuntu 24.04
systemd container on that host, `erainfra-rehearsal-worker`, run `--privileged` with the host's
`/dev` and `/lib/modules`. The provisioner itself does not check the distribution: it needs the
tools it lists and root. The container is used for three reasons. The rehearsal installs on the OS
production Workers run. It needs no root password on the host. The job network policy stays in the
container's own network namespace, so the host's firewall is never changed. State lives in Docker
volumes (`erainfra-rehearsal-state`, `erainfra-rehearsal-home`) and a sparse 200 GiB thin-pool
under `~/erainfra-rehearsal/pool`, so the second run reuses the pulled Image Release.

Known differences from a production Worker:

- the kernel is the host's, and device-mapper and loop devices are the host kernel's;
- the thin-pool is file-backed, the evaluation configuration;
- Node.js 22 comes with the container image, so the installer's Node.js download is not exercised;
- a candidate's assets are served from `file:///opt/rehearsal-assets` instead of the GitHub
  release; the script rewrites only the installer's download URLs and checks it found them;
- the container adds one nftables rule: guest DNS on port 53 goes to OpenDNS on port 5353. A
  fake-IP DNS proxy on the host (Clash, Mihomo) answers every port-53 query with an address in
  198.18.0.0/15, which the job network policy denies. The rule would also take the host resolver
  from audit and allowlist guests, so the staging Profiles are public.

### Required before tagging

Run it on the exact commit you will tag, which is the release pull request's squash merge on
`main`, after the pins are filled and before `git tag`:

```bash
sha=$(git rev-parse origin/main)          # the release merge commit
scripts/release-rehearsal --candidate "$sha" --job-repo <owner>/<test repository>
git tag v<version> "$sha" && git push origin v<version>     # only after "Result: PASS"
```

The candidate build is byte-identical to what the tag publishes, so the summary must also say
`committed pin matches build: yes`. A FAIL blocks the tag; fix the cause and make a new release
commit.

The release workflow enforces this. At the end of each run the script posts the commit status
`erainfra/release-rehearsal` on the rehearsed commit: `success` only for a PASS that ran the job
step, `failure` for any FAIL, which replaces an earlier success. The workflow's `rehearsal` job
reads that status for the tagged commit and stops the release before anything is published unless
it is `success`. Posting the status needs `gh` with write access to this repository.

Step 5 needs a repository the release manager owns and may add a workflow to, and `gh auth
token` with the `repo` scope, which the controller uses to create the staging scale set.
