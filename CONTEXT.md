# EraInfra domain context

The ubiquitous language for this repository. When a term below is written with a capital
letter in code, comments, docs or commit messages, it means _this_ and nothing looser.

EraInfra is one platform with two surfaces, both of which run on machines the customer owns:

- **CI execution**: run a GitHub Actions job in a disposable, verified isolation boundary.
- **Infrastructure management**: deploy and operate long-lived Apps on those machines.

The second surface arrived as a separate product called Portless. It is now a feature of the
platform and the name is retired. See [ADR 0004](docs/adr/0004-portless-is-a-feature-not-a-second-product.md).

## The two agents

|                     | **Action Runner Agent**                               | **Infra Agent**                                   |
| ------------------- | ----------------------------------------------------- | ------------------------------------------------- |
| lives at            | `apps/action-runner-agent`                            | `apps/infra-agent`                                |
| runs on             | a **Worker**                                          | a **Node**                                        |
| registers           | capacity per Profile                                  | itself, for management                            |
| claims work         | Attempts, experiments                                 | nothing; it is commanded                          |
| what it runs        | one disposable boundary per Attempt, then destroys it | long-lived **Apps** + allowlisted host operations |
| its work's lifetime | single-use                                            | persistent                                        |

Both dial out over an encrypted connection and hold no inbound port, so both work behind NAT.
That property is shared, which is why neither is named for it. See
[ADR 0005](docs/adr/0005-name-the-two-agents-by-what-they-serve.md).

## Terms

**Worker**: a customer machine that executes CI jobs. Reports readiness per Profile, and is only
scheduled onto when its own evidence proves the isolation contract it claims. A Worker that cannot
prove its contract is not ready; absence of a fact is never treated as a successful measurement.

**Node**: a customer machine that runs deployed Apps. Any Linux, macOS or Windows box, including
one behind NAT with no public IP.

**Action Runner Agent**: the daemon on a Worker. Registers the machine's capacity contract,
claims Attempts, and drives a provisioner that creates and destroys one isolation boundary per
Attempt. It has two claim paths: `workerApi:claimAttempt` and `workerApi:claimExperiment`. It
also sends `agentApi:heartbeat`. Releases up to v0.2.0-rc.19 also called `agentApi:pendingCommands`,
`agentApi:claim` and `agentApi:report`. The backend no longer has them, so a Worker needs
v0.2.0-rc.20 or later. Machines install it with plain `npm install`
from an archive pinned by SHA-256, which is why it deliberately does not use the `catalog:` or
`workspace:` protocols. Read the name as "the agent that serves Action Runners": **it is not
itself a Runner.**

**Runner**: an ephemeral GitHub Actions runner: an object in _GitHub's_ database with a
`runner_id` that GitHub issues, created per Attempt through
`actions/runners/generate-jitconfig` and deleted when the Attempt ends. It runs **inside** the
isolation boundary with only a single-use JIT token. One Agent creates many Runners over its
lifetime. Never use "Runner" for either of our daemons.

**Infra Agent**: the daemon on a Node. It runs `connect-convex`: it dials the Convex **control
plane** with its Node credential and executes only allowlist-resolved operations; there is no
raw-argv path. Also builds images and deploys Apps. Its Hub mode (`connect`) left main with
[ADR 0020](docs/adr/0020-the-hub-leaves-main.md).

**Hub**: retired. The separate control plane that Infra Agents in Hub mode connected to.
ADR 0016 moved its state, deploys, ingress and operator surface into Convex, and the owner's
fleet retired its Hub on 2026-11-08 ([retire-the-hub.md](docs/runbooks/retire-the-hub.md)). Its
code left main with [ADR 0020](docs/adr/0020-the-hub-leaves-main.md); a rollback uses the
`v0.2.0-rc.19` tag, the last that carries it. Never use "Hub" for the Convex control plane; the
terms are not interchangeable.

**Profile**: the immutable contract a Worker advertises capacity against. Not just a size: it
carries `executor`, `imageRelease`, `vcpus`, `memoryMiB`, `warmPool`, `fitPolicy`, `minRunners` and
`maxRunners` (the `profiles` table in `convex/schema.ts`), and its `egress` (public, audit or allowlist; see
[ADR 0015](docs/adr/0015-egress-is-a-property-of-the-profile.md)), and the `workerLabels` it is pinned
to. Readiness is per Worker _and_ Profile.

**Host label**: a word an admin puts on a Worker (`gpu`, `nvme`, `hk`), stored in
`machines.labels`. A Profile pinned to host labels is served only by Workers carrying every one.
It never appears in `runs-on`: GitHub routes to a Profile's scale set, so a Worker is chosen by
Profile, never by label ([ADR 0017](docs/adr/0017-pin-a-profile-to-workers-by-host-label.md)).
Distinct from a scale set's labels (`RC_LABELS`), which are what `runs-on` matches.

**Attempt**: one execution of one CI job inside one disposable boundary. The isolation boundary
is per Attempt, never per Worker.

**Retiring**: an Attempt EraInfra is ending while its Runner may be online (`attempts.retirement`):
a scale-down, a lost host label, a Worker that stopped reporting. It keeps its state and executor
until GitHub confirms the Runner is deleted. A JobStarted before that keeps the Attempt, because
GitHub gave the Runner a job first, and a running Attempt's Worker reporting again calls off a
retirement made for its silence (`convex/attemptRetirement.ts`). Not the retirement of a
Profile's scale set (`runner-center-controller retire`).

