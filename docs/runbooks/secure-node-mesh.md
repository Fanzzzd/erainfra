# The Node mesh sidecar

Every Node runs the pinned `erainfra-mesh` sidecar. Each link is authenticated by the Nodes'
EndpointIds, and a provider admits only the consumers its links name. Convex derives each Node's
links and grants; [Nodes and the mesh](../infra-management.md#nodes-and-the-mesh) describes the
snapshot, endpoint proofs and relays. This page covers what the installer puts on a Node.

The sidecar replaced dumbpipe, whose bearer tickets let anyone holding one reach the service.
dumbpipe left main with [ADR 0020](../adr/0020-the-hub-leaves-main.md).

## Before installation

`/install --role node` verifies `erainfra-mesh` against `AGENT_RELEASE.mesh`, which every release
since v0.2.0-rc.11 pins for all five targets. A deployment whose release pins no build for the
Node's target refuses before it downloads or replaces anything. Do not create a pin from a local or
unpublished build; [Releases](../releases.md) describes how `print-mesh-pin` fills it.

## What the installer creates

[Set up a Node](../infra-management.md#set-up-a-node) has the install command. The installer
checks `erainfra-mesh` against both the deployment pin and the release's `.sha256`. On Linux with
systemd it creates:

- an `erainfra-mesh` system user, not root;
- `/var/lib/erainfra-mesh` (0700), `endpoint.key` (0600) and the restored state directory;
- `/run/erainfra-mesh` (0750) and `control.sock` (0660);
- `erainfra-mesh.service` with memory, task, file-descriptor and CPU bounds.

`erainfra-node.service` joins the `erainfra-mesh` group and gets two variables:
`ERAINFRA_MESH_SOCKET` (the sidecar's control socket) and `ERAINFRA_MESH_CONTROL_DIR` (a 0700
directory holding the controller lock). It requires `erainfra-mesh.service`, and the Infra Agent
exits at startup if the sidecar does not answer `status`, so systemd retries it instead of running
a Node that silently lacks the mesh.

A non-systemd install runs as an ordinary user. It sets `ERAINFRA_MESH_BIN`, and the Infra Agent
then supervises one sidecar under `$ERAINFRA_PREFIX/run/mesh-control/sidecar` (key, state and
socket, all private; the prefix defaults to `~/.portless`). It refuses to supervise a root
sidecar, and refuses to start a second daemon on a socket that already answers.

Only one controller drives a sidecar. The Infra Agent holds an exclusive lock on
`controller.lock` in the control directory, and another on the directory that holds the sidecar's
socket, for its whole lifetime. A second Infra Agent fails at startup instead of fighting over
grants, even when the two were given different control directories. On Windows `connect-convex`
refuses to drive a sidecar, because a named pipe has no directory to lock.

## Relays

Each Node reads its relay policy from its own environment. Convex stores no relay token.

- `ERAINFRA_MESH_RELAYS`: a JSON array of relay URLs, for example
  `["https://relay.example.com"]`. Default `[]`. An entry may also be an object that names the
  relay's QUIC address discovery port, `{"url":"https://relay.example.com","quic_port":443}`
  ([run-a-fleet-relay.md](run-a-fleet-relay.md#6-list-the-relay-on-every-node)).
- `ERAINFRA_MESH_RELAY_TOKEN`: an optional bearer token sent only to those relays. It never appears
  in `status` output or in Infra Agent logs.
- `ERAINFRA_MESH_N0_FALLBACK`: `true` adds n0's public relays. Default `false`, because n0 describes
  them as suitable for development and hobby use only.

With no relay at all, two Nodes connect only when one can reach the other's direct address. Two
Nodes that are both behind NAT need a relay, so set `ERAINFRA_MESH_RELAYS` or
`ERAINFRA_MESH_N0_FALLBACK=true` before linking them. Set the variables on `erainfra-node.service`
as step 4 of [Set up a Node](../infra-management.md#set-up-a-node) shows.

A relay of the fleet's own is set up by [run-a-fleet-relay.md](run-a-fleet-relay.md). It checks
each client with Convex rather than with a token, so leave `ERAINFRA_MESH_RELAY_TOKEN` unset for
it. The token is for a relay run with iroh-relay's `access.shared_token`.

## The endpoint key

Keep `/var/lib/erainfra-mesh/endpoint.key` across reinstalls and upgrades. Its EndpointId is the
Node's mesh identity, and Convex refuses a different key until an admin runs
`erainfra nodes reset-endpoint <name>`
([Endpoint publication and the snapshot](../infra-management.md#endpoint-publication-and-the-snapshot)).
Delete the key only for an intended identity rotation.
