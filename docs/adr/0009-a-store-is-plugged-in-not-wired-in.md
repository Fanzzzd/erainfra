# ADR 0009: A store is plugged in, not wired in — and the freedom lives at the service↔store seam

- Status: Proposed
- Date: 2026-08-20
- Owners: EraInfra
- Amends: [ADR 0007](0007-serve-the-actions-cache-protocol-from-an-s3-compatible-store.md)
- Related: [ADR 0008](0008-win-the-cache-endpoint-below-the-environment.md) (the job↔service half), [ADR 0004](0004-portless-is-a-feature-not-a-second-product.md) (the mesh this reuses)

## What this decides, in one sentence

An operator declares _where_ the cache bytes live — Cloudflare R2, any S3, a
MinIO/Garage on a machine they own, or a colocated store on the Worker host
itself — and EraInfra reaches it by wiring seams that already exist, not by
adding a store-driver abstraction. The default is a colocated store, which
removes the operator-credential blocker ADR 0007 left standing.

## Context: most of this is already built, and the map says exactly which parts

Before proposing new architecture, the existing code was mapped. The result
narrows this ADR sharply — with the store seam already built, it is more a
decision about which of three unfinished seams to finish than a design for a
new one.

**The store seam is already an interface, consumed by interface.**
`apps/cache-service/internal/objectstore/store.go` defines a six-method `Store`
(`PutBytes`, `GetBytes`, `Open`, `List`, `NewUpload`, `PresignGet`) with an
`ErrNotFound` sentinel; both `server.New` and `cacheindex.New` take the
interface. Every S3-compatible store — R2, S3, MinIO, Garage, SeaweedFS, Ceph —
already drops in through the `ERAINFRA_CACHE_S3_*` config with no code change,
`PATH_STYLE=true` for LAN stores. **The pluggability ADR 0007 promised, for the
set of stores an operator would actually pick, is present today.**

