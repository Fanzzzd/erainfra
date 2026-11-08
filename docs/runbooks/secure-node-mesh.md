# Opt in to the secure Node mesh

The secure mesh uses the pinned `erainfra-mesh` sidecar: each link is authenticated by the Nodes'
EndpointIds, and a provider admits only the consumers its links name. It replaces dumbpipe, whose
bearer tickets let anyone holding one reach the service. The move happens in three releases, so a
fleet with links keeps them working throughout (see [Rollout](#rollout)). Existing Nodes keep their
frozen units, paths and `PORTLESS_*` values.

## Before installation

The release owner must cut an authorized release that publishes all five `erainfra-mesh` targets,
with `AGENT_RELEASE.mesh` populated on the release commit from the release workflow's own build.
The steps are in the README's release section; they use `print-mesh-pin`, never a hand-typed
digest.

Until then, `/install --role node --mesh` and `--convex` refuse before downloading or replacing an
agent. Do not create a pin from a local or unpublished build.

## Install or migrate a Node

Run the control plane's verified installer with `--mesh`:

```sh
curl --proto '=https' -fsSL https://<site>/install | sudo bash -s -- --role node \
  --token <hub token> --hub wss://<hub>/agent --mesh
```

The installer checks the Infra Agent against the deployment pin. It checks `erainfra-mesh` against
both the deployment pin and the release's `.sha256`. On Linux systemd it creates:

- an `erainfra-mesh` system user, not root;
- `/var/lib/erainfra-mesh` (0700), `endpoint.key` (0600) and the restored state directory;
- `/run/erainfra-mesh` (0750) and `control.sock` (0660);
- `erainfra-mesh.service` with memory, task, file-descriptor and CPU bounds.

`portless-agent.service` keeps its name. It joins the `erainfra-mesh` group and gets two variables:
`ERAINFRA_MESH_SOCKET` (the sidecar's control socket) and `ERAINFRA_MESH_CONTROL_DIR` (a 0700
directory holding the controller lock). The agent unit requires `erainfra-mesh.service`, and the
agent exits at startup if the sidecar does not answer `status`, so systemd retries it instead of
running a Node that silently lacks the mesh.

The same installer sets up a Node in Convex mode (`connect-convex`) with
`--role node --convex --credential-file <path>` in place of `--token` and `--hub`. It needs Linux
with systemd. It installs `erainfra-mesh.service` exactly as above, then runs the agent as
`erainfra-node.service` with the same two variables instead of `portless-agent.service`. It refuses
while `portless-agent.service` or `erainfra-agent.service` is running or enabled, unless
`--replace-hub-agent` is given to stop and disable it. The Hub-mode installer refuses while
`erainfra-node.service` is running or enabled. See
[Set up a Node](../infra-management.md#set-up-a-node).

A non-systemd install must run as an ordinary user. It sets `ERAINFRA_MESH_BIN`, and the Infra Agent
then supervises one sidecar under `$PORTLESS_PREFIX/run/mesh-control/sidecar` (key, state and
socket, all private). It refuses to supervise a root sidecar, and refuses to start a second daemon
on a socket that already answers.

Only one controller drives a sidecar. The Infra Agent holds an exclusive lock on
`controller.lock` in the control directory, and another on the directory that holds the sidecar's
socket, for its whole lifetime. A second agent process, or a Hub-mode and a Convex-mode
(`connect-convex`) agent on the same Node, fails at startup instead of fighting over grants, even
when the two were given different control directories. On Windows only the control-directory lock
exists, and `connect-convex` refuses to drive a sidecar there.

On Windows, the mesh pipe has an explicit protected DACL for SYSTEM and its owner. Key and state
directories receive a protected DACL for SYSTEM and the agent user. Windows sidecar installation is
not yet wired into `install.ps1`; use the same pinned asset only through a reviewed Windows install
change.

## Link and authorize services

Use existing `portless link` or deploy-time `needs:` links. The Hub picks the transport for each
link on every healer pass (every minute and whenever an agent connects):

- **Mesh**, when both ends advertise `erainfra-mesh/v1`, or the link is already on the mesh. The
  Hub requests `meshStatus` over its authenticated agent connection, collects stable EndpointIds and
  addresses, and sends `meshApply`. Each provider exposure grants only the consumers named by
  stored links. No fleet member gets implicit access. Link removal, App removal and reconnect
  sweeps re-send the full desired state, and removed grants close existing streams.
- **Legacy dumbpipe**, when either end has no sidecar: the old ticket path, exactly as before, for
  that link only. It is unauthenticated: anyone who obtains the ticket can reach the service.

A link never runs on both. Once the Hub records a link as mesh (table `link_transports` in the Hub
database) it never sets it up on dumbpipe again: if an end later stops answering or loses the
sidecar, the link reports `degraded` and waits. The agent enforces the same rule: a Node with the
sidecar refuses `meshShare` and `meshConnect` for any name in its mesh configuration.

When a legacy link's other end gains the sidecar, the next pass migrates it: the provider's grant
goes in first, then the consumer's dumbpipe listener is dropped to free its port, then the mesh
listener opens. Only when both sidecars confirm the grant and the bound listener does the Hub drop
the provider's dumbpipe share and record the link as mesh. Expect a few seconds without the link
on the consumer during that switch. A switch that is not confirmed shows `migrating` with the reason
and is retried on the next pass; it does not go back to dumbpipe.

### See which links are still legacy

```sh
portless links          # TRANSPORT column; legacy links print a warning naming the Node to upgrade
portless links --json   # transport, authenticated, state, warning, error per link
```

`mesh.list` in the Hub API returns the same fields for standalone and App links (App links carry
`app`). `state` is one of:

| state       | meaning                                                                     |
| ----------- | --------------------------------------------------------------------------- |
| `secure`    | on the mesh, confirmed by both sidecars                                     |
| `degraded`  | on the mesh, but an end is offline or not answering; it stays on the mesh   |
| `migrating` | both ends support the mesh; the next pass moves it, or the last move failed |
| `legacy`    | on dumbpipe, `transport: legacy-dumbpipe`, `authenticated: false`           |
| `refused`   | an end has no sidecar and `ERAINFRA_MESH_REQUIRE=true`                      |
| `offline`   | an end is offline and the link has never been on the mesh                   |

## Rollout

The transport change follows the expand, migrate, contract rule (CONTEXT.md rule 4,
[rename-phase-2.md](rename-phase-2.md)):

1. **Expand: this release.** Hub and agent support both transports. Upgrading the Hub and agents
   changes nothing for a link with a legacy end. `ERAINFRA_MESH_REQUIRE` defaults to `false`.
2. **Migrate: operator, Node by Node.** Reinstall each Node with `/install --role node --mesh`
   (below). Its links move to the mesh on the next pass. Watch `portless links` until no link
   shows `legacy-dumbpipe`, then set `ERAINFRA_MESH_REQUIRE=true` in the Hub's environment and
   restart it. From then on the Hub refuses any legacy link, ends any dumbpipe pair still running,
   and `portless link` to a Node without the sidecar fails with the Node's name.
3. **Contract: a later release.** dumbpipe is deleted from the Hub, the agent and `agent.sh`, and
   refusal becomes the only behaviour: the `ERAINFRA_MESH_REQUIRE` default flips to `true` and
   the setting then goes away. Do not take the contract release while `portless links` still
   shows a legacy link; those links stop working.

## Relays

The Hub sends every Node the same relay policy, read from its own environment:

- `ERAINFRA_MESH_RELAYS`: a JSON array of relay URLs, for example
  `["https://relay.example.com"]`. Default `[]`.
- `ERAINFRA_MESH_RELAY_TOKEN`: an optional bearer token sent only to those relays. It never appears
  in `status` output or in agent logs.
- `ERAINFRA_MESH_N0_FALLBACK`: `true` adds n0's public relays. Default `false`, because n0 describes
  them as suitable for development and hobby use only.

With no relay at all, two Nodes connect only when one can reach the other's direct address. Two
Nodes that are both behind NAT need a relay, so set `ERAINFRA_MESH_RELAYS` or
`ERAINFRA_MESH_N0_FALLBACK=true` before linking them. Changing the relay policy rebinds every
sidecar and closes its open streams; the Hub then publishes each Node's new address before
reopening links.

A relay of the fleet's own is set up by [run-a-fleet-relay.md](run-a-fleet-relay.md). It checks
each client with Convex rather than with a token, so leave `ERAINFRA_MESH_RELAY_TOKEN` unset for
it. The token is for a relay run with iroh-relay's `access.shared_token`.

## Roll back

Rolling one Node back takes its links off the mesh but not onto dumbpipe: a link recorded as mesh
stays on the mesh and reports `degraded` until the Node has the sidecar again.

1. Remove or disable the Node's links first if they must keep working, and re-create them after
   the rollback; a new link with a legacy end goes on dumbpipe (unless `ERAINFRA_MESH_REQUIRE` is
   set).
2. Reinstall the previous pinned Infra Agent with the same `/install --role node` command, omitting
   `--mesh`.
3. Stop the sidecar with `systemctl disable --now erainfra-mesh`.
4. Keep `/var/lib/erainfra-mesh/endpoint.key` if you may opt in again. Its EndpointId is the Node's
   identity. Delete it only for an intended identity rotation.

A rolled-back Node continues deployments, routes and host operations.
