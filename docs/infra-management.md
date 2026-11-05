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
runtime request or guarantee exactly-once external side effects. The deploy pipeline and failover
([Deploy and failover from Convex](#deploy-and-failover-from-convex-phase-3a)) therefore give every
Node step a deterministic idempotency key, and the Infra Agent's journal replays the recorded
outcome of a re-delivered step instead of running it again.

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
3. Phase 2b (opt-in): the Infra Agent dials Convex with its Node credential, proves and registers
   its EndpointId, links to other Nodes from Convex's mesh snapshot, and reads secrets for deploys
   addressed to it. See [Opt-in Convex Node transport](#opt-in-convex-node-transport-phase-2b).
4. Phase 3a (now): the deploy pipeline, push-to-deploy and failover run from Convex for Nodes in
   `connect-convex` mode.
5. Phase 3b: gateway ingress serves public traffic from the `appRoutes` table.
6. Phase 3c: the CLI and dashboard move to Convex, and the Hub is retired.

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

`connect-convex` is a separate Infra Agent mode. In it the Infra Agent takes commands from Convex,
publishes its `erainfra-mesh` endpoint to Convex with a proof that it holds the key, and links to
other Nodes from the mesh snapshot Convex derives for it. Existing `connect` processes,
`PORTLESS_*` settings, service units and installer defaults do not change. Use it on test Nodes
first. Deploys and failover for these Nodes run from Convex
([phase 3a](#deploy-and-failover-from-convex-phase-3a)); gateway ingress and the CLI and dashboard
still need the Hub (see [What still needs the Hub](#what-still-needs-the-hub)).

### Set up a Node

Run these steps for each Node. Both ends of a link must run `connect-convex`: a Node in Hub mode
never publishes an endpoint to Convex, so Convex never names it as a peer.

1. **Enroll the Node.** An owner or admin calls `infra/nodes:enroll` with the Node's name. The CLI
   runs a function as a signed-in person with `--identity`, whose `subject` is your `users` row id
   (shown in the Convex dashboard's data view) followed by `|` and any session label:

   ```sh
   npx convex run infra/nodes:enroll '{"name":"edge-1"}' \
     --identity '{"subject":"<users _id>|cli"}'
   ```

   The result holds the `nodeId` and an `erainfra_node_…` credential, shown once. Enrolling a name
   again issues another credential for the same Node.

2. **Store the credential** on the Node in a 0600 file, for example
   `/etc/erainfra-node.credential`. It is for this one Node, not an operator or fleet token.

3. **Give the Node a sidecar.** Build `erainfra-mesh` (`cargo build --release` in `apps/mesh`) or
   take it from a release that ships it, then pick one:
   - As an ordinary user, set `ERAINFRA_MESH_BIN=/path/to/erainfra-mesh`. The Infra Agent creates
     the endpoint key on first start and supervises the sidecar under
     `$ERAINFRA_PREFIX/run/mesh-control/sidecar` (default `~/.portless`). Keep that directory: the
     key in it is the Node's mesh identity.
   - With the `erainfra-mesh.service` that `/install --role node --mesh` sets up (see
     [secure-node-mesh.md](runbooks/secure-node-mesh.md)), stop and disable the Hub-mode
     `portless-agent.service`, then set `ERAINFRA_MESH_SOCKET=/run/erainfra-mesh/control.sock` and
     `ERAINFRA_MESH_CONTROL_DIR=/var/lib/erainfra/mesh-control`.

   With neither variable set, `connect-convex` still runs commands, but it publishes no endpoint
   and the Node has no mesh links. Windows is not supported for the sidecar in this mode.

4. **Pick the relay policy.** Each Node reads it from its own environment, with the names the Hub
   uses: `ERAINFRA_MESH_RELAYS` (a JSON array of `https` relay URLs, default `[]`),
   `ERAINFRA_MESH_RELAY_TOKEN` and `ERAINFRA_MESH_N0_FALLBACK` (`true` or `false`, default
   `false`). Convex stores no relay token, so the snapshot's `relays` field is ignored. Two Nodes
   that are both behind NAT need a relay.

5. **Start the agent** with a private persistent state directory and the credential out of argv:

   ```sh
   install -d -m 0700 /var/lib/erainfra-node
   env -u PORTLESS_HUB -u ERAINFRA_HUB \
     ERAINFRA_CONVEX_SITE=https://<deployment>.convex.site \
     ERAINFRA_MESH_BIN=/usr/local/bin/erainfra-mesh \
     ./infra-agent connect-convex \
       --credential-file /etc/erainfra-node.credential --state-dir /var/lib/erainfra-node
   ```

   `ERAINFRA_NODE_CREDENTIAL_FILE` and `ERAINFRA_NODE_STATE_DIR` can supply the two paths instead.
   `ERAINFRA_NODE_CREDENTIAL` is an alternative to the file, not an additional credential. Both
   modes refuse mixed Hub/Convex configuration, and there is no fallback to a Hub token. The journal
   requires private POSIX permissions and directory fsync. This command does not install a service.

   Within a few seconds the log shows `published mesh endpoint <EndpointId>`, then
   `applied mesh snapshot <revision> (<n> peers, <n> exposures, <n> links)`. The applied snapshot,
   without any relay token, is also written to `desired.json` in the state directory.

6. **Declare links.** Convex has no link command before phase 3. Declare the link on the Hub
   (`portless link`, or `needs:` in an App) and re-run the Hub importer (above). Each Node picks
   the change up on its next snapshot poll.

A Hub-mode agent and a `connect-convex` agent can never drive one sidecar at the same time. Each
takes an exclusive lock on `controller.lock` in its control directory and another on the directory
that holds the sidecar's socket, so the second one exits at startup with
`mesh already has a controller`, even when the two use different control directories.

### Endpoint publication and the snapshot

The agent publishes the sidecar's `status.addr`, `{id, relay_urls, direct_addrs}`, the shape
`set_fleet` takes. Each publication is three steps: `endpoint/challenge` with the address, the
sidecar's `sign_challenge` over the returned message, and `endpoint` with the signature. Addresses
are sorted and cut to Convex's limits (8 relay URLs, 16 direct addresses of at most 128 bytes).
The agent reads the sidecar's status every 5 seconds. It publishes a changed address once the
address has held for 3 seconds, and at most once every 30 seconds, so a Node switching networks
publishes once rather than on every poll.

Nothing is applied to the sidecar until this process has published its key. After that the agent
asks for `state?revision=<last applied>` every 10 seconds. An unchanged revision returns no data and
applies nothing. A new one goes through the same Reconciler Hub mode uses, which removes exposures
and links missing from the snapshot before granting new ones. If the sidecar loses its exposures or
links (a restart without its state file), the agent applies the last snapshot again. A snapshot
Convex refuses, for example one with conflicting link names, keeps the last applied one and is
logged; commands keep running, because the mesh loop is separate from command polling.

A Node's EndpointId is fixed once registered. If the sidecar presents another key (a lost or
replaced `endpoint.key`), Convex refuses it with `endpoint_key_changed` and the agent logs, every
ten minutes:

```text
connect-convex: ERROR: Convex refused mesh key <new>: this Node is registered as <old>. ...
```

It does not retry. The Node's mesh links stay down until either the original key is restored or an
owner/admin confirms the change with
`npx convex run infra/nodes:resetEndpoint '{"nodeId":"<id>"}' --identity '…'`. The agent sees the
reset in its next heartbeat and publishes the new key; peers pick it up on their next snapshot. A
key already registered to another Node is refused with `endpoint_in_use`; give the Node its own key
(a copied key file is the usual cause) and restart the agent.

### Revoke or re-enroll a Node

`infra/nodes:revokeCredential` takes effect on the Node's next request. Revoking a Node's last
live credential also clears its endpoint registration, so it drops out of every peer's snapshot at
once and peers close its connections when they apply it. Enrolling the Node again issues a new
credential, and the Node must prove a key again before any peer is granted to it. To rotate a
credential without a gap, enroll again first and revoke the old credential after the Node uses the
new one; that keeps the endpoint.

### What still needs the Hub

Phase 3 moves these to Convex. Until then they run only on the Hub, and a `connect-convex` Node
takes no part in them:

- gateway ingress: public `<app>.<domain>` routes reach a Node over the Hub's data channel;
- the deploy pipeline: builds, push-to-deploy and `portless deploy`. The Convex command path runs
  a deployment only for an existing active deployment and live App lease, and nothing creates one
  yet;
- failover scheduling;
- declaring links and the `portless` CLI and dashboard, which talk to the Hub;
- links to Nodes still in Hub mode, and legacy dumbpipe links.

### Roll back to Hub mode

1. Stop `connect-convex`. Its sidecar keeps running if it is the systemd service; a supervised one
   stops with the agent.
2. Restore the original `connect` command or re-enable `portless-agent.service`, with its
   `ERAINFRA_HUB`/`PORTLESS_HUB` and token, and unset `ERAINFRA_CONVEX_SITE` and the
   `ERAINFRA_NODE_*` variables. Keep `ERAINFRA_MESH_SOCKET` or `ERAINFRA_MESH_BIN` if the Node
   should stay on the mesh: Hub mode drives the same sidecar, key and EndpointId, and its next
   healer pass replaces the Convex grants with the Hub's.
3. Keep the state directory and its journal. Do not run both modes against the same workloads: the
   Hub cannot observe Convex command leases or journal outcomes.

Peers still in `connect-convex` mode keep this Node in their snapshots while its credential is live.
Revoke its credentials if it should leave the Convex mesh.

### Node API and execution

The versioned API is `/api/v1/nodes/`, on the Convex **site** origin. Every route requires the
per-Node credential, derives the Node from its digest, and checks revocation again in the database
transaction. No request accepts a Node id to select a different Node. Operator API tokens are
refused here; Node credentials are refused on the operator API.

| Method | Path                 | Purpose                                                             |
| ------ | -------------------- | ------------------------------------------------------------------- |
| POST   | `heartbeat`          | publish Infra Agent version/liveness                                |
| GET    | `state?revision=…`   | conditional full mesh snapshot; unchanged responses omit data       |
| GET    | `commands?cursor=…`  | at most 25 unsettled commands; opaque pagination cursor             |
| POST   | `commands/claim`     | atomically claim one addressed command, returning its epoch         |
| POST   | `commands/renew`     | renew a live claim, with owner and epoch                            |
| POST   | `commands/payload`   | claim-gated operation, deploy services and secrets, or build source |
| POST   | `commands/result`    | `success`, `failure` or `unknown`; a spec step also sends its text  |
| POST   | `endpoint/challenge` | request a one-use key-possession challenge for an EndpointAddr      |
| POST   | `endpoint`           | publish that address with its signed challenge                      |

Humans enqueue through `infra/nodeCommands:enqueue`, with `node.run` for the existing Go operation
allowlist or `app.deploy` for deployment commands. The enqueue and durable audit row commit in one
transaction. A deployment command references an active deployment on the target Node, uses the
stored App specification, and requires the matching live App lease epoch and operation
(`deploy` or `failover`). The deploy pipeline queues its own spec, build and deploy steps; spec and
build commands cannot be enqueued by hand. No raw argv, script, caller environment or source/build
URL is accepted. The server and Go
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
bounded to 16 KiB per subprocess, HTTP bodies to 256 KiB, and execution to 10 minutes (15 for a
build, 2 for reading a spec).

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
Node. Each exposure has the exact declared consumers' `allowed_peers`, never the whole fleet; a
missing or empty grant denies everyone. A peer appears in `fleet` and in any `allowed_peers` only
while its endpoint was registered through a verified challenge (`endpointProvenAt`) and it still
holds an unrevoked credential. An EndpointId recorded without a proof, as the phase-2a
`registerEndpoint` does, never grants anything. Addresses retain all relay URLs in
`nodes.meshAddress`; the phase-2a singular `endpointAddr.relayUrl/directAddresses` has an explicit
legacy conversion and is never silently treated as the Rust wire shape.

Endpoint registration signs a server-generated UTF-8 message of at most 4096 bytes:
`erainfra/node-endpoint/v1\n` followed by JSON containing the authenticated Node id, credential id,
random 256-bit nonce and exact `{id,relay_urls,direct_addrs}` address. The challenge expires after
60 seconds and is consumed once; an endpoint reset deletes any challenge still outstanding. The
Infra Agent passes the message to the sidecar's `{v:1,op:"sign_challenge",message}` unchanged, and
the sidecar signs those exact bytes with the endpoint key, which never leaves it. The result is
`{endpoint_id, signature}` with a standard base64 Ed25519 signature. Convex verifies it with pinned
pure-JavaScript `@noble/curves` (strict, not ZIP-215). The three sides check the same domain prefix
and 4096-byte limit. The heartbeat returns the Node's registered `endpointId`, or `null`, so the
agent can tell a key it may publish from one Convex will refuse.

## Deploy and failover from Convex (phase 3a)

For Nodes in `connect-convex` mode, Convex runs the deploy pipeline the Hub ran
(`packages/backend/convex/infra/pipeline.ts`), push-to-deploy, and failover. A Node still connected
to the Hub is not touched by any of it.

### The pipeline

A deployment row moves through `queued`, `reading-spec`, `planning`, `building`, `deploying`,
`linking` and ends `done` or `failed`. The stages are the Hub's, with planning made its own stage:

1. **reading-spec**: the build Node fetches the source and returns `erainfra.yaml` or
   `portless.yaml`. With neither, the run needs a `port` and deploys one service from the root.
2. **planning**: Convex validates the spec with the Hub's rules, places each service (its `node:` or
   the default Node), takes host ports from the port allocator, which returns the same port for the
   same (Node, key) on every redeploy, and fixes the image tags from the commit or the deployment id.
3. **building**: one build per `build:` service, in order, on the build Node: `docker build` when
   the context has a Dockerfile, otherwise a `nixpacks` binary already on the Node's PATH, then
   `docker push`.
4. **deploying**: each Node starts its group of services, all Nodes at once.
5. **linking**: Convex records the App, then flips its routes, then records the cross-Node links in
   the App row, from which each Node's mesh state is derived.

A run holds its App's lease from the moment it leaves `queued` until it ends, so a second deploy of
the same App waits in `queued` and starts when the first ends. Every stage write is fenced on the
run's lease epoch. A run that lost its lease is failed, and the Node steps it queued are refused.

Every step that touches a Node is a Node command whose idempotency key is
`<deploymentId>:<step>:<nodeId>`. Queuing a step twice returns the command already queued. A Node
that reports a build or deploy and loses the reply reports the same outcome again from its journal
when Convex re-delivers the command; the build or deploy does not run twice. If the Infra Agent dies
mid-step, the outcome is `unknown` and the run fails rather than repeating the step. Reading the spec
has no effect on the Node, so a re-delivered spec step is read again.

A step fails the run when its command fails or ends `unknown`, when its Node misses heartbeats for
the window below, or when it outlives its timeout: 2 minutes for the spec, 15 for a build, 5 for a
deploy, plus 5 minutes queued behind other commands on that Node. A cron every 10 seconds moves
runs that are waiting, renews their leases and starts queued runs; a Node's report moves its run at
once. The stale-run sweep that replaced the Hub's boot-time `failStale` fails any run whose lease
lapsed anyway.

### Deploy through the operator API

The routes are on the `/api/v1` operator API with dashboard API tokens. Deploying needs an `admin`
token; reading needs `read` or `admin`. Every upload and deploy request, accepted or refused, is
written to the audit log with the token's name as the actor.

```sh
SITE=https://<deployment>.convex.site
TOKEN=erainfra_…   # admin
tar -czf /tmp/src.tgz -C ./my-app .
UPLOAD=$(curl -fsS -X POST -H "Authorization: Bearer $TOKEN" "$SITE/api/v1/deployments/uploads" | jq -r .uploadUrl)
STORAGE=$(curl -fsS -X POST -H "Content-Type: application/gzip" --data-binary @/tmp/src.tgz "$UPLOAD" | jq -r .storageId)
curl -fsS -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d "{\"app\":\"my-app\",\"upload\":\"$STORAGE\",\"node\":\"node-a\"}" "$SITE/api/v1/deployments"
curl -fsS -H "Authorization: Bearer $TOKEN" "$SITE/api/v1/deployments/<id>"
curl -fsS -H "Authorization: Bearer $TOKEN" "$SITE/api/v1/deployments?app=my-app&limit=20"
```

A deploy request names the App and exactly one source: `upload` (a storage id from the upload) or
`repo` with an optional `branch` (default `main`) and `sha`. `port` is the container port for a
source with no spec file; `buildNode` and `node` name the build Node and the Node unpinned services
land on, and default to the first live Node by name. The spec's `app:`, when set, must match the
request's App. Uploads are limited to 256 MiB.

The build Node fetches an upload through the Convex file-storage URL in its claimed command payload.
That URL carries no credential, is given only to the Node holding the step's live claim, and stops
working when the run ends, because the upload is deleted then. An upload URL that is never used
for a deploy expires after an hour; the file is not deleted.

### Push-to-deploy

Create a GitHub App for deploys (not the CI App the dashboard creates, which has no Contents
permission): Repository Contents read, subscribed to `push`, webhook URL `<site>/github/webhook`.
Install it on the repositories you deploy, then set its credentials in the Convex environment under
the names the Hub reads:

```sh
pnpm convex env set ERAINFRA_GH_APP_ID <app id>
pnpm convex env set ERAINFRA_GH_APP_KEY "$(cat app.private-key.pem)"
pnpm convex env set ERAINFRA_GH_WEBHOOK_SECRET <webhook secret>
```

Bind a branch with `infra/git:bind`. A push to it queues one run per `X-GitHub-Delivery`: the
delivery row and the run commit in one transaction, so a redelivery or a duplicate delivery queues
nothing. The run builds the pushed commit, not whatever the branch points at when the build starts.
For each spec and build step, Convex mints a one-hour installation token for that one repository
with Contents read and puts it in the claimed payload. The Node passes it to `git` as an HTTP
header in the child's environment, never in argv or `.git/config`, and Convex never stores it. With
no deploy App configured, or the App not installed on the repository, public repositories still
deploy without a token. The binding records the last run's result.

### Image registry

`ERAINFRA_REGISTRY` in the Convex environment names where builds push and Nodes pull (default
`127.0.0.1:5000`). This release keeps the Hub's model of a registry container, with one limit: a
`connect-convex` Node saves its mesh state but does not yet apply it, so it cannot reach a registry
on another Node over a mesh link. Use one of:

- a single Node that builds and runs everything, with the registry on it at `127.0.0.1:5000`;
- a registry every Node can reach, with TLS (for example `registry.example.com`), and `docker login`
  on each Node when it is private.

Cross-Node `needs:` dependencies have the same limit. The links are planned, recorded and published
in each Node's mesh state, but a `connect-convex` Node does not open them yet. Keep a service and
what it needs on one Node until the mesh reconciler lands.

### Failover

A cron every 10 seconds (`infra/failover.ts`) decides from heartbeats. A healthy Infra Agent
heartbeats at most about 40 seconds apart. A Node is failed over only when:

1. a check finds it silent for three whole heartbeat intervals (120 seconds), and
2. a later check, at least 20 seconds after the first, still finds no heartbeat.

One late heartbeat, or one dropped connection, never triggers it. The Hub failed a Node over 20
seconds after its WebSocket closed, which moved Apps off Nodes that were still serving them. A
heartbeat between the two checks clears the suspicion, and one outage fails over once.

Each App with any service on the lost Node gets a failover run of the same pipeline. It takes the
App's lease (waiting for a deploy that holds it), moves every service on the lost Node to a
surviving Node, chosen round robin by name, re-plans ports, environment and links from the stored
spec, and redeploys the images the App already runs, without a rebuild, on each Node whose services
changed. Only then are the App row and its routes flipped. Every moved service records its new
Node. The Hub moved a group by its primary Node only and left `services[].node` pointing at the lost
Node. Convex also queues the removal of the moved containers on the lost Node, which runs if it
comes back, so a Node that was only partitioned does not keep serving a second copy. A later deploy
to that Node cancels the queued removal.

Failover redeploys stateless services only, as on the Hub: a database moved to another Node starts
with that Node's volume. Apps copied from the Hub have no stored spec and are not failed over until
deployed once through Convex. Set `ERAINFRA_FAILOVER=0` in the Convex environment to turn automatic
failover off.

### What still needs the Hub

- Public traffic: routes are recorded in `appRoutes`, but gateway ingress that serves them is phase
  3b. Until then the Hub's tunnel and data plane serve `<app>.<zone>`.
- The `portless` CLI, MCP server and the Hub dashboard (phase 3c). The Convex surface today is the
  operator API above and the internal functions.
- Mesh links between `connect-convex` Nodes, as above.

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