**The consumer half shipped with rc.8.** The agent injects `ACTIONS_CACHE_URL`
into the guest through the seam (ADR 0008's chain); readiness carries the
`cache?: {scope, sharedWritable, detail}` evidence ADR 0007's Consequences
demanded. What is missing is not the pipe.

**Three seams are genuinely unfinished, and this ADR is mostly about them:**

1. **Nobody mints a token.** `apps/cache-service`'s server rejects any request
   with no bearer as `401` — a failed restore is refused, not silently missed.
   The issuance primitive exists — `(*cachetoken.Issuer).Issue` — but its only
   callers are tests: no production caller exists in the cache service, the
   controller, or the agent (`config.go` says the signer "in stage C is the
   controller" — future tense), and the agent deliberately does not set
   `ACTIONS_RUNTIME_TOKEN` (its comment: the artifact service shares that
   token, so repointing it breaks `actions/upload-artifact`). **So setting
   `ERAINFRA_CACHE_URL` on a Worker today points every restore at a `401`.**
   This is the same knot as ADR 0008's rule-4 identity question, and it must
   be untied once for both.

2. **A colocated store is refused by verified code, not only by ADR 0007's
   prose.** `apps/runtime/internal/netpolicy/policy.go` denies `127.0.0.0/8`,
   `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `100.64.0.0/10`, and a
   separate `rc:deny-host-input` rule drops guest→host input outright;
   `AllowedDestinations` accepts CIDRs only, never hostnames, and readiness
   `Verify` fails if a rule comment is missing. ADR 0007's "on the same LAN
   means a _different_ host" is enforced at Preflight.

3. **The cache service is not in the supply chain.** No release asset, no
   `AgentRelease` digest pin, no installer role, no unit. Greenfield — good
   (no migration) but owed under ADR 0006's pinned-trust-root rule.

**Portless is three planes, and only one of them is relevant here.** Its
control and ingress planes are hub-brokered WebSocket reverse-proxying; its
east-west _mesh_ is genuine iroh p2p via `dumbpipe` sidecars, where the Hub
brokers only a base32 ticket and carries no data. But the mesh sidecar lives in
`apps/infra-agent` (a Node), never in `apps/action-runner-agent` (a Worker); a
job cannot reach it; and `MeshManager.Connect` surfaces the far service on a
`0.0.0.0` port inside `deniedRanges`. So portless cannot connect a _job_ to
anything — but it can connect the _cache service_ to a store on another machine
the operator owns, which is exactly where it belongs.

## Decision

### 1. Two seams carry cache traffic, and "freedom" lives only in the second

- **job ↔ cache service** is ADR 0008's problem and has exactly one mechanism
  regardless of store choice: the guest resolves GitHub's cache hostnames to
  the cache service and trusts a name-constrained fleet CA. Store location does
  not change it.
- **cache service ↔ store** is where an operator's freedom lives, and it is
  plural by construction:
  - **direct** — an S3/R2/public endpoint the service dials over HTTPS;
  - **localhost** — a colocated MinIO/Garage on the same box as the service;
  - **mesh** — a store on any machine the operator runs as a portless Node:
    the cache service (itself running on a mesh-capable Infra Agent) holds a
    `MeshManager.Connect` link to the store's `dumbpipe`-shared port and points
    `ERAINFRA_CACHE_S3_ENDPOINT` at the resulting local port. No new connector;
    the mesh verbatim.

### 2. Pluggability is S3 configuration, not a store-driver abstraction

Everything an operator named — R2, S3, their own MinIO, a colocated store —
speaks S3. The `objectstore.Store` interface stays; a `StoreKind` selector and
a second `Store` implementation are **deliberately not built** until a
genuinely non-S3 backend (a native object API, a plain filesystem, an
iroh-blobs store) earns its keep. Adding the abstraction now would be a seam
with one implementation on each side — cost without a second case to justify
it. This is a YAGNI line drawn on purpose, and it is cheap to move later
because `Store` is already the interface everything consumes.

### 3. A private store forces proxy download, and that is the price named up front

`PresignGet` mints a URL the _job_ fetches directly, so it only works when the
store endpoint is itself job-reachable — a public R2/S3 URL. A colocated or
mesh-reached store is not job-reachable by design, so it must run
`ERAINFRA_CACHE_DOWNLOAD_MODE=proxy`: the cache service streams the bytes and
the job never touches the store. The cost is that the full cache byte volume
crosses the service. For a colocated store that is a localhost copy and
cheap; for a mesh store it traverses the dumbpipe tunnel, which is the honest
price of keeping the bytes on the operator's own machine. `presign` stays the
default for the public-endpoint case, where offloading the service to R2 is
free.

### 4. The default is colocated, and its one hard problem is named, not waved

Colocated-on-the-Worker-host is the default because it needs no operator
credentials, keeps every byte on the operator's own hardware, and is the
fastest path (localhost). Its central technical task is the one seam #2 above
flagged: **the guest reaches the cache service, and a service on the Worker
host is exactly what `rc:deny-host-input` and `deniedRanges` drop.** This ADR
does not pretend that is free. Stage B picks one of:

- a cache-service endpoint on the guest network that is not the host's input
  chain (a dedicated CNI-routed address, or a DNAT to a host listener that the
  policy classifies as an allowed destination rather than host-input), added
  to the Profile's `AllowedDestinations` and _verified at readiness like every
  other rule_ — never a hand-punched hole, which `Verify` rejects by design;
- or the store and service on a distinct box/namespace the operator runs,
  which is ADR 0007's original "different host" and needs no policy change.

Either way the isolation contract's verified surface is extended by a rule
readiness checks, not bypassed. If neither can be made to verify, the default
falls back to a mesh or remote store and colocation is documented as
unsupported rather than shipped with a hole.

### 5. Token issuance is stage 0, shared with ADR 0008

Nothing about store topology matters until a request can authenticate. The
controller calls `(*cachetoken.Issuer).Issue` for a short-lived, per-Attempt
token scoped by the Attempt's repository and event (ADR 0007's rules 1–2), and
it reaches the job as the bearer the cache client sends. The open question —
whether that is an EraInfra token swapped in at ADR 0008's interception point,
or a verification of GitHub's own `ACTIONS_RUNTIME_TOKEN` — is **the same
decision ADR 0008's rule 4 raises, and is resolved once for both**.

Two invariants this ADR fixes now, because they are cheap to state and
expensive to discover in production. **Authorization is by the authenticated
`Repository` claim and the token's permission bit, never by `Attempt`** —
`Attempt` is a per-Attempt identifier for logging and revocation, not an
authorization input, and treating it as one would make every Attempt its own
cache scope and never hit. And **`Attempt` must be present**: issuance and
verification both reject a missing or whitespace-only value rather than
minting an unattributable token, so a token that cannot be tied back to the
Attempt that used it does not exist. A request whose `Repository` identity
cannot be established is rejected, never defaulted.

### 6. The store becomes a fourth installer role

Under ADR 0006: add `erainfra-cache-service` to `build-go-assets.ts` with the
reproducible ldflags every other target uses, extend `AgentRelease` with a
`cacheService` digest map rendered through the same validated `renderPinnedDigests`
path, and add a `--role cache-store` following the `node`/`worker-host` shape —
its own `*_install` function, a `0600` `/etc/erainfra/cache.env` written before
the secret with the `_FILE` variants for `SIGNING_KEY` and `S3_SECRET`, an
`erainfra-cache-service.service` unit, and the explicit `restart`-after-`enable`
the other roles use because `enable --now` no-ops on a running unit. All names
are new; CONTEXT.md rule 4 binds nothing here.

**The store binary is a trust root too, and ADR 0006 does not exempt it.** The
`erainfra-cache-service` binary gets a pinned digest like every other asset,
but a colocated install also pulls a _store_ image (MinIO, Garage), and an
unpinned `quay.io/minio/minio:latest` is exactly the unverified download ADR
0006 retired for the Infra Agent. So the role gets one of two honest shapes,
and this ADR does not pick which: either **the store image is pinned by digest
in `AgentRelease` and verified before it runs**, on the same footing as the
service binary — which makes EraInfra responsible for tracking that upstream's
releases — or **`--role cache-store` provisions only the service and requires
the operator to point it at an S3-compatible store they manage**, and the
one-command "bring up a store too" convenience is explicitly out of scope until
the pin exists. A role that starts an unpinned store image is not shipped under
ADR 0006 regardless.

## Consequences

- **The plan shrinks rather than grows.** No store-driver framework, no new
  connector, no runner patch. The work is: token issuance (shared with 0008),
  the colocated-reachability rule, a proxy-mode default for private stores, and
  one installer role. Most of the store layer already exists and is tested.
- **The R2 blocker is gone from the critical path.** A colocated default needs
  no Cloudflare credentials. R2 stays a first-class option for operators
  without a box to run a store, and the day it is chosen it is four env vars.
- **A guest with a cache trusts a name-constrained CA (0008) and reaches one
  more allowed destination (this ADR).** Both must show up in the conformance
  fingerprint as decisions traceable to these ADRs, not as drift.
- **A dead store degrades cache to misses only for the fault shapes ADR 0007
  measured** (`404`/`500`); refusal, TLS error and hang stay unmeasured until
  stage B sets the budget — and where the store is reached by proxy, its outage
  is the cache service's outage, which is the availability coupling ADR 0008
  already flagged for the shared results host.

## What would reverse this

- **If the colocated-reachability rule cannot be made to verify at readiness**,
  the default is not colocation — it is a mesh or remote store, and this ADR's
  "default" clause is what changes, not the isolation contract.
- **If a non-S3 store ever earns a place** (an iroh-blobs native store that
  removes the S3 hop for mesh topologies, say), decision #2's YAGNI line moves
  and `StoreKind` gets built then, against a real second implementation.
- **If token issuance cannot bind a stable repository claim** — ADR 0008's
  rule-4 reversal condition — the whole cache fails closed, store topology
  included.

## Considered and rejected

- **A `StoreKind` driver abstraction now:** rejected as premature. Every store
  an operator named is S3-compatible; a driver seam with one S3 implementation
  is cost without a second case. `Store` is already the interface, so the line
  is cheap to move when a non-S3 store earns it.
- **Connecting a job directly to a mesh/portless store:** rejected on three
  independent grounds the map established — the mesh sidecar exists only on
  Nodes, its surfaced port sits in `deniedRanges`, and every mesh op is a
  `confirm:true`, `app.deploy` Hub call on a control plane not merged with the
  Convex one. A job is a network client of the cache service and nothing else;
  the store is the service's concern, never the job's.
- **Modifying `rc:deny-host-input` broadly to reach a colocated store:**
  rejected. The rule is verified at readiness precisely so it cannot be quietly
  widened; the colocated path must add a _specific_ allowed destination that
  readiness checks, not relax the drop.
- **Making the store choice change the job↔service mechanism:** rejected — that
  is ADR 0008's single mechanism, and coupling it to store location would give
  four interception paths to secure instead of one.
