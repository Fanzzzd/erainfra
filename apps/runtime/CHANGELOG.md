# @erainfra/runtime

## 0.2.0-rc.22

### Patch Changes

- [#368](https://github.com/Fanzzzd/erainfra/pull/368) [`aa8534e`](https://github.com/Fanzzzd/erainfra/commit/aa8534ede2e4e1998faa880c70bb508d8442a5ed) Thanks [@Fanzzzd](https://github.com/Fanzzzd)! - Placement no longer charges a guest twice for thin-pool space it already wrote. A Worker now reports `storage.poolReserveUsedMiB`: how much of their reserves the guests live at the pool sample had already written, at most one reserve each. Placement admits while `poolFreeMiB + poolReserveUsedMiB >= poolReserveMiB * guests`. Before, a sample taken while guests ran lowered a Worker's disk capacity until its next readiness report, up to 6 hours later for a Profile without a warm pool. A runtime that does not report the field gets no credit, which is the old rule. Deploy the control plane before rolling out this runtime: an older control plane rejects readiness that carries the new field.

- [#367](https://github.com/Fanzzzd/erainfra/pull/367) [`50b2488`](https://github.com/Fanzzzd/erainfra/commit/50b2488fae0e640ac66d6c38196c51ad41c61f81) Thanks [@Fanzzzd](https://github.com/Fanzzzd)! - A job placed while its warm pool replaces a parked guest that exited now waits for the replacement instead of failing. If that replacement also exits before a job claims it, jobs fail until the next readiness check. Lowering `warmPool` below the number of running warm jobs no longer fails new jobs; they cold-boot while the pool drains. A job that reaches the runtime after it began shutting down now fails instead of cold-booting.

## 0.2.0-rc.21

### Patch Changes

- [#362](https://github.com/Fanzzzd/erainfra/pull/362) [`cb38ae4`](https://github.com/Fanzzzd/erainfra/commit/cb38ae4d6a7817bda6391d594457aad7d8508a0b) Thanks [@Fanzzzd](https://github.com/Fanzzzd)! - A Worker now reports the thin-pool reserve it enforces for each guest as `storage.poolReserveMiB`, and placement uses that value. Before, the control plane hard-coded 8 GiB, so changing `RC_MIN_POOL_FREE_MIB` on a Worker changed its own preflight and warm-pool checks but not placement. A runtime that does not report the field is still placed against 8 GiB. Deploy the control plane before rolling out this runtime: an older control plane rejects readiness that carries the new field.

- [#361](https://github.com/Fanzzzd/erainfra/pull/361) [`e1731f4`](https://github.com/Fanzzzd/erainfra/commit/e1731f45def22c5dbda1c618e1a85bee50b1324a) Thanks [@Fanzzzd](https://github.com/Fanzzzd)! - A job placed while its Profile's warm pool boots a replacement guest now waits for that guest. The runtime used to fail the job with `warm pool is unhealthy: warm pool owns N-1 of N microVMs`. A pool that has recorded a real failure still fails the job.

## 0.2.0-rc.20

### Minor Changes

- [#353](https://github.com/Fanzzzd/erainfra/pull/353) [`087d56e`](https://github.com/Fanzzzd/erainfra/commit/087d56e7719e62f4e8a38d7591ceed19ecca1be7) Thanks [@Fanzzzd](https://github.com/Fanzzzd)! - The guest keeps a job's writes in memory (lazy writeback) and resets the VM without syncing, so a job no longer loads the Worker's shared disk with writes to a snapshot that is deleted after the Attempt.

### Patch Changes

- [#357](https://github.com/Fanzzzd/erainfra/pull/357) [`27df7a9`](https://github.com/Fanzzzd/erainfra/commit/27df7a920c1fc598fad72b433abea4dce0355cef) Thanks [@Fanzzzd](https://github.com/Fanzzzd)! - Image Release pruning keeps the release a VM booted from most recently as the rollback, not the one pulled last.

## 0.2.0-rc.19

### Patch Changes

- [#337](https://github.com/Fanzzzd/erainfra/pull/337) [`7f3f275`](https://github.com/Fanzzzd/erainfra/commit/7f3f2756df008fcc6a31d5bdeb8192c009ecb724) Thanks [@Fanzzzd](https://github.com/Fanzzzd)! - The runtime deletes Image Releases no Profile of its Worker uses. Once an hour the Agent sends the Image Releases of its Firecracker Profiles; the runtime keeps those, its warm pools' and the newest other one, and deletes the rest. ubuntu0 held seven, about 10 GiB each unpacked, with every Profile on one. `runner-center-runtime prune-images` runs it by hand.

- [#335](https://github.com/Fanzzzd/erainfra/pull/335) [`98fa05e`](https://github.com/Fanzzzd/erainfra/commit/98fa05ee1805550f6337fa0b082387361611d05a) Thanks [@Fanzzzd](https://github.com/Fanzzzd)! - The runtime logs `held Attempt for the start budget` only for an Attempt that waited. It logged every start before, with `held=0s`.

## 0.2.0-rc.18

### Patch Changes

- [#330](https://github.com/Fanzzzd/erainfra/pull/330) [`874c13b`](https://github.com/Fanzzzd/erainfra/commit/874c13bf19beca8f6cfb1f640328f4487fbe7b8f) Thanks [@Fanzzzd](https://github.com/Fanzzzd)! - Guests and Docker job containers ask the resolver with `options edns0 timeout:1 attempts:3`. glibc waits 5 s for a lost DNS answer by default, and the resolvers sit across the Worker's uplink. On ubuntu0, 2 of 360 sampled lookups to github.com took 5 s; with this change a lost answer costs 1 s. `testdata/resolver-options.json` holds the option list, and the Go and TypeScript tests both read it.

- [#333](https://github.com/Fanzzzd/erainfra/pull/333) [`cf3d1cb`](https://github.com/Fanzzzd/erainfra/commit/cf3d1cb34ab87aba4d1643035539922538b53c1d) Thanks [@Fanzzzd](https://github.com/Fanzzzd)! - Firecracker Workers space Attempt starts out within a start budget. The runtime holds a start, warm claims included, while two Attempts are still in their first 60 seconds or the host's I/O pressure (io "some" avg10) is at 30% or more, for at most 120 seconds, in arrival order. The Agent forwards the state in its heartbeat, and `/runs-on` answers the fallback with reason `over-start-budget` while every ready Worker is over budget. On ubuntu0, six Attempts starting together held I/O stall at 40 to 60% for minutes and slowed tests on every job. `ERAINFRA_MAX_STARTING`, `ERAINFRA_START_WINDOW_S`, `ERAINFRA_IO_PRESSURE_LIMIT` and `ERAINFRA_MAX_START_HOLD_S` change the limits; `docs/workers.md` has the details. Deploy the control plane before the Agent. An older control plane rejects the new heartbeat field; the Agent then retries without it.

## 0.2.0-rc.17

### Patch Changes

- [#324](https://github.com/Fanzzzd/erainfra/pull/324) [`ee39c1c`](https://github.com/Fanzzzd/erainfra/commit/ee39c1c5833de876ba25093a9005af2074e20c0d) Thanks [@Fanzzzd](https://github.com/Fanzzzd)! - Guests mount their root filesystem with `nobarrier,data=writeback,journal_async_commit,commit=30`, the root mount options of GitHub's hosted image. Our image dropped them together with GRUB. Each Attempt's root is a throwaway snapshot, so each small write saved also saves a 64 KiB copy-on-write or zeroing write in the Worker's thin pool. The image boot test now fails if the guest's root mount lacks any of them.

- [#323](https://github.com/Fanzzzd/erainfra/pull/323) [`3c87ca2`](https://github.com/Fanzzzd/erainfra/commit/3c87ca2b2b5d4acbbc36eef9fcc2dc5c91d173a2) Thanks [@Fanzzzd](https://github.com/Fanzzzd)! - The thin pool now zeroes every new block. Before this change the pool was created with `skip_block_zeroing`, so a guest that wrote part of a fresh 64 KiB block could read the rest of it, which could hold an earlier Attempt's data. Host setup reloads an existing pool's table in place. A new readiness check, `snapshot-block-zeroing`, fails while the pool skips zeroing, and the control plane requires it on every Firecracker Worker. Update the runtime on each Worker before deploying the control plane, or Workers on an older runtime are refused.

## 0.2.0-rc.16

### Minor Changes

- [#316](https://github.com/Fanzzzd/erainfra/pull/316) [`1e4f95e`](https://github.com/Fanzzzd/erainfra/commit/1e4f95ed478055058dc1c2d112d7428d055d66da) Thanks [@Fanzzzd](https://github.com/Fanzzzd)! - A save of a key another job is still uploading is skipped, as GitHub's own cache does. Before, a cold burst of jobs that all missed one key each uploaded the same bytes, and the newest commit won.

- [#306](https://github.com/Fanzzzd/erainfra/pull/306) [`da5ad28`](https://github.com/Fanzzzd/erainfra/commit/da5ad28abac6503cc92ea0da2eb0f0953986795d) Thanks [@Fanzzzd](https://github.com/Fanzzzd)! - Firecracker guests can send apt's `http://` fetches through an apt mirror such as apt-cacher-ng. Set `RC_APT_MIRROR_URL=http://<host>:3142` on the runtime and allow the address in the egress list. A probe before each apt run sends apt direct when the mirror does not answer, so a mirror outage never fails a job. `https://` sources always go direct. See `docs/runbooks/operate-the-apt-mirror.md`.

### Patch Changes

- [#301](https://github.com/Fanzzzd/erainfra/pull/301) [`9538ddc`](https://github.com/Fanzzzd/erainfra/commit/9538ddce10f521c6dad33826f5ad7f1b2fb7c5b5) Thanks [@Fanzzzd](https://github.com/Fanzzzd)! - Setup and readiness messages, and the dashboard's alert and metrics notes, now point to the current docs pages instead of README sections that moved to `docs/`.

- [#294](https://github.com/Fanzzzd/erainfra/pull/294) [`98ab6f3`](https://github.com/Fanzzzd/erainfra/commit/98ab6f319fce4a220374e034729f06e1a60997b9) Thanks [@Fanzzzd](https://github.com/Fanzzzd)! - The Firecracker runtime's warnings in `journalctl -u runner-center-runtime` keep their `time=`, `level=` and `msg=` fields and their messages, but the level now reads `WARN` or `INFO` instead of `warning` or `info`, and the time carries milliseconds.
