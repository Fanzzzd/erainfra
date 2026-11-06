# ADR 0018: Serve build-system caches through a guest proxy

- Status: Accepted
- Date: 2026-11-06
- Owners: EraInfra
- Related: [ADR 0007](0007-serve-the-actions-cache-protocol-from-an-s3-compatible-store.md) (scoping
  rules), [ADR 0008](0008-win-the-cache-endpoint-below-the-environment.md) (the runner bearer and the
  interceptor), [ADR 0009](0009-a-store-is-plugged-in-not-wired-in.md) (the store)

## Context

Blacksmith serves Turborepo's remote cache and Go's build cache (through `GOCACHEPROG`) from its
cache layer, beside the Actions cache
([turborepo](https://docs.blacksmith.sh/blacksmith-caching/turborepo-build-caching),
[go](https://docs.blacksmith.sh/blacksmith-caching/go-build-caching)). EraInfra's cache service
served only the Actions cache protocol, which BuildKit's `type=gha` also speaks.

Neither build tool is an Actions cache client. turbo reads `TURBO_API`, `TURBO_TOKEN` and
`TURBO_TEAM` and speaks the Turborepo Remote Cache API. cmd/go starts the program named in
`GOCACHEPROG` and speaks a JSON protocol with it over stdin and stdout. Both run in `run:` steps, so
unlike `actions/cache` (ADR 0008) they read the environment the guest hands the runner.

The cache service authorizes a request by the runner bearer the host mints at claim and the facts
the controller pushes at `JobStarted`. The bearer is in the guest's MMDS and in the memory of the
guest daemon. It has never been in the job's environment.

## Decision

1. **The cache service serves both protocols as ordinary entries.** `/_erainfra-build/turbo/v8/...`
   implements the Turborepo Remote Cache API v8 and `/_erainfra-build/go/<action ID>` is a two-verb
   remote tier for the Go helper. Each artifact is an index entry with key `turbo/<hash>` or
   `go/<action ID>` and a version that names the build system and CPU architecture. So scoping
   (ADR 0007 rules 2 and 3), the per-repository quota, idle and LRU eviction, and the admin API
   apply to them unchanged. A lookup is exact, because a key is a content hash.
2. **A proxy in the guest daemon holds the bearer.** It listens on `127.0.0.1:7457` and presents the
   runner bearer on the job's behalf. The job gets `TURBO_API` pointing at it, `TURBO_TEAM`, and a
   placeholder `TURBO_TOKEN` that is not a credential. A job can do through the proxy what it can
   already do through the interceptor, nothing more. A fork pull request reads and does not write.
   The proxy answers only requests whose `Host` is the address it advertises and that carry no
   `Origin` or `Sec-Fetch-Site` header, so a page in a browser the job runs cannot reach it by
   rebinding its DNS name to `127.0.0.1`.
3. **turbo is on by default; the Go helper is a one-line opt-in.** The guest sets the three `TURBO_`
   variables whenever a cache is configured. It ships `erainfra-gocacheprog` and sets
   `ERAINFRA_BUILD_CACHE_URL`, but a workflow turns the helper on with `GOCACHEPROG:
erainfra-gocacheprog`.
4. **A workflow's own `TURBO_API` wins, and the proxy never forwards a token it did not issue.** A
   step's `env` overrides the runner's, so a workflow that sets `TURBO_API` bypasses the proxy.
   `turbo.json` does not: turbo 2.10.9 (`turbo config`) ranks environment variables and its global
   config file above `remoteCache.apiUrl`. The guest cannot read `turbo.json` when it builds the
   runner's environment, because nothing is checked out yet, and neither source it can write ranks
   below `turbo.json`. So a workflow that sets only `TURBO_TOKEN` reaches the proxy, and the proxy
   cannot tell whether that token was meant for Vercel or for a server `turbo.json` names. It sends
   the token nowhere: the status check gets a `401`, which turbo prints once as "check
   TURBO_TOKEN", and every other request gets the disabled-cache answers in decision 5. The guest
   journal says to set `TURBO_API`, `https://vercel.com/api` for Vercel. An earlier version
   forwarded such requests to Vercel, which sent a self-hosted cache's token to a host the
   workflow never named.
5. **Both fail open with one line.** When the cache service cannot be reached or does not know the
   runner yet, the proxy answers turbo as a disabled cache: status `disabled`, reads `404`, uploads
   `202`. Measured against turbo 2.10.9, that prints one "Remote caching unavailable" warning; a
   `5xx` prints one warning per task. The Go helper turns its remote tier off for the rest of the go
   command and prints one line. Its local tier is always consulted first.

## Consequences

- turbo needs no workflow change on a Firecracker Profile with a cache. Go needs one line.
- Build entries share the repository's quota with `actions/cache` entries. A large Go build can
  evict a `setup-node` cache, and the reverse. That is the same LRU order the quota already imposes,
  and `erainfra-cache-service admin delete --prefix go/` clears one system's entries.
- The proxy answers a refused upload from a read-only job with `202` and drops it. turbo has no
  answer for "read but do not write": it prints a `403` as a Vercel permissions warning on every
  upload, and the one code it acts on, `remote_caching_disabled`, also stops its reads for the rest
  of the run (`turborepo-cache` `multiplexer.rs`, v2.10.9). The cache service still answers `403`;
  only the guest translates it.
- An upload the store fails is different: the job's outputs were meant to be saved. The cache
  service answers `503` and counts it as `outcome="error"`, and the proxy passes the `503` on, so
  turbo prints a warning for that task instead of taking the artifact as cached.
- Build entries are always streamed through the cache service, in presign mode too. They are many
  and small, so a redirect would add a round trip per hit.
- `container:` jobs and `docker build` do not reach the proxy, because a Docker bridge does not see
  guest loopback. Blacksmith documents the same limit for its Turborepo cache.

## Why the Go helper is not on by default

- cmd/go treats a GOCACHEPROG program that exits early as fatal to the build. A defect in the helper
  would fail every Go build in every job, where a defect in turbo's remote cache path costs a
  warning.
- Go caches test results through the same protocol, and the helper cannot tell them from build
  outputs. Shared test results replay a passing run of a test that depends on outside state.
  Blacksmith turns test result sharing off by default for that reason. A workflow that saves
  `GOCACHE` with `setup-go` already shares test results, so the helper is no worse than that, but it
  should be a choice.
- One line is the cost of the choice, and turning it on by default later is one line in
  `runnerEnv`.

## Considered and rejected

- **Hand the job the runner bearer as `TURBO_TOKEN`.** No proxy to run, but the bearer would be in
  every step's environment and in anything that prints it. The proxy keeps the job's environment
  free of credentials.
- **Serve Turborepo from the in-guest TLS interceptor.** turbo does not talk to a GitHub host, so
  there is nothing to intercept; it would need the same variables anyway.
- **A separate quota for build caches.** It would be a second budget over the same eviction code,
  and an operator would have to size two budgets for one bucket.
- **Blacksmith's scoping, one cache per repository shared across branches.** Blacksmith's pages say
  so for both caches. EraInfra keeps GitHub's rules for every entry instead: a branch reads its own
  ref, its pull request's base and the default branch. A feature branch therefore does not see a
  sibling's outputs, which costs some hits and keeps one branch from feeding another.
- **Bazel's remote cache (gRPC REAPI or HTTP).** Not built. It is the remaining Blacksmith build
  cache.
