# Job isolation and egress

What each Attempt is given, what it is denied, and how a Worker proves both before it takes work.
The design is in [ADR 0002](adr/0002-verify-the-job-isolation-boundary.md); the platform table is
in [How EraInfra works](architecture.md#executors).

## Firecracker Attempts

For a Firecracker Profile, each Attempt gets:

- a fresh guest kernel and a copy-on-write root prepared from the Image Release's chain ID; no host
  path, socket, volume or device is shared, and the snapshot is discarded on exit;
- a point-to-point job network whose policy is rendered and verified by the runtime itself. Traffic
  to the host, to other guests, and to RFC1918, CGNAT, link-local and other special-purpose ranges
  is dropped. The guest's link carries only IPv4 from the guest's own address: IPv6 and borrowed
  source addresses are dropped as they arrive, even from root writing raw frames, and the host side
  of the link has IPv6 turned off in the kernel as well. A Worker whose nftables table no longer
  matches, or whose guest link has IPv6 back on, stops being ready. If the table is reloaded under
  a running guest, which empties the guest's sets, the runtime writes them back within 10 seconds
  and readiness fails if it cannot; drain the Worker before reloading (see
  [Restrict job egress](runbooks/restrict-job-egress.md));
- the egress its Profile publishes, enforced on the host, never inside the guest (see
  [Egress policy](#egress-policy));
- single-use JIT credentials over MMDSv2, never in argv, an image layer, a host environment or a
  log;
- teardown on success, failure, cancellation, timeout, and controller reconciliation. After an Agent
  crash, its service supervisor restarts it and startup recovery reconciles the privileged runtime
  before the Worker advertises readiness or accepts replacement work. If that supervisor is disabled
  and the Agent never restarts, a guest can remain alive until its job or runtime timeout exits it;
- CPU, memory and thin-pool admission before the Attempt is placed, and one process-bounded runtime
  service per host.

For a Docker Profile, each Attempt additionally gets **its own range of the Worker's CPUs**. The
Agent reserves `vcpus` cores per Attempt, disjoint from every other Attempt and Experiment running
on that Worker, and passes them to `--cpuset-cpus` beside the `--cpus` quota. Without the cpuset the
quota is invisible: `nproc`, `os.availableParallelism()`, `runtime.NumCPU()` and
`Runtime.availableProcessors()` all read the affinity mask through `sched_getaffinity(2)` and never
the quota, so an 8-vCPU job on a 64-core Worker told every autosizing build tool it owned 64 cores
and each one over-subscribed by 8x. Reservations are released on every teardown path, and a Worker
whose Agent was killed outright reconciles them against the running containers before it advertises
readiness again. A Worker with no free range refuses the Attempt rather than running it
over-subscribed, and a Profile asking for more vCPUs than the Worker has CPUs fails its
`cpu-capacity` readiness check instead of being scheduled onto.

None of that is taken on trust. Before a Worker advertises a Docker Profile as ready it runs one
throwaway container with that Profile's exact limit flags, on a range borrowed from the same
allocator that pins a real Attempt, and asserts the container agrees about its own size: `nproc`
equals `vcpus`, `RC_VCPUS` and `RC_MEMORY_MIB` hold the right numbers, and `RC_MEMORY_MIB` is the
limit the memory cgroup actually enforces. That is the `job-resource-visibility` check, and its
detail carries the measured numbers on a pass as well as a failure. A Worker that cannot give a job
an honest view of its own size does not accept work, which is the rule the network policy already
follows.

A cpuset does not fix every CPU-count interface, so **`RC_VCPUS` in the job environment is the
authoritative limit.** `/proc/cpuinfo` is not filtered and still lists every host CPU, which leaves
Node's `os.cpus().length` reporting the Worker. Python's `os.cpu_count()` depends on the C library:
musl answers it from the affinity mask, glibc from the online-CPU count. The Linux Image
Release is glibc, so Python jobs need `len(os.sched_getaffinity(0))`, `os.process_cpu_count()` on
3.13+, or `RC_VCPUS`.

**Memory is not made honest by that, and the container is told so explicitly.** `free`,
`/proc/meminfo` and `os.totalmem()` still report the host's RAM, because the cgroup limit is not
reflected there without LXCFS, which needs a host daemon, its own readiness evidence, and a bind
mount into a container whose contract forbids one. Every Docker job therefore receives `RC_VCPUS`
and `RC_MEMORY_MIB` in its environment, holding the limits actually enforced on it. Anything that
sizes a heap or a worker pool from total RAM (`--max-old-space-size` is the usual one) should read
`RC_MEMORY_MIB` rather than believe `free`.

Nothing writable survives a job on either Linux executor, so the only warm state on a Worker is
the immutable Image Release. Dependency caches are kept off the Worker, in GitHub's cache or in
EraInfra's job cache.

## Egress policy

Egress is part of the Profile, like its executor and size. The controller publishes it from
`ERAINFRA_EGRESS_MODE`, `ERAINFRA_EGRESS_PRESETS` and `ERAINFRA_EGRESS_ALLOW` in its environment
(the `RC_` names still work; see [Environment variable names](architecture.md#setting-names)), and every Worker
renders and verifies it for that Profile's guests. Three modes exist:

| Mode        | What a guest can reach                                     | What is recorded per Attempt                      |
| ----------- | ---------------------------------------------------------- | ------------------------------------------------- |
| `public`    | the internet; host, private ranges and other guests denied | nothing                                           |
| `audit`     | the same as `public`                                       | every DNS name queried and every new IP:port flow |
| `allowlist` | only the listed domains and CIDRs                          | the same, with each refused name and flow marked  |

A Profile without the setting is `public`, which is what every Profile was before.
`ERAINFRA_EGRESS_ALLOW` takes domains (`registry.npmjs.org`, `*.example.com`) and IPv4 CIDRs or
addresses. `ERAINFRA_EGRESS_PRESETS=github` expands to the domains GitHub lists for
[self-hosted runner communication](https://docs.github.com/en/actions/reference/runners/self-hosted-runners#communication-requirements),
plus `*.githubusercontent.com`. The Worker's cache service and Docker Hub registry mirror, when it has them, are always allowed.

Enforcement happens on the host. Each audit or allowlist guest's DNS, to whatever server it names,
is redirected to a resolver in the runtime daemon. For an allowlist guest the resolver answers only
allowed names, and before it replies it adds the answer's addresses to that guest's nftables set
with a timeout of the record's TTL. The kernel then forwards new TCP and UDP flows only to set
members and the Profile's CIDRs; a direct connection to any other address is dropped and recorded.
Because the set follows DNS, an allowed name that moves to a new address keeps working, and a CNAME
chain behind an allowed name is followed. The record comes from the resolver and from a kernel set
the forward chain fills, so nothing in it depends on the guest.

The host operator's `RC_EGRESS_MODE` and `RC_EGRESS_ALLOW` in `/etc/runner-center/runtime.env`
(or their `ERAINFRA_` names) apply to every guest on that Worker, on top of each Profile's egress.
The stricter layer wins:

- the effective mode is the stricter of the host's and the Profile's (`public` < `audit` <
  `allowlist`);
- a host allowlist keeps denying everything not in `RC_EGRESS_ALLOW`, whatever a Profile allows, so
  a guest under both reaches only what both allow;
- a Profile cannot open a private, host or special-purpose range; the operator must list it in
  `RC_EGRESS_ALLOW` and the Profile must list it too.

A Worker that cannot run the resolver or write the per-guest sets fails its
`egress-policy` check and is not ready for audit or allowlist Profiles; its public Profiles keep
running. The [egress runbook](runbooks/restrict-job-egress.md) walks through moving a Profile
from audit to allowlist, and [ADR 0015](adr/0015-egress-is-a-property-of-the-profile.md)
records the design.
