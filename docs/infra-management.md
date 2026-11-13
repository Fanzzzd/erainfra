# Infrastructure management

EraInfra deploys and runs long-lived Apps on Nodes: machines you own, including ones behind NAT
with no public IP. This surface started as a separate product called Portless
([ADR 0004](adr/0004-portless-is-a-feature-not-a-second-product.md)). The `portless` names that
remain, such as `portless.yaml` and `PORTLESS_PREFIX`, are frozen identifiers
([CONTEXT.md](../CONTEXT.md), naming rule 4).

The Infra Agent on each Node runs `connect-convex`: it dials the Convex control plane that also
runs CI. Convex holds the state and runs deploys, push-to-deploy and failover. Gateway Nodes serve
public traffic and reach Apps over `erainfra-mesh`. Operators use the `erainfra` CLI and the
dashboard's Nodes, Apps, Deployments and Links pages
([ADR 0016](adr/0016-nodes-meet-over-iroh-and-keep-state-in-convex.md)). The Hub, the separate
control plane that did this before, retired on 2026-11-08
([retire-the-hub.md](runbooks/retire-the-hub.md)) and left main with
[ADR 0020](adr/0020-the-hub-leaves-main.md). Some rules below still recognize what the Hub
created on a Node.

```
   browser ──https──▶ Cloudflare ──tunnel──▶ gateway Node ──mesh──▶ Infra Agent (App Node) ──▶ containers
   git push ─webhook─▶ Convex: build → registry → deploy → route
   erainfra deploy ──▶ Convex
```

