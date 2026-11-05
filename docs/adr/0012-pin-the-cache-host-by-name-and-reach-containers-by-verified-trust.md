# ADR 0012: Pin the cache host by name, and reach containers only by verified trust

- Status: Accepted
- Date: 2026-11-05
- Owners: EraInfra
- Amends: [ADR 0008](0008-win-the-cache-endpoint-below-the-environment.md) §1 and §5
- Related: [ADR 0002](0002-verify-the-job-isolation-boundary.md) (what may survive a job)

## Context

ADR 0008 decided to intercept GitHub's cache host inside the guest and serve its
cache path from EraInfra's cache service. §1 named the mechanism: a guest-local
resolver backed by a packet rule that DNATs the cache host's addresses, so that
"a `container:` job and a `type=gha` buildx step each land on the interceptor."
What shipped was one iptables `nat OUTPUT` DNAT per resolved address, matched on
the runner's UID, and no container coverage at all. Three facts measured while
building container coverage rule out the packet-rule design, not only the
shipped rule:

1. **The guest kernel cannot tell the interceptor's traffic from a client's.**
   The pinned guest kernel is Firecracker's `microvm-kernel-ci-*-6.1` build
   (v1.13 series, 6.1.141). Its configuration, on both x86_64 and aarch64,
   leaves `CONFIG_NETFILTER_XT_MATCH_OWNER`, `_MARK`, `_CGROUP` and `_COMMENT`
   unset, and `CONFIG_MODULES` unset, so none of them can be loaded. The
   shipped rule's `-m owner --uid-owner` therefore fails to install on every
   real guest, the redirect tears itself down as designed, and no Firecracker
   job has reached the interceptor. Without owner, mark or cgroup matching, an
   OUTPUT DNAT cannot exempt the interceptor's own forward to GitHub, which is
   the loop ADR 0008 §3 forbids.
2. **The cache host's addresses rotate faster than a rule can follow.**
   `results-receiver.actions.githubusercontent.com` is a CNAME onto
   `glb-db52c2cf8be544.github.com`, whose A record carries a TTL under a minute
   and answered 140.82.114.22 and 140.82.112.21 on consecutive queries on
   2026-11-05. A rule written for the addresses seen at claim misses the next
   one a client resolves.
3. **A packet rule cannot know whether a container trusts the interceptor.**
   A container image does not trust the per-guest CA. Redirecting its traffic
   turns every cache and artifact call into an x509 failure, where today it
   reaches GitHub. Measured locally with buildx v0.37.2 and
   `moby/buildkit:buildx-stable-1`: a builder pointed at a TLS endpoint serving
   a `cacheca` leaf fails `type=gha` with "x509: certificate signed by unknown
   authority"; the same builder given the CA as below completes the
   `CacheService` Twirp calls against it.

## Decision

**Pin the cache host by name, in each namespace separately, and only where the
CA is trusted.**

- **On the guest itself**, the cache host is pinned in `/etc/hosts` to the
  interceptor at `100.64.0.1:443`. Every process on the guest, as any user,
  resolves through that file and trusts the CA through the system store
  (OpenSSL, Go, .NET, curl) or the trust variables listed under Consequences
  (Node, Python requests, httpx), kept across `sudo` by a drop-in. The
  interceptor reaches GitHub through a resolver that never reads `/etc/hosts`:
  it records the cache host's addresses and CNAME target before the pin is
  written, then resolves the CNAME target, which nothing pins. No packet rule
  is installed, so nothing depends on a match the kernel lacks.
- **In a container**, the pin is written into that container's own hosts file
  (the file Docker bind-mounts as its `/etc/hosts`) only after the guest has
  read, inside the container, a file that holds the CA and that the container's
  environment points a TLS stack at: `SSL_CERT_FILE`, a directory in
  `SSL_CERT_DIR` holding `erainfra-cache.crt`, or `NODE_EXTRA_CA_CERTS`. The
  guest watches Docker's container start events to do this, and also removes
  the pin from any container that does not pass, which matters for
  host-network containers: Docker gives one a copy of the guest's `/etc/hosts`,
  pin included.
