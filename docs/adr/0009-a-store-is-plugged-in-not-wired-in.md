# ADR 0009: A store is plugged in, not wired in — and the freedom lives at the service↔store seam

- Status: Proposed
- Date: 2026-08-20
- Owners: EraInfra
- Amends: [ADR 0007](0007-serve-the-actions-cache-protocol-from-an-s3-compatible-store.md)
- Related: [ADR 0008](0008-win-the-cache-endpoint-below-the-environment.md) (the job↔service half), [ADR 0004](0004-portless-is-a-feature-not-a-second-product.md) (the mesh this reuses)

## What this decides, in one sentence

An operator declares _where_ the cache bytes live — Cloudflare R2, any S3, or a
MinIO/Garage the operator runs (including in a separate network namespace on the
Worker host itself) — and EraInfra reaches it by wiring seams that already
exist, not by adding a store-driver abstraction. The default keeps the bytes on
the operator's own box without amending the verified isolation contract; R2 is a
first-class alternative for operators who would rather not run a store.

## Context: most of this is already built, and the map says exactly which parts

Before proposing new architecture, the existing code was mapped. The result
narrows this ADR sharply — with the store seam already built, it is more a
decision about which of three unfinished seams to finish than a design for a
new one.

**The store seam is already an interface, consumed by interface.**
`apps/cache-service/internal/objectstore/store.go` defines a six-method `Store`
(`PutBytes`, `GetBytes`, `Open`, `List`, `NewUpload`, `PresignGet`) with an
`ErrNotFound` sentinel; both `server.New` and `cacheindex.New` take the
interface, and the hand-rolled SigV4 is deliberately R2/MinIO-shaped
(`UNSIGNED-PAYLOAD`, no chunked signing, no `x-amz-checksum-*`, path-style
default, `us-east-1` which R2 aliases to `auto`). So every S3-compatible store —
R2, S3, MinIO, Garage, SeaweedFS, Ceph — drops in through `ERAINFRA_CACHE_S3_*`
config with no code change. **Two caveats keep this "structurally present," not
"proven":** there is no integration test against a real MinIO/Garage/R2 (only an
in-repo fake that does not verify signatures), and the multipart uploader
overshoots part size by up to one client chunk, which R2's uniform-part-size
rule can reject on irregular chunk streams. Stage B owes a real-store
integration test and a uniform-part fix before "pluggability" is a promise
rather than an inference.

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
   This is the same knot as ADR 0008's §4 identity question, and ADR 0008
   unties it once for both by authorizing at the interceptor.

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
  regardless of store choice: the guest transparently resolves GitHub's cache
  hostname to the interceptor and trusts a name-constrained **per-guest
  ephemeral** CA. Store location does not change it.
- **cache service ↔ store** is where an operator's freedom lives, and it is
  plural by construction:
  - **direct** — an S3/R2/public endpoint the service dials over HTTPS;
  - **localhost** — a MinIO/Garage in the same namespace as the service;
  - **mesh** — a store on a machine the operator runs as a portless Node,
    reached over the existing iroh/`dumbpipe` mesh. The seam is a plain local
    TCP port the service dials via `ERAINFRA_CACHE_S3_ENDPOINT`; **the cache
    service does not itself drive the mesh** — `MeshManager` is `internal` to
    `apps/infra-agent` and Hub-brokered, so this topology means enrolling the
    store box as a portless Node and running one confirm-gated `mesh.link`, and
    it inherits the Hub as an availability dependency for the cache. Honest, but
    not "the mesh verbatim" — it is the second product's stack on the store box.

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

`PresignGet` mints a URL the _job_ fetches directly (the presigned URL is built
verbatim from `ERAINFRA_CACHE_S3_ENDPOINT` — there is no public-URL rewrite), so
it only works when the store endpoint is itself **job-reachable**: a public
R2/S3 URL, or a LAN store whose CIDR is in `AllowedDestinations`. A store the
job cannot reach — a `127.0.0.1` MinIO, a mesh-tunnelled store — must run
`ERAINFRA_CACHE_DOWNLOAD_MODE=proxy`, where the cache service streams the bytes
and the job never touches the store. Two honest corrections to an earlier draft:
"private" is not "job-unreachable" (a LAN store in `AllowedDestinations` presigns
fine), and presign does **not** make the public case free — only downloads
presign; v1 uploads are `PATCH` against the service and the v2 `signed_upload_url`
always points back at the service (the Azure-shape translation), so **upload byte
volume crosses the service in every topology.** The code defaults to `presign`
while this ADR's default store is not job-reachable, so the install must set
`proxy` for the default or the first restore fails on an unreachable URL.

### 4. The default keeps bytes on the operator's box WITHOUT touching the isolation contract

The intuitive default — cache service and store on the Worker host itself — is
the one the code makes hardest, and the store review proved it. The guest
reaches the cache service, and a service on the Worker host is what
`rc:deny-host-input` drops. Worse, the input chain in
`apps/runtime/internal/netpolicy` has **no allow mechanism at all** —
`rc:allow-destinations` exists only in the forward chain — so "a DNAT to a host
listener classified as an allowed destination" is not implementable: DNAT is
prerouting, the packet is still locally delivered, the input hook matches on
source, and making it work means adding a rule to the input chain, which changes
`ExpectedRules`, the renderer, the verifier, and `IdentityHash` together — i.e.
**amending the verified isolation contract itself.** The host-side gateway
address is doubly inexpressible: it is host-input (dropped) and it sits inside
the guest subnet, which `Validate` rejects for `AllowedDestinations`.

