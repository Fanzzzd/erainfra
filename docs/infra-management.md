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

`agent.sh` installs dumbpipe, not the `erainfra-mesh` sidecar. Its Nodes' cross-node links run on
the legacy, unauthenticated dumbpipe transport, and `portless links` marks them
`legacy-dumbpipe (unauthenticated)`. To move them onto the authenticated mesh, install the Node
with the control plane's `/install --role node --mesh`
([secure-node-mesh.md](runbooks/secure-node-mesh.md)).

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
| (none)         | `appLeases`                    | one live lease per App; fenced Convex writes reject a stale epoch                |
| (none)         | `webhookDeliveries`            | a push delivery queues at most one deploy, keyed by `X-GitHub-Delivery`          |

Other tables reference a Node by its Convex id, not its name, so a Node's identity can move from the
name it announced to the Hub to its iroh EndpointId without rewriting them.

App lease epochs fence Convex state transitions only. They cannot cancel an old holder's in-flight
runtime request or guarantee exactly-once external side effects. Before enabling the deploy and
failover command paths, those paths must carry stable operation/step idempotency keys, and the
runtime must reject stale fencing epochs and deduplicate retries. Phase 2a does not implement that
runtime protocol.

**One identity system.** Hub accounts become Convex Auth accounts with a permission role
(`owner`, `admin`, `operator`, `viewer`) and the Hub's permission table (`infra/policy.ts`; the
Hub's `agent.run` is `node.run`). An account created before roles existed reads as `owner`, which is
what it could already do. The CI dashboard's functions admit `owner` and `admin` only, so an imported
`viewer` cannot use them. Dashboard API tokens keep their scopes: `read` grants what a Hub viewer
had, `admin` adds deploying and running Node operations, and no token administers accounts. A Node
authenticates with an `erainfra_node_` credential that an admin issues for that one Node, replacing
the shared `operator` token. An imported account signs in with its Hub password; the Hub's scrypt
hash is verified as is until the password is next reset.

**Secrets** belong to a scope, which is an App plus an optional service. The App-wide scope
(`infra/secrets:set` with `app` only) is common environment for every service of the App. A
service-private scope (`app` and `service`) reaches that one service only. Both names follow the
App naming rule, and the scope is stored as two fields, never joined into one string. App and
service names may contain `-`, so the Hub's `<app>-<service>` string `web-api` named both service
`api` of App `web` and App `web-api`.

Each scope's values are encrypted with a random data key for that scope, and the data keys are
encrypted with a master key you hold in the Convex environment. The associated data of every
encryption is a JSON array of the App, the service and the variable name, so a row moved to
another scope or name fails to decrypt. Generate a master key and set it before importing:

```sh
pnpm convex env set ERAINFRA_SECRETS_MASTER_KEY "$(openssl rand -hex 32)"
```

Keep a copy somewhere safe. Without it the stored secrets cannot be decrypted, and Convex fails
closed rather than generating a new one. A value leaves Convex only through the internal
`infra/secrets:forNodeDeploy`, for a deploy that targets the asking Node and still holds its App's
lease. Each targeted Node that hosts at least one service receives the App-wide scope, which is
common environment injected into every service. It receives a service's private scope only when
`(service.nodeId ?? app.nodeId)` names that Node. A targeted Node hosting no services is refused.
A single-container deploy with no `apps` row uses `targetNodeIds` as its placement record and
receives only the App-wide scope. Put values that other service hosts must
not see in a service-private scope, not the App-wide scope.

### Rotate ERAINFRA_SECRETS_MASTER_KEY

Master-key rotation is follow-up work. Today, replacing `ERAINFRA_SECRETS_MASTER_KEY` makes existing
data keys unreadable; the stored fingerprint detects the mismatch and secret reads and writes fail
closed. Keep the current master key backed up and do not replace it in place. A rotation tool must
unwrap each scope's data key with the old master key and re-wrap it with the new one, with an
explicit transition that accepts both key versions until every scope has moved. The encrypted
secret values themselves need not change.

### Migration order

1. Phase 1: `erainfra-mesh` replaces dumbpipe, still brokered by the Hub. Opt-in installation,
   migration and rollback are in [secure-node-mesh.md](runbooks/secure-node-mesh.md).
2. Phase 2a (now): Convex holds the state and its invariants, and the importer copies the Hub into
   it. Existing Hub-mode Nodes do not read the copy.
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

The Hub keyed secrets on one string, `<app>` or `<app>-<service>`, so the importer splits each one
against the Hub's own Apps (`apps` and single-container `routes`) and their services:

