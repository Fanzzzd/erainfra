# Runbook: take the only Worker out of service

A Profile with one Worker cannot roll. While that Worker is away, the scale-set listener keeps
accepting jobs and they queue: GitHub has no fallback label, and it cancels a queued self-hosted
job only after 24 hours. A consumer that has read its own runbook will not wait that long.
biel-payable-system's rule is "any required check queued longer than 10 minutes, unset
`RC_CI_RUNS_ON`", and on 2026-08-20 that rule fired during the Firecracker cutover, moved the
repository to `ubuntu-latest`, and nobody set it back for two weeks (#138).

So the question before any operation on a single-Worker Profile is one number: how long will the
Worker be away, and is that longer than the consumer's rule.

## What takes the Worker away, and for how long

| Operation                                                                                 | Away for                                                                                                                            | Running Attempts                                                                                                                            |
| ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `rc update`, `rc restart`                                                                 | The Agent restart is sub-second. Readiness re-probes each Profile; with the Image Release already in the thin-pool that is seconds. | Preserved: the runtime daemon keeps running and recovery reports `preserved N server-live execution(s)`.                                    |
| A release that changes the Image Release                                                  | As above plus one pull of the new image from GHCR (about 1 GiB) before the Profile is ready.                                        | Preserved.                                                                                                                                  |
| `systemctl restart runner-center-runtime`                                                 | The daemon restart plus readiness.                                                                                                  | Lost: systemd kills the daemon's control group, every guest with it, and `Recover` reclaims what they held. Wait for the Worker to be idle. |
| Moving or recreating the thin-pool, a host reboot, a kernel upgrade, the executor cutover | The whole operation plus a full image pull, since the pool starts empty. Minutes to an hour.                                        | Lost, as above.                                                                                                                             |

The first two rows need no coordination: the queue is shorter than the rule. The last two do.

## Before

1. Look at what is running and queued: the dashboard's Attempts page, and `rc logs -f` on the
   Worker for `Starting firecracker Attempt` lines without a matching finish.
2. Tell the consumer to move to hosted for the duration. For biel-payable-system that is
   `gh variable delete RC_CI_RUNS_ON` in that repository, run by someone with access to it, and
   cancelling anything already queued on the Profile label (a queued job keeps its label).
3. Write the re-enable down where the consumer will see it, before starting: a task in their
   tracker with the exact command, assigned to a person. This is the step that was forgotten.
   The command for biel-payable-system is `gh variable set RC_CI_RUNS_ON --body rc-linux-js`.
4. Wait for the Worker to be idle if the operation loses Attempts.

## During

Do the operation. Watch `rc logs -f` on the Worker; the line to wait for is

```
rc-linux-js readiness: ready (firecracker-microvm, guest-kernel)
```

for every Profile the Worker serves. The dashboard's Profile row turns ready at the same moment.

## After

1. Run the daily canary by hand and read it: `gh workflow run smoke.yml` in this repository, then
   the run's summary. It checks out the repository with a two-minute bound, which is the step the
   consumer's jobs lost their minutes in on 2026-08-20.
2. Set the consumer back. Close the tracker task from step 3 only after the first consumer job has
   run on the Profile: the dashboard's Attempts page names the repository of each Attempt once
   GitHub has started the job on it.

## Known gap

Nothing on this side notices when a consumer leaves. The controller sees zero `JobStarted` for a
Profile that used to get dozens a day and says nothing. Until it does (#138), the tracker task in
step 3 is the only reminder.
