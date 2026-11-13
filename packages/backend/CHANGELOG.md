# @erainfra/backend

## 0.2.0-rc.22

### Patch Changes

- [#365](https://github.com/Fanzzzd/erainfra/pull/365) [`d5aae66`](https://github.com/Fanzzzd/erainfra/commit/d5aae6618abee8d7adb6e1fd8ab56c985c697ed7) Thanks [@Fanzzzd](https://github.com/Fanzzzd)! - `/install --role node` no longer migrates a Hub-mode Node. It stops checking for a live `portless-agent.service` or `erainfra-agent.service`, and it refuses `--replace-hub-agent` with a message that says how to stop the old unit by hand. Every Node moved to `connect-convex` before this change.

- [#368](https://github.com/Fanzzzd/erainfra/pull/368) [`aa8534e`](https://github.com/Fanzzzd/erainfra/commit/aa8534ede2e4e1998faa880c70bb508d8442a5ed) Thanks [@Fanzzzd](https://github.com/Fanzzzd)! - Placement no longer charges a guest twice for thin-pool space it already wrote. A Worker now reports `storage.poolReserveUsedMiB`: how much of their reserves the guests live at the pool sample had already written, at most one reserve each. Placement admits while `poolFreeMiB + poolReserveUsedMiB >= poolReserveMiB * guests`. Before, a sample taken while guests ran lowered a Worker's disk capacity until its next readiness report, up to 6 hours later for a Profile without a warm pool. A runtime that does not report the field gets no credit, which is the old rule. Deploy the control plane before rolling out this runtime: an older control plane rejects readiness that carries the new field.

## 0.2.0-rc.21

### Patch Changes

- [#359](https://github.com/Fanzzzd/erainfra/pull/359) [`e6bdde2`](https://github.com/Fanzzzd/erainfra/commit/e6bdde29ccd2e745587cb05114d449b062123f04) Thanks [@Fanzzzd](https://github.com/Fanzzzd)! - The Node installer no longer tells operators to roll back to Hub mode, which ADR 0020 retired.

- [#362](https://github.com/Fanzzzd/erainfra/pull/362) [`cb38ae4`](https://github.com/Fanzzzd/erainfra/commit/cb38ae4d6a7817bda6391d594457aad7d8508a0b) Thanks [@Fanzzzd](https://github.com/Fanzzzd)! - The Action Runner Agent's warm-pool capacity check now uses the same CPU and memory envelope as placement, including the whole-host exception: a warm guest that needs all of a Worker's CPUs or memory is measured against the whole host instead of 90%. Before, a Worker sized exactly for its warm pool passed placement but failed the warm-pool check. `testdata/host-envelope-cases.json` owns the rule, and both test suites run its cases.

- [#362](https://github.com/Fanzzzd/erainfra/pull/362) [`cb38ae4`](https://github.com/Fanzzzd/erainfra/commit/cb38ae4d6a7817bda6391d594457aad7d8508a0b) Thanks [@Fanzzzd](https://github.com/Fanzzzd)! - A Worker now reports the thin-pool reserve it enforces for each guest as `storage.poolReserveMiB`, and placement uses that value. Before, the control plane hard-coded 8 GiB, so changing `RC_MIN_POOL_FREE_MIB` on a Worker changed its own preflight and warm-pool checks but not placement. A runtime that does not report the field is still placed against 8 GiB. Deploy the control plane before rolling out this runtime: an older control plane rejects readiness that carries the new field.

- [#363](https://github.com/Fanzzzd/erainfra/pull/363) [`f1b5ba3`](https://github.com/Fanzzzd/erainfra/commit/f1b5ba3b628c64eeb06465225c72cda06465b508) Thanks [@Fanzzzd](https://github.com/Fanzzzd)! - Retire the dashboard's CI GitHub App. The Manifest flow (`/github/app/new`, `/github/app/callback`), the dashboard panel "Legacy webhook runner migration" and the `githubApp` and `githubAppSetups` tables are removed, and the backend no longer reads `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY` or `GITHUB_WEBHOOK_SECRET`. `/github/webhook` now verifies every delivery against the deploy App's `ERAINFRA_GH_WEBHOOK_SECRET` only, so a leftover repository webhook signed with `GITHUB_WEBHOOK_SECRET` gets 401. The `actions/runner` release read uses the controller GitHub App's token, else none.

- [#360](https://github.com/Fanzzzd/erainfra/pull/360) [`04d0757`](https://github.com/Fanzzzd/erainfra/commit/04d07572485d96ccecd4442e4dfc8a056f0c517f) Thanks [@Fanzzzd](https://github.com/Fanzzzd)! - Remove the pre-Profile webhook job path. The backend no longer stores `workflow_job` deliveries, assigns them to Workers as commands, or asks GitHub to redeliver missed ones; `/github/webhook` acts only on `push`. `agentApi:pendingCommands`, `agentApi:claim` and `agentApi:report` are gone, so a Worker needs Action Runner Agent v0.2.0-rc.20 or later. The dashboard's Legacy jobs page and the `ALLOWED_REPOS`, `ALLOW_PUBLIC_REPOS` and `GITHUB_PAT` settings are removed. Reading the `actions/runner` release list now falls back to the controller GitHub App's token instead of `GITHUB_PAT`.

  The `jobs`, `commands`, `runnerDeletions`, `webhookRecovery` and `webhookRecoveryState` tables leave the schema. Convex does not delete documents a removed table still holds; delete them from the Convex dashboard.

## 0.2.0-rc.20

### Patch Changes

- [#356](https://github.com/Fanzzzd/erainfra/pull/356) [`8598496`](https://github.com/Fanzzzd/erainfra/commit/8598496848f8a12324d7f4c4283ebfa88e60091c) Thanks [@Fanzzzd](https://github.com/Fanzzzd)! - Drop the empty `hubImportTombstones` table, which nothing has written since the Hub importer left main.

- [#341](https://github.com/Fanzzzd/erainfra/pull/341) [`3d94215`](https://github.com/Fanzzzd/erainfra/commit/3d9421566361d21db9d7447900349a4cb45937da) Thanks [@Fanzzzd](https://github.com/Fanzzzd)! - Webhook intake no longer stores a `workflow_job` delivery that the pre-Profile job path would not act on. It answers such a delivery 200 `Ignored`. `/runs-on?labels=` now answers 400 with an error that names `profile=`.

- [#344](https://github.com/Fanzzzd/erainfra/pull/344) [`d1fcdf3`](https://github.com/Fanzzzd/erainfra/commit/d1fcdf33aa6acafaab7f75617ec12b0bc2edaa8e) Thanks [@Fanzzzd](https://github.com/Fanzzzd)! - The control plane no longer reads three storage shapes that predate v0.2.0-rc.5: a full benchmark report on the `machines` row, readiness evidence on the `workerReadiness` row, and a JIT config on the `attempts` row. The schema refuses them now. The Worker API is unchanged.

## 0.2.0-rc.19

No changes in this release.

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
