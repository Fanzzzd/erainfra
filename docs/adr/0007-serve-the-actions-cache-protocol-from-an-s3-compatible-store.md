# ADR 0007: Serve the Actions cache protocol from an S3-compatible store

- Status: Accepted
- Date: 2026-08-18
- Owners: EraInfra

## Context

[ADR 0002](0002-verify-the-job-isolation-boundary.md) rejected "an EraInfra cache service with
per-repository scopes". Its reason was precise, and it is still correct:

> a scale-set Attempt is created _before_ GitHub binds a job to it: the controller receives only a
> desired runner count, and the repository, ref and event arrive later, in `JobStarted`. A
> per-repository cache device cannot be attached at boot because at boot the repository is not yet
> known.

That argument rules out **a per-repository device attached at boot**. It does not reach a cache
that a job fetches over the network, because such a cache is opened _inside_ the job — after
`JobStarted` has already named the repository, ref and event. Nothing has to be attached at boot.
Nothing writable has to survive on the Worker. The bytes land in the disposable environment and are
destroyed with it, exactly like the source checkout.

The distinction is worth stating rather than assuming, because ADR 0002 also wrote "warm state
therefore comes from the digest-pinned Image Release", and a reader who stops there concludes the
question is closed. It is not closed; it was answered for a different design.

