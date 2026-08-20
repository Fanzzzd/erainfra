# ADR 0008: Win the cache endpoint below the environment

- Status: Proposed
- Date: 2026-08-20
- Owners: EraInfra
- Amends: [ADR 0007](0007-serve-the-actions-cache-protocol-from-an-s3-compatible-store.md)
- Related: [ADR 0009](0009-a-store-is-plugged-in-not-wired-in.md) (the store this points at)

## The measurement that forces this, and the protocol reality it runs into

ADR 0007 refused to assume the one thing its delivery design needed: "whether an
EraInfra-supplied value survives the runner's own injection is unmeasured here
and is a stage-C prerequisite." Three runs of
`.github/workflows/cache-env-probe.yml` on real `rc-e2e` Attempts settled it:

- **Run 32109974600** found a `run:` step and an action step are different
  environments — the runner composes every **action** step's environment from
  GitHub's job message, overwriting `ACTIONS_CACHE_URL`, `ACTIONS_RESULTS_URL`,
  `ACTIONS_CACHE_SERVICE_V2` and `ACTIONS_RUNTIME_TOKEN` regardless of the
  process environment, a step `env:` block, or `$GITHUB_ENV`.
- **Run 32353754282**, with the full v0.2.0-rc.8 seam live, closed the last
  workflow-shaped tier: a value EraInfra set reached the job's script step
  intact and was overwritten in the very same job's action step.

Every real cache client — `actions/cache`, `setup-node`, `setup-go`, buildx's
`type=gha` — is an action step. **EraInfra can deliver any environment it likes,
and the runner overwrites the four cache variables in every environment a cache
client reads.** No workflow-shaped mechanism can carry the endpoint.

**And the protocol underneath is not what the earlier drafts assumed.** The
2025 migration changed the target:

- **The legacy cache service is gone.** GitHub's migration to the v2 cache
  service began 2025-02-01, `actions/cache` v1/v2 client releases were retired
  2025-03-01, and the legacy cache service was shut down 2025-04-15. A client
  reaching for `ACTIONS_CACHE_URL` / `artifactcache.actions.githubusercontent.com`
  now has nothing to talk to on github.com. Any design that leans on the v1
  hostname, or offers "intercept v1 alone" as a fallback, is targeting a dead
  endpoint. (GitHub Enterprise Server lags this timeline; a GHES-targeting fleet
  would still meet v1, which is why `apps/cache-service` keeps implementing it.)
- **Cache v2 and Artifacts v4 share one hostname**:
  `ACTIONS_RESULTS_URL` = `results-receiver.actions.githubusercontent.com`. They
  are the same host, the same SNI, and can share one keep-alive/HTTP-2
  connection; they are distinguished only by the **Twirp service path inside the
  TLS session** — `github.actions.results.api.v1.CacheService/*` versus
  `.../ArtifactService/*`. Both return **signed Azure Blob URLs**
  (`*.blob.core.windows.net` + SAS); the bytes never touch results-receiver.

Two consequences fall straight out and they shape the whole decision:

1. **The cache/artifact coupling is inherent to v2, not a design choice.**
   Because the two share a host and a connection, nothing at the DNS, SNI, or
   TCP layer can select cache without also selecting artifacts. Any interception
   that serves cache must terminate `results-receiver` TLS and route by the
   inner Twirp path. An `https_proxy` transport does not escape this — a
   `CONNECT results-receiver:443` is byte-identical for both.
2. **The interception point is the Twirp metadata call, not the blob host.** We
   serve `CacheService` by answering its create/get/finalize calls with signed
   URLs pointing at **our** store; we never impersonate Azure. `apps/cache-service`
   already implements exactly this surface (v2 Twirp + the Azure-block-to-S3
   translator in `blob.go`).

## Decision

**Intercept `results-receiver.actions.githubusercontent.com` transparently at
the guest network layer, terminate its TLS with a per-guest ephemeral CA, serve
the cache Twirp path from EraInfra's cache service, and fail-open-forward
everything else to real GitHub. Do not modify the runner. Require zero workflow
change.**

