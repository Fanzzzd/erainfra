# Runner parity gap: GitHub hosted, Blacksmith, EraInfra

Checked on 2026-11-12 against GitHub's docs, `actions/runner-images`, and Blacksmith's docs and
blog. EraInfra facts come from this repository. [The image research](blacksmith-runner-images.md)
already covers why the ARC runner container is not the hosted image and how Blacksmith builds its
images; this page does not repeat it. "Unverified" marks a claim no primary source confirmed.

## Summary

- The full image matches hosted `ubuntu-24.04` at the same upstream release (`ubuntu24/20261101.360`,
  `images/ubuntu-24.04-full/upstream.json`). Software parity on 24.04 is not the main gap.
- The main gap for payable-style jobs is network resilience. Every job fetches npm packages,
  Playwright's Chromium, the Convex local backend binary, apt packages and git objects across one
  uplink that stalls about a third of new connections to github.com in episodes (#149). GitHub's
  image fails apt over between mirrors in 15 s. Blacksmith routes GitHub traffic through a peered
  proxy pool. EraInfra has neither yet.
- Second: capacity and availability. There is one x64 Worker, two sizes (4 and 16 vCPU), and no
  ARM. The `/runs-on` router falls back to GitHub hosted, which neither GitHub nor Blacksmith offers,
  but it must be added to each workflow.
- Third: GitHub moves `ubuntu-latest` to 26.04 by 2026-11-19. EraInfra has no 26.04 image, so a
  workflow migrated from `ubuntu-latest` lands on 24.04 defaults (Node 22, Python 3.12).
- Caching is close to Blacksmith for this workload: Actions cache, Turborepo, git checkout and a
  Docker Hub mirror all work with no workflow change. Sticky disks stay out by design (ADR 0002).
- Observability is ahead of GitHub and behind Blacksmith on log search, step timelines and
  debugging a failed job.

## Sources

GitHub:

- G1 runner table and sizes: https://docs.github.com/en/actions/reference/runners/github-hosted-runners
- G2 larger runners: https://docs.github.com/en/actions/reference/runners/larger-runners
- G3 limits: https://docs.github.com/en/actions/reference/limits
- G4 hosted concepts (network, image info): https://docs.github.com/en/actions/concepts/runners/github-hosted-runners
- G5 workflow syntax (`timeout-minutes`): https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax
- G6 24.04 readme: https://github.com/actions/runner-images/blob/main/images/ubuntu/Ubuntu2404-Readme.md
- G7 26.04 readme: https://github.com/actions/runner-images/blob/main/images/ubuntu/Ubuntu2604-Readme.md
- G8 26.04 GA: https://github.com/actions/runner-images/issues/14747 ; `ubuntu-latest` move:
  https://github.com/actions/runner-images/issues/14748
- G9 apt config: https://github.com/actions/runner-images/blob/main/images/ubuntu/scripts/build/configure-apt.sh
  and `configure-apt-sources.sh` in the same directory
- G10 metrics: https://docs.github.com/en/actions/concepts/metrics ; debug logging:
  https://docs.github.com/en/actions/how-tos/monitor-workflows/enable-debug-logging
- G11 runner shutdown message: https://github.com/actions/runner/blob/main/src/Runner.Worker/JobRunner.cs

Blacksmith:

- B1 sizes and labels: https://docs.blacksmith.sh/blacksmith-runners/overview
- B2 concurrency: https://docs.blacksmith.sh/blacksmith-runners/concurrency
- B3 Actions cache: https://docs.blacksmith.sh/blacksmith-caching/dependencies-actions
- B4 Docker builds: https://docs.blacksmith.sh/blacksmith-caching/docker-builds ; container image
  cache: https://docs.blacksmith.sh/blacksmith-caching/docker-container-caching
- B5 sticky disks: https://docs.blacksmith.sh/blacksmith-caching/dependencies-sticky-disks
- B6 git checkout: https://docs.blacksmith.sh/blacksmith-caching/git-checkout-caching ; Turborepo:
  https://docs.blacksmith.sh/blacksmith-caching/turborepo-build-caching
- B7 observability: https://docs.blacksmith.sh/blacksmith-observability/logs ,
  `.../metrics`, `.../test-analytics`, `.../ssh-access`, `.../monitors`
- B8 migration: https://docs.blacksmith.sh/introduction/quickstart
- B9 GitHub path proxy: https://www.blacksmith.sh/blog/blacksmith-x-tailscale (post date unverified)
- B10 scheduler and timeouts: https://www.blacksmith.sh/blog/how-blacksmith-runs-10-million-jobs-per-day
- B11 outage postmortem: https://www.blacksmith.sh/blog/us-west-regional-failure-august-13-2026-postmortem
- B12 rightsizing: https://docs.blacksmith.sh/blacksmith-runners/rightsizing
- B13 egress observability: https://www.blacksmith.sh/blog/what-is-your-ci-job-talking-to

Priority is for a payable-style job: a Node and pnpm monorepo, turbo, Playwright Chromium E2E, and a
local Convex backend, on x64.

## Image contents

| Item              | GitHub hosted                                                                | Blacksmith                                                             | EraInfra                                                                                                         | Gap                                                                          | Priority |
| ----------------- | ---------------------------------------------------------------------------- | ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | -------- |
| Base image        | 24.04 image 20261101.360.1; 26.04 GA since 2026-09-17 (G6, G7, G8)           | "same image(s)" as GitHub; `ubuntu-2404` and `ubuntu-2604` labels (B1) | full image from the same 24.04 release, every upstream script in Packer order (`recipe.py`); js image is minimal | no 26.04 image                                                               | medium   |
| `ubuntu-latest`   | moving to 26.04, rollout ends 2026-11-19 (G8)                                | maps to their default label (B8)                                       | `migrate runs-on` maps it to the newest active Profile version, today 24.04                                      | migrated jobs get Node 22 and Python 3.12 instead of Node 24 and Python 3.14 | medium   |
| Node, pnpm        | Node 22 default on 24.04, 24 on 26.04; toolcache 22 and 24; no pnpm (G6, G7) | same as GitHub (B1)                                                    | js: Node 22 and 24 in toolcache, pnpm preinstalled; full: hosted set                                             | none for setup-node; pnpm is extra                                           | low      |
| Browsers          | Chrome, Chromium, Firefox, drivers; no Playwright browsers or deps (G6)      | same as GitHub                                                         | full: hosted browsers plus Playwright Chromium system packages (`recipe.py` overlay); js: Playwright deps only   | Playwright's own Chromium build downloads every job everywhere               | high     |
| Docker            | 28.0.4, Compose 2.38.2 on 24.04 (G6)                                         | same; no Linux containers on Windows (B1)                              | dockerd in the guest, pinned 29.1.3; no iptables raw table (`docs/images.md`)                                    | none for `services:`                                                         | low      |
| Conformance proof | n/a                                                                          | not published                                                          | daily fingerprint diff against hosted, but only `rc-e2e` is in `.github/conformance/profiles.txt`                | the two `erainfra-*` Profiles are not measured                               | medium   |
| Custom images     | larger runners only (G4)                                                     | machine definitions, private beta                                      | any pinned Image Release per Profile                                                                             | none                                                                         | low      |

## Sizes and architectures

| Item               | GitHub hosted                                                   | Blacksmith                                                       | EraInfra                                                                                                       | Gap                                     | Priority |
| ------------------ | --------------------------------------------------------------- | ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | --------------------------------------- | -------- |
| Standard Linux x64 | public 4 vCPU/16 GB/14 GB; private 2 vCPU/8 GB/14 GB (G1)       | 2, 4, 8, 16, 32 vCPU at 4 GB per vCPU, 80 GB to 1.5 TB disk (B1) | `erainfra-4vcpu-ubuntu-2404`, `erainfra-16vcpu-ubuntu-2404`; disk is the Worker's thin pool                    | no 2, 8 or 32 vCPU Profile              | low      |
| Larger runners     | 2 to 96 vCPU, GPU T4, Team and Enterprise only (G2)             | up to 32 vCPU; 64 vCPU listed for 26.04 (B1)                     | sized by Worker hardware                                                                                       | none needed today                       | low      |
| ARM64 Linux        | `ubuntu-24.04-arm`, `ubuntu-26.04-arm`, public and private (G1) | 2 to 32 vCPU, 3 GB per vCPU (B1)                                 | no ARM Worker; the js image builds arm64, the full image is amd64 only                                         | no ARM path                             | low      |
| Capacity           | 20 to 500 concurrent jobs by plan (G3)                          | no concurrency limit (B2)                                        | one Worker; `maxRunners` per Profile                                                                           | one Worker is a single point of failure | high     |
| Isolation          | fresh VM per job (G1)                                           | Firecracker microVM per job                                      | Firecracker microVM per Attempt, cpuset and memory match the Profile (allowlist `cpu_visible_matches_allowed`) | none                                    | low      |

## Caching

| Item                       | GitHub hosted             | Blacksmith                                                             | EraInfra                                                                                                         | Gap                                                                                                      | Priority |
| -------------------------- | ------------------------- | ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | -------- |
| `actions/cache`, `setup-*` | 10 GB per repository (G3) | intercepted, colocated, 25 GB per repository, 7-day idle eviction (B3) | cache service through the in-guest interceptor; 10 GiB quota and 7-day idle TTL by default (`docs/job-cache.md`) | none                                                                                                     | low      |
| pnpm store                 | via `actions/cache`       | via cache, or sticky disk for `node_modules` (B5)                      | via `actions/cache`; no persistent disk                                                                          | a cold `node_modules` link step each job                                                                 | low      |
| Turborepo                  | none                      | org toggle, one cache per repository (B6)                              | guest proxy on `127.0.0.1:7457`, no workflow change                                                              | none                                                                                                     | low      |
| Docker layers              | `type=gha`                | BuildKit state on a sticky disk (B4)                                   | BuildKit `type=gha` against the cache service, one `driver-opts` line                                            | one line per workflow                                                                                    | low      |
| Container images           | none                      | Docker image store kept per org, region and arch, on by default (B4)   | Docker Hub pull-through mirror only (`operate-the-registry-mirror.md`)                                           | ghcr.io, mcr and quay pulls go to the internet every job                                                 | medium   |
| Git checkout               | none                      | `useblacksmith/checkout` mirror and colocated git proxy (B6)           | git checkout mirror with `RC_GIT_MIRROR=on`; still contacts GitHub per checkout                                  | checkout still exposed to #149                                                                           | medium   |
| Sticky disks               | none                      | up to 5 per job (docs) or 10 (README), 7-day eviction (B5)             | not served: breaks the per-Attempt boundary (ADR 0002)                                                           | deliberate                                                                                               | none     |
| Tool downloads             | none                      | none documented                                                        | none                                                                                                             | Playwright browsers and the Convex local backend binary download per job unless the workflow caches them | high     |

## Network resilience (apt, DNS, registry)

| Item                | GitHub hosted                                                                                                                    | Blacksmith                                                                                                                    | EraInfra                                                                                                                                          | Gap                                          | Priority |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- | -------- |
| apt                 | mirror list: azure.archive, archive, security; x64 `Acquire::Retries "1"` with 15 s timeouts so a stalled mirror fails over (G9) | not documented                                                                                                                | full image keeps upstream's apt sources, which point at Azure's mirror; no local mirror                                                           | an apt mirror is being built separately      | high     |
| DNS                 | resolver and IPv6 not documented (G1, G4); unverified                                                                            | host-side DNS proxy for egress counts (B13); unverified as a resolver                                                         | guest writes the Profile's resolvers, default 1.1.1.1 and 9.9.9.9; no stub or caching resolver; IPv6 off (allowlist `dns_*`, `net_ipv6_disabled`) | every lookup crosses the uplink; no cache    | medium   |
| GitHub reachability | Azure or AWS network; needs 70 kbit/s (G4)                                                                                       | GitHub CIDRs redirected through a host proxy to a Squid pool with direct peering, after an ISP stalled 7-10% of requests (B9) | direct; #149 records SYN stalls of 30-60 s to github.com                                                                                          | no path around a bad uplink                  | high     |
| Docker Hub limits   | not applied to public image pulls on hosted (G3)                                                                                 | first pull counts against anonymous limits (B8); image store cache after that                                                 | pull-through mirror; falls back to Docker Hub                                                                                                     | none with the mirror on                      | low      |
| npm registry        | direct                                                                                                                           | direct                                                                                                                        | direct; no npm proxy                                                                                                                              | every `pnpm install` miss crosses the uplink | medium   |
| Egress control      | none                                                                                                                             | allowlist promised, not shipped (B13); unverified                                                                             | Profile egress public, audit or allowlist (ADR 0015)                                                                                              | none                                         | low      |

## Timeouts and retries

| Item              | GitHub hosted                                                                            | Blacksmith                                                                       | EraInfra                                                                                                                                                        | Gap                                   | Priority |
| ----------------- | ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- | -------- |
| Job time limit    | 6 hours, then the job fails; self-hosted 5 days (G3)                                     | 12 h default, 72 h maximum per the scheduler blog (B10); not in docs, unverified | runtime refuses a job timeout over 21,600 s, so 6 hours (`apps/runtime/internal/runtimeapi/api.go`)                                                             | none for CI                           | low      |
| `timeout-minutes` | job default 360; step maximum 360 (G5)                                                   | GitHub's                                                                         | GitHub's                                                                                                                                                        | none                                  | low      |
| Queue             | hosted run dropped if not picked up in 45 min; self-hosted cancelled after 24 h (G3, G4) | "starts within seconds"; queueing only without the App installed (B1)            | the `/runs-on` router decides once, when the job is enqueued. A job routed to a Profile whose Workers all drop afterwards waits until GitHub cancels it at 24 h | a routed job can strand for 24 h      | high     |
| Failover          | n/a                                                                                      | none documented; manual label revert in the Aug 13 outage (B11)                  | `/runs-on` fallback                                                                                                                                             | ahead                                 | none     |
| Infra retry       | none documented                                                                          | none documented; unverified                                                      | none found; an Attempt lost with its Worker fails                                                                                                               | no re-run of a job lost to the Worker | medium   |
| Cache outage      | n/a                                                                                      | jobs hung on cache calls on Aug 13; circuit breakers added after (B11)           | 3 s scope lookup then cold cache; failures turn into misses (`docs/job-cache.md`)                                                                               | ahead                                 | none     |

## Observability

| Item               | GitHub hosted                                   | Blacksmith                                              | EraInfra                                                                                         | Gap                               | Priority |
| ------------------ | ----------------------------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | --------------------------------- | -------- |
| Resource metrics   | none per job                                    | CPU, memory, network per job, with a step timeline (B7) | CPU, memory, network, disk per Attempt; OOM count; peak summary on Runs (`docs/job-insights.md`) | no step timeline over the charts  | medium   |
| Fleet metrics      | usage and performance metrics, queue time (G10) | duration, failure rate, cost per repository             | Prometheus `/metrics`, 12 alert rules (`docs/monitoring.md`)                                     | none                              | low      |
| Logs               | per run, downloadable (G10)                     | search across all runs by repo, branch, job, step (B7)  | GitHub's logs only                                                                               | no cross-run log search           | medium   |
| Test results       | none                                            | JUnit and log parsing incl. Playwright, PR comment (B7) | JUnit parsed by the guest after the job (`docs/job-insights.md`)                                 | no PR comment; no flaky detection | low      |
| Debug a failed job | `ACTIONS_RUNNER_DEBUG` (G10)                    | SSH into the VM, hold after failure (B7)                | Experiments run a command non-interactively; no SSH by design (`docs/workflows.md`)              | no way to inspect a failed guest  | medium   |
| Alerts             | none                                            | Monitors: result, duration, log pattern; Slack (B7)     | Slack-compatible or generic webhook; Attempt failure rate, queue backlog, running too long       | no per-job or log-pattern rule    | low      |
| Right-sizing       | none                                            | per-job history, PR edits `runs-on` (B12)               | right-size recommendations (`docs/job-insights.md`)                                              | no PR                             | low      |

## Failure messages

| Item                      | GitHub hosted                                             | Blacksmith          | EraInfra                                                                                                                                              | Gap                                            | Priority |
| ------------------------- | --------------------------------------------------------- | ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- | -------- |
| Time limit                | job "is terminated and fails" (G3); exact text unverified | not documented      | guest killed at the runtime deadline; what the GitHub log shows is unverified                                                                         | job log may not say "timeout"                  | medium   |
| Runner gone               | "The runner has received a shutdown signal..." (G11)      | not documented      | same runner text; Worker loss reconciled, reason on the Attempt                                                                                       | reason is on the dashboard, not in the job log | medium   |
| Runner exits before a job | n/a                                                       | n/a                 | last runner `ERR` line on the Attempt and in alerts (`docs/job-insights.md`)                                                                          | ahead                                          | none     |
| No capacity               | n/a                                                       | queues              | a job for an unserved Profile queues until timeout and reads like a dead runner (`docs/images.md`); router fallback reason only in the deployment log | silent wait without the router                 | high     |
| Network stall             | generic tool errors                                       | generic tool errors | generic tool errors; nothing ties a failed step to #149                                                                                               | no network signal per Attempt                  | medium   |
| Out of disk, OOM          | not documented; unverified                                | not documented      | OOM count recorded; disk chart, no disk-full flag                                                                                                     | no disk-full flag                              | low      |

## What to build, in order

1. **Fetch path for job downloads.** One caching proxy on the Worker's network for the hosts every
   payable job hits: registry.npmjs.org, Playwright's CDN, GitHub release assets (Convex local
   backend), ghcr.io and other OCI registries. This removes most uplink round trips that #149
   breaks, and covers what the Docker Hub mirror misses. The apt mirror, being built separately,
   is the apt part of this.
