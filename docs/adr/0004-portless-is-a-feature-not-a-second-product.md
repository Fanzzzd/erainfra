# ADR 0004: Portless is a feature of EraInfra, not a second product

- Status: Accepted
- Date: 2026-08-17
- Owners: EraInfra

## Context

`feat: absorb portless — infra management joins the CI platform (#35)` moved Portless
into this repository. The title states the intent: Portless _joins_ the platform. The
execution did not match it. Portless was moved in as a directory, not adopted as a
member of the workspace, and eleven months of independent history came with it intact.

The evidence that Portless is currently a separate product sharing a repository:

- The root `pnpm-workspace.yaml` lists `apps/*` and `packages/*`. It does not include
  `portless`. Portless carries its own `pnpm-workspace.yaml`, `pnpm-lock.yaml`,
  `turbo.json`, and `package.json`.
- The toolchains have diverged: root pins pnpm 11.21.0, turbo 2.10.9 and TypeScript
  7.0.2; Portless pins pnpm 9.15.0, turbo 2.9.18 and TypeScript 6.0.3.
- Portless has no `lint` script, and CI invokes `pnpm run --if-present lint`, so the
  Portless tree — including the hub side of the privilege boundary added in #45 — has
  never been linted.
- `.github/workflows/release.yml` carries a workaround for the fork: a second
  `pnpm/action-setup` with its own `dest`, and the comment "Portless pins pnpm
  independently from the EraInfra root."
- Portless ships nothing. The `v0.2.0-rc.5` release contains seventeen assets and not
  one of them is a Portless artifact — yet `release.yml` tests, vets and cross-compiles
  two Portless Go modules on every release. **The release is gated on something it does
  not publish.**
- Portless has no version. Neither the Portless root nor `apps/api` declares one, while
  EraInfra's rule is that root, Agent, Controller and Runtime versions move together.
- `deploy/` contains a complete independent install and deploy path — `agent.sh`,
  `agent.ps1`, `hub.sh`, `cli.sh`, `image.sh`, `registry.sh` — that bypasses the
  `AGENT_RELEASE` pin-and-verify supply chain entirely.

## Decision

Portless is a **feature** of EraInfra: the infrastructure-management surface of a single
platform. It is not a second product that happens to live here.

Concretely, this means Portless is expected to converge on the platform's guarantees
rather than keep its own: one workspace, one toolchain, one lint and format gate, one
lockfile, and a release that ships what it gates on.

## Consequences

- The half-absorbed state is a defect to be repaired, not a layout to be preserved. Every
  divergence listed above is now a bug with an owner, not a property of the tree.
- A Go module merge becomes admissible. `portless-agent` requires
  `github.com/gorilla/websocket v1.5.3` — it is not, and never was, standard-library only,
  so the module boundary was not protecting a zero-dependency guarantee. What that boundary
  did provide is replaced by an explicit `go version -m` assertion on the shipped bytes.
- The naming collision must be resolved, because two things called "agent" cannot live in
  one `apps/`. See [CONTEXT.md](../../CONTEXT.md) for the resolved vocabulary.
- **The name "Portless" is retired** as a user-facing surface name. This does not follow
  automatically from the decision above — AWS keeps `ecs-agent` and Azure keeps
  `azure-pipelines-agent` precisely because an absorbed service may retain its own name, and
  an earlier draft of this ADR wrongly asserted that `portless-agent` was merely a vestige.
  Retirement is a separate, deliberate product choice: the infrastructure-management surface
  is described as part of EraInfra and gets no separate brand. The cost is a migration of the
  `portless-agent` binary and `portless-agent.service` unit on customer Nodes, which is
  sequenced after the merge rather than inside it.
- The Portless hub's `docker run -v "$REPO":/srv/portless` bind mount (`deploy/hub.sh:61,72`)
  becomes materially more dangerous under this decision. Today `$REPO` is Portless; after the
  merge `$REPO` is the entire CI platform, mounted into a container on a customer's hub box.
  Merging without addressing this would use the merge to enlarge a customer-facing exposure.
- Whether Portless remains independently installable — keeping `deploy/`'s `curl | sh`
  path — is a separate decision this ADR does not settle.

## Alternatives considered

**Keep Portless as a separate product and harden the boundary instead.** Give it its own
version, remove it from the release gate, and possibly its own workflow. This is the
cheaper and lower-risk change, and it would also fix the release-gates-what-it-does-not-ship
asymmetry. It was rejected because it contradicts #35's stated intent and forecloses sharing
between the two halves — for example the two independent `dockerargs` validators, which today
disagree on nine of ten probed inputs.

**Do the directory flatten without merging the supply chains.** Rejected as the worst
outcome available: a tree that looks merged while release, install and verification remain
two systems, which is harder to reason about than either honest end state.
