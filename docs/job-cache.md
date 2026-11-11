# The job cache

How EraInfra serves the GitHub Actions cache, build-system caches, a registry mirror and a git
checkout mirror to Firecracker jobs. To turn the cache on, follow
[Runbook: run the job cache](runbooks/operate-the-job-cache.md).

A Firecracker Profile can have its GitHub Actions cache served by EraInfra's own cache service,
`apps/cache-service`, which stores entries in an S3-compatible bucket the operator picks
([ADR 0007](adr/0007-serve-the-actions-cache-protocol-from-an-s3-compatible-store.md),
[ADR 0009](adr/0009-a-store-is-plugged-in-not-wired-in.md)). Workflows do not change. When a
Worker's runtime is configured with a cache, the guest pins GitHub's cache host,
`results-receiver.actions.githubusercontent.com`, in its `/etc/hosts` to an interceptor inside the
guest. The interceptor terminates TLS with a CA minted for that boot, sends cache calls to the cache
service, and forwards artifact calls and everything else to GitHub
([ADR 0008](adr/0008-win-the-cache-endpoint-below-the-environment.md),
[ADR 0012](adr/0012-pin-the-cache-host-by-name-and-reach-containers-by-verified-trust.md)).
The caches of `actions/cache`, `setup-node` and `setup-go` all take this path.