- **A buildx builder opts in with one line.** At claim the guest writes the
  runner's `~/.docker/buildx/buildkitd.default.toml`, which buildx applies to
  every builder it creates without an explicit `--config`. It lists the CA as a
  registry CA for the cache host. Nothing pulls from that host; the entry is
  there because buildx copies every registry CA into the builder, at
  `/etc/buildkit/certs/results-receiver.actions.githubusercontent.com/erainfra-cache.crt`.
  A workflow adds
  `driver-opts: env.SSL_CERT_DIR=/etc/ssl/certs:/etc/buildkit/certs/results-receiver.actions.githubusercontent.com`
  to `docker/setup-buildx-action`; the guest sees the builder start, verifies
  the CA there, and pins it. On a runner without EraInfra the directory does
  not exist, Go skips it, and the line changes nothing.
- **A `container:` job opts in** by mounting the CA and naming it:
  `volumes: [/usr/local/share/ca-certificates/erainfra-cache.crt:/etc/erainfra/erainfra-cache.crt:ro]`
  and `env: { NODE_EXTRA_CA_CERTS: /etc/erainfra/erainfra-cache.crt }`. Service
  containers are not opted in; they do not call the cache host.

Everything not opted in reaches GitHub directly, exactly as before. The
invariants of ADR 0008 §3 hold and are now tested: the interceptor is listening
and the container watcher running before the guest pin is written; any failure
during setup unwinds every earlier step; once up, the redirect comes down whole
if the interceptor or the watcher stops, so a pin never outlives what it points
at; and a container the watcher cannot account for (its inspect fails, or its
pin cannot be removed) stops the watcher and with it the redirect.

## Consequences

- **Zero workflow change for the runner and everything it starts on the guest;
  one line for a buildx builder; three for a `container:` job.** Blacksmith's
  Docker layer cache needs two action swaps, and actuated's mirror needs a
  workflow step, so the opt-in is within what workflows moving from either
  already accept.
- **Every client on the guest is redirected, as any user, and has to trust the
  CA.** The cache host also serves Artifacts v4, so a client that does not
  trust it fails artifact calls as well as cache calls. While the redirect is
  installed the runner is handed `NODE_EXTRA_CA_CERTS` (the CA, for Node),
  `REQUESTS_CA_BUNDLE` and `SSL_CERT_FILE` (the rebuilt system bundle, for
  Python requests, pip, httpx and OpenSSL builds with their own default path),
  and a sudoers drop-in keeps all three across `sudo`. OpenSSL, Go, .NET and
  curl already read the system store. Each variable is a measured difference
  from ubuntu-latest with an allowlist reason, so variables that would cover
  no additional client (`CURL_CA_BUNDLE`, `SSL_CERT_DIR`) are not set. What
  remains uncovered is a client with its own root list and no variable for a
  PEM file: the JVM, and binaries built with compiled-in roots. The README
  gives a one-line `keytool` opt-in, and a one-line opt-out that removes the
  guest pin for the rest of a job.
- **Non-cache traffic is a passthrough.** Everything outside the CacheService
  path, artifacts included, is forwarded with its method, path, query,
  headers and body unchanged and without `X-Forwarded-*`. Compression is left
  to the client and GitHub: the forward transport neither adds
  `Accept-Encoding` nor decodes a reply on its own.
- **The residual race is a few milliseconds per host-network container.** A
  host-network container that does not trust the CA carries the guest's pin
  from its start until the watcher removes it. A process that calls the cache
  host in that window fails TLS once.
- **The conformance fingerprint measures what the redirect changes**:
  `cache_host_pinned` and the three trust variables, each allowlisted with its
  reason, as ADR 0008's Consequences anticipated.

## Considered and rejected

- **iptables DNAT with the interceptor's upstream on reserved source ports**
  (`! --sport` needs only the built-in tcp match). It fixes the loop but not
  the rotation or the trust problem, and adds a userspace port allocator.
- **DNAT every container's traffic and terminate TLS only on the cache SNI,
  splicing the rest to `SO_ORIGINAL_DST`.** It keeps other hostnames on a
  shared address working, but a container that does not trust the CA still
  fails on the cache host itself.
- **Injecting the CA into every container** (an OCI runtime wrapper, a Docker
  API proxy that rewrites create requests, or bind-mounting a merged bundle
  over each image's). Each changes every container a job runs to rescue the
  few that call the cache host, and none can know where an arbitrary image
  keeps its trust store.
- **Making the docker driver the default builder.** Its `type=gha` export needs
  the containerd image store, and `docker/setup-buildx-action` creates a
  docker-container builder unless told otherwise, so it would still need a
  workflow change, and a larger one.
