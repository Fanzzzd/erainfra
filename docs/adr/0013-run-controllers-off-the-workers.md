# ADR 0013: Run controllers off the Workers

- Status: Accepted
- Date: 2026-11-05
- Owners: EraInfra

## Context

[ADR 0001](0001-use-scale-sets-with-platform-executors.md) splits demand from execution: one small
controller per Profile holds GitHub's scale-set session and turns demand into Attempts, and Workers
execute them. The controller needs no KVM and does no job work, so it can run anywhere with
outbound HTTPS to GitHub and the control plane. Where it runs was decided in operation, not
recorded: both controllers live on a small always-on VM (oracle-singapore-1), not on the Worker
(ubuntu0). This ADR writes down why, so the choice is not undone by accident.

## Decision

Controllers run on a host that is not a Worker.

1. **Taking a Worker away must not take demand with it.** The controller is the only process that
   hears GitHub's `JobAvailable`. On a separate host it keeps the session through a Worker reboot,
   rollout or outage: demand is still recorded, jobs queue visibly, and the `/runs-on` router can
   send them to a GitHub-hosted fallback. On the Worker itself, every Worker update is also a
   demand outage.
2. **Workers stay interchangeable.** A Profile is a scale set, and any ready Worker may serve it. A
   controller pinned to one Worker makes that Worker special and breaks the symmetry adding a
   second one depends on.
3. **The controller's network path is its own.** It long-polls GitHub's scale-set API. A Worker's
   uplink is chosen for job traffic and has its own failure modes: ubuntu0's office uplink drops
   about a third of new connections to github.com for 30 to 60 s in episodes (#149), which on the
   Worker would become late or missed job messages.
4. **The machine that runs untrusted jobs holds fewer secrets.** A controller holds the GitHub App
   private key and the controller token. Guests cannot reach their host, but a host compromise
   should not also yield the credentials that register runners.

## Consequences

- Running a controller on a Worker gains one fewer host and nothing on the job path: the
  controller is not in the data path, so jobs are not faster. It costs all four properties above.
- If the controller host is a concern, the answer is a second controller host (a standby with the
  same env files, started only if the first is gone), not the Worker.
- A Profile is retired with `runner-center-controller retire --yes` after its unit is stopped,
  because stopping a controller leaves its scale set registered on GitHub.
