# ADR 0005: Name the two agents by what they serve

- Status: Accepted
- Date: 2026-08-17
- Owners: EraInfra

## Context

[ADR 0004](0004-portless-is-a-feature-not-a-second-product.md) makes Portless a feature of
EraInfra and retires "Portless" as a user-facing name. That leaves two daemons in one `apps/`
directory that were both called some variant of "agent", which is not survivable.

The two are genuinely different things:

|                      | on a **Worker**                                                                     | on a **Node**                                     |
| -------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------- |
| registers            | capacity per Profile (`executor`, `imageRelease`, `vcpus`, `memoryMiB`, `warmPool`) | itself, for management                            |
| claims               | Attempts, experiments, legacy commands                                              | nothing; it is commanded                          |
| runs                 | one disposable boundary per Attempt, then destroys it                               | long-lived Apps, plus allowlisted host operations |
| lifetime of its work | single-use, torn down on every exit path                                            | persistent                                        |

Both dial out and hold no inbound port. Both run on machines the customer owns, including
behind NAT.

## The naming principle this rests on

**A qualifier only carries information when the unqualified alternative also exists.**

`ecs-agent` informs because `ssm-agent` exists alongside it. Portainer's `edge agent` informs
because Portainer also ships a plain `agent` that the server dials _into_. A qualifier naming a
property that everything in the system shares teaches the reader nothing.

Surveyed prior art, all of which qualifies by the _service the agent serves_ rather than by a
functional adjective: `amazon-ecs-agent`, `amazon-ssm-agent`, `codedeploy-agent`, Azure Monitor
Agent, Azure Pipelines Agent, Azure Connected Machine agent (`azcmagent`), `oracle-cloud-agent`,
`gitlab-runner`, GitLab Agent for Kubernetes (`agentk`), `datadog-agent` / Cluster Agent,
`cattle-node-agent` / `cattle-cluster-agent`.

AWS ECS Anywhere is the closest structural precedent: an external instance the customer owns
must run **both** `amazon-ssm-agent` (management) and `amazon-ecs-agent` (registers capacity,
runs workloads). Two agents, two names, one machine, one platform — and neither is bare.

## Decision

```text
apps/action-runner-agent   the Action Runner Agent — on a Worker
apps/infra-agent           the Infra Agent          — on a Node
```

Read `action-runner-agent` as "the agent that serves Action Runners", exactly as `ecs-agent` is
"the agent that serves ECS" and is not itself an ECS. It is not a Runner; see below.

The two names are each other's counterpart, so both carry information: a reader who sees one
learns what the other is not.

## Consequences

- **"Runner" is reserved for the ephemeral, GitHub-issued entity**, never for our daemon. A
  Runner is an object in GitHub's database with a `runner_id` GitHub assigns
  (`convex/github.ts:122` creates one per Attempt via `actions/runners/generate-jitconfig`;
  `:197` deletes it). The cardinality is one Agent to many Runners, and they sit on opposite
  sides of the isolation boundary — the Agent on the host with credentials, the Runner inside a
  disposable microVM with a single-use JIT token. Collapsing both into "runner" would make the
  product's central sentences unsayable: "the Agent registered a Runner", "the Runner cannot
  reach the host", "Firecracker teardown after Agent crashes" (#40).
- GitHub itself observes this split. Actions Runner Controller names the manager a **Listener**
  and reserves **`EphemeralRunner`** for the unit that runs the workflow.
- `action-runner-agent` hard-codes GitHub Actions into the name. Accepted knowingly: the product
  is GitHub-only today. Adding a second forge would make this name a liability and is the one
  scenario in which it should be revisited.
- Renaming `apps/agent` touches 13 in-repo files. The published asset name
  `erainfra-agent-<version>.tar.gz` is a hardcoded string in `packages/release/src/agent-archive.ts`
  and is decoupled from the directory, and archive entry prefixes are content-relative
  (`dist/`, `provisioners/`), so the directory rename is invisible to machines in the field.
- The asset rename is therefore **deferred** and should ride along with the unfinished
  `runner-center` → `erainfra` migration (66 files, 14 published assets, 4 systemd units still
  carry the old name), which already needs the install-script fallback pattern that
  `convex/installScript.ts:335` established.
- Retiring "Portless" requires migrating `portless-agent.service` and the
  `agent-bin/portless-agent-<target>` download path on customer Nodes. Sequenced after the merge,
  not inside it, because a mistake here silently disconnects live Nodes.
- Still open, and not settled here: the Node-side control plane is currently the **Hub**, separate
  from the Convex control plane Workers report to. Whether those converge is an architecture
  question, not a naming one.

## Alternatives considered

**`apps/agent` (bare) + a qualified second name.** The Datadog and Blacksmith shape — Blacksmith
calls its host-level VM-lifecycle daemon simply "agent", with `blacksmithd` inside the VM.
Rejected because a bare name is the ambiguity, not a solution to it; Datadog's asymmetry is a
historical artifact of the node agent predating the cluster agent, not a design choice worth
inheriting.

**`runner-agent` / `action-runner`.** `action-runner` without the `-agent` suffix is rejected
outright: it is one letter from `ghcr.io/actions/actions-runner` (`convex/catalog.ts:23`), which
this codebase pulls, and from the `actions/runners` REST resource it creates and deletes.
`runner-agent` is defensible under the `<service>-agent` reading and was the runner-up; the longer
form was chosen because it is unambiguous next to the `runner-center-*` binaries that will coexist
with it until that migration finishes.

**`edge-agent`.** Has real precedent in Portainer and accurately describes an outbound,
NAT-traversing agent. Rejected because it is equally true of _both_ agents here, and both READMEs
advertise it as a headline feature — EraInfra's says "a Worker behind NAT, a home router, or a
corporate firewall participates like any other", Portless's says "machines dial out to it over WSS,
so everything works behind NAT/firewalls". A qualifier naming a universally-held property is
uninformative, and implying the other agent is not "edge" would be false.

**`worker-agent` / `node-agent`.** Names each agent after the machine it runs on, following
`cattle-node-agent` and Kubernetes' description of kubelet as "the node agent". Genuinely viable
and symmetric. Rejected narrowly: `node-agent` reads as "the Node.js agent" in a TypeScript
monorepo where `node` appears constantly, and naming by the served surface survives a future where
one machine is both a Worker and a Node (deliberately left open by keeping Worker and Node distinct).

**`ci-agent` / `infra-agent`.** The original instinct, and the accepted decision is its close
relative. `ci-agent` was replaced by `action-runner-agent` because no surveyed system names an
agent after a functional adjective; every one qualifies by a service name. `infra-agent` keeps the
functional form despite that, because the surface it serves has no other name once "Portless" is
retired, and because it is accurate about the full job — host operations _and_ App orchestration —
where `deploy-agent` would be too narrow.
