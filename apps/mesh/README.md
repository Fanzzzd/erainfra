# erainfra-mesh

`erainfra-mesh` carries TCP between Nodes over [iroh](https://www.iroh.computer) 1.x. A Node
exposes a service that listens on its own loopback, and another Node links to it: the linking Node
listens on a local port and forwards each TCP connection, end-to-end encrypted, to the exposing
Node, which connects it to the service. Nodes behind NAT connect directly when hole punching works
and through a relay when it does not.

It is phase 1a of [ADR 0016](../../docs/adr/0016-nodes-meet-over-iroh-and-keep-state-in-convex.md):
the sidecar that replaces dumbpipe. It is built, attested and published with every release, but
the Infra Agent still runs dumbpipe until the change that pins these binaries in `AGENT_RELEASE`
and switches the agent over.

What it does that dumbpipe did not:

- **A stable identity.** The Node's Ed25519 key is created once and kept, so its EndpointId
  survives restarts and upgrades. dumbpipe made a new key every start.
- **A fleet allowlist.** Only peers whose EndpointId is in the fleet list may connect, checked after
  the TLS handshake and before any stream. dumbpipe accepted anyone holding a ticket.
- **No implicit n0 services.** It does not publish to or resolve from `dns.iroh.link`, and uses
  n0's public relays only if told to. dumbpipe used both by default.
- **Loopback-only exposure.** A Node can expose only a service on its own loopback, so a fleet peer
  can never use it to reach the Node's LAN.
- **One daemon, driven over a socket.** One endpoint carries every link, instead of one process per
  link parsed out of stdout.

## Run it

```bash
erainfra-mesh init --key /var/lib/erainfra-mesh/mesh.key      # prints the EndpointId
erainfra-mesh daemon --key /var/lib/erainfra-mesh/mesh.key \
  --socket /run/erainfra-mesh/mesh.sock --state /var/lib/erainfra-mesh/state
erainfra-mesh ctl --socket /run/erainfra-mesh/mesh.sock '{"v":1,"op":"status"}'
```

| Command                               | What it does                                                                                                          |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `init --key <path>`                   | Creates the endpoint key with mode 0600 and prints the EndpointId. Refuses if anything exists at `<path>`.            |
| `id --key <path>`                     | Prints the EndpointId of an existing key.                                                                             |
| `daemon --key <path> --socket <path>` | Runs the endpoint and serves the control API. Exits 0 on SIGTERM or SIGINT after closing every link and the endpoint. |
| `ctl --socket <path> <json>`          | Sends one control request and prints the response line. Exits non-zero if the response has `"ok": false`.             |
| `version`                             | Prints `erainfra-mesh <version>`.                                                                                     |

`daemon` options:

| Flag                    | Default         | Meaning                                                                                                                                     |
| ----------------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `--state <dir>`         | none            | Saves the last fleet, relays, exposures and links to `<dir>/state.json` (mode 0600, directory 0700) and restores them on start.             |
| `--idle-timeout <secs>` | 3600            | Closes a forwarded TCP connection after this long with no bytes in either direction. An hour, because pooled database connections sit idle. |
| `--no-portmap`          | port mapping on | Stops asking the local router for a port mapping (UPnP, PCP, NAT-PMP). Mapping helps two NAT'd Nodes connect directly.                      |
| `--log-format <fmt>`    | `text`          | `text` or `json`, written to stderr. `RUST_LOG` sets the level (default `info`).                                                            |

## Threat model

What it protects:

- **The endpoint key.** Whoever holds it is the Node. `init` writes it mode 0600 through a temporary
  file and a hard link, so it is never partly written and never overwritten. `daemon` refuses a key
  file that group or others can read or write, as ssh does.
- **The services a Node exposes.** A peer must be in the current fleet and in that exposure's
  explicit `allowed_peers` list. An omitted or empty list denies everyone. Admission is checked
  against the authenticated connection's EndpointId before connecting to the loopback target.
- **The relay token.** It is sent only to the configured relays, never to n0's, and only over
  https. No log line carries it, at any level (a test captures iroh's trace output to check), and
  `status` reports only `auth_token_set`. With `--state` it is saved in the owner-only state file.

Who it defends against:

| Adversary                                      | Defence                                                                                                                                                                                                                                                                                                                          |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Any iroh endpoint on the internet              | iroh's TLS 1.3 handshake authenticates the peer's EndpointId. The `after_handshake` hook then closes the connection with code 403 unless that id is in the fleet list, before either side can open a stream. `status.fleet_rejections` counts these.                                                                             |
| A relay, ours or n0's                          | Relays forward packets they cannot decrypt. A relay can drop or delay traffic, and learns which EndpointIds talk to which.                                                                                                                                                                                                       |
| A Node removed from the fleet                  | `set_fleet` closes its live connections at once, and the hook refuses its next handshake.                                                                                                                                                                                                                                        |
| This Node dialing somewhere it should not      | The `before_connect` hook refuses to dial an EndpointId outside the fleet, and there is no discovery service: a peer is dialed only at the addresses `set_fleet` gave.                                                                                                                                                           |
| A fleet peer asking for more than it was given | Fleet membership alone grants no service access. Each stream requires an explicit grant to its authenticated EndpointId in that exposure's `allowed_peers`; missing or empty grants deny everyone. Removing a grant closes that peer's streams without interrupting retained peers. Only the named loopback target is forwarded. |
| Another local user                             | The control socket is mode 0660, so only the daemon's user and group can drive it. Run the daemon as its own user and put the Infra Agent in its group. On Windows the named pipe keeps Windows' default security, under which only the creating user, Administrators and SYSTEM may write to it.                                |

What it does not defend against:

- **A compromised authorized consumer.** It can use the services explicitly granted to its
  EndpointId. Services must still authenticate their own clients where needed; mesh authorization
  controls which Node can reach a service, not which application user it represents.
- **Anyone who can write to the control socket.** The control API can grant access to any loopback
  port of this Node and link to any fleet peer. Group membership is the local access check.
- **Linking to 0.0.0.0.** A link listening on `0.0.0.0` (needed so containers reach it through
  the Docker bridge) is reachable from the Node's LAN too. Use `127.0.0.1` or the bridge address
  where that matters.
- **Traffic analysis.** Relays and on-path observers see who talks to whom and how much.

## Control API

Newline-delimited JSON over the control socket. Each request is one line and gets one response
line, in order. On Windows the socket path names a named pipe, such as `\\.\pipe\erainfra-mesh`,
which refuses remote clients.

Every request carries the API version and an operation. An optional `id` of any JSON type is
echoed in the response. Unknown fields are an error rather than ignored.

```json
{"v":1,"op":"status","id":7}
{"v":1,"id":7,"ok":true,"result":{...}}
{"v":1,"id":7,"ok":false,"error":{"code":"bad_request","message":"..."}}
```

Every operation that changes state is idempotent by name. Repeating it returns
`"changed": false` and does nothing. An exposure's `allowed_peers` is compared as a set, so order
and duplicate ids make no difference. Sending a different value under the same name returns `"changed": true`.
Replacing a link or changing an exposure's target or limit closes its connections and resets its
counters. Changing only `allowed_peers` closes streams of removed peers, while retained peers'
streams and the exposure's counters continue.

### status

```json
{ "v": 1, "op": "status" }
```

```json
{
  "version": "0.2.0-rc.10",
  "endpoint_id": "60d23d44…215f",
  "addr": {
    "id": "60d23d44…215f",
    "relay_urls": ["https://relay.example.com/"],
    "direct_addrs": ["203.0.113.7:41641"]
  },
  "relay": {
    "mode": "relays",
    "configured": ["https://relay.example.com"],
    "auth_token_set": true,
    "n0_fallback": false,
    "home": [
      {
        "url": "https://relay.example.com/",
        "connected": true,
        "auth_denied": null,
        "last_error": null
      }
    ]
  },
  "fleet": [{ "id": "9f1c…", "connections": 1 }],
  "fleet_rejections": 0,
  "exposures": [
    {
      "name": "pg",
      "target": "127.0.0.1:5432",
      "allowed_peers": ["9f1c…"],
      "max_connections": 256,
      "bytes_sent": 0,
      "bytes_received": 0,
      "connections_active": 0,
      "connections_total": 0,
      "connections_refused": 0
    }
  ],
  "links": [
    {
      "name": "pg-main",
      "peer": "9f1c…",
      "peer_in_fleet": true,
      "service": "pg",
      "listen": "127.0.0.1:15432",
      "bound": "127.0.0.1:15432",
      "max_connections": 256,
      "bytes_sent": 0,
      "bytes_received": 0,
      "connections_active": 0,
      "connections_total": 0,
      "connections_refused": 0
    }
  ]
}
```

`addr` has the same shape as a `set_fleet` entry, so the agent can publish it and hand it to peers
unchanged. `relay.mode` is `direct_only` when no relay is configured: the Node then connects only to
peers it can reach at a direct address. `bytes_sent` counts bytes sent into the mesh and
`bytes_received` bytes that came out of it. `connections_refused` counts connections the limit or
the peer turned away.

### set_fleet

```json
{
  "v": 1,
  "op": "set_fleet",
  "peers": [
    {
      "id": "9f1c…",
      "relay_urls": ["https://relay.example.com/"],
      "direct_addrs": ["198.51.100.4:41641"]
    }
  ]
}
```

Replaces the whole allowlist at once. Each entry is a peer's `status.addr`. This Node's own id may
be in the list and is skipped. Peers no longer listed are disconnected immediately; the result
lists them in `removed`. A peer listed twice is an error.

### set_relays

```json
{
  "v": 1,
  "op": "set_relays",
  "relays": ["https://relay.example.com"],
  "auth_token": "…",
  "n0_fallback": false
}
```

Sets the relays this Node uses. A changed configuration closes the old endpoint and rebinds with
the same key. This closes active streams and changes the ephemeral UDP port, so the agent must
publish the new `status.addr` to peers. Repeating the same configuration does not rebind.

Rebinding matters: in iroh 1.4 an empty relay map still allows dialing a peer-supplied relay URL,
and removing a relay does not close its existing connections. With no relays we use
`RelayMode::Disabled`, which removes the relay transport entirely. `relays` may be empty.
`auth_token` is optional and sent as a bearer token to the listed relays only.
`n0_fallback` (default false) adds n0's public relays, which n0 describes as suitable for
development and hobby use only; they never receive the token.

iroh keeps relays as a set and picks the home relay by measured latency, so list order is kept
for `status` but does not rank relays. A token over plain `http` is refused.

### expose and unexpose

```json
{"v":1,"op":"expose","name":"pg","target":"127.0.0.1:5432","allowed_peers":["9f1c…"],"max_connections":256}
{"v":1,"op":"unexpose","name":"pg"}
```

`target` must be a literal loopback address and a non-zero port: `127.0.0.0/8` or `[::1]`. Host
names such as `localhost` are refused (`invalid_target`), as is every other address.
`allowed_peers` is an explicit list of consumer EndpointIds. Both current fleet membership and
membership in this list are required on every stream, before the target TCP connection opens.
Omitting the field or sending `[]` denies everyone; there is no wildcard or all-fleet default.
The future controller/Hub integration will derive grants from declared mesh links. This daemon
never infers grants from its fleet list or local link configuration.

Replacing the list closes removed peers' existing streams immediately. Retained peers' streams
and counters continue. A malformed EndpointId rejects the whole request without changing grants.
`max_connections` defaults to 256. `unexpose` closes the service's open streams.

Saved state includes `allowed_peers`. Earlier, undeployed v1 state files without this field still
load, but their exposures deny everyone until an explicit grant is sent. No fleet-wide access is
preserved or inferred. This default-deny tightening remains API v1 because no version has deployed.

### link and unlink

```json
{"v":1,"op":"link","name":"pg-main","peer":"9f1c…","service":"pg","listen":"15432","max_connections":256}
{"v":1,"op":"unlink","name":"pg-main"}
```

`listen` is `PORT`, `:PORT` or `IP:PORT`. A bare port listens on `127.0.0.1`; any other address,
`0.0.0.0` included, has to be written out. Port 0 picks a free port, and the result's `listen`
gives the bound address. A link may name a peer that is not in the fleet yet; its connections are
refused until it is (`peer_in_fleet` in `status`). The exposing Node must also explicitly grant
this Node's EndpointId access to `service`; creating a link grants nothing on the remote Node.
`unlink` closes the listener and every connection it carries.

### Errors

| Code                  | Meaning                                                                                   |
| --------------------- | ----------------------------------------------------------------------------------------- |
| `bad_request`         | Not JSON, an unknown operation or field, a missing field, or a value that does not parse. |
| `unsupported_version` | `v` is not 1.                                                                             |
| `invalid_target`      | An `expose` target that is not a loopback address and port.                               |
| `listen_failed`       | A `link` could not bind its listen address, usually because the port is taken.            |
| `endpoint_failed`     | The endpoint could not rebind after a relay change. Restart the daemon.                   |
| `shutting_down`       | The daemon received SIGTERM.                                                              |

Names (`name`, `service`) are 1 to 64 characters of `A-Z a-z 0-9 . _ -`. A request line may be up to
4 MiB.

## Wire protocol

Peers connect with ALPN `erainfra/tcp/1`. A link opens one QUIC bidirectional stream per TCP
connection and writes the service name, a big-endian `u16` length followed by the name. The exposing
Node answers with one status byte: `0` accepted, `1` no such service, `2` target unreachable,
`3` at the connection limit, `4` not authorized for this exposure. After `0`, both directions carry
raw bytes, and a TCP half-close becomes a
stream finish. The link sends its first bytes without waiting for the answer, which saves a round
trip per connection.

## Operations

- **Run it unprivileged.** It needs no root and no capabilities: the endpoint uses an unprivileged
  UDP port, and links usually listen above 1024. Give it its own user, a key directory it owns
  (0700), and a socket directory such as `/run/erainfra-mesh` (0750, group shared with the agent).
- **Firewall.** iroh picks an ephemeral UDP port and uses hole punching and the configured relays.
  Open outbound UDP for direct connectivity and HTTPS to the relays for fallback.
- **Upgrades and restarts** keep the EndpointId as long as the key file is kept. With `--state`,
  the daemon comes back with its last configuration before the agent re-sends it. Saved fleet
  addresses can be stale after peers restart on new ports, so the agent should push a fresh
  `set_fleet` after every start.
- **Rotating a Node's identity** is deliberate: stop the daemon, delete the key, run `init`, and
  publish the new EndpointId so every peer's fleet list changes.
- **Diagnosing a link.** `status` shows whether the peer is in the fleet, live connections per
  peer, the home relay's state (`auth_denied` names a relay that refuses the token), and per-link
  counters. Refused connections are logged at `warn` with the reason. Raise detail with
  `RUST_LOG=erainfra_mesh=debug,iroh=info`.

## Develop

```bash
cargo fmt --check
cargo clippy --locked --all-targets -- -D warnings
cargo test --locked
cargo deny --locked check
```

The tests run real daemons in-process and drive them through their control sockets, with endpoints
bound to 127.0.0.1, relays disabled and port mapping off, so they need no network. The relay tests
run iroh's test relay on loopback. Release binaries are built by
`pnpm --filter @erainfra/release build-mesh-assets` (see `packages/release/src/mesh-assets.ts`).