Everything is self-hosted: your registry (`registry:2`) and your GitHub App for push-to-deploy.
Builds use your Dockerfile, or [Nixpacks](https://nixpacks.com) when there isn't one.

## Use it

Sign in with a dashboard API token and drive everything from `erainfra`:

```sh
erainfra auth login --url https://<deployment>.convex.site --token -
erainfra deploy ./my-app --port 3000          # pack, upload, deploy, follow each stage
erainfra apps list                            # what's running, where, with URLs
erainfra logs my-app --service web --lines 200
erainfra env set my-app MODE=prod
erainfra links add gpu-box:8080 web-box       # web-box reaches gpu-box's 8080 at 127.0.0.1:8080
```

[Operate from the erainfra CLI](#operate-from-the-erainfra-cli) lists every command.

## portless.yaml

How a project deploys is written in the project. The platform executes it deterministically:

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
over an encrypted P2P mesh link (hole-punched when possible). The database never touches a public
domain. If a node dies, its apps auto-redeploy onto a survivor and the routes flip (stateless only).

## State in Convex

The Convex deployment that runs the CI control plane also holds every Node, App and link
([ADR 0016](adr/0016-nodes-meet-over-iroh-and-keep-state-in-convex.md)). The code is in
`packages/backend/convex/infra/`.

| Convex table                   | Invariant, kept by a transaction                                                 |
| ------------------------------ | -------------------------------------------------------------------------------- |
| `users` (Convex Auth)          | unique email; the first account is the owner; the last owner cannot be removed   |
| `apiTokens`, `nodeCredentials` | one token system; each Node gets its own credential                              |
| `appRoutes`                    |                                                                                  |
| `apps`                         |                                                                                  |
| `meshLinks`                    |                                                                                  |
| `portAllocations`              | one port per (Node, key), stable across redeploys; one key per (Node, port)      |
| `appSecrets`, `appDataKeys`    | envelope-encrypted; no query returns a value                                     |
| `gitBindings`                  | (repository, branch) unique; at most 200                                         |
| `appDeployments`               | newest 1000 kept; a run whose lease lapsed is failed by a cron                   |
| `auditEvents`, `infraCounters` | a gapless sequence in commit order; a dangerous action is audited before it runs |
| `nodes`                        | one row per Node; a registered iroh EndpointId belongs to one Node               |
| `appLeases`                    | one live lease per App; fenced Convex writes reject a stale epoch                |
| `webhookDeliveries`            | a push delivery queues at most one deploy, keyed by `X-GitHub-Delivery`          |

Other tables reference a Node by its Convex id, not its name.

App lease epochs fence Convex state transitions only. They cannot cancel an old holder's in-flight
runtime request or guarantee exactly-once external side effects. The deploy pipeline and failover
([Deploy and failover](#deploy-and-failover)) therefore give every Node step a deterministic
idempotency key, and the Infra Agent's journal replays the recorded outcome of a re-delivered step
instead of running it again.

**One identity system.** Accounts are Convex Auth accounts with a permission role (`owner`,
`admin`, `operator`, `viewer`) and the permission table in `infra/policy.ts`. An account created
before roles existed reads as `owner`, which is what it could already do. The CI dashboard's
functions admit `owner` and `admin` only, so a `viewer` cannot use them. Dashboard API tokens have
scopes: `read` grants what a viewer has, `admin` adds deploying and running Node operations, and no
token administers accounts. A Node authenticates with an `erainfra_node_` credential that an admin
issues for that one Node. An account imported from the Hub signs in with its Hub password; the
Hub's scrypt hash is verified as is until the password is next reset.

**Secrets** belong to a scope, which is an App plus an optional service. The App-wide scope
(`infra/secrets:set` with `app` only) is common environment for every service of the App. A
service-private scope (`app` and `service`) reaches that one service only. Both names follow the
App naming rule, and the scope is stored as two fields, never joined into one string. App and
service names may contain `-`, so the Hub's `<app>-<service>` string `web-api` named both service
`api` of App `web` and App `web-api`.

Each scope's values are encrypted with a random data key for that scope, and the data keys are
encrypted with a master key you hold in the Convex environment. The associated data of every
encryption is a JSON array of the App, the service and the variable name, so a row moved to
another scope or name fails to decrypt. Generate a master key and set it before the first secret.

Every `npx convex env` and `npx convex run` command in this document runs from `packages/backend`
and passes `--prod`. Without it the CLI acts on the deployment `packages/backend/.env.local` names,
which on a developer's checkout is a dev deployment, so production never sees the change.
`npx convex dashboard --prod --no-open` prints the production deployment's name.

This command generates a key only while none is set, and saves it to a file only you can read
before it sets it, so running it twice never replaces a key:

```sh
if current=$(npx convex env get --prod ERAINFRA_SECRETS_MASTER_KEY) && [ -z "$current" ]; then
  (umask 077 && openssl rand -hex 32 | tr -d '\n' > ~/erainfra-secrets-master-key)
  npx convex env set --prod ERAINFRA_SECRETS_MASTER_KEY --from-file ~/erainfra-secrets-master-key
else
  echo 'Not generated: the key is already set, or Convex could not be read. Keep the saved key.'
fi
unset current
```

Move the saved key somewhere safe and delete the file. Without the key the stored secrets cannot
be decrypted, and Convex fails closed rather than generating a new one. A value leaves Convex only through the internal
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

## Nodes and the mesh

The Infra Agent (`connect-convex`) takes commands from Convex, publishes its `erainfra-mesh`
endpoint to Convex with a proof that it holds the key, and links to other Nodes from the mesh
snapshot Convex derives for it. Convex runs [deploys and failover](#deploy-and-failover) for the
Node, [gateway Nodes](#gateway-ingress) carry its public traffic, and operators use
[the erainfra CLI](#operate-from-the-erainfra-cli).

### Set up a Node

Run these steps for each Node. Both ends of a link need a proven mesh endpoint: a Node without
one is never named as a peer.

1. **Enroll the Node** with an admin API token, or as an owner or admin in the dashboard (Nodes):

   ```sh
   (umask 077 && erainfra nodes enroll edge-1 > edge-1.credential)
   ```

   The subshell's `umask` creates the file 0600; under the default umask it would be readable by
   every local user. The command prints an `erainfra_node_…` credential once, on standard output. Enrolling a name
   again issues another credential for the same Node. Without the CLI, an owner or admin can call
   `npx convex run --prod infra/nodes:enroll '{"name":"edge-1"}' --identity '{"subject":"<users _id>|cli"}'`.

2. **Copy the credential to the Node** as a file, then make the copy private:
   `scp edge-1.credential edge-1: && ssh edge-1 chmod 600 edge-1.credential`. It is for this one
   Node, not an operator or fleet token. Never pass it on a command line. Delete your local copy
   once the Node is installed.

3. **Install the Infra Agent and its sidecar.** On Linux with systemd, run the control plane's
   installer from the deployment the Node will report to:

   ```sh
   curl --proto '=https' -fsSL https://<deployment>.convex.site/install | sudo bash -s -- \
     --role node --credential-file ./edge-1.credential
   ```

   The installer verifies the Infra Agent and `erainfra-mesh` against the deployment's pins,
   installs `erainfra-mesh.service` (see [secure-node-mesh.md](runbooks/secure-node-mesh.md)), and
   then:
   - moves the credential to `/etc/erainfra-node.credential` (0600, root) and creates
     `/var/lib/erainfra-node` (0700) for the journal. Delete the copy you gave it;
   - installs the Infra Agent as `/usr/local/lib/erainfra/erainfra-node`, beside `erainfra-mesh`;
   - writes and starts `erainfra-node.service`, which runs
     `connect-convex --credential-file /etc/erainfra-node.credential --state-dir /var/lib/erainfra-node`
     with `ERAINFRA_CONVEX_SITE` set to the deployment's own site URL,
     `ERAINFRA_MESH_SOCKET=/run/erainfra-mesh/control.sock` and
     `ERAINFRA_MESH_CONTROL_DIR=/var/lib/erainfra/mesh-control`.

   The Node's name comes from its enrollment. `--convex` and `--mesh` are accepted and change
   nothing. `--token`, `--hub`, `--name` and `--replace-hub-agent` were Hub-era flags and fail with
   a message that says what to use instead.

   The installer does not migrate a Node that still runs in Hub mode. Stop its Infra Agent first
   (`systemctl disable --now portless-agent`), because two Infra Agents must not drive one sidecar.
   On a Node migrated from the Hub, the installer leaves the disabled `portless-agent.service`,
   `/etc/portless/agent.env` and the Hub-mode binary under `~/.portless/bin` untouched. A rollback
   from the `v0.2.0-rc.19` tag needs them.

4. **Pick the relay policy.** Each Node reads it from its own environment:
   `ERAINFRA_MESH_RELAYS` (a JSON array of `https` relay URLs, default `[]`; an entry may instead
   be an object such as `{"url":"https://relay.example.com","quic_port":443}`, see
   [Fleet relay](#fleet-relay)), `ERAINFRA_MESH_RELAY_TOKEN` and `ERAINFRA_MESH_N0_FALLBACK` (`true` or `false`, default
   `false`). Convex stores no relay token, so the snapshot's `relays` field is ignored. Two Nodes
   that are both behind NAT need a relay: the fleet's own ([Fleet relay](#fleet-relay)), n0's, or
   both. For the installed unit, add them with `systemctl edit erainfra-node` as `Environment=`
   lines, then `systemctl restart erainfra-node`. Wrap the whole assignment in single quotes, as in
   `Environment='ERAINFRA_MESH_RELAYS=["https://relay.example.com"]'`: systemd.syntax(7) defines
   quotes only when they wrap a whole item, and the JSON array holds double quotes. Those double
   quotes must also survive the way you write the file. Write it with a quoted heredoc
   (`<<'EOF'`), not with `printf` or `echo` inside an ssh command: on 2026-11-08 that lost them,
   and the agent restart-looped with `ERAINFRA_MESH_RELAYS must be a JSON URL array`. The drop-in
   survives a re-install.

   In practice, give every Node a relay. With the defaults a Node publishes only its direct
   addresses (`published mesh endpoint … (0 relay, …)` in its journal), and a Node whose NAT
   rejects inbound UDP cannot be dialed at all. On 2026-11-08 `oracle-singapore-1` (OCI, 1:1 NAT)
   was unreachable that way: its peer logged `timed out dialing <id>: deadline has elapsed` and the
   gateway answered 502. `ERAINFRA_MESH_N0_FALLBACK=true` on every Node fixed it, and paths still
   went direct. ADR 0016 prefers a self-hosted `iroh-relay` on a Node with a public address,
   listed in `ERAINFRA_MESH_RELAYS`; [Fleet relay](#fleet-relay) sets one up. A drop-in written
   before the install takes effect at its first start:

   ```sh
   sudo install -d -m 755 /etc/systemd/system/erainfra-node.service.d
   printf '[Service]\nEnvironment=ERAINFRA_MESH_N0_FALLBACK=true\n' |
     sudo tee /etc/systemd/system/erainfra-node.service.d/20-mesh-relay.conf >/dev/null
   ```

5. **Without systemd** (macOS, or Linux without systemd), start the Infra Agent by hand. Build
   `erainfra-mesh` (`cargo build --release` in `apps/mesh`) or take it from a release that ships
   it. Run the Infra Agent as an ordinary user that owns a private persistent state directory and
   the 0600 credential file, with the credential out of argv:

   ```sh
   sudo install -d -m 0700 -o "$USER" /var/lib/erainfra-node
   chmod 0600 edge-1.credential
   ERAINFRA_CONVEX_SITE=https://<deployment>.convex.site \
     ERAINFRA_MESH_BIN=/usr/local/bin/erainfra-mesh \
     ./infra-agent connect-convex \
       --credential-file ./edge-1.credential --state-dir /var/lib/erainfra-node
   ```

   With `ERAINFRA_MESH_BIN` set, the Infra Agent creates the endpoint key on first start and
   supervises the sidecar under `$ERAINFRA_PREFIX/run/mesh-control/sidecar` (default
   `~/.portless`). Keep that directory: the key in it is the Node's mesh identity. Without
   `ERAINFRA_MESH_BIN` or `ERAINFRA_MESH_SOCKET`, `connect-convex` still runs commands, but it
   publishes no endpoint and the Node has no mesh links. On Windows `connect-convex` refuses to
   drive a sidecar.

   `ERAINFRA_NODE_CREDENTIAL_FILE` and `ERAINFRA_NODE_STATE_DIR` can supply the two paths instead.
   `ERAINFRA_NODE_CREDENTIAL` is an alternative to the file, not an additional credential. The
   journal requires private POSIX permissions and directory fsync. This command does not install a
   service.

   Either way, within a few seconds the log (`journalctl -u erainfra-node -f` for the installed
   unit) shows `published mesh endpoint <EndpointId> (<n> relay <home relay URL>, <n> direct addresses)`,
   then
   `applied mesh snapshot <revision> (<n> peers, <n> exposures, <n> links)`. The applied snapshot,
   without any relay token, is also written to `desired.json` in the state directory.
   `erainfra nodes list` shows the Node `online` with `MESH proven`.

6. **Declare links** with `erainfra links add <provider>:<port> <consumer>[:<local-port>]`, or
   with `needs:` in an App deployed through Convex. Each Node picks the change up on its next
   snapshot poll. `erainfra links list` shows the link `active` once both Nodes have a proven
   endpoint.

Two Infra Agents can never drive one sidecar at the same time. Each takes an exclusive lock on
`controller.lock` in its control directory and another on the directory that holds the sidecar's
socket, so the second one exits at startup with `mesh already has a controller`, even when the two
use different control directories.

### Node privilege boundary

Treat every Node as a privileged service boundary, not as an unprivileged sandbox. The installer
writes `erainfra-node.service` without a `User=` directive, so the Infra Agent runs as root. An
Infra Agent started by hand that can reach the Docker socket, including through membership in the
`docker` group, is also effectively root on that Node. Docker-group execution is not unprivileged
isolation.

The control protocol limits what a remote request can do. Deploying containers needs
`app.deploy`, host operations need `node.run`, the Node resolves host operations from its own
allowlist, and both Convex and the Node reject Docker flags that request host namespaces, bind
mounts or sockets, devices, capabilities, or security profile changes. Those checks limit remote
requests. They do not make a compromised Convex deployment, Infra Agent binary, Docker daemon or
privileged Node account harmless. Use dedicated Nodes with a blast radius that fits the workloads,
and keep the Convex deployment and admin credentials inside the same trust domain.

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
applies nothing. A new one goes through meshclient's Reconciler, which removes exposures
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
owner/admin confirms the change with `erainfra nodes reset-endpoint <name>` (an admin token). The
agent sees the
reset in its next heartbeat and publishes the new key; peers pick it up on their next snapshot. A
key already registered to another Node is refused with `endpoint_in_use`; give the Node its own key
(a copied key file is the usual cause) and restart the agent.

### Fleet relay

Two Nodes that cannot reach each other's direct addresses talk through a relay. Any Node with a
public address can run one for the fleet ([ADR 0016](adr/0016-nodes-meet-over-iroh-and-keep-state-in-convex.md),
item 5): `deploy/infra/relay.sh` installs n0's own iroh-relay build, pinned by version and
SHA-256, as `erainfra-relay.service`. The procedure is
[run-a-fleet-relay.md](runbooks/run-a-fleet-relay.md).

The relay keeps no list of Nodes. For each client, after the client has proven its EndpointId in
the relay handshake, iroh-relay asks Convex with `POST /api/v1/relay/access`
(`infra/relayAccess.ts`), and relays only on `200 true`. Convex answers `true` for exactly the
Nodes a mesh snapshot may name: a proven endpoint key and a live credential. Enrolling, proving,
`reset-endpoint` and `revoke` therefore reach the relay at the client's next connection. The
route needs the Convex env var `RELAY_ACCESS_TOKEN`, the secret the relay sends as its bearer
token, with `RELAY_ACCESS_TOKEN_NEXT` accepted beside it during a rotation. A request without it
gets `401` whatever EndpointId it names, so the route tells a stranger nothing about the fleet.
With the variable unset, it answers `503` and the relay admits nobody.

| Answer      | Meaning                                                                   |
| ----------- | ------------------------------------------------------------------------- |
| 200 `true`  | a Node with a proven endpoint and a live credential: relay for it         |
| 403 `false` | no such Node, an unproven key, a reset endpoint or no live credential     |
| 400 `false` | `X-Iroh-Endpoint-Id` is missing or not 64 lowercase hex characters        |
| 401 `false` | the bearer token is not `RELAY_ACCESS_TOKEN` or `RELAY_ACCESS_TOKEN_NEXT` |
| 503 `false` | `RELAY_ACCESS_TOKEN` is not set                                           |

Nodes list the relay in `ERAINFRA_MESH_RELAYS`. The order of that list does not matter: iroh
measures every relay in it and takes the fastest as the Node's home relay, and moves only when
another one answers in less than two thirds of the time. A Node publishes only its home relay, and
peers reach it through that one. So with `ERAINFRA_MESH_N0_FALLBACK=true`, a Node that measures
n0's relay as faster than the fleet relay homes on n0's. The runbook says how to check which relay
each Node took and when to turn the fallback off.

iroh measures a relay with QUIC address discovery, on udp/7842 unless the relay entry names
another port. When a cloud security list blocks udp/7842, iroh can time the relay only with an
HTTPS request, whose time includes the TCP and TLS handshakes, and n0's relays win. That happened on 2026-11-08 with `oracle-singapore-1`, whose OCI security
list blocked udp/7842 and allowed udp/443. The fix needs no cloud console change. Run `relay.sh`
with `ERAINFRA_RELAY_QUIC_PORT=443`, which binds QUIC on udp/443 beside HTTPS on tcp/443, and list
the relay on every Node with its port:

```ini
Environment='ERAINFRA_MESH_RELAYS=[{"url":"https://relay.on99.ai","quic_port":443}]'
```

An entry is a URL string, meaning udp/7842, or an object with `"url"` and either `"quic_port"`
(1 to 65535) or `"quic":false` (no address discovery with that relay). The Infra Agent checks
every entry at startup and names the bad one. It sends a plain URL to `erainfra-mesh` as a string,
so an older sidecar still accepts a policy without objects. The object form needs an Infra Agent
and `erainfra-mesh` from a release that has it. The steps are in
[run-a-fleet-relay.md](runbooks/run-a-fleet-relay.md#2-firewall-the-host-and-the-cloud).

### Revoke or re-enroll a Node

`erainfra nodes revoke <name>` revokes every live credential of the Node; with
`--credential <hint>` it revokes one. Either takes effect on the Node's next request. Revoking a
Node's last
live credential also clears its endpoint registration, so it drops out of every peer's snapshot at
once and peers close its connections when they apply it. Enrolling the Node again issues a new
credential, and the Node must prove a key again before any peer is granted to it. To rotate a
credential without a gap, enroll again first and revoke the old credential after the Node uses the
new one; that keeps the endpoint.

### Node API and execution

The versioned API is `/api/v1/nodes/`, on the Convex **site** origin. Every route requires the
per-Node credential, derives the Node from its digest, and checks revocation again in the database
transaction. No request accepts a Node id to select a different Node. Operator API tokens are
refused here; Node credentials are refused on the operator API.

| Method | Path                 | Purpose                                                             |
| ------ | -------------------- | ------------------------------------------------------------------- |
| POST   | `heartbeat`          | publish Infra Agent version/liveness and command health             |
| GET    | `state?revision=…`   | conditional full mesh snapshot; unchanged responses omit data       |
| GET    | `commands?cursor=…`  | at most 25 unsettled commands; opaque pagination cursor             |
| POST   | `commands/claim`     | atomically claim one addressed command, returning its epoch         |
| POST   | `commands/renew`     | renew a live claim, with owner and epoch                            |
| POST   | `commands/payload`   | claim-gated operation, deploy services and secrets, or build source |
| POST   | `commands/result`    | `success`, `failure` or `unknown`; a spec step also sends its text  |
| POST   | `commands/status`    | status of up to 200 of this Node's commands, for journal compaction |
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
process (through `execution.lock`, and the journal file itself) and bound to the Convex origin and
Node. Do not enroll a second machine with the same Node credential or delete/copy its journal to
bypass the lock. A record torn by power loss during an append is recovered when the journal opens;
any other damage fails closed ([When the journal is damaged](#when-the-journal-is-damaged)). Lease
epochs and the local journal do not provide globally exactly-once external effects across cloned
hosts or loss of the journal.

#### What the journal keeps

A journal key exists so that a re-delivered command replays its recorded outcome instead of running
again, and for nothing else. Convex never re-delivers a terminal command: `commands/claim` refuses
one, nothing moves a finished command back to pending or deletes it, and an idempotency key names
one command per Node forever. So the Infra Agent forgets a key exactly when Convex holds its
command terminal (`success`, `failure`, `unknown` or `cancelled`):

- when its `commands/result` returns 200, at once. That includes an `unknown` outcome: Convex
  records it on the command, and a deploy run fails with "inspect the Node before deploying
  again", which is where an operator acts on it. The agent also logs
  `command … ended with an unknown outcome`.
- when a status sweep (`commands/status`) finds the command terminal. This catches a key whose
  acknowledgement a crash cut off, and a command cancelled while it ran, by an operator or by a
  deploy run that ended. When Convex ended the command another way than the journal recorded (a
  command the Node finished but Convex cancelled), the agent logs
  `journal key … ended in Convex as cancelled, but this Node recorded success` before it forgets
  the key, because Convex cannot know it. The sweep runs once at least 500 such keys have
  collected, at most every 10 minutes, and every 30 seconds while the journal is full.

Every other key stays:

| Key                                         | Why it stays                                                |
| ------------------------------------------- | ----------------------------------------------------------- |
| Command still pending or running in Convex  | It can be delivered again; the journal replays its outcome. |
| The command running in this agent right now | It waits for its own outcome.                               |
| Unknown to Convex (`missing`)               | Nothing confirms it cannot be delivered again.              |
| No answer (an older control plane)          | Nothing confirms it either.                                 |

The file is rewritten without the forgotten keys once 1,024 dead lines collect (written beside it,
fsynced, renamed over it), so it stays under about 11 MiB. A healthy Node's journal holds only its
in-flight command, and cancellations or restarts in the middle of a command leave nothing behind
once Convex has them.

One case the journal no longer covers: if the Convex deployment is restored from a backup taken
while a since-finished command was still pending, that command is delivered again and runs again,
because its key was forgotten when it finished.

#### Command health in the heartbeat

Each heartbeat carries `commandsBlocked` while command polling fails or the journal is full, and how
many keys the journal holds (`journalKeys` of `journalKeyLimit`). The reason is one of
`journal_full`, `journal_error` (the journal cannot be written), `command_api` (the Node API refuses
or fails command requests) or `command_error`. A full journal stays `journal_full` while no command
is waiting, because the next one would be refused; it clears only when a sweep frees keys or an
operator releases them. It shows on the dashboard's Nodes page and in `erainfra nodes list` as
`online, blocked: <reason>`, in `/metrics` as `erainfra_node_commands_blocked`, and fires the
**Node unable to run commands** alert rule. A blocked Node that then stops heartbeating stays in
breach, so the incident does not resolve because the Node died; the **Node offline** rule pages for
the silence. The agent logs each distinct error once, again every five minutes while it lasts, and
once when polling recovers:

```text
connect-convex: ERROR: command polling failed (journal_full): journal key limit reached: 10000 keys are held, 37 of them unknown outcomes, and Convex has not finished their commands; ...
```

An agent newer than the control plane falls back to a version-only heartbeat and logs a warning;
deploy the control plane to see the health fields.

#### When the journal is full

At 10,000 keys the Node refuses every new build, deploy and operate command with
`journal key limit reached`. Spec reads and log tails are not journaled and keep working, and so do
re-deliveries of commands the journal already holds. Keys of finished commands are forgotten on
their own, so a full journal means 10,000 commands Convex has not finished, does not know, or
cannot answer for (a control plane without `commands/status`). Usually that is a control plane
that was restored or replaced, or one older than the agent; deploy the current control plane
first.

1. List what the journal holds. This reads without the lock, so the agent can keep running:

   ```sh
   ./infra-agent journal list --state-dir /var/lib/erainfra-node
   ```

   Each line is `{"key":"<nodeId>:<idempotency key>","commandId":"…","outcome":"success|failure|unknown"}`.

2. For each key, look the command up in Convex (the deployment's `nodeCommands` table, by
   `commandId`, or the run it belongs to on the dashboard's Deployments page).
   - A command still `pending` or `running` must keep its key: releasing it would let the
     command run again. Cancel it (`infra/nodeCommands:cancel`) if it should not run; the next
     sweep then forgets its key.
   - A command Convex does not have can only come back with a restored deployment. If that is
     not going to happen, its key can go.
   - **`unknown` outcomes need a human check** before release. The command started and its
     result is lost: a restart, deploy, build or removal may or may not have happened. Inspect
     the workload on this Node (`docker ps`, `systemctl status`, the App's URL) and decide
     whether to issue a new operation under a new key. Never re-enqueue under the old key.

3. Stop the Infra Agent and release the keys you have checked:

   ```sh
   systemctl stop <the connect-convex unit>   # or stop the process
   ./infra-agent journal release --state-dir /var/lib/erainfra-node <key> [<key>...]
   ```

   `release` takes the journal's lock, so it refuses while the agent runs. It refuses the binding
   record and keys that do not exist.

4. Start the agent again. It logs `command polling recovered`, and the next heartbeat clears the
   blocked state.

Never delete or edit `execution.jsonl` by hand: that forgets every key at once, including commands
Convex can still deliver.

#### When the journal is damaged

Power loss while the agent appends a record can leave the journal's last line torn. The agent
recovers it when it opens the journal, the way a write-ahead log drops a torn final record, and
logs a warning that names the line and its bytes:

```text
connect-convex: WARNING: journal /var/lib/erainfra-node/execution.jsonl: dropped the torn record at line 4, which an interrupted append left without its newline: ...
```

`journal list` and `journal release` read the journal the same way, so neither is stranded by a
torn line. The recovery never lets a command whose effect may have started run again. The agent
acts on a record only after its write and fsync return, and each record after a key's first only
moves the key towards what Convex holds, so what happens depends on the line:

| Last line                                      | What it was                               | After recovery                                                                    |
| ---------------------------------------------- | ----------------------------------------- | --------------------------------------------------------------------------------- |
| No newline: an `accepted` record               | A command that had not started            | Dropped. The command runs if Convex delivers it again.                            |
| No newline: an outcome                         | The outcome of a command that ran         | Dropped. The key's `accepted` reads back as `unknown`: reported, never run again. |
| No newline: `settled`                          | A key Convex already holds                | Dropped. The key comes back until the next report or sweep forgets it.            |
| No newline: the binding                        | The Node binding                          | Dropped. The next heartbeat writes it again.                                      |
| Newline but unreadable, for a key already held | A later record for that key               | Dropped. The key keeps its earlier state.                                         |
| Newline but unreadable, for a new key          | Possibly an `accepted` whose effect began | Kept as `unknown`: reported unknown, never run again.                             |
| Newline but unreadable, key unreadable         | Unknown                                   | Refused: nothing says which command must not run again.                           |

A line without its newline is dropped whatever it holds: its write never finished, so its fsync
never returned and the agent never acted on it. A damaged record before the last line is refused
too, since an append never leaves one there; that is damage to the file, usually failing storage.
The agent and both `journal` commands then stop with an error that names the line and points here.
To recover:

1. Stop the Infra Agent and copy the state directory somewhere safe. Check the disk (`dmesg`,
   `smartctl`).
2. In Convex, cancel every command of this Node that is still `pending` or `running`
   (`infra/nodeCommands:cancel`). Convex can then deliver none of them again, so no key in the
   journal has anything left to protect.
3. Move `execution.jsonl` out of the state directory and start the agent. It writes a new binding
   on its first heartbeat. Before step 2 this could let a re-delivered command run twice; after
   it, nothing is lost.

A write that fails while the agent runs (a full disk, an I/O error) does not leave a partial line
behind: the agent rewrites the journal from what it has acted on. If even that fails, it refuses
journaled commands with `journal_error` until it is restarted.

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
A link's `listen` is a loopback `IP:PORT`. Version 2 adds one more form, `bridge:<port>`, for an
App dependency link ([Image registry and cross-Node links](#image-registry-and-cross-node-links)).
It is derived only from standalone `meshLinks` and declared App dependency links involving this
Node. Each exposure has the exact declared consumers' `allowed_peers`, never the whole fleet; a
missing or empty grant denies everyone. A peer appears in `fleet` and in any `allowed_peers` only
while its endpoint was registered through a verified challenge (`endpointProvenAt`) and it still
holds an unrevoked credential. An EndpointId recorded without a proof, as the internal
`registerEndpoint` does, never grants anything. Addresses retain all relay URLs in
`nodes.meshAddress`; the older singular `endpointAddr.relayUrl/directAddresses` has an explicit
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

## Deploy and failover

Convex runs the deploy pipeline (`packages/backend/convex/infra/pipeline.ts`), push-to-deploy, and
failover.

### The pipeline

A deployment row moves through `queued`, `reading-spec`, `planning`, `building`, `deploying`,
`linking` and ends `done` or `failed`:

1. **reading-spec**: the build Node fetches the source and returns `erainfra.yaml` or
   `portless.yaml`. With neither, the run needs a `port` and deploys one service from the root.
2. **planning**: Convex validates the spec, places each service (its `node:` or
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
once. A stale-run sweep fails any run whose lease lapsed anyway.

### Names and ownership

A deploy derives every runtime name by joining the App's name with another name:

| Name                       | Form                                                            |
| -------------------------- | --------------------------------------------------------------- |
| container                  | `<app>-<service>`                                               |
| built image                | `<registry>/<app>-<service>:<tag>`                              |
| named volume               | `<app>-<volume>`                                                |
| network                    | `<app>-net`                                                     |
| cross-Node mesh link       | first 30 characters of `<app>`, `-`, first 30 of the dependency |
| route label, `route: true` | `<app>` when one service is routed, otherwise `<app>-<service>` |

A route label, written or derived, must be a DNS label, because a gateway serves `<label>.<zone>`
only for one: at most 63 characters, starting and ending with a letter or digit. `<app>-<service>`
can be longer than that, and an App name may end in `-`. A deploy whose spec routes at a label that
is not a DNS label fails when Convex reads the spec, and the error names the label and its length.
Write the label explicitly (`route: <label>`). The other derived names have no such limit: Docker
accepts container and network names longer than 63 characters, a derived volume name is at most
127 characters where the Infra Agent accepts 128, and a mesh link name is cut to 61.

App, service and volume names may all contain `-`, so two Apps can derive the same name. App `shop`
with service `web-api` and App `shop-web` with service `api` both get container `shop-web-api`. App
`shop` with volume `db-data` and App `shop-db` with volume `data` both get volume `shop-db-data`.
Deployed Nodes already hold these names, so the scheme does not change. Instead, each name has one
owner:

- **Planning refuses a taken name.** Convex compares every name the plan derives with the names
  every other App holds: its App row (containers, volumes from the Docker args, links, routes, and
  network), its route rows, the plan of any of its runs still in flight, and standalone links. A run
  whose plan derives a name another App holds fails at planning, before any Node is asked to do
  anything, with an error that names both Apps and the name. Rename the App, or the service, volume
  or dependency that derives it. The check is fleet-wide, not per Node, because failover moves
  services between Nodes. Apps that only share a prefix, such as `shop` and `shop-staging`, deploy
  normally as long as no derived name is equal.
- **A route label has an owner.** Each route row records the App and service it belongs to. Only
  that App may move it, between its services or onto another Node by redeploy or failover. A spec
  that names another App's label (`route: shop` in App `evil`) fails at planning. Route rows written
  before ownership was recorded take the owner from the one App row whose service routes at the
  label, or are a single-container App the Hub deployed when no App row does. When two App rows
  route at one label, the gateways serve it 503 and log why, and neither App may deploy with it
  until one of them stops routing there or is removed.
- **Removal and retirement use exact names.** `apps remove` removes the containers recorded in the
  App's own row. Given a name with no App row, it removes a container only when the route of that
  name is a single-container App the Hub deployed. A route label that belongs to another App's
  service is refused. A deploy cancels the queued failover retirements of exactly the containers it
  starts, never every container with the App's prefix.
- **The Infra Agent labels what it creates.** Each container gets `erainfra.app=<app>` and
  `erainfra.service=<service>`, and each named volume it creates gets `erainfra.app=<app>`. Before
  replacing a container, the Infra Agent checks that the existing one is this App's service: its
  labels must match. An unlabelled container is one the Hub created, and it is accepted only when it
  is attached to `<app>-net` with the service name as its alias, which is how the Hub started every
  App service, and which no other App's container can match. A single-container App's unlabelled
  container must be on Docker's default network only. The check reads only the name, the networks
  and the alias. Mounts, ports and the image are what a deploy replaces, so extra bind mounts an
  operator added by hand do not stop a Hub container from being accepted. Any other container is
  refused and left running, and the deploy fails with the reason, unless the operator adopts it
  (below). A volume labelled for another App is refused.
- **An unlabelled volume belongs to the containers that mount it.** Planning cannot protect every
  volume the Hub created. The Hub's single-container deploy (`agents.deploy`) mounts any volume
  name its Docker args give, such as `-v postgres-data:/var/lib/postgresql/data` for an App `db`.
  The Hub stored none of those args, so no control plane knows that `db` keeps its database in
  `postgres-data`. App `postgres` with volume `data` derives the same name. So before mounting a
  volume without the `erainfra.app` label, the Infra Agent lists every container that mounts it,
  running or stopped (`docker ps -a --filter volume=<name>`). It mounts the volume only when each of
  them passes the test above for this App: labelled for it, or in the shape the Hub gave the App's
  containers. A container of the same App but of the other deploy kind is refused too, because the
  deploy would not replace it: App `db`'s services do not start on a volume the Hub's single
  container `db` still mounts, or two databases would write one data directory. The same check runs
  on a volume labelled for this App, since the label names the App but not which of its deploy
  kinds wrote the data. A volume no container mounts carries no evidence, and the first App to
  mount it adopts it.
- **An adopted volume is recorded on the Node.** Docker cannot add a label to an existing volume, so
  the Infra Agent records the adoption in its state directory instead:
  `<state-dir>/volume-owners/<volume>` holds the App's name. From then on the record refuses every
  other App, also after the App's containers are removed, as a label would.

Convex receives only the outcome of a refused deploy. The Infra Agent writes the reason to its
standard error as
`[erainfra] deploy <app> failed: <reason>`.

To adopt a container the Infra Agent refused, first confirm on the Node that it belongs to the App
being deployed (`docker inspect <name>`, look at its image and networks). Then deploy again with
`--adopt`:

```sh
erainfra deploy ./my-app --adopt my-app-web
```

The Infra Agent replaces the named container in the deploy step, as it replaces any container of
the App: it removes it and starts the new one right after, so the App is down no longer than in a
normal redeploy. Do not remove the container by hand first; that leaves the App down until the next
deploy succeeds. The new container carries the labels, so later deploys need no `--adopt`. The
App's volumes are not touched, and a volume the adopted container mounts counts as this App's.
`--adopt` is repeatable and holds for one run only. It must name a container the run starts,
`<app>-<service>`: the CLI and Convex refuse any other name, and the Infra Agent checks again.
It never overrides a label, so a container labelled for another App or service is still refused.
Each adoption is in the audit log, in the `apps.deploy.request` entry. A Node whose Infra Agent
predates `--adopt` ignores it and refuses as before.

If the container belongs to another App, change the name that collides in the App that has no data
yet. An App that already keeps data in a volume moves the data first (below).

To move the Hub's single-container App `db` to a spec with services, stop sending it traffic, then
`docker rm -f db` on its Node and deploy App `db`. A service volume can only be named `db-<volume>`,
so if `db` kept its data in a volume of another name, move the data into that name first.

#### Moving a volume to a new name

Renaming a volume in a spec, or renaming the App, does not move any data. The next deploy mounts a
new, empty volume, the App starts as if it were new, and the data stays in the old volume. Copy the
data first, on every Node where the App keeps it:

1. Stop every container that mounts the old volume, so nothing writes during the copy:
   `docker ps -a --filter volume=<old>` lists them, and `docker stop <name>` stops each.
2. Create the new volume, labelled for the App that will mount it, and copy into it. Any image with
   `sh` and `cp` works, such as the App's own image:

   ```sh
   docker volume create --label erainfra.app=<app> <app>-<volume>
   docker run --rm -v <old>:/from:ro -v <app>-<volume>:/to <image> sh -c 'cp -a /from/. /to/'
   ```

3. Deploy the spec that mounts `<app>-<volume>`, and check the App sees its data.
4. Keep the old volume until you have checked. Then `docker volume rm <old>`. If the Infra Agent had
   adopted it, also delete `<state-dir>/volume-owners/<old>`.

To release an adopted volume to another App without copying, for example after removing the App
that adopted it, delete `<state-dir>/volume-owners/<volume>` on the Node. The next App that mounts
the volume, and that the containers mounting it allow, adopts it.

#### Names Convex does not record

Some names on a Node, from Apps the Hub deployed or from the Infra Agent itself, are in no Convex
row. Each one is either checked on the Node or fails loudly:

| Held by                                                         | Name                                                      | What stops a second App                                                                                                                                                                                                       |
| --------------------------------------------------------------- | --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Hub single-container App deployed without a port (no route row) | its container `<name>`                                    | The Infra Agent's container check: the container is unlabelled on the default network, which no `<app>-<service>` matches.                                                                                                    |
| Hub single-container App                                        | the volumes in its `-v` args                              | The Infra Agent's volume check above. The Hub stored no args for these Apps, so Convex has none of these names.                                                                                                               |
| Hub single-container App                                        | the host ports in its `-p` args                           | Docker refuses to publish a host port twice, so a Convex App given the same port fails at `docker run` with Docker's "port is already allocated" error. The route row records the port, but Convex's port allocations do not. |
| Infra Agent                                                     | volumes it adopted                                        | The record in `<state-dir>/volume-owners`.                                                                                                                                                                                    |
| Hub multi-service App, Hub links and Hub ports                  | containers, volumes, networks, link names and their ports | Recorded: the import from the Hub copied the App rows (with their Docker args), links and port allocations, and planning checks the names.                                                                                    |

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
source with no spec file; `node` names the Node unpinned services land on, and `buildNode` the Node
that builds, which defaults to the `node` default. `adopt` lists containers the run replaces
although the ownership check would refuse them, as `erainfra deploy --adopt` sends it
([Names and ownership](#names-and-ownership)). The spec's `app:`, when set, must match the
request's App. Uploads are limited to 256 MiB.

Without `node`, an App that already runs stays where it runs: its primary Node takes the unpinned
services, and each service it already runs stays on that service's Node. A Hub single-container
App, which has only a route row, stays on the route's Node. Only an App Convex has never seen goes
to the first live Node by name. When the Node an App runs on is not connected to Convex, the run
fails rather than starting the App elsewhere with empty volumes; name a Node with `node` to move
it on purpose. Moving an App off a lost Node is failover's job. The same defaults apply to a push
to a bound branch that names no deploy Node, including bindings copied from the Hub.

The build Node fetches an upload through the Convex file-storage URL in its claimed command payload.
That URL carries no credential, is given only to the Node holding the step's live claim, and stops
working when the run ends, because the upload is deleted then. An upload URL that is never used
for a deploy expires after an hour; the file is not deleted.

### Push-to-deploy

Create a GitHub App for deploys: Repository Contents read, subscribed to `push`, webhook URL
`<site>/github/webhook`. Install it on the repositories you deploy, then set its credentials in the
Convex environment under these names. `/github/webhook` verifies every delivery against
`ERAINFRA_GH_WEBHOOK_SECRET` and refuses any other signature with 401. A verified `push` deploys;
every other verified event is acknowledged and ignored. With no deploy secret set, every delivery
is refused.

```sh
npx convex env set --prod ERAINFRA_GH_APP_ID <app id>
npx convex env set --prod ERAINFRA_GH_APP_KEY --from-file app.private-key.pem
npx convex env set --prod ERAINFRA_GH_WEBHOOK_SECRET <webhook secret>
```

Bind a branch with an admin token, from the CLI or the operator API:

```sh
erainfra git bind acme/web main --app web                       # builds and runs where the App runs
erainfra git bind acme/web release/1.2 --app web-rc --build-node edge-1 --deploy-node edge-2 --port 3000
erainfra git bindings                                           # repository, branch, App, Nodes, last run
erainfra git unbind acme/web release/1.2
```

`POST /api/v1/git/bindings` takes `{repo, branch, app, buildNode?, deployNode?, port?}`, with Nodes
by name. `DELETE /api/v1/git/bindings?repo=<owner/name>&branch=<branch>` removes one; the branch is
a query parameter because it may contain `/`. `--port` is for a repository without a
`portless.yaml`. The App need not exist: the first push creates it. Convex refuses a branch git
would refuse or one written as `refs/heads/…`, since neither can match a push. It answers 409 to a
second binding of the same repository branch (repository names ignore case) and to a binding past
the 200th. A binding does nothing until the deploy App's webhook above reaches
`/github/webhook` and verifies against `ERAINFRA_GH_WEBHOOK_SECRET`. The dashboard functions
`infra/git:bind`, `unbind` and `list` run the same code for a signed-in operator, admin or owner;
`npx convex run` carries no user, so it cannot bind.

A push to a bound branch queues one run per `X-GitHub-Delivery`: the
delivery row and the run commit in one transaction, so a redelivery or a duplicate delivery queues
nothing. The run builds the pushed commit, not whatever the branch points at when the build starts.
For each spec and build step, Convex mints a one-hour installation token for that one repository
with Contents read and puts it in the claimed payload. The Node passes it to `git` as an HTTP
header in the child's environment, never in argv or `.git/config`, and Convex never stores it. With
no deploy App configured, or the App not installed on the repository, public repositories still
deploy without a token. The binding records the last run's result.

### Image registry and cross-Node links

The fleet uses one `registry:2` container on a Node you choose, reached by every other Node at the
same loopback address over an `erainfra-mesh` link, so Docker treats it as a local registry and no
daemon needs configuring. On that Node, start it:

```sh
docker run -d --name portless-registry --restart unless-stopped \
  -p 127.0.0.1:61050:5000 -v portless-registry:/var/lib/registry registry:2.8.2
```

The container and volume names are frozen (CONTEXT.md rule 4). The owner's fleet runs the
`portless-registry` container the Hub's installer started, and its volume holds every image layer
a deploy pulls. A container under another name or volume starts with an empty registry.

Then set both in the Convex environment:

```sh
npx convex env set --prod ERAINFRA_REGISTRY 127.0.0.1:61050       # where builds push and Nodes pull
npx convex env set --prod ERAINFRA_REGISTRY_NODE <node name>      # the Node running the registry
```

`ERAINFRA_REGISTRY` has no default. It is `host[:port]` with no scheme, and it must name the
registry that actually runs. `docker port portless-registry` on the registry Node prints its
address.

A run that would build fails at planning, before anything is built, when:

- `ERAINFRA_REGISTRY` is unset or is not `host[:port]`;
- `ERAINFRA_REGISTRY_NODE` is set but names no Node, or the port cannot be read from
  `ERAINFRA_REGISTRY`;
- a Node other than the registry Node needs the registry and the registry Node is not connected to
  Convex with a proven mesh endpoint;
- `ERAINFRA_REGISTRY_NODE` is unset, `ERAINFRA_REGISTRY` is a loopback address (`127.x.x.x` or
  `localhost`), and more than one Node is enrolled. Each Node would push to and pull from its own
  loopback. With a single Node, that Node's own registry is the right one.

A Node needs the registry when it builds (it pushes) or starts a service whose image is in
`ERAINFRA_REGISTRY` (it pulls): a built image, or an `image:` that begins with the registry
address. An App whose services all name an image from elsewhere, such as `nginx:1`, builds
nothing and pulls nothing from the registry, so it deploys and fails over while the registry Node
is down.

During planning, before any build, the pipeline records a standalone link `registry-<node>` from
the registry Node to each of those Nodes, other than the registry Node itself. Each Node's mesh
snapshot carries it: the registry Node exposes the registry port to that one peer, and the other
Node listens on the same `127.0.0.1` port. The links stay after the run, so a later failover can
pull too. A link of that name that already carries exactly this registry (same Nodes, same port),
such as one imported from the Hub, is used as it is. A run
fails instead of overwriting a different link of that name that someone declared. Leave
`ERAINFRA_REGISTRY_NODE` unset to use a registry every Node reaches by itself, such as one with TLS
at `registry.example.com` (`docker login` on each Node when it is private); nothing is linked then.

A `needs:` dependency on another Node becomes a link in the App row. The provider Node exposes the
dependency's loopback host port to the consumer Node only. The consuming service is started with
`--add-host=host.docker.internal:host-gateway` and reaches the dependency at
`host.docker.internal:<port>`, the port injected as `<NEED>_PORT`.

The consumer Node listens on the address `host-gateway` resolves to, not on every interface. That
address is reachable from the host and its containers only, so the dependency never appears on the
Node's LAN or public address. Convex cannot know the address, so the snapshot names the scope,
`listen: "bridge:<port>"` (snapshot version 2), and the Infra Agent resolves it on the Node the
way Docker does. The [dockerd reference](https://docs.docker.com/reference/cli/dockerd/) says
`host-gateway` resolves to the IPv4 address of the default bridge unless `host-gateway-ips` (or
the older `host-gateway-ip`) is set. So the Infra Agent reads those keys from
`/etc/docker/daemon.json` first, then asks `docker network inspect bridge` for its gateway,
usually `172.17.0.1`. If neither gives an IPv4 address, or the address is loopback or unspecified,
the link stays closed. The agent logs `mesh link <name> stays closed: …` once a minute and retries
at each state poll; it never binds `0.0.0.0` instead. A daemon given `--host-gateway-ip` on its
command line rather than in daemon.json is not visible to the agent; move the setting into
daemon.json. An Infra Agent that only understands snapshot version 1 refuses a version-2 snapshot
and keeps its last one. Convex sends version 2 only to a Node that consumes such a link.

Both ends must run `connect-convex` with a proven endpoint ([Set up a Node](#set-up-a-node)). A
Node without one is left out of its peers' snapshots, and the link stays down.

### Failover

A cron every 10 seconds (`infra/failover.ts`) decides from heartbeats. A healthy Infra Agent
heartbeats at most about 40 seconds apart. A Node is failed over only when:

1. a check finds it silent for three whole heartbeat intervals (120 seconds), and
2. a later check, at least 20 seconds after the first, still finds no heartbeat.

One late heartbeat, or one dropped connection, never triggers it. A heartbeat between the two
checks clears the suspicion, and one outage fails over once.

Each App with any service on the lost Node gets a failover run of the same pipeline. It takes the
App's lease (waiting for a deploy that holds it), moves every service on the lost Node to a
surviving Node, chosen round robin by name, re-plans ports, environment and links from the stored
spec, and redeploys the images the App already runs, without a rebuild, on each Node whose services
changed. Only then are the App row and its routes flipped. Every moved service records its new
Node. Convex also queues the removal of the moved containers on the lost Node, which runs if it
comes back, so a Node that was only partitioned does not keep serving a second copy. A later deploy
to that Node cancels the queued removal.

Failover redeploys stateless services only: a database moved to another Node starts with that
Node's volume. Apps imported from the Hub have no stored spec and are not failed over until
deployed once through Convex. A survivor is any live Node, gateway Nodes included. Set
`ERAINFRA_FAILOVER=0` in the Convex environment to turn automatic failover off, which a fleet with
one Node that should run Apps needs: otherwise a reboot of that Node longer than two minutes moves
its Apps to a gateway Node with empty volumes.

## Gateway ingress

A gateway Node serves `https://<app>.<zone>`. cloudflared on the gateway Node
hands each request to the gateway proxy on loopback, and the proxy forwards it over
`erainfra-mesh` to the Node running the App. No App Node listens publicly.

```text
browser ─https─▶ Cloudflare ─tunnel─▶ cloudflared ─▶ infra-agent gateway (127.0.0.1:61090)
                                      (gateway Node)       │ Host web.<zone> → 127.0.0.1:<ingress port>
                                                           ▼
                                      mesh link ingress.web ═iroh═▶ exposure ingress.web ─▶ App
                                                                    (App Node, 127.0.0.1:<route port>)
```

Only Apps on Nodes with a proven mesh endpoint can be served this way. The owner's fleet moved its
zone from the Hub's tunnel to gateway Nodes on 2026-11-08
([move-ingress-to-gateways.md](runbooks/move-ingress-to-gateways.md)).

### What Convex sends

An owner or admin, or an admin API token, marks a Node as a gateway with its placement roles:

```sh
erainfra nodes set-roles edge-1 gateway
```

Without the CLI: `npx convex run --prod infra/nodes:setPlacementRoles '{"nodeId":"<id>","roles":["gateway"]}' --identity '{"subject":"<users _id>|cli"}'`.

A Node cannot set its own roles: a gateway gets a mesh path to every routed App. An empty `roles`
list removes the role, and the next snapshot revokes the gateway's links and grants. The Node's
mesh snapshot (`GET /api/v1/nodes/state`, see above) then carries ingress under the same revision
as everything else:

- **A gateway Node** gets `ingress.routes`, one `{host, upstream}` per row of `appRoutes`, and one
  link named `ingress.<label>` per route to the App's Node. The link listens on a loopback port in
  61100-61999, derived from the label. A new route never moves an existing route's port, and
  every gateway uses the same port for a route. A route served on the gateway itself has the App's
  port as its upstream and no link. A route whose Node has no proven endpoint or no live
  credential stays in the table with `upstream: null`, so the proxy answers 503 for it. The
  gateway's `fleet` holds only the App Nodes it links to.
- **The App's Node** gets one exposure `ingress.<label>` per route it serves, targeting
  `127.0.0.1:<route port>`. Its `allowed_peers` are exactly the gateway Nodes with a proven
  endpoint and a live credential, and nothing else. Ingress links and exposures allow 1024
  concurrent connections each (the sidecar's default is 256).
- **Every other Node** gets no `ingress` field and no ingress grant. An App Node reads only the
  routes on itself, so the size of the route table never affects a Node that is not a gateway.

A route is served only while its row names the placement the App runs. The App row must place the
route's service on the route's Node at the route's port, and that port must be allocated on that
Node to that service (key `<app>/<service>` in `portAllocations`). A route that fails the check is
refused, not guessed: no exposure on its Node and `upstream: null` at the gateways (503). This
keeps a stale row from pointing an exposure at a port another App now holds on that Node.

A single-container App the Hub deployed has a route row and no App row: its container is named
after the label and publishes the route's port itself, so no port was ever allocated for it. Such
a route is served as long as no App row routes at the label or carries its name, and nothing
Convex knows of holds its port on the route's Node: no port allocation, no mesh link listening
there, and none of the fleet's host-service ports: 61050 and 61080, where the Hub's installer put
the registry and the Hub's API, 61090 for the gateway proxy, 61100-61999 for ingress links, and
the port in `ERAINFRA_REGISTRY`. Convex cannot see containers, so this catches a row that outlived
its container only once one of those took its port, which is exactly when serving it would publish
something else at `<label>.<zone>`, such as the unauthenticated registry.

Route count never refuses a snapshot. Every released Infra Agent refuses a snapshot with more than
128 links or 128 exposures, so each Node's ingress gets what its declared links and exposures
leave of those 128. On a gateway, routes are taken in creation order; the ones that do not fit
answer 503 there, are counted in `ingress.overflow`, and the agent logs
`ERROR: <n> routes do not fit this gateway's mesh link budget` once per revision. An App Node
exposes, in the same order, as many of its routes as fit its own budget. A gateway reads at most
1000 route rows; more are counted as overflow too. Raising the 128 needs an agent release that
raises the validator first. Each gateway's links to one App Node also share that peer
connection's 1024-stream ceiling in the sidecar.

A route is served only if its name is a lowercase first-level DNS label, because Cloudflare's free
certificate covers one wildcard level. Mesh names starting with
`ingress.` are reserved; a declared link with such a name makes that Node's snapshot fail.

### Where the proxy runs

The proxy is a subcommand of the Infra Agent binary, `infra-agent gateway`, run as a separate
process under its own system user. It parses every public request, so it does not run inside the
Infra Agent, which runs as root and holds the Convex credential and the Docker socket. Shipping it
in the same binary keeps one attested release artifact per platform, so the release pins
(ADR 0006) do not grow.

The two processes share one file. The Infra Agent writes the route table to
`ERAINFRA_GATEWAY_ROUTES_FILE` after the sidecar has applied the snapshot's links, by atomic rename,
mode 0644, under the snapshot's revision. The proxy checks that file every second and swaps in a new
revision whole. It refuses an upstream that is not a loopback address, and it refuses to start as
root unless given `--allow-root`.

### Set up a gateway Node

1. Set up the Node with its `erainfra-mesh` sidecar ([Set up a Node](#set-up-a-node)).
2. On the Node, as your own user with `sudo` (not under `sudo`: the script reads
   `~/.cloudflared/cert.pem`), with a Cloudflare origin cert for the zone (`cloudflared login`) and
   cloudflared installed. The script needs no checkout; take it from the release tag the Node's
   agent came from:

   ```sh
   curl -fsSLO https://raw.githubusercontent.com/Fanzzzd/erainfra/v<version>/deploy/infra/gateway.sh
   ERAINFRA_ZONE=example.com sh gateway.sh
   ```

   It runs the Infra Agent's `gateway` command from `/usr/local/lib/erainfra/erainfra-node`, where
   `/install --role node` installs it, or from `ERAINFRA_AGENT_BIN`. It reads that binary
   through `sudo`, so the binary may sit where only root can enter. It creates the
   `erainfra-gateway` system user, `/var/lib/erainfra-gateway` (0750, owned by the
   agent's user, `ERAINFRA_AGENT_USER`, default root, group `erainfra-gateway`), a root-owned copy of
   the binary in `/usr/local/libexec/erainfra-gateway`, and two units that both run as
   `erainfra-gateway`:
   - `erainfra-gateway.service`: the proxy on `127.0.0.1:61090` (`ERAINFRA_GATEWAY_PORT`). The
     unit allows IP traffic to and from loopback only, with no capabilities and a read-only system.
   - `erainfra-gateway-tunnel.service`: cloudflared running the tunnel `erainfra-gateway`
     (`ERAINFRA_GATEWAY_TUNNEL`), with ingress `*.<zone>` to the proxy and 404 for anything else.
     It is bound to the proxy unit: if the proxy stops, this replica leaves the tunnel. The script
     creates the tunnel on first use and fetches its credentials with
     `cloudflared tunnel token --cred-file`, so no credentials file is copied between Nodes.

   It also writes `~/.cloudflared/config-erainfra-gateway.yml`, naming the tunnel and the origin
   cert, for DNS commands. Pass it to every `cloudflared tunnel route dns` for this tunnel:
   `cloudflared tunnel --config ~/.cloudflared/config-erainfra-gateway.yml route dns …`. Without
   `--config`, cloudflared reads a default config (`~/.cloudflared/config.yml`,
   `/etc/cloudflared/config.yml`) and routes to the tunnel that file names.

   If the zone's origin cert is not `~/.cloudflared/cert.pem`, for example because that file
   belongs to another zone, set `TUNNEL_ORIGIN_CERT=<path>` for the script. It then writes
   `config-erainfra-gateway.yml` in the cert's directory, with `origincert: <path>` in it, and
   prints the full DNS command. That command works as printed: cloudflared takes the cert from
   the config, so it needs no `--origincert`.

   If the Node has no `cloudflared` and downloads from GitHub are slow (one host in China got
   about 7 KB/s), take the binary from the official `cloudflare/cloudflared` image if the box
   already has it. It sits at `/usr/local/bin/cloudflared` in the image:
   `docker create --name cloudflared-copy cloudflare/cloudflared:<tag>`, then
   `docker cp cloudflared-copy:/usr/local/bin/cloudflared <dir>/`, `docker rm cloudflared-copy`
   and `sudo install -m 755 <dir>/cloudflared /usr/local/bin/cloudflared`.

   The script does not touch DNS. Without systemd, run the proxy as an ordinary user:
   `infra-agent gateway --zone example.com --routes-file <path> [--listen 127.0.0.1:61090]`, and
   point cloudflared at it.

3. Add `ERAINFRA_GATEWAY_ROUTES_FILE=/var/lib/erainfra-gateway/routes.json` to the
   `connect-convex` agent's environment and restart it. The variable must be an absolute path in a
   directory that exists.
4. Mark the Node a gateway (`infra/nodes:setPlacementRoles` above).
5. Check it. Within about 15 seconds the agent logs
   `gateway route table <revision> written (<n> routes)`, and then:

   ```sh
   curl -s -H 'Host: localhost' http://127.0.0.1:61090/healthz   # {"ok":true,"revision":…,"routes":n}
   curl -s -H 'Host: web.example.com' http://127.0.0.1:61090/     # the App "web", over the mesh
   cloudflared tunnel info erainfra-gateway                         # one connector per gateway Node
   ```

   If Convex marks the Node a gateway but the variable is unset, the agent logs a warning once per
   revision and no proxy gets routes.

### Remove a gateway Node

1. Remove the role: `erainfra nodes set-roles <name> --clear` (or `infra/nodes:setPlacementRoles`
   with `"roles":[]`). Its links and grants go on the next snapshot, and its routes file becomes
   an empty table.
2. `sudo systemctl disable --now erainfra-gateway-tunnel erainfra-gateway`. Its replica leaves the
   tunnel and Cloudflare sends its share to the other gateways.

Never remove the last gateway while the wildcard points at its tunnel: no other replica serves the
zone.

### Proxy behaviour

- **Routing.** `<label>.<zone>` (case-insensitive, port and trailing dot ignored) goes to that
  label's upstream. An unknown label, a deeper name such as `a.web.<zone>`, or a host outside the
  zone gets 404. A known App with no reachable Node gets 503, and so does every request before the
  first table loads. `/healthz` on a host outside the zone reports the loaded revision; names in
  the zone always go to the App, so an App's own `/healthz` is not shadowed. `--zone` takes a
  comma-separated list.
- **Streaming.** Request and response bodies are streamed in both directions with no size limit at
  the gateway, and responses are flushed as the App writes them. WebSocket and other `Upgrade`
  requests are passed through.
- **Timeouts.** Request headers must arrive within 10 seconds; idle keep-alive connections close
  after 120 seconds. The App has 120 seconds to send response headers
  (`--response-header-timeout`), above Cloudflare's 100-second proxy read timeout, so Cloudflare's
  own 524 decides first. Bodies and upgraded connections have no deadline; the mesh closes a
  stream idle for an hour. Dialing the loopback link times out after 5 seconds. A failed upstream
  returns 502, a timeout 504.
- **Headers.** The App sees the public `Host`. `X-Forwarded-For` keeps the chain cloudflared sent and
  appends the hop that reached the proxy (`127.0.0.1`). `X-Forwarded-Host` is the public host.
  `X-Forwarded-Proto` is `https` when cloudflared says so, otherwise `http`. Hop-by-hop headers
  (`Connection` and every header it names, `Keep-Alive`, `Proxy-*`, `TE`, `Trailer`,
  `Transfer-Encoding`, and `Upgrade` outside an upgrade) are removed in both directions.
  `Cf-Connecting-Ip` passes through unchanged. Any local process on the gateway Node can reach
  the loopback port and set these headers, so treat them as trustworthy only as far as you trust
  the gateway Node.
- **TLS** ends at Cloudflare. The proxy speaks plain HTTP on loopback, and the mesh encrypts the
  hop to the App's Node.

### High availability

Run `gateway.sh` on two or more gateway Nodes with the same tunnel name. Each run adds one
cloudflared replica (Cloudflare's word for another connector of the same tunnel). Cloudflare's
documentation ([tunnel availability](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/configure-tunnels/tunnel-availability/),
[deploy replicas](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/configure-tunnels/tunnel-availability/deploy-replicas/),
read 2026-11-06) says:

- a request goes to the geographically closest replica, with no round-robin or hash steering;
- if that connection fails, Cloudflare retries with another replica, with no guarantee which;
- if a host running cloudflared goes down, the remaining replicas keep serving;
- a tunnel takes up to 100 connections, which is 25 replicas.

Cloudflare only notices a replica that has lost its connections. A replica whose proxy is up but
whose table is stale or empty still receives its share, which is why the tunnel unit is bound to
the proxy unit and why `/healthz` should be monitored on every gateway. On the mesh side each App
Node grants every gateway, so any replica can reach any App.

### When Convex is unreachable

Running Apps keep serving. The sidecars keep their links and grants, the routes file keeps the
last table, and the proxy keeps serving it. A restarted proxy loads the file from disk. A restarted
Infra Agent applies nothing and writes no table until Convex answers (it must publish its endpoint
first), so the last table stays in place. Deploys, failover, new routes and role changes wait for
Convex.

### Failover timing

A failover run of the deploy pipeline redeploys the App on a survivor, which allocates its own
ports there, and then rewrites the App row and its route rows with the survivor's Node and port in
one transaction under the App lease (`pipeline.ts` `commit`; `deployments.completeFailover` does
the same and refuses a service with no port allocated on the target). The gateways and the App's
new Node see the change on their next snapshot poll. With the default intervals:

| step                                                               | at most        |
| ------------------------------------------------------------------ | -------------- |
| gateway fetches the new revision (10 s poll, checked on 5 s ticks) | 15 s           |
| sidecar moves the `ingress.<label>` link to the new Node           | under a second |
| route table written, same tick; proxy reads it (1 s poll)          | 1 s            |
| new App Node grants the gateways (its own poll, in parallel)       | 15 s           |

So the gateway serves the new Node within about 16 seconds of the Convex write, plus network
latency. Detecting the lost Node takes at least the missed-heartbeat window plus the failover grace
period ([Failover](#failover)), and the redeploy takes as long as the survivor needs to pull and
start the images; both come before this. The route keeps its gateway-side loopback port, so the proxy's
upstream does not change; the proxy drops idle pooled connections when a new table loads. Until
then requests to that App get 502.

### Limits

- `gateway.sh` is for Linux with systemd. The proxy itself runs anywhere the Infra Agent does.
- The proxy has no access control or rate limiting of its own; use Cloudflare's.

## Operate from the erainfra CLI

`erainfra` (apps/erainfra-cli, [ADR 0011](adr/0011-one-erainfra-cli-over-an-operator-api.md)) is
the operator CLI for Convex.

The EraInfra dashboard shows the same state on its Nodes, Apps, Deployments and Links pages, and
offers the same changes to a signed-in owner or admin (an operator may deploy, link and remove
Apps; a viewer reads). It judges Node liveness against the browser's clock with the backend's
rule, so a Node that stops heartbeating turns offline on the page without a new query result.

Log in once with a dashboard API token (Settings, API tokens). A `read` token runs the list and
view commands; everything that changes state, and log tails, needs an `admin` token.

```sh
erainfra auth login --url https://<deployment>.convex.site --token -

erainfra nodes list                         # liveness, mesh endpoint proof
(umask 077 && erainfra nodes enroll edge-1 > edge-1.credential)
erainfra nodes revoke edge-1                # every live credential; --credential <hint> for one
erainfra nodes reset-endpoint edge-1        # after a Node lost its mesh key
erainfra nodes set-roles edge-1 gateway     # placement roles; --clear removes them

erainfra deploy ./my-app --port 3000        # pack, upload, deploy, follow each stage
erainfra deploy --repo acme/web --branch main
erainfra deployments list --app my-app
erainfra deployments view <id> --follow

erainfra apps list                          # status, Nodes, last deploy, URLs
erainfra apps view my-app                   # services, links, env names, recent deploys
erainfra apps remove my-app --yes

erainfra env list my-app                    # names by scope, never values
erainfra env set my-app MODE=prod
printf %s "$TOKEN" | erainfra env set my-app API_TOKEN --service web
erainfra env unset my-app MODE

erainfra links add gpu-box:8080 web-box     # web-box reaches gpu-box's 8080 at 127.0.0.1:8080
erainfra links list                         # state and reason
erainfra links remove gpu-box-8080-web-box

erainfra git bind acme/web main --app web   # deploy web on every push to main
erainfra git bindings
erainfra git unbind acme/web main

erainfra logs my-app --service web --lines 200
erainfra logs --node edge-1 --unit erainfra-mesh.service
```

Every command takes `--format table|json`. `erainfra deploy` packs a git repository with
`git archive HEAD`, so uncommitted changes are left out and it says so; any other directory is
packed without `node_modules`, `.git`, `dist` and `.turbo`. It exits 0 when the run ends `done`
and 1 when it fails. A source upload that loses its connection, times out or gets a 5xx is tried
again with a new upload URL, up to 4 attempts with 3.5 to 7 seconds of waits in all. A 4xx is
not retried.

### Nodes

A Node that has never heartbeated is offline. Its mesh endpoint is `proven` only after the Node
signed a challenge with its erainfra-mesh key; only a proven Node with a live credential is ever
granted a mesh peer.

Enrolling, revoking and resetting a Node need the `node.admin` permission: an owner or admin
account, or an admin API token. An admin token may enroll a Node because a Node credential cannot
call `/api/v1`, so it cannot be used to mint another token; and an admin token can already run any
image on any Node by deploying it.

### Apps and removal

An App's status is what Convex can see: `deploying` while a run is in flight, `running` when every
Node it runs on heartbeats, and `node-offline` when one stopped or never connected. A
single-container App the Hub deployed without an App row is listed
with kind `container`.

`apps remove` queues `container.remove` for each service's
container and `container.network.remove` for the App's network on every Node the App runs on, and
forgets its routes, port allocations and App row in the same transaction. Each Node removes the
containers when it next polls; one that is offline does it when it returns. The App's env and git
bindings stay: unset or unbind them separately. Removal is refused while a deploy or failover of
the App is queued or holds its lease. A name that is
another App's route label, such as `shop-web` for App `shop`'s routed service `web`, is not an App
and is refused (see [Names and ownership](#names-and-ownership)).

### Env

`env set` without `--service` writes the App-wide scope every service receives; with `--service`
only that service's scope. A bare `KEY` reads its value from standard input, which keeps a secret
out of shell history. No route returns a value: `env list` shows names and a mask.

### Links

A standalone link joins two Nodes: the consumer reaches the provider's `127.0.0.1:<port>` at its own
`127.0.0.1:<local-port>`. The default name is `<provider>-<port>-<consumer>`. Adding an
existing name re-points it. Convex refuses a link it could not carry: the same Node at both ends, a
name an App dependency link or the deploy pipeline already uses, a consumer port another link
listens on, or more than 500 standalone links.

`links list` shows standalone links and every App's dependency links. Each link's `state` is
derived from endpoint proofs and heartbeats, not observed traffic, and comes with a `reason`:

- `active`: both Nodes have a proven endpoint and a live credential, so Convex grants the link over
  erainfra-mesh;
- `degraded`: a Node stopped heartbeating;
- `pending`: a Node has no proven endpoint (never connected, no sidecar, or credential revoked),
  so Convex grants nothing for the link.

### Log tails

The Node API stores no command output, because output can hold secrets. A log tail is the one
exception, shaped so the output reaches only the person who asked:

1. An admin token asks for the last N lines of an App's service or a Node's platform unit
   (`portless-*` or `erainfra-*`). N is 1 to 1000, default 100. Convex writes a row bound to that
   token and queues a `logs` command that runs the allowlisted `container.logs` or `service.logs`
   operation, in one audited transaction. A Node that is not heartbeating to Convex is refused up
   front.
2. The Node runs it, keeps the newest 128 KiB of output, and uploads it with the command's result.
   The command row keeps its outcome only.
3. The requesting token reads it once: `GET /api/v1/logs/<id>` answers 202 while the Node has not
   answered, then 200 once, and deletes the row in that read. Any other token, including another
   admin token, gets 404. An unread tail is deleted five minutes after the request, and its command
   is cancelled if it never ran.

Logs can contain secrets: an App may print its environment, and a stack trace may include a
connection string. That is why reading them needs an admin token, why the tail lives in one row for
one reader, and why the audit log records who asked for which tail and when it was read, but never
its text. A logs command waits behind other commands on its Node; behind a long build it can
expire before it runs. An Infra Agent older than this change answers a logs command with a failure.

### The operator API routes

All on the Convex site origin, with `Authorization: Bearer <API token>`. Errors are
`{"error":{"code","message"}}`: 400 for a refused request, 401 without a valid token, 403 for a
token without the scope, 404 for a name that does not exist, 409 while a deploy holds the App and
for a git binding that exists already or would pass the limit.

| Route                                                                                                | Scope      | Does                                                                |
| ---------------------------------------------------------------------------------------------------- | ---------- | ------------------------------------------------------------------- |
| `GET /api/v1/nodes`                                                                                  | read       | Nodes with liveness, endpoint proof, credentials                    |
| `POST /api/v1/nodes` `{name}`                                                                        | admin      | enrolls; returns the credential once                                |
| `POST /api/v1/nodes/<name>/revoke`                                                                   | admin      | `{credential?}`: one credential, or every live one                  |
| `POST /api/v1/nodes/<name>/endpoint/reset`                                                           | admin      | forgets the Node's mesh key                                         |
| `PUT /api/v1/nodes/<name>/roles`                                                                     | admin      | `{roles}`: replaces the placement roles                             |
| `GET /api/v1/apps`, `GET /api/v1/apps/<app>`                                                         | read       | Apps with status; one App with env names and recent runs            |
| `DELETE /api/v1/apps/<app>`                                                                          | admin      | removes the App (202: Nodes remove containers when they poll)       |
| `GET /api/v1/apps/<app>/env`                                                                         | read       | variable names by scope, masked                                     |
| `PUT /api/v1/apps/<app>/env`                                                                         | admin      | `{vars, service?}`                                                  |
| `DELETE /api/v1/apps/<app>/env/<NAME>`                                                               | admin      | `?service=` for a service's scope                                   |
| `GET`/`POST /api/v1/deployments`, `GET /api/v1/deployments/<id>`, `POST /api/v1/deployments/uploads` | read/admin | [Deploy through the operator API](#deploy-through-the-operator-api) |
| `GET /api/v1/links`                                                                                  | read       | links with state and reason                                         |
| `POST /api/v1/links`                                                                                 | admin      | `{provider, providerPort, consumer, localPort?, name?}`             |
| `DELETE /api/v1/links/<name>`                                                                        | admin      | removes a standalone link                                           |
| `GET /api/v1/git/bindings`                                                                           | read       | push-to-deploy bindings with Nodes by name and the last run         |
| `POST /api/v1/git/bindings`                                                                          | admin      | `{repo, branch, app, buildNode?, deployNode?, port?}`; 201          |
| `DELETE /api/v1/git/bindings?repo=<owner/name>&branch=<branch>`                                      | admin      | removes a binding                                                   |
| `POST /api/v1/logs`                                                                                  | admin      | `{app, service?, lines?}` or `{node, unit, lines?}`; 202            |
| `GET /api/v1/logs/<id>`                                                                              | admin      | 202 pending, 200 once, then 404                                     |

The Node API shares the `/api/v1/nodes/` prefix. Its routes are exact paths, which Convex matches
first, and none of them is a route above. It takes Node credentials only, and these routes take API
tokens only.

Every change through these routes runs the same function body as the matching Convex mutation, writes an
audit row with `token:<name>` as the actor in the same transaction, and audits a refused request
as `deny` with the reason.

## Develop

Run from the repository root, scoped to the parts this surface uses:

```sh
pnpm install
pnpm --filter @erainfra/backend test                 # Convex functions, including convex/infra
go test ./apps/infra-agent/... ./apps/erainfra-cli/...
(cd apps/mesh && cargo test --locked)
sh deploy/infra/gateway.test.sh && sh deploy/infra/relay.test.sh
```

- `packages/backend/convex/infra`: Node, App, link and deploy state, the deploy pipeline,
  failover, ingress and the operator API.
- `apps/infra-agent`: the Infra Agent. `connect-convex`, Docker deploys, builds, the journal and
  the `gateway` proxy.
- `apps/mesh`: the `erainfra-mesh` sidecar.
- `apps/erainfra-cli`: the `erainfra` CLI.
- `apps/dashboard`: the Nodes, Apps, Deployments and Links pages.
- `deploy/infra/`: `gateway.sh` and `relay.sh`.
