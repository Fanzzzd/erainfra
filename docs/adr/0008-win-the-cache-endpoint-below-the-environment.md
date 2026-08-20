# ADR 0008: Win the cache endpoint below the environment

- Status: Proposed
- Date: 2026-08-20
- Owners: EraInfra
- Amends: [ADR 0007](0007-serve-the-actions-cache-protocol-from-an-s3-compatible-store.md)

## The measurement that forces this

ADR 0007 refused to assume the one thing its delivery design needed: "whether an
EraInfra-supplied value survives the runner's own injection is unmeasured here
and is a stage-C prerequisite, not an assumption this ADR is allowed to make."
That measurement now exists, taken in three runs of
`.github/workflows/cache-env-probe.yml` on real `rc-e2e` Attempts:

- **Run 32109974600** found that a `run:` step and an action step are different
  environments: the runner's `Runner.Worker` composes every **action** step's
  environment from GitHub's job message, overwriting `ACTIONS_CACHE_URL`,
  `ACTIONS_RESULTS_URL`, `ACTIONS_CACHE_SERVICE_V2` and `ACTIONS_RUNTIME_TOKEN`
  regardless of what the process environment, a step `env:` block (T2) or
  `$GITHUB_ENV` (T3) held.
- **Run 32353754282** closed T0, the last workflow-shaped tier, with the full
  v0.2.0-rc.8 seam live: `ERAINFRA_CACHE_SERVICE_V2=false` set on the Worker
  reached the job's script-step environment intact — the agent → runtime →
  MMDS → guest chain works, and nothing else can plant that variable in a
  microVM job (#110 proved image `ENV`, PAM and unit `Environment=` lines all
  dead there) — and the very same job's **action** step read
  `ACTIONS_CACHE_SERVICE_V2=True` with GitHub's own cache URL and a real
  2495-byte runtime token.

Every cache client in ADR 0007's measured volume — `actions/cache`,
`setup-node`, `setup-go` — is an action step. One is not always: BuildKit's
`type=gha` can be driven by a bare `docker buildx build` in a `run:` step,
where the seam's values DO survive — but on hosted, a run step holds no
`ACTIONS_RUNTIME_TOKEN` either (measured: all four unset, run 32108617455),
so such workflows already route the runtime environment through an action
(`crazy-max/ghaction-github-runtime` or `docker/build-push-action`), which
puts them back on the overwritten side. The claim this amendment rests on is
therefore stated at its measured width: **the runner overwrites the four
cache variables in every action step, and every client responsible for the
329 MiB ADR 0007 counted reads its environment there.** A run-step BuildKit
probe is cheap and stage A should run one before the script-step path is
declared worthless rather than merely small.

The runner-environment-level delivery ADR 0007 decided on cannot carry the
endpoint. Its store decision, security contract, two-generation requirement
and fault-tolerance obligations are untouched; what this amendment replaces
is only the sentence "at the runner-environment level."

One instrument note, recorded so the next reader does not re-fight it: the
probe's "T0" row reads `/proc/1/environ`, which is Docker-shaped. On a microVM
PID 1 is the guest's init and the row says `unavailable`; the T1 rows carry the
microVM's T0 evidence.

## Decision

**Intercept the cache hostnames inside the guest, at name resolution, and
terminate their TLS at EraInfra's cache service. Do not modify the runner.**

The values that win the environment war are hostnames GitHub controls:
`ACTIONS_CACHE_URL` points at `artifactcache.actions.githubusercontent.com`
and `ACTIONS_RESULTS_URL` at `results-receiver.actions.githubusercontent.com`.
The runner decides what the variables say; it does not decide what those names
resolve to inside a guest whose image, DNS and trust store are all
EraInfra-built and digest-pinned. Concretely:

1. **Name pinning in the guest.** `runner-center-guest` writes `/etc/hosts`
   entries for exactly the two cache hostnames, pointing at the cache service
   address it already receives over MMDS (`cache_url`, shipped in
   v0.2.0-rc.8, becomes the interception target rather than an environment
   value). No entry arrives when the Worker configures no cache, and the fleet
   behaves exactly as today.

2. **A fleet CA that CANNOT sign more than two names.** The clients speak
   HTTPS to GitHub's hostnames, so the service must present certificates for
   them, and no public CA will issue those. The guest image carries an
   EraInfra fleet CA in its system trust store, and the guest seam sets
   `NODE_EXTRA_CA_CERTS` for the Node-based clients that ignore the system
   store — a variable the job message does not carry, so the runner does not
   overwrite it (measured class: T1 script and action rows agree on
   everything outside the four cache variables). The CA's private key lives
   with the cache service, never on a Worker.

   "Signs exactly two hostnames" must be a property of the certificate, not a
   promise about the key's handling: the CA carries a **critical X.509 Name
   Constraints extension** permitting only the two cache DNS names, so a
   compromised cache service holding the key still cannot mint a certificate
   the guest would accept for any other host. The acceptance test is the
   negative one: a CA-signed certificate for a third hostname is REJECTED by
   the guest's TLS stack — both the system store path and the
   `NODE_EXTRA_CA_CERTS` path, tested separately, because Node's constraint
   enforcement is not the system's. If either path fails to enforce the
   constraint, this design ships a fleet-wide MITM root and must not ship.