**What this ADR supersedes, exactly.** One bullet of ADR 0002's "Considered and rejected" list —
"An EraInfra cache service with per-repository scopes" — and only in the object-store form decided
here. Its stated revisit condition ("revisit only if the controller starts creating Attempts per
`JobAvailable` message") turns out to be sufficient but not necessary: it is the condition for
attaching a cache _device_ at boot, and this design does not attach one.

**What this ADR leaves standing, without qualification.** The isolation contract. "Nothing writable
survives a job" is unchanged, because nothing writable is added to the Worker: the cache is a
network service, and the job's copy dies with the disposable environment. The removal of the
Profile-wide pnpm volume stands, and this ADR must not be read as a route to bringing it back —
a shared writable store _on the Worker_ is a cross-job write path; an authenticated, per-repository,
fork-read-only network service is not the same object. `apps/runtime/netpolicy`'s egress policy
stands; the cache endpoint becomes one more operator-declared allowed destination, in exactly the
mechanism ADR 0002 built for reaching `actions/cache` in the first place. And ADR 0002's second
objection — that this is "a new authenticated, multi-tenant storage surface to secure" — is not
waved past. It is the largest part of this decision, below.

The reason to do this at all is bandwidth, not compute. Issue #80's canary showed `check` and
`build` on `rc-linux-js` already about 2x faster than GitHub-hosted on a cold cache, because a
Worker is a large machine. What remains is that every dependency restore crosses the public
internet to GitHub, from a fleet whose entire premise is that it sits on the customer's own
network.

## The measurement this decision rests on

The protocol facts below were captured from real traffic against a stand-in endpoint, not read from
a changelog. The full transcript, method, and the exact request and response bodies are in
[`docs/research/actions-cache-protocol-capture.md`](../research/actions-cache-protocol-capture.md);
every protocol claim in this ADR cites a line number in it. Several findings changed the design,
and two of them correct issue #81.

**The generation is not chosen by the runner version.** Issue #81 says "which one is used depends on
the client action version, not only on the runner." The capture says it is neither: what selects the
generation is an environment variable, `ACTIONS_CACHE_SERVICE_V2`. Absent it, every client we drove
falls back to legacy v1 — including `actions/cache` v6.1.0, released two months ago (capture
L001–L006 with the variable absent, L007–L012 with it present). The pinned
`actions-runner:2.336.0` does not choose either: its `Runner.Worker.dll` carries the literal pairs
`CacheServerUrl`/`ACTIONS_CACHE_URL`, `ResultsServiceUrl`/`ACTIONS_RESULTS_URL` and
`actions_uses_cache_service_v2`/`ACTIONS_CACHE_SERVICE_V2`, which is a relay of a server-delivered
job flag, not a decision. The consequence is good news: **EraInfra composes the job environment, so
EraInfra picks the generation.**

**But it cannot pick only one.** Client version still decides in both directions. `actions/cache`
v4.0.2 — which plenty of workflows still pin — has no v2 code path and stays on v1 even with the
flag set (L013–L018). BuildKit's `type=gha` exporter is the mirror image: BuildKit v0.32.2 driven by
buildx v0.20.1 stays on v1 _even with the flag set_ (L147–L164), because that buildx does not
forward the flag into the builder container, while the same BuildKit driven by buildx v0.36.1 goes
v2 (L165–L194). The older buildx does reach v2 when a workflow spells out a `url_v2` cache
attribute by hand (L078–L120), which no ordinary workflow does.
`docker/setup-buildx-action` installs whatever buildx is latest at job time, so this is not a
version EraInfra pins. **The service must implement both generations.** Issue #81 treats
choosing a generation as the open question; it is not one.

The rest of the protocol is in the capture: a v1 miss is `204` with no body and a v2 miss is `200`
with `{"ok": false}` (never a `404`); v1 `keys` is a prefix match that BuildKit's index depends on;
v2 hands out an Azure-Blob-shaped signed URL whose commit response must carry `x-ms-request-id`,
because omitting it segfaults `buildkitd` after every byte has already been uploaded.

### What this did not measure

Stated here rather than only in the capture, because a decision that hides its gaps is worse than
one that names them.

- **`actions/setup-python` with `cache:`** — named in issue #81 as one of the expensive implicit
  clients, and **not driven**. It bundles `@actions/cache` the same way `setup-node` and `setup-go`
  do, but that is an inference and is deliberately not carried into any claim above.
- **`actions/setup-go` with `ACTIONS_CACHE_SERVICE_V2` set** — only its v1 path was captured
  (L041–L050). Its v2 behaviour is not claimed.
- **A job end to end through the pinned `actions-runner:2.336.0`** — that needs a real scale-set
  Attempt bound to a repository. What is measured is the shipped `Runner.Worker.dll`'s own string
  table, which proves the environment mapping exists in the pinned binary; it does not prove when
  GitHub's service sets `actions_uses_cache_service_v2`, so a fleet that relays GitHub's flag
  instead of setting its own would be relying on unmeasured behaviour.
- **BuildKit against malformed v1 responses** — only its v2 fault behaviour was observed.
- **Any latency or throughput number for a colocated store versus R2 versus GitHub.** The two-case
  recommendation below rests on where the bytes travel, not on a benchmark; the actual delta is
  stage C's job to report, on real Profiles, the way #80's canary reported its numbers.

## Decision

**Speak GitHub's Actions Cache Service protocol at the runner-environment level. Do not ship an
`erainfra/cache` action.**

The convenience argument — that a swap-in action breaks the README's promise that
"`runs-on: <profile>` is the entire workflow change" — is true but is not what decides it. What
decides it is coverage, and the capture puts a number on it. EraInfra's own `check` job restores
329 MiB of cache per warm run: 194 MiB through `actions/setup-node`'s `cache: pnpm` (capture
L020–L030) and 135 MiB through `actions/setup-go`'s `cache: true` (L042–L050). It contains **zero**
`actions/cache` steps. A swap-in action would therefore capture **0% of the restore volume of the
job this product runs on itself**, while requiring a workflow edit to capture nothing. Those two
setup actions speak the cache protocol directly through their bundled `@actions/cache`, and so does
buildx's `type=gha`; a per-Attempt environment captures all of them with no workflow change at all.

**Implement both API generations.** Not as a migration with a deprecation date — as a standing
requirement, for the reason measured above. `ACTIONS_CACHE_URL` and `ACTIONS_RESULTS_URL` are both
injected, and `ACTIONS_CACHE_SERVICE_V2` is set. Clients that can use v2 will; clients that cannot
fall back to v1 and must still work.

**The store is S3-compatible with a configurable endpoint.** One `endpoint / bucket / access key /
secret` contract covers R2, S3, MinIO, Garage, SeaweedFS and Ceph, and no vendor name appears in the
design. This is deliberately an operator's decision and not an architectural one, because the right
answer depends on a fact the design cannot know — where the Workers are:

- **Workers on the operator's own network**, which is this product's entire premise: put the store on
  the same LAN — MinIO or Garage on a Worker or a NAS. This is where the speedup actually comes
  from. The win is bandwidth and latency, not the storage vendor; a remote bucket recovers some of
  the gap to a colocated competitor, a local one recovers all of it.
- **No colocated store, or a fleet spread across sites:** R2 over S3, decisively. A CI cache is
  egress-dominated — written once per key, restored by every job on every branch — so on S3 that
  egress is most of the bill and on R2 it is zero. R2 speaks the S3 API, so choosing it now costs
  nothing if the fleet later consolidates onto one site.

