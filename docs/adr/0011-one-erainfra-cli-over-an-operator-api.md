# ADR 0011: One `erainfra` CLI over an operator API

- Status: Accepted
- Date: 2026-11-05
- Owners: EraInfra

## Context

An operator who wants to know which jobs failed on a Profile today, or which Workers are not ready,
has to open the dashboard. Blacksmith (`blacksmith jobs list`, `auth login`, org tokens,
`--format json|table`) and actuated (`actuated-cli jobs`, `runners`, `logs`, `--json`) both answer
those questions from a terminal and from scripts.

Two command-line tools already exist, and neither is the right home:

- `rc` is generated per Worker by `convex/installScript.ts`. It manages the one machine it runs on
  (`status`, `doctor`, `logs -f`, `update`) and holds that machine's token. It has no view of the
  fleet, and its name is the retired Runner Center name, kept only because Workers in the field call
  it (docs/runbooks/rename-phase-2.md).
- `portless` in `packages/cli` drives the Hub, the infrastructure-management surface. It talks to a
  different control plane, and its name is retired as a brand by ADR 0004. Its published package
  name is frozen by CONTEXT.md rule 4.

The Convex control plane exposed no authenticated read path other than the dashboard's own session.

## Decision

1. **The fleet CLI is called `erainfra`**, the product's name. ADR 0004 makes EraInfra one product
   with one brand, so the CLI carries no surface or legacy name: not `rc`, not `runner-center`, not
   `portless`. It lives in `apps/erainfra-cli`.

2. **It talks to a versioned HTTP API, `/api/v1`, with operator API tokens.** It does not call
   Convex functions directly. Convex function names are an implementation detail that has already
   moved (`machines`, `attempts`, `workerApi`), while a script needs a contract that holds across
   releases. The tokens are separate from dashboard sessions: minted by a signed-in operator in the
   dashboard, stored as a SHA-256 digest, revocable, and stamped with when they were last used.
   The API has no route that mints or lists tokens, so a leaked admin token cannot create its own
   replacement.

   They are the same tokens Prometheus scrapes `/metrics` with: one table, one dashboard list
   (Settings, API tokens), and a scope per token. `read` reads `/api/v1`, `admin` adds the admin
   route, and `metrics` scrapes and does nothing else, because a scrape token sits in Prometheus
   configuration, the most widely copied place a token ends up. #160 shipped metrics tokens in a
   table of their own; it was folded into this one before any deployment held a row, so two
   parallel token systems never reached the field.

3. **Admin routes exist only for actions the dashboard already offers**, and reuse its code. Today
   that is minting a Worker registration token (Add Worker). The dashboard has no pause or drain
   action, so neither does the API. When the dashboard gains one, the API route calls the same
   mutation body.

4. **It is a Go binary.** An operator's laptop or a CI job is not a Worker: it has no reason to hold
   a Node runtime, and the Agent's npm archive exists to make a Worker's install reproducible, not
   an operator's. A static Go binary is one file, cross-compiles from the existing release workflow
   for the Infra Agent's five targets, has no dependencies outside the standard library, and also
   installs with `go install`. The controller, runtime, cache service and Infra Agent are Go for
   the same reasons.

5. **One name, one program.** The name `erainfra` on a PATH means this binary. When the
   Worker-local tool is renamed in phase 2, it does not become a second program called `erainfra`;
   two programs with one name is the collision ADR 0005 exists to prevent. The fleet CLI reserves
   the `erainfra worker` command group for it, so the phase-2 rename can either dispatch from this
   binary to the local tool or ship the local verbs inside it.

6. **The Hub's commands join later.** When the Hub and the Convex control plane converge (the open
   question in ADR 0005), `portless` commands move under `erainfra` as further command groups. Until
   then `portless` stays as it is, because its package name is frozen.

## Consequences

- The control plane stores no job or Worker logs, so the CLI has no log endpoint to read. GitHub
  holds the job log: `erainfra jobs logs` runs `gh run view --log` when the GitHub CLI is installed
  and prints the run URL otherwise. A Worker's Agent log stays on the Worker (`rc logs`).
- The control plane does not record which Agent version a Worker runs, so `workers list` cannot
  report it. Adding it means the Agent sends its version on a heartbeat, which needs the backend
  deployed before the Agent release that sends it.
- Each release publishes five more assets, `erainfra-<os>-<arch>`, with SHA-256 sidecars and
  provenance attestation like every other binary.
- `jobs` is the CLI's noun because that is what an operator calls them and what Blacksmith and
  actuated call them. Each row is one Attempt; the API path says `attempts`, and the CLI accepts
  `attempts` as an alias.
