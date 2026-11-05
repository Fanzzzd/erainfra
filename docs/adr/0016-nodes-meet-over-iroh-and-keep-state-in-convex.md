# ADR 0016: Nodes meet over iroh and keep their state in Convex

- Status: Accepted; implementation in progress (until each phase lands, the Hub runs as before)
- Date: 2026-11-05
- Owners: EraInfra
- Related: [ADR 0004](0004-portless-is-a-feature-not-a-second-product.md),
  [ADR 0005](0005-name-the-two-agents-by-what-they-serve.md),
  [ADR 0006](0006-one-onboarding-path-with-a-pinned-trust-root.md),
  [ADR 0014](0014-controllers-run-on-the-workers-under-a-lease.md)

## Context

The infrastructure-management surface runs through one Hub process on one server. The Hub is the
only database (`portless.db`), the only scheduler, the only public way in (a Cloudflare tunnel into
the Hub, which proxies every request to a Node over the Node's `/data` socket), the only broker of
mesh tickets, and the only host of installers, agent binaries, uploaded sources and the image
registry. Nodes keep no durable state and no persistent network identity: a Node's id is whatever it
claims in its `hello`, its credential is an ordinary `operator` API token that any CLI user also
holds, and the dumbpipe sidecars that carry node-to-node links start with a new iroh key on every
restart and ride n0's public relays.

The owner wants the fewest servers that are not running workloads, and asked for an uncloud-like
design on iroh. What was measured on 2026-11-05 (sources in the PR that added this ADR):

- **iroh 1.0** (2026-06-15; 1.4.1 current) promises wire and API stability for its core endpoint,
  hole punching and relay fallback. Roughly nine in ten network paths connect directly; the rest
  relay, end-to-end encrypted. Relays are stateless and a client can list several.
- **No supported Go binding.** iroh-ffi covers Python, Swift, Kotlin and Node. The Go FFI wrapper
  needs cgo and only Linux musl; the native Go port is an unaffiliated v0. n0's documented path for
  other languages is a small application-specific binary driven over a local socket.
- **iroh-gossip and iroh-docs are not 1.0.** Gossip's next release changes its wire protocol with no
  backward compatibility; docs has not shipped since May.
- **uncloud** replicates state with Corrosion over a WireGuard mesh. It cannot join two machines that
  are both behind NAT, and Corrosion's QUIC gossip needs directly reachable addresses, so it cannot
  run over iroh without an IP tunnel. Its state model is AP: concurrent deploys are not serialized.
- **n0's public relays** are free but "suitable for development and hobby use only".

The Hub's state also carries invariants a CRDT cannot keep: a port allocator with no uniqueness
constraint, first-user-becomes-owner and never-remove-the-last-owner, unique emails, a total audit
order, token revocation that must reach everyone, and operations that must run exactly once (the
deploy pipeline, webhook-triggered deploys, failover, the stale-deploy sweep). Replicating that
state peer to peer would need consensus on top of the CRDT.

## Decision

Split the Hub's two jobs and give each the home that already exists for it.

**Control state lives in Convex.** The Hub's desired state, invariants and exactly-once operations
move into the same Convex deployment that already runs the CI control plane without a server of the
owner's: apps, routes, links, port allocations, encrypted secrets, git bindings, deployments, audit,
users and tokens. Convex mutations are serializable transactions, so the allocator, ownership rules,
uniqueness and audit order hold by construction. Exactly-once work runs as Convex scheduled
functions under per-app leases (the same lease-and-epoch pattern as ADR 0014), and GitHub webhook
deliveries are deduplicated by delivery id, as the CI webhook intake already does. The Infra Agent
dials Convex, as the Action Runner Agent does, and claims commands addressed to it.

**The data plane runs Node to Node over iroh.**

1. **A sidecar of our own.** `erainfra-mesh`, a small Rust binary on iroh 1.0's core (no gossip,
   docs or blobs), replaces dumbpipe. The Infra Agent drives it over a Unix socket. It runs as its
   own unprivileged user, not as root, and is built, versioned, checksummed and attested in our
   release like every other binary; the installer verifies it against the deployment pin (ADR 0006),
   which dumbpipe's unverified GitHub download never was.