2. **Stranded job recovery.** Reported by payable on 2026-11-12. A job that the router sent to a
   Profile stays queued for 24 hours if every Worker for that Profile drops before the job
   starts. GitHub-hosted and Blacksmith runners do not strand a job that way. The control plane
   already moves a waiting Attempt to another ready Worker. It cannot do that when no Worker is
   ready. Planned: after a short deadline, the control plane cancels the workflow run and asks
   GitHub to rerun it. The router job then answers with the fallback. Limits: the rerun repeats
   the whole workflow, it helps only workflows that use the router, and the GitHub App needs
   Actions write. Off by default.
3. **A second Worker, or a documented capacity floor.** One Worker means a hardware or uplink
   fault takes every Profile down. Until a second exists, make the `/runs-on` router the default
   in `erainfra migrate runs-on` output so a job falls back instead of waiting 24 hours.
4. **GitHub path resilience.** Send github.com and its object hosts through a second path when
   connections stall, the way Blacksmith did (B9). The git checkout mirror already cuts bytes;
   this cuts the connection count that stalls.
5. **Clear failure text in the job log.** On a runtime deadline, Worker loss or a stalled network
   call, write one line the job log shows (through the guest before teardown) with the reason the
   dashboard already has.
6. **Bake Playwright Chromium into the full image** at the version payable pins, or document an
   `actions/cache` step for `~/.cache/ms-playwright`. The system packages are already baked.
7. **Ubuntu 26.04 image and Profile.** GitHub's `ubuntu-latest` is 26.04 by 2026-11-19. Build
   `images/ubuntu-26.04-full` from the same recipe and teach `migrate runs-on` to map
   `ubuntu-latest` to it.
8. **Conformance for the live Profiles.** Add `erainfra-4vcpu-ubuntu-2404` and
   `erainfra-16vcpu-ubuntu-2404` to `.github/conformance/profiles.txt`.
9. **A caching DNS resolver** per Worker for guests, with the Profile's resolvers as upstreams.
10. **Step timeline on the Attempt charts** from the runner's step timestamps, and a cross-run log
    search. Lower value: GitHub's own logs work for one run.
11. **Re-run an Attempt lost with its Worker**, when GitHub reports the job failed for runner loss.
    Needs design: re-running is GitHub's call, not the Worker's.

Not planned: sticky disks (ADR 0002), SSH into guests (`docs/workflows.md`), ARM until a consumer
needs it.
