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

Every real cache client — `actions/cache`, `setup-node`, `setup-go`, buildx's
`type=gha` — is an action step. So the finding is exact: **EraInfra can deliver
any environment it likes to a job, and the runner will overwrite the four cache
variables in every environment a cache client actually reads.** The
runner-environment-level delivery ADR 0007 decided on cannot carry the
endpoint. Its store decision, security contract, two-generation requirement and
fault-tolerance obligations are untouched; what this amendment replaces is only
the sentence "at the runner-environment level."

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

2. **A fleet CA that exists to sign two names.** The clients speak HTTPS to
   GitHub's hostnames, so the service must present certificates for them, and
   no public CA will issue those. The guest image carries an EraInfra fleet CA
   in its system trust store, and the guest seam sets `NODE_EXTRA_CA_CERTS`
   for the Node-based clients that ignore the system store — a variable the
   job message does not carry, so the runner does not overwrite it (measured
   class: T1 script and action rows agree on everything outside the four
   cache variables). The CA's private key lives with the cache service, never
   on a Worker, and signs exactly the two cache hostnames. A CA that signs
   anything else has left this ADR's authorization.

3. **The results host is shared, so the service proxies what it does not
   serve.** ADR 0007 already measured that `ACTIONS_RESULTS_URL` carries both
   cache v2 and `actions/upload-artifact` traffic behind the same
   `ACTIONS_RUNTIME_TOKEN`. Intercepting the hostname therefore obligates the
   service to pass every non-cache path through to the real upstream
   unmodified, or artifacts break fleet-wide — the exact accident ADR 0007
   said the seam "is not allowed to make silently" now becomes a routing rule
   with a test: cache twirp paths are served, everything else is reverse-
   proxied, and an upload-artifact job on an intercepted Worker is a standing
   canary. The v1 host serves cache alone and is intercepted whole.

4. **GitHub's own token becomes the repository claim.** The intercepted
   requests arrive bearing the job message's `ACTIONS_RUNTIME_TOKEN` — a JWT
   GitHub minted, carrying the repository and run identity ADR 0007's security
   rule 1 demanded from "the issuer, not the job". Verifying its signature and
   scoping entries by its claims satisfies rules 1 and 2 with a credential no
   job authored; the fork-PR write refusal reads the same claims. The token is
   also a live GitHub credential, so the service treats it as ADR 0007 treats
   bucket keys: used for verification and upstream proxying, never logged,
   never stored beyond the request.

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
  breach. If the cache service is down, the pinned names refuse connections
  and clients degrade to misses — which lands exactly on ADR 0007's unmeasured
  fault classes (refusal, hang), so the timeout-and-retry budget it owed
  stage B is now a prerequisite for enabling interception at all.
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