**Start budget**: how much starting a Firecracker Worker allows at once: Attempts still in their
start window, and the host's I/O pressure. The runtime holds an Attempt's start while either is at
its limit, for a bounded time, then starts it anyway (`apps/runtime/internal/admission`). `/runs-on`
answers the fallback while every ready Worker is over budget (`convex/startBudget.ts`). It spaces
starts on a shared disk; it is not a capacity limit, which slots and `maxRunners` set.

**App**: a customer workload deployed onto one or more Nodes, with its own Docker network.

**Executor**: the mechanism providing an Attempt's boundary: `docker` (shared-kernel),
`firecracker`, `tart`, or `hyperv` (all guest-kernel). The boundary a Profile may claim is
determined by its executor and is not negotiable per Worker.

**Boundary**: `guest-kernel` or `shared-kernel`. A security claim, not a description: a Worker
reporting a boundary weaker than its executor promises is refused.

**Readiness evidence**: the measured facts a Worker submits to justify a ready state, including
the network policy identity hash and thin-pool identity. Admission is fail-closed against it.

**Platform**: the service the control plane runs on: Convex (production today) or Cloudflare (a
Durable Object, being built). Both answer the same Convex syscalls, so the backend runs unmodified
on either; `packages/platform` holds the Cloudflare implementation
([ADR 0019](docs/adr/0019-the-control-plane-runs-on-convex-or-cloudflare.md)). Not the Executor
and not a Worker's OS.

**API token**: a bearer credential for the Convex control plane's `/api/v1` and `/metrics`, minted
in the dashboard and used by the `erainfra` CLI, scripts and Prometheus. Its **scope** is `read`,
`admin` or `metrics` (`convex/apiTokenPolicy.ts`). It is unrelated to a
Worker's machine token, a Node's enrollment credential (`erainfra_node_`, bound to one Node), the
controller's `CONTROLLER_TOKEN`, and the retired Hub's API tokens
([ADR 0011](docs/adr/0011-one-erainfra-cli-over-an-operator-api.md)).

**Role**: three unrelated vocabularies here use the word, and only the first is a machine kind, so
a bare "role" in code, a comment or a commit message is ambiguous. Qualify it.

- **Machine role**: `worker` | `node`, the two kinds above. What `/install --role` picks, and the
  owner of the word **worker**. Neither of the other two may spend it.
- **Placement role**: `gateway` | `compute` | `database` | `relay`, which capability a Node carries
  for the Apps deployed onto it, reported by the Infra Agent on its `hello` frame. `compute` was
  called `worker` until #64, which is how a Node came to be badged as a Worker.
- **Permission role**: `owner` | `admin` | `operator` | `viewer`, what a human may do on a Convex
  account (`convex/infra/policy.ts`, where a dashboard API token's scope maps onto the same
  permissions). The Hub used the same four. It shares only the field name with either of the
  above.

## Naming rules

1. **`agent` alone is never a name here.** Both daemons are qualified by the surface they serve.
   A qualifier only informs when its counterpart exists, so both get one or neither does.
2. **"Runner" belongs to GitHub's ephemeral entity.** Our daemon creates Runners; it is not one.
   The word also still appears in the retiring `runner-center-*` binaries and units. Those are
   legacy, not precedent.
3. Do not name a component after a property every component shares. "Edge", "outbound" and
   "NAT-traversing" describe both agents and therefore distinguish neither.
4. **Renaming rule for the merge: repository paths and workspace package names may change; no
   identifier a running system already holds may change.** Frozen for that reason, on Nodes:
   `portless-agent.service` and `erainfra-agent.service` (Hub-mode units the Node installer
   detects), `/etc/portless/agent.env`, `~/.portless` and `PORTLESS_PREFIX`, and the names the
   Convex-mode installer writes: `erainfra-node.service`, `/etc/erainfra-node.credential`,
   `/var/lib/erainfra-node`, `erainfra-mesh.service`, the `erainfra-mesh` user,
   `/var/lib/erainfra-mesh`, `/var/lib/erainfra/mesh-control` and `/usr/local/lib/erainfra`, and
   the `erainfra-gateway*` and `erainfra-relay*` units, users and directories that
   `deploy/infra/gateway.sh` and `relay.sh` write. On the fleet's registry Node: the
   `portless-registry` container and volume. On the retired Hub's host: the `portless-data` volume,
   which holds `portless.db`, the Hub's entire state and the rollback source; a renamed or deleted
   volume comes back empty. [ADR 0020](docs/adr/0020-the-hub-leaves-main.md) retired the names only
   the Hub used and lists them; the CI gate lets exactly those leave the tree. Retiring any other
   identifier is migration work with its own rollout.
   The npm package `@erainfra/agent` is frozen for a different reason: its `package.json` is packed
   into the attested release archive, so renaming it moves the published SHA-256.
   The Worker side's `RC_*` variables, `runner-center-*` units and paths and the `rc` command are
   frozen the same way. Each `RC_<NAME>` is also read as `ERAINFRA_<NAME>`, the new name first and a
   disagreement refused, and `erainfra worker` runs `rc`; the names themselves move only through
   [the phase-2 runbook](docs/runbooks/rename-phase-2.md).
