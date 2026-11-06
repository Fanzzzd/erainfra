---
status: accepted
---

# Pin a Profile to Workers by host label

actuated puts labels on hosts. The agent installer takes `LABELS=gce,ssd,r1`, and a workflow targets
that host with `runs-on: [actuated-2cpu-8gb, r1]` (docs.actuated.com/install-agent, lastmod
2026-02-04). Operators want the same thing here: send this job to the Worker with the GPU, the NVMe
pool, or the one in Hong Kong.

Until now every Worker served every active Profile its OS could run. `machines.labels` existed, set
by the installer's `--labels`, but only the pre-Profile webhook path read it.

## What GitHub allows

The actuated form works because actuated's control plane reads each queued job's labels from the
webhook and starts a Runner registered for that job on a host it picks. EraInfra uses runner scale
sets ([ADR 0001](0001-use-scale-sets-with-platform-executors.md)), and a scale set gives that choice
to GitHub:

- A scale set has one label set: its name, plus extra labels where the platform allows them (all of
  github.com, GHES 3.18 and later behind a flag). Its Runners carry exactly that set; a JIT
  registration takes no labels of its own.
- GitHub sends a job to a scale set whose labels include every label in `runs-on`. When several
  scale sets qualify, any of them can get it.
- Within a scale set, "GitHub assigns a pending job to any idle runner in the scale set"
  (github.com/actions/scaleset README, v0.4.0). A Runner the controller created because job A was
  queued may run job B.

So no label can choose a Worker inside one Profile: the Runner is created before the job it will
run is known. Two ways to fake it both fail:

- **One scale set, extra labels for every host label** (`erainfra-4vcpu-ubuntu-2404` also answering
  to `gpu`). `[erainfra-4vcpu-ubuntu-2404, gpu]` would match, but its Runner can land on any Worker,
  and a plain job can take the Runner started on the GPU Worker.
- **A second scale set labelled `[erainfra-4vcpu-ubuntu-2404, gpu]`**. It matches the pinned job,
  and it also matches every plain `runs-on: erainfra-4vcpu-ubuntu-2404` job. GitHub can hand those to
  the second scale set, which runs them under its contract: its image, its egress, its Workers.

## Decision

**The Profile stays the routing unit, and a pin is a Profile of its own.** A Profile may carry
`workerLabels`, a set of host labels. Only a Worker carrying every one of them serves it:

- `workerApi.profiles` does not show the Profile to other Workers, so they never prepare its image,
  park warm guests for it or report readiness for it.
- `reportReadiness` refuses a report for it from a Worker without the labels.
- `isSchedulableReadiness`, the one rule the scheduler, the `/runs-on` router, the Profile list, the
  metrics and the alerts all read readiness through, counts no Worker without the labels. The pin
  is read from the Profile at placement, not copied onto the Attempt, so a queued Attempt waits for
  a Worker that carries the Profile's current labels.

The controller publishes the pin with the rest of the contract, from `ERAINFRA_WORKER_LABELS`
(`RC_WORKER_LABELS`, installer flag `--worker-labels`). A controller that sends none, including one
built before this ADR, unpins the Profile. Workflows target the pinned Profile by its name:

```yaml
runs-on: erainfra-4vcpu-ubuntu-2404-gpu
```

The name uses ADR 0010's flavour slot: a pinned Profile is a different contract with the same image,
the way a second image is.

**A host label is the operator's, not the Worker's.** The Worker names its labels once, when it
registers (`--labels gpu,nvme`, the installer flag that already existed). After that only an admin
API token changes them: `PUT /api/v1/workers/<name>/labels`, `erainfra workers set-labels`. actuated
reads `LABELS` from the agent's environment on every start. Here a label decides which Profile's jobs
may run on a machine, and a Profile can be pinned to trusted hardware, so a Worker that could
relabel itself could pull in jobs that were kept off it. Labels are lowercase `[a-z0-9._-]`, at most
63 characters and 16 per Worker or Profile. They match case-insensitively, as GitHub's labels do,
and labels written before this rule are compared lowercased.

**No scale set may answer to another Profile's name.** Registration is refused (HTTP 409 to the
controller) when a Profile's scale-set labels include another active Profile's name, or another
Profile's labels include this one's. That is the second failed design above, and the guard keeps an
operator from building it with `ERAINFRA_LABELS`. The guard refuses only a conflict the registration
adds. A pair that already overlapped when the guard was deployed keeps registering; refusing it
would refuse both Profiles at their next controller restart while their rows stayed active and the
router kept sending jobs to them. Such a pair is logged at each registration and raised by the
Profile list, `erainfra profiles list`, a metric and an alert until an operator relabels one side.

## Consequences

- `runs-on: [erainfra-4vcpu-ubuntu-2404, gpu]`, the actuated shape, does not work and is refused at
  registration if someone configures a scale set to make it match.
- Each pin is one more controller unit and scale set. That is the cost of the routing GitHub does;
  a fleet with a few kinds of special hardware has a few extra Profiles. The pinned and unpinned
  Profiles share the pinned Workers' slots: an unpinned Profile still schedules onto a GPU Worker.
  Pin the unpinned Profile too, to a label only the other Workers carry, to keep it off.
- Removing a label from a Worker stops new placements for the pinned Profile at once. A Runner
  that is starting or idle there is registered with GitHub and could still be handed the Profile's
  next job, so it is cancelled and its registration deleted, as a scale-down does; the controller
  creates a replacement, which is placed on a labelled Worker. An Attempt placed there but not yet
  claimed goes back to the queue. Running jobs finish where they are. A pin added to a Profile that
  already has Runners does the same on every Worker without the labels. The Worker stops seeing the
  Profile on its next discovery update and removes what it prepared for it, as it does when a
  Profile is paused.
- Profiles registered before the field have no pin and behave exactly as before. No migration.
