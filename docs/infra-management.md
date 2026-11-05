# portless

Deploy to **your own machines** — no public IP, no open ports, no third-party PaaS.

A hub (control plane + dashboard) runs on one box behind a Cloudflare tunnel. Agents on your other
machines dial **out** to it over WSS, so everything works behind NAT/firewalls. Apps get automatic
`https://<app>.<your-domain>` URLs, served through the hub's single tunnel and reverse-proxied to
whichever node runs them.

```
   browser ──https──▶ Cloudflare ──tunnel──▶ hub ──ws──▶ agent(node A) ──▶ containers
   git push ─webhook─▶  hub: build → registry → deploy → route            │
   portless deploy ──▶                                        mesh (iroh) ┴── agent(node B)
```

Everything is self-hosted: your registry (`registry:2`), your S3 for backups, your GitHub App for
push-to-deploy. Builds use your Dockerfile, or [Nixpacks](https://nixpacks.com) when there isn't one.

## Use it

```sh
curl -fsSL https://<hub>/cli.sh | sh          # install the CLI (needs node >= 20)
portless login https://<hub>                  # sign in with your hub account (email+password)

portless deploy                               # deploy the current directory → live URL
portless apps                                 # what's running, where, with URLs
portless logs my-app                          # container logs
portless env my-app set DATABASE_URL=...      # encrypted secrets
portless link gpu-box:8080 web-box            # reach gpu-box:8080 from web-box at 127.0.0.1:8080
                                              #   (P2P mesh, no tunnel; persisted + self-healing)
```

AI agents get the same capabilities, typed, over MCP: `claude mcp add portless -- portless mcp`.

## portless.yaml

How a project deploys is written in the project — the platform executes it deterministically:

```yaml
services:
  web:
    build: . # Dockerfile or Nixpacks auto-detect
    port: 3000
    route: true # → https://<app>.<your-domain>
    needs: [db] # injects DB_HOST / DB_PORT
  db:
    image: 127.0.0.1:61050/postgres:16 # from YOUR registry
    port: 5432
    volumes: [pgdata:/var/lib/postgresql/data]
    # node: other-box   # optional placement; needs: wires cross-node over the mesh (iroh)
```

No `portless.yaml` → single service, built from the repo root, routed at the app name.

Same-node services reach each other by name (per-app docker network). Cross-node `needs:` are wired
over an encrypted P2P mesh link (hole-punched when possible) — the database never touches a public
domain. If a node dies, its apps auto-redeploy onto a survivor and the routes flip (stateless only).

## Stand up the infrastructure

**Hub** (a Linux box with docker + cloudflared + a CF origin cert):

```sh
PORTLESS_ZONE=example.com sh deploy/infra/hub.sh
```

That brings up the hub + dashboard (`https://portless.<zone>`), an OCI registry, a dedicated named
tunnel with a first-level wildcard (`*.<zone>` — Cloudflare's free Universal SSL covers exactly one
level), systemd units, and prints the enroll command.

**Nodes** (any Linux box; installs docker if missing, systemd-persisted):

```sh
curl -fsSL https://<hub>/agent.sh | sudo sh -s -- --token <plt_...> --name <name>   # token: dashboard Settings → API tokens (role: operator)
```

Windows: `deploy/infra/agent.ps1` (see `deploy/infra/WINDOWS.md`).

### Node privilege boundary

Treat every Portless node as a privileged service boundary, not as an unprivileged sandbox. On
Linux, the `sudo` installer currently creates `portless-agent.service` without a `User=` directive,
so the agent runs as root. A foreground/non-root agent that can access the Docker socket (including
through membership in the `docker` group) is also effectively root-capable on that node; Docker-group
execution is **not** unprivileged isolation.

The control protocol reduces the exposed authority: `operator` credentials may deploy containers,
host operations require `agent.run`, host operations are resolved from a node-side allowlist, and
Docker flags that request host namespaces, bind mounts/sockets, devices, capabilities, or security
profile changes are rejected at both hub and node. Those checks limit remote requests; they do not
make a compromised hub, agent binary, Docker daemon, or privileged node account harmless. Use
dedicated nodes with a blast radius appropriate for the workloads and keep the hub/admin credentials
inside the same trust domain.

**Push-to-deploy**: create a GitHub App (webhook → `https://<hub>/webhook/github`), set
`PORTLESS_GH_*` on the hub, bind a repo (`portless bind owner/repo`). Public repos also work without
an App via `portless redeploy`.

## State in Convex

[ADR 0016](adr/0016-nodes-meet-over-iroh-and-keep-state-in-convex.md) moves the Hub's state out of
`portless.db` and into the Convex deployment that already runs the CI control plane. The code is in
`packages/backend/convex/infra/`. Until the last migration step the Hub stays the source of truth
and Convex holds a copy.

| Hub table      | Convex table                   | Invariant, now kept by a transaction                                             |
| -------------- | ------------------------------ | -------------------------------------------------------------------------------- |
| `users`        | `users` (Convex Auth)          | unique email; the first account is the owner; the last owner cannot be removed   |
| `api_tokens`   | `apiTokens`, `nodeCredentials` | one token system; each Node gets its own credential                              |
| `routes`       | `appRoutes`                    |                                                                                  |
| `apps`         | `apps`                         |                                                                                  |
| `links`        | `meshLinks`                    |                                                                                  |
| `ports`        | `portAllocations`              | one port per (Node, key), stable across redeploys; one key per (Node, port)      |
| `secrets`      | `appSecrets`, `appDataKeys`    | envelope-encrypted; no query returns a value                                     |
| `git_bindings` | `gitBindings`                  | (repository, branch) unique; at most 200                                         |
| `deployments`  | `appDeployments`               | newest 1000 kept; a run whose lease lapsed is failed by a cron                   |
| `audit`        | `auditEvents`, `infraCounters` | a gapless sequence in commit order; a dangerous action is audited before it runs |
| (none)         | `nodes`                        | one row per Node, keyed by its iroh EndpointId once phase 1 registers one        |
| (none)         | `appLeases`                    | one deploy or failover per App at a time; a stale holder is refused by its epoch |
| (none)         | `webhookDeliveries`            | a push delivery queues at most one deploy, keyed by `X-GitHub-Delivery`          |

Other tables reference a Node by its Convex id, not its name, so a Node's identity can move from the
name it announced to the Hub to its iroh EndpointId without rewriting them.

**One identity system.** Hub accounts become Convex Auth accounts with a permission role
(`owner`, `admin`, `operator`, `viewer`) and the Hub's permission table (`infra/policy.ts`; the
Hub's `agent.run` is `node.run`). An account created before roles existed reads as `owner`, which is
what it could already do. The CI dashboard's functions admit `owner` and `admin` only, so an imported
`viewer` cannot use them. Dashboard API tokens keep their scopes: `read` grants what a Hub viewer
had, `admin` adds deploying and running Node operations, and no token administers accounts. A Node
authenticates with an `erainfra_node_` credential that an admin issues for that one Node, replacing
the shared `operator` token. An imported account signs in with its Hub password; the Hub's scrypt
hash is verified as is until the password is next reset.

**Secrets** are encrypted with a random data key per App, and the data keys are encrypted with a
master key you hold in the Convex environment. Generate one and set it before importing:

```sh
pnpm convex env set ERAINFRA_SECRETS_MASTER_KEY "$(openssl rand -hex 32)"
```

Keep a copy somewhere safe. Without it the stored secrets cannot be decrypted, and Convex fails
closed rather than generating a new one. A value leaves Convex only through the internal
`infra/secrets:forNodeDeploy`, for a deploy that targets the asking Node and still holds its App's
lease.

### Rotate ERAINFRA_SECRETS_MASTER_KEY

Master-key rotation is follow-up work. Today, replacing `ERAINFRA_SECRETS_MASTER_KEY` makes existing
App data keys unreadable; the stored fingerprint detects the mismatch and secret reads and writes
fail closed. Keep the current master key backed up and do not replace it in place. A rotation tool
must unwrap each App data key with the old master key and re-wrap it with the new one, with an
explicit transition that accepts both key versions until every App has moved. The encrypted secret
values themselves need not change.

### Migration order

1. Phase 1: `erainfra-mesh` replaces dumbpipe, still brokered by the Hub.
2. Phase 2a (now): Convex holds the state and its invariants, and the importer copies the Hub into
   it. Nothing reads the copy yet.
3. Phase 2b: the Infra Agent dials Convex with its Node credential, registers its EndpointId, and
   reads secrets for deploys addressed to it.
4. Phase 3: gateway ingress, the deploy pipeline and failover run from Convex, the CLI and dashboard
   follow, and the Hub is retired.

Run the importer on the Hub's host, where `portless.db` and `secret.key` are (the state directory
inside the `portless-data` volume). Start with `--dry-run`, which reads everything and sends nothing:

