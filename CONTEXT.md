# EraInfra — domain context

The ubiquitous language for this repository. When a term below is written with a capital
letter in code, comments, docs or commit messages, it means _this_ and nothing looser.

EraInfra is one platform with two surfaces, both of which run on machines the customer owns:

- **CI execution** — run a GitHub Actions job in a disposable, verified isolation boundary.
- **Infrastructure management** — deploy and operate long-lived Apps on those machines.

The second surface arrived as a separate product called Portless. It is now a feature of the
platform and the name is retired — see [ADR 0004](docs/adr/0004-portless-is-a-feature-not-a-second-product.md).

## The two agents

|                     | **Action Runner Agent**                               | **Infra Agent**                                   |
| ------------------- | ----------------------------------------------------- | ------------------------------------------------- |
| lives at            | `apps/action-runner-agent`                            | `apps/infra-agent`                                |
| runs on             | a **Worker**                                          | a **Node**                                        |
| registers           | capacity per Profile                                  | itself, for management                            |
| claims work         | Attempts, experiments                                 | nothing — it is commanded                         |
| what it runs        | one disposable boundary per Attempt, then destroys it | long-lived **Apps** + allowlisted host operations |
| its work's lifetime | single-use                                            | persistent                                        |

Both dial out over an encrypted connection and hold no inbound port, so both work behind NAT.
That property is shared, which is why neither is named for it — see
[ADR 0005](docs/adr/0005-name-the-two-agents-by-what-they-serve.md).

## Terms

**Worker** — a customer machine that executes CI jobs. Reports readiness per Profile, and is only
scheduled onto when its own evidence proves the isolation contract it claims. A Worker that cannot
prove its contract is not ready; absence of a fact is never treated as a successful measurement.

**Node** — a customer machine that runs deployed Apps. Any Linux, macOS or Windows box, including
one behind NAT with no public IP.

**Action Runner Agent** — the daemon on a Worker. Registers the machine's capacity contract,
claims Attempts, and drives a provisioner that creates and destroys one isolation boundary per
Attempt. Machines install it with plain `npm install` from an archive pinned by SHA-256, which is
why it deliberately does not use the `catalog:` or `workspace:` protocols. Read the name as "the
agent that serves Action Runners" — **it is not itself a Runner.**

**Runner** — an ephemeral GitHub Actions runner: an object in _GitHub's_ database with a
`runner_id` that GitHub issues, created per Attempt through
`actions/runners/generate-jitconfig` and deleted when the Attempt ends. It runs **inside** the
isolation boundary with only a single-use JIT token. One Agent creates many Runners over its
lifetime. Never use "Runner" for either of our daemons.

**Infra Agent** — the daemon on a Node. Holds an outbound WebSocket to the Hub and executes only
allowlist-resolved operations; there is no raw-argv path. Also builds images and deploys Apps.

**Hub** — the control plane an Infra Agent connects to. Distinct from the Convex **control plane**
that Workers report to; the two have not been merged and the terms are not interchangeable.

**Profile** — the immutable contract a Worker advertises capacity against: executor, image
release, vCPUs, memory. Readiness is per Worker _and_ Profile.

**Attempt** — one execution of one CI job inside one disposable boundary. The isolation boundary
is per Attempt, never per Worker.

**App** — a customer workload deployed onto one or more Nodes, with its own Docker network.

**Executor** — the mechanism providing an Attempt's boundary: `docker` (shared-kernel),
`firecracker`, `tart`, or `hyperv` (all guest-kernel). The boundary a Profile may claim is
determined by its executor and is not negotiable per Worker.

**Boundary** — `guest-kernel` or `shared-kernel`. A security claim, not a description: a Worker
reporting a boundary weaker than its executor promises is refused.

**Readiness evidence** — the measured facts a Worker submits to justify a ready state, including
the network policy identity hash and thin-pool identity. Admission is fail-closed against it.

## Naming rules

1. **`agent` alone is never a name here.** Both daemons are qualified by the surface they serve.
   A qualifier only informs when its counterpart exists, so both get one or neither does.
2. **"Runner" belongs to GitHub's ephemeral entity.** Our daemon creates Runners; it is not one.
   The word also still appears in the retiring `runner-center-*` binaries and units — those are
   legacy, not precedent.
3. Do not name a component after a property every component shares. "Edge", "outbound" and
   "NAT-traversing" describe both agents and therefore distinguish neither.
4. **Renaming rule for the merge: repository paths and workspace package names may change; no
   identifier a running system already holds may change.** Frozen for that reason: the
   `portless-data` Docker volume (it holds `portless.db`, the Hub's entire state — `hub.sh` is
   idempotent by design and customers re-run it, so a renamed volume silently comes up empty, with
   no accounts, apps, routes or tokens, and CI cannot catch it because CI never runs `hub.sh`); the
   51 `PORTLESS_*` environment variables across ~70 files; `/etc/portless/agent.env`;
   `portless-agent.service`; the published npm package name; and the `agent-bin` download path.
   Retiring those identifiers is migration work with its own rollout, sequenced after the merge.
   The npm package `@erainfra/agent` is frozen for a different reason: its `package.json` is packed
   into the attested release archive, so renaming it moves the published SHA-256.
