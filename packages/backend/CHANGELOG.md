# @erainfra/backend

## 0.2.0-rc.16

### Minor Changes

- [#313](https://github.com/Fanzzzd/erainfra/pull/313) [`d736199`](https://github.com/Fanzzzd/erainfra/commit/d7361998361055fe11b68db4b705d67b258ebdd2) Thanks [@Fanzzzd](https://github.com/Fanzzzd)! - Name the guest's out-of-memory kill as the runner cause when a job fails after the guest kernel killed a process.

- [#314](https://github.com/Fanzzzd/erainfra/pull/314) [`fffd457`](https://github.com/Fanzzzd/erainfra/commit/fffd45780697855e4d0641910038ce99b2ddee38) Thanks [@Fanzzzd](https://github.com/Fanzzzd)! - The `/runs-on` router stores each answer as a `routerDecisions` row with its route and fallback reason, kept 90 days, so routing can be counted per day and repository for billing reconciliation. The router accepts an optional `repo=OWNER/NAME` parameter to tag the row; the answer itself does not change.

- [#308](https://github.com/Fanzzzd/erainfra/pull/308) [`3ba2b4b`](https://github.com/Fanzzzd/erainfra/commit/3ba2b4bbc31118d1997ab14e08c6c6df08ed015c) Thanks [@Fanzzzd](https://github.com/Fanzzzd)! - When the runner, not the job's own steps, fails a run, the dashboard's run page, `erainfra jobs view` and the operator API name the cause (for example, no Worker within 24 hours, Worker lost, executor killed for memory) and link the GitHub or Blacksmith page that describes the same behaviour.

- [#312](https://github.com/Fanzzzd/erainfra/pull/312) [`35a1cf5`](https://github.com/Fanzzzd/erainfra/commit/35a1cf5524d4a188ec4acfccf2ddf7dc51b26d8f) Thanks [@Fanzzzd](https://github.com/Fanzzzd)! - A job routed to a Profile that then loses every ready Worker no longer has to wait 24 hours: set `ERAINFRA_STRANDED_JOB_ACTION` to `cancel` or `rerun` on the deployment, and grant the controller's GitHub App Actions: Read and write. The control plane then cancels the run after `ERAINFRA_STRANDED_JOB_AFTER_MINUTES` (default 5) and, for `rerun`, asks GitHub to rerun it once. The controller now reports each job it acquires so the control plane knows the job's workflow run. The default, `wait`, changes nothing.

### Patch Changes

- [#301](https://github.com/Fanzzzd/erainfra/pull/301) [`9538ddc`](https://github.com/Fanzzzd/erainfra/commit/9538ddce10f521c6dad33826f5ad7f1b2fb7c5b5) Thanks [@Fanzzzd](https://github.com/Fanzzzd)! - Setup and readiness messages, and the dashboard's alert and metrics notes, now point to the current docs pages instead of README sections that moved to `docs/`.

- [#315](https://github.com/Fanzzzd/erainfra/pull/315) [`83e5b0b`](https://github.com/Fanzzzd/erainfra/commit/83e5b0b0a5ace2dea0515096323662ecb037f36f) Thanks [@Fanzzzd](https://github.com/Fanzzzd)! - The `/runs-on` router answers the fallback when no controller holds the Profile's lease. Before, a Profile whose controller was stopped still routed jobs to a scale set nobody listened on.