```sh
CONVEX_URL=https://<deployment>.convex.cloud CONVEX_DEPLOY_KEY=<deploy key> \
  pnpm --filter @erainfra/backend import-hub-state \
    --db /abs/path/portless.db --secret-key /abs/path/secret.key --dry-run
```

Drop `--dry-run` to import. A run is safe to repeat: rows are keyed on the Hub's keys, so each run
makes Convex match the Hub, and re-run it right before each later phase switches a reader over. It
keeps port numbers, audit order and timestamps, Hub ids (`legacyId`, `legacyHubId`, `hubSeq`),
creation times, password hashes and secret values (re-encrypted). It refuses, without writing that
batch, a port another key already holds on the same Node or a binding that would duplicate one. It
does not copy:

- sessions: people sign in to the dashboard again;
- Hub API tokens (`plt_…`): the importer lists each one. Replace CLI tokens with dashboard API
  tokens, and give each Node its own credential in phase 2b;
- the AI transcript archive (`chat_*`), which is not control state and stays on the Hub for now.

## Develop

Run from the repository root — this is one workspace with the rest of EraInfra, so scope the
commands to the two packages rather than starting the whole platform.

```sh
pnpm install
pnpm --filter @erainfra/hub dev       # hub :8787
pnpm --filter @erainfra/hub-web dev   # dashboard (vite)
pnpm test                             # hermetic — no docker, no network, no infra
```

- `apps/hub` — hub: Fastify + tRPC control plane, data plane (wildcard ingress over agent WS),
  deploy pipeline (`runtime/appdeploy.ts`), failover, secrets, backups.
- `apps/infra-agent` — Go agent: outbound WS, docker deploys, builds, mesh links (dumbpipe/iroh).
- `packages/cli` — the `portless` CLI + MCP server. Zero dependencies.
- `apps/hub-web` — dashboard (React + shadcn).
- `deploy/infra/` — `hub.sh`, `agent.sh`, `image.sh` (build), `registry.sh`, `cli.sh`.
- `apps/hub/scripts/verify/` — the end-to-end harnesses (fresh box, multi-node, WSL, Windows,
  failover). Not run by `pnpm test`: they need docker and real machines.