- **Scope.** Entries are stored per repository and ref, where a repository is GitHub's repository
  ID as well as its name (next item). The guest's token names only the runner.
  At `JobStarted` the controller reads the job's workflow run from GitHub, works out which refs the
  job may read and the one it may write, and pushes those facts to the cache service, which applies
  them to every request. The rules follow GitHub's own cache restrictions: a branch or tag job reads
  its own ref, then the default branch; a pull request reads `refs/pull/<n>/merge`, then its base
  branch, then the default branch, and writes only to its merge ref; a pull request from a fork
  writes nothing; a sibling branch is never readable. A lookup that fails or takes over 3 s gives
  the job a cold cache, never a wider one. The exact table is in
  [the runbook](runbooks/operate-the-job-cache.md#one-key-three-holders).
- **One repository, not one name.** Entries live under the repository's name, and each one also
  records GitHub's repository ID from the job facts. A job reads only entries saved under its own
  ID. A repository deleted or renamed away and then created again under the same name is a new
  repository with a new ID: it restores none of the old one's entries, and its first save removes
  them. This covers `actions/cache`, BuildKit, Turborepo, the Go build cache and the git seed.
  Two cases still match by name alone. A job from a controller that pushes no ID reads every
  entry under the name, for as long as such a controller runs. An entry saved before the cache
  service recorded IDs has none: it belongs to the first ID that saves under its name after the
  upgrade, and another ID that later takes the name gets none of it. So for each name the
  by-name window ends at the first save from an upgraded controller. If the name changed hands
  before that save, the new repository adopts the old one's entries, because nothing stored can
  tell the two apart. A job of the old repository that was already running when the name moved
  cannot take it back: for six hours after a newer repository (a larger ID) takes the name, saves
  from a smaller ID are refused and leave the new holder's entries alone.
  `erainfra-cache-service admin list` shows each entry's ID and the ID that holds the
  name, and `--repository-id` narrows a list, delete or clear to one ID.
- **Failure.** A cache service or store that cannot answer in time turns into a cache miss or a
  request forwarded to GitHub. A guest whose redirect does not come up talks to GitHub directly. A
  cache failure makes the cache step warn; it does not fail the job.
- **Passthrough.** The cache host also serves Artifacts v4 (`upload-artifact` and
  `download-artifact` v4+). The interceptor serves only the cache path. Every other request,
  artifacts included, goes to GitHub with its method, path, query, headers and body unchanged, and
  GitHub's reply comes back the same way.
- **Coverage.** Every process on the guest is redirected, as any user. Docker containers have their
  own hosts file and an image does not trust the guest's CA, so a container is redirected only when
  it opts in. A buildx builder for `type=gha` adds one `driver-opts` line, and a `container:` job
  mounts the CA. Both are in
  [the runbook](runbooks/operate-the-job-cache.md#docker-builds-and-container-jobs).
  Containers that do not opt in, service containers among them, use GitHub's cache. Docker, Tart
  and Hyper-V Profiles have no interceptor and use GitHub's cache too.
- **Trust.** Every client the redirect reaches must trust the guest's CA, or its cache and artifact
  calls fail TLS. While the redirect is installed, the guest covers these clients with no workflow
  change, as the runner user and through `sudo`: OpenSSL, Go, .NET and curl through the system store
  `update-ca-certificates` rebuilds; Node through `NODE_EXTRA_CA_CERTS`; Python `requests` and `pip`
  through `REQUESTS_CA_BUNDLE`; and `httpx` and conda's OpenSSL through `SSL_CERT_FILE`. The last two
  point at the rebuilt system bundle. The JVM is not covered, because it reads its own truststore and
  has no variable for a PEM file. Neither is a binary with a compiled-in root list, such as a Rust
  tool built with `webpki-roots`. A job whose JVM calls the cache host itself (a Gradle build cache
  plugin backed by the Actions cache, for example) adds one step after `setup-java`, and that step
  does nothing where no cache is configured:

  ```bash
  f=/usr/local/share/ca-certificates/erainfra-cache.crt; [ -f "$f" ] && keytool -importcert -noprompt -cacerts -storepass changeit -alias erainfra-cache -file "$f"
  ```

  Any job can instead send its own cache and artifact traffic straight to GitHub for the rest of
  the job: `sudo sed -i '/# erainfra-cache-interceptor$/d' /etc/hosts`.

- **Build-system caches.** The same service backs Turborepo's remote cache and Go's build cache
  ([ADR 0018](adr/0018-serve-build-system-caches-through-a-guest-proxy.md)). The guest runs a
  proxy on `127.0.0.1:7457` that presents the runner's bearer, and hands the runner `TURBO_API`,
  `TURBO_TEAM` and a placeholder `TURBO_TOKEN`, so `turbo run` caches remotely with no workflow
  change. Go opts in with one line, `GOCACHEPROG: erainfra-gocacheprog`, which the image ships.
  Turborepo artifacts and Go outputs are ordinary entries: the same scope rules, quota, eviction
  and admin commands apply, and a fork pull request reads them without writing. A workflow that
  sets its own `TURBO_API` keeps its own remote cache. turbo ranks the guest's `TURBO_API` above
  `remoteCache.apiUrl` in `turbo.json`, so a repository that names its cache only there, or that
  sets only `TURBO_TOKEN` for Vercel, must also set `TURBO_API` in the workflow
  (`https://vercel.com/api` for Vercel). Until it does, the proxy forwards that token nowhere,
  turbo prints one `check TURBO_TOKEN` warning and builds uncached. The proxy answers only
  requests addressed to `127.0.0.1:7457` that carry no browser `Origin`. If the cache service is
  down, turbo prints one warning and the Go helper one line, and both build uncached.
  `container:` jobs and `docker build` do not reach the proxy. Details are in
  [the runbook](runbooks/operate-the-job-cache.md#10-build-system-caches-turborepo-and-go).
- **Registry mirror.** Workers can also give guests a Docker Hub pull-through mirror
  ([runbook](runbooks/operate-the-registry-mirror.md)). dockerd and buildx builders use it
  with no workflow change, and fall back to Docker Hub when it is down.
- **Git checkout mirror.** With `RC_GIT_MIRROR=on`, a job's `actions/checkout` of its own
  repository fetches from GitHub only the objects missing from the repository's seed, a git bundle
  an earlier job saved in the cache service under the cache's own scope rules. The guest's git
  reaches `https://github.com/` through a proxy in the guest, which checks the job's credential with
  GitHub before every fetch it answers and forwards everything else unchanged. On this repository a
  depth-1 checkout drops from 2.4 MB to 34 KB with a seed one commit old. A checkout still contacts
  GitHub every time, so it does not avoid an uplink that stalls new connections to
  github.com (#149). Any failure sends the fetch
  to GitHub. A seed over the entry size limit is refused, and the next jobs skip building one
  until a backoff passes. A refusal on the default branch holds for the whole repository. A
  refusal on any other ref holds for that ref only, because the job there chose the length it
  declared and must not stop the default branch's seed. Details, measurements and limits are in
  [the runbook](runbooks/operate-the-job-cache.md#11-git-checkout-mirror).
- **Activation.** The cache is off until an operator deploys the service and its bucket and turns
  the interception on, following
  [docs/runbooks/operate-the-job-cache.md](runbooks/operate-the-job-cache.md). Until every
  step there is done, jobs use GitHub's cache exactly as before.

Blacksmith's cache paths, and what serves each one here on a Firecracker Profile with the cache on:

| Blacksmith                                               | EraInfra                                                                                                                                      | workflow change               |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| Actions cache (`actions/cache`, `setup-*` caching)       | cache service through the in-guest interceptor                                                                                                | none                          |
| Docker layer cache (`setup-docker-builder`)              | BuildKit `type=gha` against the same service                                                                                                  | one buildx `driver-opts` line |
| Container image caching                                  | Docker Hub pull-through registry mirror                                                                                                       | none                          |
| Turborepo build cache                                    | Turborepo Remote Cache API through the guest's build proxy                                                                                    | none                          |
| Go build cache (`GOCACHEPROG`)                           | `erainfra-gocacheprog`, local disk first, then the service                                                                                    | one `env` line                |
| Bazel and Buck2 remote cache                             | not served                                                                                                                                    | n/a                           |
| Git checkout cache (`useblacksmith/checkout`, git proxy) | git checkout mirror with `RC_GIT_MIRROR=on`: the job's own repository over HTTPS, seeded from the service                                     | none                          |
| Sticky disks (`useblacksmith/stickydisk`)                | not served: a writable disk that outlives the job breaks the per-Attempt boundary ([ADR 0002](adr/0002-verify-the-job-isolation-boundary.md)) | n/a                           |