- `web-api` is an App and no App `web` has a service `api`: App `web-api`'s App-wide scope.
- App `web` has a service `api` and `web-api` is not an App: service `api` of App `web`.
- Both are true: the importer refuses. The Hub gave those variables to both, and no reading is
  safe to guess. Rename the App or the service on the Hub, or unset the variables there and set
  them in Convex after the import with an explicit `service`.
- Neither is true and the string contains `-`: the importer refuses, since nothing says where the
  split is. Unset the variables on the Hub, or deploy the App they belong to.

A string with no `-` that names no known App is imported as that App's App-wide scope, its only
reading. Refusals happen while reading the Hub, before anything is sent, so `--dry-run` reports
them and a refused run writes nothing. The error names every scope it could not resolve.

## Opt-in Convex Node transport (phase 2b)

`connect-convex` is a separate Infra Agent mode. Existing `connect` processes, `PORTLESS_*`
settings, service units and installer defaults do not change. No live Hub database is imported by
this mode. Use it on a test Node with state deliberately created in Convex. Gateway ingress, the
build/deploy pipeline, failover scheduling and the CLI/dashboard migration remain phase 3 work.

Build the Infra Agent from a checkout containing this mode, or use a release that includes it.
An authenticated owner/admin issues a credential with `infra/nodes:enroll`. Put the returned
`erainfra_node_…` value in a 0600 file. This credential is for one Node, not an operator or shared
fleet token. On Linux/macOS, stop any existing Hub-connected process before starting the opt-in
process, use a private persistent directory, and keep the credential out of argv:

```sh
install -d -m 0700 /var/lib/erainfra-node
# Write the enrollment credential to /etc/erainfra-node.credential, mode 0600.
env -u PORTLESS_HUB -u ERAINFRA_HUB \
  ERAINFRA_CONVEX_SITE=https://<deployment>.convex.site \
  ./infra-agent connect-convex \
    --credential-file /etc/erainfra-node.credential --state-dir /var/lib/erainfra-node
```

`ERAINFRA_NODE_CREDENTIAL_FILE` and `ERAINFRA_NODE_STATE_DIR` can supply the two paths instead.
`ERAINFRA_NODE_CREDENTIAL` is an alternative to the file, not an additional credential. Both modes
refuse mixed Hub/Convex configuration. There is no fallback to a Hub token or a simultaneous Hub
data channel. The journal requires private POSIX permissions and directory fsync; Windows opt-in
needs separate ACL/durability validation before support. This command does not install a service
or switch an existing service's defaults.

### Node API and execution

The versioned API is `/api/v1/nodes/`, on the Convex **site** origin. Every route requires the
per-Node credential, derives the Node from its digest, and checks revocation again in the database
transaction. No request accepts a Node id to select a different Node. Operator API tokens are
refused here; Node credentials are refused on the operator API.

| Method | Path                 | Purpose                                                         |
| ------ | -------------------- | --------------------------------------------------------------- |
| POST   | `heartbeat`          | publish Infra Agent version/liveness                            |
| GET    | `state?revision=…`   | conditional full mesh snapshot; unchanged responses omit data   |
| GET    | `commands?cursor=…`  | at most 25 unsettled commands; opaque pagination cursor         |
| POST   | `commands/claim`     | atomically claim one addressed command, returning its epoch     |
| POST   | `commands/renew`     | renew a live claim, with owner and epoch                        |
| POST   | `commands/payload`   | claim-gated operation or placed deployment services and secrets |
| POST   | `commands/result`    | report only `success`, `failure` or `unknown`                   |
| POST   | `endpoint/challenge` | request a one-use key-possession challenge for an EndpointAddr  |
| POST   | `endpoint`           | publish that address with its signed challenge                  |

Humans enqueue through `infra/nodeCommands:enqueue`, with `node.run` for the existing Go operation
allowlist or `app.deploy` for deployment commands. The enqueue and durable audit row commit in one
transaction. A deployment command references an active deployment on the target Node, uses the
stored App specification, and requires the matching live App lease epoch and operation
(`deploy` or `failover`). This API does not start the phase-3 pipeline or create a deployment for
it. No raw argv, script, caller environment or source/build URL is accepted. The server and Go
executor both validate operations and Docker arguments. Use a stable idempotency key per intended
operation/step, such as App revision plus Node and step. Reusing a key for different work is refused.