Both cases get documented. Neither gets hardcoded.

## The security contract

ADR 0002's second objection stands unanswered until these five hold, and they are the actual work of
stages B and C. A cache is a supply-chain surface: whoever can write an entry injects bytes into
every later job that restores it. These are stated as a contract because each has to be a test
before it is a feature.

1. **Scope by repository.** A job for repository A can neither read nor write repository B's
   entries. The object key prefix is derived from the per-Attempt **token**, never from anything in
   the request body. This is not a detail of how the prefix is computed: the capture shows the
   client sends `key` and `version` and nothing else that identifies a repository (L008, L020), so
   any repository identity the service reads out of the request is identity the _client_ chose.

2. **A fork pull request must never write.** This is the poisoning attack, and the one to get right
   first. GitHub-hosted runners already enforce it; a self-hosted fleet that omits it has shipped a
   hole that its users did not have before they moved, which is the worst possible shape for a
   security bug in a migration product. The mechanism it defeats is concrete: a fork PR's workflow
   runs attacker-authored code inside a job that holds a writable cache token, so it can overwrite
   the `node-cache-…-pnpm-<lockfile-hash>` entry (L020's key is exactly that) and every subsequent
   job on the base branch that restores that key installs the attacker's store. Fork PRs get
   read-only access, scoped to the base branch's entries. "We forgot" is how this ships, so the
   read-only path must be the default and write must be the case that has to prove itself: the token
   issuer decides write permission from the Attempt's `event` and head/base repository, and a token
   with no proven write claim is a read token.

3. **Reproduce GitHub's restore fallback exactly: own ref, then base ref, then default branch —
   never a sibling feature branch.** People rely on this for warm caches on new branches, and it is
   simultaneously an isolation property: sibling-branch reads let any branch author stage bytes that
   another branch picks up. The capture makes the mechanism precise — restore keys are prefix
   matches, and the client accepts whatever `matched_key`/`cacheKey` the service returns (L072
   answers a request for `index-D1-1-f921bd05` with `index-D1-1-f921bd05#1`). The service, not the
   client, decides what a key matches, so scoping the candidate set by ref is the service's job and
   nothing in the request can be trusted to do it.

4. **The job never holds bucket credentials.** It gets a short-lived, per-Attempt token for
   EraInfra's service, which presigns or proxies. Static bucket keys inside a job would let any job
   read and rewrite the entire fleet's cache, and jobs run untrusted code by definition. The capture
   shows this is compatible with how the clients work: in v2 the client never sees a bucket, only a
   `signed_upload_url` / `signed_download_url` the service mints (L008, L011), and in v1 only an
   opaque `archiveLocation` (L029). Presigned URLs must be short-lived and scoped to one object and
   one method.

5. **Say so in the readiness evidence.** Below.

## Consequences

**`Cache` in `apps/runtime/internal/executor/report.go` stops being the whole truth, and must say
more rather than change its answer.** The struct reports `Scope`, `SharedWritable` and `Detail`, and
Workers report `Scope: immutable-image` — documented in the struct itself as "nothing writable is
shared at all". That remains true _of the Worker_ once a network cache exists, and it stops being
true _of the job_. ADR 0002's rule is that readiness reports evidence, not a boolean, and this is
the first thing to strain it: leaving `immutable-image` in place would let the dashboard keep making
a complete-sounding claim that has quietly become partial.

So `SharedWritable` stays **false** — it means writable storage shared between jobs _on this
Worker_, and no such thing is added. `Scope` must stop being a single word that implies exhaustion
and must name the external cache and its scoping instead, with `Detail` carrying the endpoint the
Worker will actually let jobs reach and the scope the token enforces. The concrete shape belongs to
stage C, but the acceptance test does not: **an operator reading the readiness report must be able
to tell a Worker whose jobs have a network cache from one whose jobs do not, and see what that cache
is scoped by.** A report that cannot distinguish those two is a failed report even if every check
passes. The control plane already refuses a "ready" report that contradicts itself; a Worker
advertising a cache scope it has no configured endpoint for is that same class of contradiction and
should be refused the same way.

**Everything else in ADR 0002 is unchanged.** No writable state is added to the Worker. The cache
endpoint becomes one operator-declared allowed egress destination in `apps/runtime/internal/netpolicy`,
which is the mechanism that already exists for reaching `actions/cache`. The Profile-wide pnpm
volume stays deleted.

**The cache is not free and not a Profile promise.** A colocated store is a machine an operator has
to run and size; a remote bucket is a bill. Neither belongs in a Profile's capacity contract, and a
Worker must not become unready because a cache is unreachable — restores degrade to misses. The
capture supports that shape: every wrong-shaped _restore_ response we injected produced a warning
and a slower job rather than a failed one (L121–L128). Uploads are where it is not free — a
malformed _success_ response on the v2 commit path panics `buildkitd` and fails the build — so the
service's upload path needs the harder tests.

**Stage B inherits a specification, not a guess.** The endpoint list, request and response bodies,
chunking, the `204`-versus-`{"ok":false}` miss shapes, the prefix-match requirement, the
`size_bytes`-as-string-or-number divergence and the `x-ms-request-id` requirement are all in the
capture and are all citable.

## What would reverse this decision

In ADR 0002's own style, stated so that a future reader can check it rather than re-argue it:

- **If measured restore volume on real Profiles stays below roughly 50 MiB per job**, this is not
  worth a new authenticated storage surface. The 329 MiB measured on this repository's own `check`
  job is what makes it worth it; a fleet whose jobs are dominated by compute rather than dependency
  restore should keep sending cache traffic to GitHub over allowed egress and spend the effort
  elsewhere. Stage C reports this number the way #80's canary reported its numbers, and if it comes
  back small, stage C is where this ADR gets superseded rather than shipped.
- **If GitHub retires the legacy v1 API and the client ecosystem converges on v2 alone**, the
  two-generation requirement above should be revisited — but only against a fresh capture, and only
  once the buildx client that still selects v1 (measured here at v0.20.1) is out of circulation.
- **If rule 2 cannot be enforced** — if per-Attempt token issuance cannot reliably distinguish a
  fork pull request from a branch push at the moment the token is minted — then this decision fails
  and must be withdrawn rather than shipped with a warning in the docs. A cache that a fork PR can
  write is worse than no cache.
- **If Workers stop being on the operator's own network** — if the deployment model becomes a hosted
  fleet — the LAN argument evaporates and the remaining case is only "cheaper egress than GitHub",
  which is a much weaker reason to own a storage surface.

## Considered and rejected

- **Ship an `erainfra/cache` action that workflows swap in for `actions/cache`, as Blacksmith does:**
  rejected on measurement, not on taste. It captures only explicit `actions/cache` steps, and the
  expensive restores are implicit — 100% of EraInfra's own `check` job's 329 MiB of cache traffic
  comes from `setup-node` and `setup-go`, which speak the protocol directly and would keep going to
  GitHub (capture L019–L050). It also breaks the README's one-line-change promise, and creates a
  second thing to version.
- **Implement only Cache Service v2, on the grounds that it is current:** rejected, measured.
  `actions/cache` v4.0.2 has no v2 code path (L013–L018) and buildx v0.20.1 does not select v2 even
  when told to (L147–L164). A v2-only service silently loses those clients' caches.
- **Implement only legacy v1, on the grounds that every client still falls back to it:** rejected.
  It is true today only because we control the flag, and it means opting the whole fleet out of the
  generation GitHub is moving to; the v1 upload path is also a single-stream `PATCH` per chunk
  against our service rather than a presigned object write, which puts the full cache byte volume
  through the control path.
- **Hand jobs bucket credentials directly and skip the service:** rejected. It is the simplest
  design and it hands every untrusted job read-write access to the whole fleet's cache. It also
  cannot enforce rules 1–3, which are the entire answer to ADR 0002's second objection.
- **Reuse the sticky-disk shape ADR 0002 rejected, now that a cache is wanted:** rejected, and the
  rejection is ADR 0002's own and still correct — the repository is not known at boot, and a disk
  that survives a job is a cross-job write path regardless of what is on it.
- **Infer the protocol from GitHub's changelog and the `@actions/cache` source:** rejected, and this
  is why the capture exists. Reading the source would have produced a v2-only design (v2 is what the
  current library documents as current), a `404`-on-miss response shape, an exact-match key lookup,
  and a blob commit response without `x-ms-request-id`. All four are wrong, and the last two fail
  silently or as an unrelated-looking crash.