2. **A Node's identity is its iroh key.** Each Node generates an endpoint key once, stores it mode
   0600, and registers its EndpointId with Convex at enrollment. That id replaces the self-declared
   name as the Node's identity, and its enrollment credential replaces the shared operator token.
3. **Only the fleet may connect.** The sidecar rejects, after the handshake and before any
   application data, every peer whose EndpointId is not in the fleet list it receives from Convex.
   Each protocol has its own ALPN (`erainfra/tcp/1` for service links, `erainfra/ingress/1` for
   public traffic), and a link is only opened to the port the link names.
4. **No dependency on n0's discovery.** Each Node publishes its EndpointAddr (id, relay URL, direct
   addresses) through Convex, so peers dial without `dns.iroh.link`.
5. **Relays are a list, not a server to keep.** Any Node with a public address may run iroh-relay
   with an access allowlist of fleet EndpointIds, and is listed first. n0's public relays stay in the
   list as a fallback with their limits documented, and a paid Iroh Services relay can be listed
   instead. A fleet with no public Node relies on the fallback and says so in the dashboard.

**Public traffic enters at gateway Nodes.** A Node with the `gateway` placement role runs the
Cloudflare tunnel connector and an ingress proxy that routes `<app>.<zone>` by the `routes` table
and forwards over iroh to the Node running the app. Several gateways may run the same tunnel;
Cloudflare spreads traffic across connectors and drops a dead one, which is ingress high availability
without a load balancer.

**Files the Hub served move with their owners.** Installers and binaries come from `/install` and
the GitHub Release (ADR 0006). Uploaded sources go to Convex file storage, and the build Node
fetches them through a URL Convex issues for that build. The image registry stays a container on a chosen Node, reached over
iroh links as today, or is replaced by an external registry.

The CLI and the web UI talk to Convex, through the authenticated `/api/v1` and the dashboard, so
the Hub's web app folds into the EraInfra dashboard.

## Considered options

- **uncloud as is:** rejected. NAT-to-NAT Nodes cannot join, and its AP state does not serialize the
  deploys and allocations the Hub's invariants need.
- **CRDT state replicated over iroh (iroh-docs, or Corrosion over a tunnel):** rejected for control
  state. Docs is stalled and gossip is about to break its wire protocol; Corrosion needs an IP tunnel;
  and either still needs consensus for the invariants above. Convex already provides that consensus
  without a server.
- **Native Go iroh in the agent:** rejected for now. The only port is an unaffiliated v0 with a
  forked QUIC and TLS stack, linked into a root process. Revisit when an n0-supported Go binding
  exists; the sidecar's socket API keeps the agent independent of that choice.
- **Keep the Hub and add a standby:** rejected. It keeps a server and adds a second one.

## Consequences

- With ADR 0014, the minimum deployment for both surfaces is Convex plus the machines running
  workloads. A relay is optional; a Node with a public address can be one.
- If Convex is unreachable, running apps keep serving: links are Node to Node and ingress routes from
  the gateway's last copy of the table. Deploys, failover and configuration wait for Convex.
- The migration is phased so a running Hub keeps working throughout:
  1. `erainfra-mesh` with persistent keys and the fleet allowlist replaces dumbpipe, still brokered
     by the Hub;
  2. Node identity and Hub state move into Convex, and the Infra Agent dials Convex;
  3. gateway ingress, the deploy pipeline and failover run from Convex, the CLI and UI follow, and the
     Hub is retired.
- Identifiers a running Node or Hub already holds (`PORTLESS_*`, `/etc/portless/agent.env`,
  `portless-agent.service`, the `portless-data` volume) change only through the dual-read migration
  rules in CONTEXT.md rule 4, never as part of a phase.