Commands are delivered at least once. A 60-second claim lease fences Convex payload/result writes;
the Infra Agent renews every 10 seconds and cancels the child context if renewal fails or the
operator calls `infra/nodeCommands:cancel`. Cancellation cannot undo an effect already performed.
The command lease does not extend the App lease: the deploying coordinator must keep that lease
live too, or payload/result requests are refused. Execution is sequential per Node, which also prevents parallel commands for the same App. A local
append-only journal fsyncs acceptance before an effect and its outcome before reporting. On restart,
accepted-but-unfinished work becomes `unknown`; a restart/deploy with an interrupted outcome is
never automatically repeated. Failed result delivery replays the journaled outcome, not the effect.
No output, environment or secret is journaled or uploaded as a result. Child output capture is
bounded to 16 KiB per subprocess, HTTP bodies to 256 KiB, and execution to 10 minutes.

Keep the state directory across upgrades, outages and rollbacks. It is locked against another local
process and bound to the Convex origin and Node. Do not enroll a second machine with the same Node
credential or delete/copy its journal to bypass the lock. The journal stops accepting new work at
10,000 keys or 16 MiB; a torn record fails closed for manual recovery. Unknown outcomes require
inspection of the actual workload before a human deliberately issues a new operation key. Lease
epochs and the local journal do not provide globally exactly-once external effects across cloned
hosts or loss of the journal.

The client uses bounded HTTPS polling, not a generic Convex WebSocket or a sleeping action. Busy
polling is about one second; idle/error backoff doubles from 2 to 30 seconds, with ±20% jitter.
Healthy idle Nodes therefore usually see newly queued commands within about 36 seconds, plus
network latency, at roughly six HTTP requests per minute. Heartbeats are sent on polls at least
15 seconds apart, so an idle heartbeat can be 36 seconds apart. Revision matching saves response
bytes, not database reads. Mesh snapshots refuse more than 500 Apps, 500 standalone links or 2000
combined links rather than silently returning partial grants. Larger fleets need a more incremental
state feed before enabling this path at scale.

### Mesh contract and key possession

The full desired snapshot is `convexnode.DesiredMesh` in the Go client:
`{v:1,fleet:[{id,relay_urls,direct_addrs}],relays:{relays,n0_fallback},exposures,links}`.
It is derived only from standalone `meshLinks` and declared App dependency links involving this
Node. Each exposure has the exact declared consumers' `allowed_peers`, never the whole fleet.
Peers without a successful key-possession proof are omitted. Addresses retain all relay URLs in
`nodes.meshAddress`; the phase-2a singular `endpointAddr.relayUrl/directAddresses` has an explicit
legacy conversion and is never silently treated as the Rust wire shape.

A future reconciler maps this snapshot to #181's NDJSON v1 `set_fleet`, `set_relays`, `expose` and
`link`, and removes absent names with `unexpose`/`unlink`. Missing/empty grants deny all. This PR
only saves `desired.json`; it does not launch or configure a sidecar, gateway or ingress proxy.
The phase-1b worker owns the reusable Go mesh client/reconciler and legacy Hub adapter.

Endpoint registration signs a server-generated UTF-8 message of at most 4096 bytes:
`erainfra/node-endpoint/v1\n` followed by JSON containing the authenticated Node id, credential id,
random 256-bit nonce and exact `{id,relay_urls,direct_addrs}` address. The challenge expires after
60 seconds and is consumed once. Its Ed25519 signature is verified with pinned pure-JavaScript
`@noble/curves`; no unverified EndpointId is accepted through HTTP. The coordinated sidecar
extension is `{v:1,op:"sign_challenge",message}` returning a base64 `signature` and `endpoint_id`.
The registration path remains provisional until that sidecar operation/client is integrated; the
Go poller does not publish `status` as if it proved key possession.

To roll back, stop `connect-convex`, unset its configuration, and restore the original Hub `connect`
command and environment. Keep the Node journal even while the Hub serves it. Do not run both
controllers against the same workloads: the Hub cannot observe Convex leases or journal outcomes.

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
- `apps/infra-agent` — Go agent: outbound WS, docker deploys, builds, opt-in authenticated `erainfra-mesh` links.
- `packages/cli` — the `portless` CLI + MCP server. Zero dependencies.
- `apps/hub-web` — dashboard (React + shadcn).
- `deploy/infra/` — `hub.sh`, `agent.sh`, `image.sh` (build), `registry.sh`, `cli.sh`.
- `apps/hub/scripts/verify/` — the end-to-end harnesses (fresh box, multi-node, WSL, Windows,
  failover). Not run by `pnpm test`: they need docker and real machines.