This is the approach the one vendor doing transparent capture (Blacksmith) uses,
for the reason it uses it: interception at the network layer catches every
client including those inside `container:` jobs and nested Docker, with the
pinned `actions/runner` left byte-identical to GitHub's — which is a property
EraInfra's conformance story is built on. The rest of this section is the part
Blacksmith does not document publicly: the trust model.

### 1. Transparent interception at the packet layer, scoped to one name

The redirect must survive a `container:` job and a nested Docker daemon, because
covering those is the entire reason this design was chosen over patching the
runner. **`/etc/hosts` alone does not** — a container has its own resolver
(Docker's `127.0.0.11`) and would resolve GitHub's real address and bypass the
interceptor. So interception is at the guest **packet/DNS layer**, the way
Blacksmith actually does it: a guest-local resolver answers the one intercepted
name with the interceptor's address for every namespace that uses it, backed by
an nftables rule that DNATs TCP/443 to that name's resolved addresses so a
container using its own embedded DNS is still caught. The guest binary composes
this at boot from the cache address delivered over MMDS; nothing is installed
when the Worker configures no cache, and the fleet behaves exactly as today.
Every other name resolves and connects unchanged; a client that reaches GitHub's
real IPs by some path this does not cover reaches GitHub — degraded-to-upstream,
not a breach. The ship gate is a test matrix: a plain job, a `container:` job,
and a `type=gha` buildx step each land on the interceptor.

### 2. A per-guest, per-boot ephemeral CA — not a fleet CA

The clients speak HTTPS to GitHub's hostname, so the interceptor must present a
certificate for it, and no public CA will issue one. EraInfra mints a **fresh CA
per guest boot on the host**, signs exactly one leaf covering the single
intercepted name, gives it a lifetime bounded by the VM's, and keeps the CA
private key host-side — it never enters the guest. The guest trusts it via the
system store (`update-ca-certificates`) and `NODE_EXTRA_CA_CERTS` for the Node
clients that ignore the system store.

Why per-guest rather than one fleet CA: a microVM is ephemeral, so the natural
lifetime of a signing key is one VM. With a fleet CA, "the key leaked" is a
fleet-wide MITM event; with a per-guest key that never leaves the host and dies
with the VM, the worst case collapses to "an attacker who already owns this
guest can MITM this same guest until it is recycled" — approximately zero
marginal blast radius, since owning the guest already owns its traffic.

The CA is name-constrained as **defense in depth**, and the constraint must
cover **every name type, not just DNS**. Research on this exact stack (guest
OpenSSL 3.x, the runner's .NET 8, Node 20/24, BuildKit's Go ≥1.21) confirmed all
three client stacks **enforce** critical name constraints, including on a root
in the trust-anchor position — the historical "constraints ignored on local
roots" footgun lived in Chrome/Apple/NSS, not in OpenSSL, Go, or .NET's
OpenSSL-backed chain. But a constraint permitting only two dNSNames leaves
iPAddress, URI, and email SANs **unconstrained**, so the extension is critical
and carries `excludedSubtrees` for `IP:0.0.0.0/0`, `IP:::/0`, and the email/URI
space, permitting only the one DNS name. The negative test is a ship gate and
covers **every constrained type**: a CA-signed certificate for a different
hostname, a raw IP, a URI SAN, and an email SAN is each **rejected** by the
guest, tested on the system-store path, the `NODE_EXTRA_CA_CERTS` path, and —
once Stage B injects the CA there — the `buildkitd` trust path, because each
stack's enforcement is its own. The version floors are **conformance
prerequisites**, checked like any other fingerprint fact, not prose: the
runner's .NET ≥6, guest OpenSSL ≥3.0.15-class patch level, BuildKit's Go
≥1.25.8/1.26.1 (the 2025–2026 name-constraint CVEs). If the negative test ever
fails to reject, or a floor is unmet, this ships a fleet-wide MITM root and must
not ship.

### 3. Serve cache, fail-open-forward the rest

On the terminated `results-receiver` listener:

- **`CacheService/*`** is served by EraInfra's cache service, which answers with
  signed URLs pointing at the operator's store (ADR 0009). Downloads a job can
  reach directly presign to that store; a store only the service can reach is
  streamed (`DOWNLOAD_MODE=proxy`).
- **`ArtifactService/*` and any unrecognized `CacheService` method** are
  reverse-proxied to the real `results-receiver`, the request's original
  `Host`/SNI reconstructed against the real upstream (which the proxy resolves
  itself, so the guest's pinned resolution cannot loop it back).

**Fail-open is an availability rule, and it has a precedence that the word
"error" hides.** Not every failure may forward, because forwarding a request we
have already acted on, or one we have refused, corrupts state or masks a denial:

1. **Transport/backend-unavailable** — the store or index is unreachable, a
   lookup times out, the request never mutated anything: forward to real GitHub.
   A dead cache degrades to GitHub's cache, a miss-cost not an outage.
2. **Identity, authorization, validation, or policy failure** — the repository
   identity cannot be established (§4), a fork PR attempts a write, the request
   is malformed: **fail closed.** Return the error to the client; never forward
   it as a cache result and never synthesize a success. Forwarding an authz
   decision to GitHub would let GitHub's answer paper over ours; the client
   simply gets our denial.
3. **A mutating call past its commit point** — `CreateCacheEntry`,
   `FinalizeCacheEntryUpload`, and the v1 commit may have written a session, an
   object, or the index before returning an error. Once a call **may** have
   mutated, it must **not** also forward (that is the split-brain: an entry in
   our store and GitHub's for one key). The commit point is defined per method,
   forwarding is allowed only for failures proven to precede it, and everything
   after is returned to the client — with idempotency keys so a client retry
   after an ambiguous result converges rather than double-writes.

So "fail-open" means exactly: transparently let GitHub answer a request we did
not act on, and never fabricate a `200`. The inbound listener is likewise not
steerable — it serves only a request whose `Host`/SNI is exactly the intercepted
name, and never routes one intercepted name's request to another's upstream.

**And the interceptor must be at least as available as the redirect that points
at it.** The DNAT/resolver from §1 sends cache and artifact traffic to the
interceptor before any of the above runs, so a dead interceptor fails both
before they can forward. The redirect is therefore installed **only while the
interceptor is confirmed listening**, and a guest-local supervisor removes the
redirect if the interceptor stops — restoring direct-to-GitHub for every client
in every namespace. The interceptor being down is a slower job (traffic goes
straight to GitHub), never a broken artifact upload.

### 4. Identity comes from where the guest already knows it

The chicken-and-egg the store review raised is real: the runner overwrites
`ACTIONS_RUNTIME_TOKEN` per action step and the guest environment is composed at
boot from MMDS, before `JobStarted` exists, so **no per-Attempt bearer can be
delivered to the cache client through the environment.** Interception dissolves
it: the cache service is per-guest and already holds the Attempt's identity from
the MMDS boot context EraInfra set. It authorizes by that identity — the
`Repository` claim and the token's permission bit (ADR 0007 rules 1–2), with
`Attempt` carried for logs and revocation only, never as an authorization input
(this matches `cachetoken`'s actual `Verify`, which never inspects `Attempt`).
The client's inbound `ACTIONS_RUNTIME_TOKEN` is GitHub's, seen because we
terminate TLS; it is used only to forward artifact/passthrough requests upstream
and is never logged or stored. A request whose repository identity the service
cannot establish is rejected, never defaulted.

### 5. The container and builder gap is named, not waved

Interception at the guest network layer reaches `container:` jobs for free — the
reason to prefer it over a runner patch. The exception is **buildx's
`type=gha`**: with the default docker-container driver, `buildkitd` runs in its
own container with its own trust store and does not inherit the guest's
`update-ca-certificates` output. The CA must be injected into the builder
container (a `buildkitd.toml`/driver-opt step), or the `docker` driver used, or
`type=gha` fails closed with `x509: unknown authority` — a cache-availability
bug, not a security hole. Stage B owns making one of these the default.

## Consequences

- **Zero workflow change, and the runner stays GitHub's exact bytes.** The
  `runner_version` pin holds; the cleverness lives in the guest network layer
  EraInfra fully owns. This is the property that made interception the right
  call over patching the runner.
- **A guest with a cache trusts a per-guest CA and pins one name.** Both are
  decisions the conformance fingerprint must measure — a trust-store delta and a
  `/etc/hosts` entry that appear only when a cache is configured — so the
  allowlist carries them traceable to this ADR, not as drift.
- **A dead cache service — or a dead interceptor — is a slower job, not a broken
  one**, and never a broken artifact upload, by §3's availability-precedence and
  supervised-redirect rules. The unmeasured fault classes ADR 0007 flagged
  (refusal, TLS error, hang) become the interceptor's timeout budget, which
  stage B owes before interception is enabled.
- **Authorization never fails open.** §3's precedence is the load-bearing safety
  property: only requests EraInfra did not act on forward to GitHub, and no
  failure is ever answered with a fabricated success.
- **Stage C's exit conditions carry over** — the end-to-end v2-selection test,
  the restore-volume number that could still reverse ADR 0007 — plus the CA
  negative-rejection test across all SAN types and trust paths (§2), the
  container/nested-buildx interception matrix (§1), the artifact-passthrough and
  mutating-call commit-point tests (§3), and the buildkitd trust-delivery
  default (§5).

## What would reverse this

- **If the CA negative test cannot be made to pass** on all three stacks — a guest
  accepting a CA-signed cert for a name outside the constraint — the design is a
  MITM root and is withdrawn, not shipped with a warning.
- **If GitHub separates cache back onto its own hostname**, the artifact coupling
  and its fail-open proxy disappear and §3 simplifies to serving one host whole.
- **If per-Attempt identity cannot be bound at the interceptor** — ADR 0009's and
  ADR 0007's rule-1 reversal condition — the cache fails closed.

## Considered and rejected

- **Patch/fork the runner to override `ACTIONS_RESULTS_URL`** (Depot, Ubicloud,
  RunsOn, falcondev): the field's more common path, and cheaper on the CA axis —
  no trust anchor in the guest, our service can use an ordinary cert for a name
  we own. Rejected for EraInfra specifically: it forks the one component whose
  byte-identical provenance the conformance story asserts (`runner_version`),
  needs `--disableupdate` and a re-patch per runner bump, and does not reach
  `container:`/nested-Docker caching without extra env-propagation work — the
  exact case network interception covers for free. We own the network layer;
  keeping the runner pristine and doing the work below it is the EraInfra-native
  trade.
- **A single fleet CA** (what Blacksmith's design implies): rejected for the
  blast radius §2 removes — a leaked key is fleet-wide instead of one recyclable
  guest.
- **`https_proxy` transport instead of `/etc/hosts`**: marginally cleaner (one
  chokepoint, tunnels unrelated hosts with no cert) but does not change the
  coupling (§1) or remove the CA (still terminates results-receiver). An
  operational choice for stage B, not an architectural one; `/etc/hosts` is
  simpler and the guest already writes it.
- **A runner job-started hook / env tier**: measured dead — the runner overwrites
  action steps after any of them (run 32109974600).
- **Intercept the v1 host, or only v1**: v1 is sunset (Feb 2025); a dead target.
- **SPKI/leaf pinning instead of a CA**: would require patching three
  third-party client stacks that expose no uniform pinning hook; the trust-store
  - name-constraint mechanism is the one knob all three honor.
- **A swap-in `erainfra/cache` action**: ADR 0007 rejected it on measurement —
  0% of this repo's own 329 MiB of restore volume flows through explicit
  `actions/cache`; it is all `setup-node`/`setup-go`, which interception catches
  and a swap-in does not.