3. **The results host is shared, so the service proxies what it does not
   serve — and that is new code, not an aspiration.** ADR 0007 already
   measured that `ACTIONS_RESULTS_URL` carries both cache v2 and
   `actions/upload-artifact` traffic behind the same `ACTIONS_RUNTIME_TOKEN`.
   Today `apps/cache-service` answers unknown paths with `404`; under
   interception that 404 IS a fleet-wide artifact outage. So the routing rule
   is an acceptance condition: cache twirp paths are served locally,
   everything else on the results host is reverse-proxied to an explicitly
   configured upstream, and an `actions/upload-artifact` job on an
   intercepted Worker is a standing integration test, not a canary that
   exists only in prose. The v1 host serves cache alone and is intercepted
   whole.

   The proxy is not an open forwarder, and the inbound request does not get
   to steer it: inbound `Host` and TLS SNI are untrusted and must BOTH equal
   the results hostname exactly, or the request is rejected; the upstream
   `Host` and TLS `ServerName` come from fixed configuration, never copied
   from the request; and the upstream dial resolves the real address itself,
   so the guest's pinned resolution cannot loop the proxy back into itself.
   Tests: an arbitrary inbound `Host` is rejected, and a request arriving on
   the v1 cache hostname cannot be routed to the results upstream.

4. **The repository claim is this amendment's open question, and it fails
   closed until answered.** The intercepted requests arrive bearing the job
   message's `ACTIONS_RUNTIME_TOKEN` — a JWT GitHub minted, which no job
   authored. If its claims name the repository stably and its signature is
   verifiable against a published key set, it is exactly the issuer-minted
   claim ADR 0007's rule 1 demanded, and the fork-PR refusal (rule 2) reads
   the same claims. But GitHub documents no verification contract for this
   internal token, and the current service accepts only EraInfra's own HMAC
   tokens (`cachetoken.Verifier`) — so treating the GitHub JWT as verified
   identity is a **hypothesis that stage A must measure** (decode real
   tokens across Attempts, repositories and fork PRs; establish which claims
   are stable and whether the signature can be checked) before anything
   scopes storage by it. If the measurement comes back unverifiable, the
   fallback is EraInfra-minted identity bound out of band: the control plane
   knows each Attempt's repository and event at `JobStarted`, and the seam
   already delivers per-Attempt values to the guest — the binding mechanism
   is then stage-A design work, and rules 1–2 hold whichever way. A request
   whose repository identity the service cannot establish is REJECTED, never
   defaulted — ADR 0007's own rule, restated because interception makes it
   easy to forget. Either way the token is a live GitHub credential and the
   service treats it as ADR 0007 treats bucket keys: used for verification
   and upstream proxying, never logged, never stored beyond the request.

## Consequences

- **The one-line-change promise survives.** No workflow edit, no swap-in
  action, no runner patch. The pinned `actions-runner:2.336.0` stays
  byte-identical to GitHub's.
- **A guest with a cache configured trusts a CA a guest without one does not.**
  That is the honest cost of this design and it must stay visible: the
  conformance fingerprint should measure the trust-store delta so the
  allowlist carries it as a decision (`allow` traceable to this ADR), not as
  drift nobody chose.
- **Interception is scoped by construction.** The hosts entries name two
  hostnames; every other name resolves as before; a job that dials the real
  IPs directly gets GitHub, which is the degraded-to-upstream behaviour, not a
  breach.
- **A dead cache service degrades cache and BREAKS artifacts, and those are
  different failures with different budgets.** For cache clients the
  miss-degradation is measured only for HTTP `404` and `500` restore bodies
  (ADR 0007's fault matrix); what a client does with connection refusal, a
  TLS error or an endpoint that never answers is exactly the unmeasured
  class ADR 0007 flagged, and this amendment inherits the flag rather than
  papering over it — a dead pinned name lands the fleet in unmeasured
  territory until stage B measures those shapes and sets the timeout and
  retry budget. Artifact clients cannot degrade to anything measured or
  otherwise: their upstream path runs THROUGH the proxy this design put in
  front of them, so on an intercepted Worker the cache service becomes a
  hard availability dependency of `actions/upload-artifact`. That coupling is the single strongest argument
  against intercepting the results host, and the amendment does not wave it
  past: stage B owes separate timeout/retry budgets and separate canaries
  for the two traffic classes, and the alternative — intercepting only the
  v1 host and letting v2 clients keep GitHub's cache — remains on the table
  as the fallback if the artifact coupling proves unacceptable. ADR 0007's
  unmeasured fault classes (refusal, hang) are prerequisites for enabling
  interception at all.
- **Stage C's exit conditions carry over** — the end-to-end v2-selection test,
  the restore-volume number that could still reverse ADR 0007, and now one
  more: the artifact-passthrough canary above.

## Considered and rejected

- **A runner job-started hook writing the variables:** measured dead — that is
  T3, and the runner overwrites action steps after it (run 32109974600).
- **Patching `Runner.Worker` in the image:** delivers the variables directly,
  but the fleet stops running GitHub's runner and starts running a fork with a
  security-relevant diff to maintain against every runner release. The pinned
  runner's provenance is worth more than the proxy hop it saves.
- **DNAT in the Worker's nftables instead of guest hosts entries:** same TLS
  problem, less visibility — the redirect happens where the conformance
  fingerprint cannot see it, and per-guest scoping (cache on, cache off) turns
  into per-VM firewall state. The guest image is the layer this fleet already
  proves things about.
- **Accepting environment delivery for script steps only:** the seam already
  does this for free, and it captures 0% of measured cache volume — every
  byte of the 329 MiB ADR 0007 counted moves through action steps.
