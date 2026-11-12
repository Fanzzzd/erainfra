# @erainfra/backend

## 0.2.0-rc.18

### Patch Changes

- [#333](https://github.com/Fanzzzd/erainfra/pull/333) [`cf3d1cb`](https://github.com/Fanzzzd/erainfra/commit/cf3d1cb34ab87aba4d1643035539922538b53c1d) Thanks [@Fanzzzd](https://github.com/Fanzzzd)! - Firecracker Workers space Attempt starts out within a start budget. The runtime holds a start, warm claims included, while two Attempts are still in their first 60 seconds or the host's I/O pressure (io "some" avg10) is at 30% or more, for at most 120 seconds, in arrival order. The Agent forwards the state in its heartbeat, and `/runs-on` answers the fallback with reason `over-start-budget` while every ready Worker is over budget. On ubuntu0, six Attempts starting together held I/O stall at 40 to 60% for minutes and slowed tests on every job. `ERAINFRA_MAX_STARTING`, `ERAINFRA_START_WINDOW_S`, `ERAINFRA_IO_PRESSURE_LIMIT` and `ERAINFRA_MAX_START_HOLD_S` change the limits; `docs/workers.md` has the details. Deploy the control plane before the Agent. An older control plane rejects the new heartbeat field; the Agent then retries without it.

## 0.2.0-rc.17

### Minor Changes

- [#320](https://github.com/Fanzzzd/erainfra/pull/320) [`4107de7`](https://github.com/Fanzzzd/erainfra/commit/4107de78e590ed78f680918d3ce287cbd3a1895e) Thanks [@Fanzzzd](https://github.com/Fanzzzd)! - The control plane no longer knows the legacy image labels `rc-linux`, `rc-mac` and `rc-win`. A job that names no image gets `ubuntu-24.04`, `macos-15` or `windows-2025`, the same images the aliases pointed at. A pre-Profile job that still asks for an old name now needs a Worker with that host label. `/runs-on?labels=` takes the real labels, such as `labels=ubuntu-24.04`.

### Patch Changes

- [#317](https://github.com/Fanzzzd/erainfra/pull/317) [`f8232bb`](https://github.com/Fanzzzd/erainfra/commit/f8232bbb3c8d4745fdcb47cd82e828a0f4ed9ffb) Thanks [@Fanzzzd](https://github.com/Fanzzzd)! - A scale-set job's start is GitHub's runner assignment time, the clock its finish time is on, and a job is never recorded as finishing before it started. Before, a JobStarted that reached the control plane after the job finished gave it a start later than its finish and a zero duration.

- [#321](https://github.com/Fanzzzd/erainfra/pull/321) [`2c53b30`](https://github.com/Fanzzzd/erainfra/commit/2c53b30905973622849063d50cddfdada2b6545e) Thanks [@Fanzzzd](https://github.com/Fanzzzd)! - `erainfra jobs list --since 720h --all` no longer fails on page 2 with "cursor is not valid for these filters". The CLI turns a `--since` span into a time once, before the first page, and its hint for the next page names that time. The operator API's refusal now says when a `since` span sent with a cursor is the likely cause.

- [#317](https://github.com/Fanzzzd/erainfra/pull/317) [`f8232bb`](https://github.com/Fanzzzd/erainfra/commit/f8232bbb3c8d4745fdcb47cd82e828a0f4ed9ffb) Thanks [@Fanzzzd](https://github.com/Fanzzzd)! - When GitHub sends no queue time, queue wait counts from when GitHub assigned the job to the Profile's scale set. GitHub's scale-set messages have so far carried no queue time, so `queueWaitMs` was null on every scale-set Attempt. `queuedAt` stays null. The API returns the new start as `scaleSetAssignedAt`, and `erainfra jobs view` prints it as "On scale set".

- [#323](https://github.com/Fanzzzd/erainfra/pull/323) [`3c87ca2`](https://github.com/Fanzzzd/erainfra/commit/3c87ca2b2b5d4acbbc36eef9fcc2dc5c91d173a2) Thanks [@Fanzzzd](https://github.com/Fanzzzd)! - The thin pool now zeroes every new block. Before this change the pool was created with `skip_block_zeroing`, so a guest that wrote part of a fresh 64 KiB block could read the rest of it, which could hold an earlier Attempt's data. Host setup reloads an existing pool's table in place. A new readiness check, `snapshot-block-zeroing`, fails while the pool skips zeroing, and the control plane requires it on every Firecracker Worker. Update the runtime on each Worker before deploying the control plane, or Workers on an older runtime are refused.

## 0.2.0-rc.16

### Minor Changes

- [#313](https://github.com/Fanzzzd/erainfra/pull/313) [`d736199`](https://github.com/Fanzzzd/erainfra/commit/d7361998361055fe11b68db4b705d67b258ebdd2) Thanks [@Fanzzzd](https://github.com/Fanzzzd)! - Name the guest's out-of-memory kill as the runner cause when a job fails after the guest kernel killed a process.

- [#314](https://github.com/Fanzzzd/erainfra/pull/314) [`fffd457`](https://github.com/Fanzzzd/erainfra/commit/fffd45780697855e4d0641910038ce99b2ddee38) Thanks [@Fanzzzd](https://github.com/Fanzzzd)! - The `/runs-on` router stores each answer as a `routerDecisions` row with its route and fallback reason, kept 90 days, so routing can be counted per day and repository for billing reconciliation. The router accepts an optional `repo=OWNER/NAME` parameter to tag the row; the answer itself does not change.

- [#308](https://github.com/Fanzzzd/erainfra/pull/308) [`3ba2b4b`](https://github.com/Fanzzzd/erainfra/commit/3ba2b4bbc31118d1997ab14e08c6c6df08ed015c) Thanks [@Fanzzzd](https://github.com/Fanzzzd)! - When the runner, not the job's own steps, fails a run, the dashboard's run page, `erainfra jobs view` and the operator API name the cause (for example, no Worker within 24 hours, Worker lost, executor killed for memory) and link the GitHub or Blacksmith page that describes the same behaviour.

- [#312](https://github.com/Fanzzzd/erainfra/pull/312) [`35a1cf5`](https://github.com/Fanzzzd/erainfra/commit/35a1cf5524d4a188ec4acfccf2ddf7dc51b26d8f) Thanks [@Fanzzzd](https://github.com/Fanzzzd)! - A job routed to a Profile that then loses every ready Worker no longer has to wait 24 hours: set `ERAINFRA_STRANDED_JOB_ACTION` to `cancel` or `rerun` on the deployment, and grant the controller's GitHub App Actions: Read and write. The control plane then cancels the run after `ERAINFRA_STRANDED_JOB_AFTER_MINUTES` (default 5) and, for `rerun`, asks GitHub to rerun it once. The controller now reports each job it acquires so the control plane knows the job's workflow run. The default, `wait`, changes nothing.

### Patch Changes

- [#301](https://github.com/Fanzzzd/erainfra/pull/301) [`9538ddc`](https://github.com/Fanzzzd/erainfra/commit/9538ddce10f521c6dad33826f5ad7f1b2fb7c5b5) Thanks [@Fanzzzd](https://github.com/Fanzzzd)! - Setup and readiness messages, and the dashboard's alert and metrics notes, now point to the current docs pages instead of README sections that moved to `docs/`.

- [#315](https://github.com/Fanzzzd/erainfra/pull/315) [`83e5b0b`](https://github.com/Fanzzzd/erainfra/commit/83e5b0b0a5ace2dea0515096323662ecb037f36f) Thanks [@Fanzzzd](https://github.com/Fanzzzd)! - The `/runs-on` router answers the fallback when no controller holds the Profile's lease. Before, a Profile whose controller was stopped still routed jobs to a scale set nobody listened on.