So the default is the shape that keeps the bytes on the operator's box and
changes **zero** netpolicy code: **the cache service and its store run in a
distinct network namespace (or a small second host) at an address outside the
guest subnet** — e.g. `172.30.0.2/32` in the Profile's `AllowedDestinations`,
which rides the existing, already-verified forward-chain allow. This can be the
Worker host physically (a separate netns on `ubuntu0`), so "on my own hardware,
no cloud" is preserved, without amending the contract readiness checks. The
store sits localhost-to-the-service inside that namespace; the guest reaches
only the service, never the store.

The honest cost ordering the review established, stated so nobody re-derives it:
**R2-direct ≈ separate-netns ≪ mesh ≪ colocated-on-the-Worker-host.** R2-direct
is genuinely simplest (four env vars, presigned downloads bypass the service, no
netpolicy work, no store image to pin) and stays a first-class option;
separate-netns ties for cheapest while keeping bytes on-prem. Colocated-on-the-
Worker-host is **not** offered as the default it once was — it is the most
expensive path, and its only saving is credentials, which R2 aside is the
smallest blocker in play.

### 5. Identity is solved at the interceptor, not by minting a bearer

The store review found the chicken-and-egg that sinks "mint a per-Attempt token
and hand it to the client": the runner overwrites `ACTIONS_RUNTIME_TOKEN` per
action step, and the guest environment is composed at boot from MMDS before
`JobStarted` exists, so **no EraInfra bearer can be delivered to the cache
client through any environment tier.** ADR 0008 §4 dissolves this — the
interceptor is per-guest and already holds the Attempt's identity from the MMDS
boot context, so it authorizes by that identity rather than by a token the
client presents. "Stage 0" is therefore the ADR 0008 interceptor, not a token
mint; store topology is downstream of it, and arguing store choice before the
interceptor exists is choosing wallpaper before the door.

The authorization contract matches the code as it stands, not an invented
invariant: `(*cachetoken.Issuer).Issue` exists (no `Mint`), and its `Verify`
authorizes by the `Repository` claim and the permission bit. **`Attempt` is
carried for logs and revocation only — `Verify` never inspects it** — so
authorization must never key on it (that would give every Attempt its own scope
and never hit). If a future revocation story needs `Attempt` to be present, that
is a deliberate code change to `Issue`/`Verify`, not a fact this ADR can assert.
A request whose `Repository` identity the interceptor cannot establish is
rejected, never defaulted.

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
  connector, no runner patch. The store layer is mostly present; the real work
  is downstream of ADR 0008's interceptor: the separate-netns reachability, a
  real-store integration test, the multipart-uniformity fix, `proxy` as the
  default for a non-job-reachable store, and one installer role.
- **The credential blocker was never the real one.** The job↔service seam
  (interception, identity, netpolicy reach to the service) is identical across
  every store choice, so R2 credentials are the smallest blocker in play. The
  default keeps bytes on the operator's box with no credentials; R2 stays a
  first-class option and is four env vars the day it is chosen.
- **A guest with a cache trusts a per-guest CA (0008) and reaches one more
  allowed destination (this ADR).** Both must show up in the conformance
  fingerprint as decisions traceable to these ADRs, not as drift.
- **A dead store degrades cache the way ADR 0008's fail-open forward does** —
  to real GitHub for the reached-directly case, and to a miss for the
  proxied case — for the fault shapes ADR 0007 measured (`404`/`500`); refusal,
  TLS error and hang stay unmeasured until stage B sets the budget.

## What would reverse this

- **If the separate-netns address cannot be reached under the existing
  forward-chain allow** — if it turns out to need input-chain changes after all
  — the default is R2-direct or a remote store, not a contract amendment.
- **If a non-S3 store ever earns a place** (an iroh-blobs native store that
  removes the S3 hop for mesh topologies, say), decision #2's YAGNI line moves
  and `StoreKind` gets built then, against a real second implementation.
- **If identity cannot be bound at the interceptor** — ADR 0008's rule-1/§4
  reversal condition — the whole cache fails closed, store topology included.

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
- **Colocated on the Worker host as the default** (an earlier draft's choice):
  rejected once the code was read. The input chain has no allow mechanism, the
  host gateway address is both host-input and inside the guest subnet
  `Validate` rejects, and reaching a host listener would mean amending the
  verified isolation contract (ExpectedRules + renderer + verifier +
  IdentityHash). The separate-netns address keeps bytes on the same physical box
  with zero contract change, so colocation-on-host buys nothing its safer
  sibling does not.
- **Modifying `rc:deny-host-input` broadly to reach a store:** rejected. The
  rule is verified at readiness precisely so it cannot be quietly widened; the
  store is reached through the existing forward-chain allow to an address
  outside the guest subnet, not by relaxing the input drop.
- **Making the store choice change the job↔service mechanism:** rejected — that
  is ADR 0008's single mechanism, and coupling it to store location would give
  four interception paths to secure instead of one.
