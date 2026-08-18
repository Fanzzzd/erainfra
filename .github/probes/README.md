# Probes

Instruments, not implementations. Everything here exists to answer a question
about the live fleet that cannot be answered by reading code, and nothing here
is deployed or imported by anything that ships.

## `cache-env-probe.yml` — which environment does a real step get?

ADR 0007 lists this as unmeasured and as a prerequisite for stage C:

> Whether a value EraInfra sets for `ACTIONS_CACHE_SERVICE_V2` survives the
> runner's own injection. The string table proves the runner writes that
> variable from the job message; it says nothing about what happens to a value
> already present in the process environment.

Stage A answered everything it could from a capture against a stand-in and from
the shipped `Runner.Worker.dll`'s string table. Neither can answer this one:
the mapping's existence in the binary says nothing about precedence, and a
stand-in has no runner in front of it. The only honest instrument is a real
Attempt on a real Profile, which is why the workflow runs on `rc-e2e` — the one
scale set measured to pick work up on this repository.

## What the first live run found, and why there is a second iteration

Run `32108617455` on `rc-e2e` reported:

- **T0 and T1 empty.** None of the four variables was set, in the container or
  in a `run:` step.
- **T2 and T3 both survived** — in a `run:` step.
- **`actions/cache` v6.1.0 printed `Cache not found` and sent the probe zero
  requests.**

Read on its own that says the fleet injects nothing, so there is nothing for an
EraInfra value to collide with. It cannot say that, because the same Profile
contradicts it: `actions/upload-artifact` uploads from `rc-e2e`
(conformance run `32106186241`, artifact ID 9313227775, downloaded and diffed
by the next job), and it cannot upload anything without `ACTIONS_RESULTS_URL`
and `ACTIONS_RUNTIME_TOKEN`. **The credentials exist. A script step does not see
them.**

That reframes all three findings, because the probe was asking the wrong
process. Every real cache client — `actions/cache`, `actions/setup-node`,
`actions/setup-go` — is a **JavaScript action** step, and the first iteration
never measured one. The leading explanation for the silent client is no longer
"a missing runtime token disabled it" but "the runner injected its own URLs over
the step `env:` block, so it did a real lookup against GitHub and got a real
miss" — which fits every observation with no new hypothesis.

Neither is proven. This iteration measures instead of choosing:

- Every overriding tier is read **twice**, from a script step and from a
  JavaScript action step (`env-action/`), so the two environments are in one
  table.
- Every client run happens **twice**, once with no runtime token and once with a
  dummy one, so "the client disabled itself for want of a credential" stops
  being a hypothesis.
- A separate `artifacts` job round-trips a real artifact on the same Profile, so
  every run carries its own proof that the runtime credentials work — and nobody
  has to read another workflow's history to notice.

## Tiers

| tier | where the value comes from                    | who could write it                                               |
| ---- | --------------------------------------------- | ---------------------------------------------------------------- |
| T0   | the container environment (`/proc/1/environ`) | `apps/action-runner-agent`, when it composes the per-Attempt env |
| T1   | no override at all                            | the runner, from the job message                                 |
| T2   | a step-level `env:` block                     | a workflow author                                                |
| T3   | `$GITHUB_ENV`, written by an earlier step     | a runner job-started hook                                        |

T1, T2 and T3 are each read from a script step and from an action step. T0 is
read once, from the container, and is the one tier this workflow **cannot** set
for itself: nothing in a workflow reaches `docker run`. Until the agent seam
ships and an operator points `ERAINFRA_CACHE_URL` at something, T0 says only
what the container was given, which today is nothing.

T0 and T3 are the two that decide a design rather than a preference, and the
reason is an ordering fact this repository already records in
`packages/backend/convex/schema.ts`:

> Unlike the legacy `jobs` table, an Attempt exists before GitHub assigns a
> concrete job: the official listener asks for capacity, EraInfra prepares one
> ephemeral runner, and a later JobStarted message binds the GitHub metadata to
> it by runnerName.

T0 is the only tier that exists **before** the runner starts. T3 is the only
tier that exists **after** a job has been bound to a repository — so it is the
only delivery route available to a token minted from `JobStarted` facts, which
is what `cachetoken`'s own package comment assumes the issuer does. If T3 loses
in an action step, that seam needs a different mechanism than the one currently
written down.

Each overriding tier points `ACTIONS_CACHE_URL` and `ACTIONS_RESULTS_URL` at a
local capture endpoint under its own path prefix, and a real `actions/cache`
v6.1.0 — the release the stage-A capture drove — is run against it. A tier
survived if a step saw the probe's own URL; a client honoured it if a request
with that prefix reaches the capture log. Those are two different claims and the
verdict reports them separately, because they can disagree:

- **The tier claim** is read out of the step's own environment. It settles what
  a client _would_ see and needs no client at all.
- **The client claim** has three outcomes, not two. Every client step is
  `continue-on-error`, so an empty capture log means the client went elsewhere
  **only if it ran**. A client step that never completed — a failed action
  download, a client that refused the environment — proves nothing about the
  environment, and the verdict says `INCONCLUSIVE` rather than turning it into
  a measurement. The step outcome is recorded for exactly this distinction.

### What never reaches the log

The capture log is printed into a job summary, so two things in a cache request
are treated as secrets:

- **the bearer credential** — a client sends the runner's own
  `ACTIONS_RUNTIME_TOKEN`; its presence and length are recorded and its value
  never leaves the process.
- **the cache key** — v1 carries it in the `keys=` query parameter and v2 in the
  request body, and a key is routinely a lockfile hash, a branch name or a path
  out of a private repository. The query string is dropped before anything is
  written and the body is drained without being read, so only the pathname is
  recorded — which is where the tier prefix and the generation marker live.
  Whether there _was_ a query is still recorded, because "a restore arrived
  carrying keys" is evidence and the keys are not.

`probe.test.sh` sends a distinctive sentinel through each route and fails if
either reaches the log.

A negative result is a result. The verdict never fails the job for one, because
a probe that goes red on the answer nobody wants is a probe that stops being
run.

### Files

- `cache-capture-server.mjs` — the endpoint. Answers the miss shapes the capture
  measured (v1 `204`, v2 `200 {"ok":false}`), records one JSON line per request,
  and never records a credential's value.
- `tiers.sh` — reads the four variables out of a script step's environment and
  renders them. `ACTIONS_RUNTIME_TOKEN` is rendered by presence and length only.
- `env-action/` — a JavaScript action that renders the same four variables from
  an **action** step's environment, which is the environment every real cache
  client runs in. The rendering rules are duplicated from `tiers.sh` because one
  is shell and the other is Node and there is no third place both can read;
  `probe.test.sh` runs both against the same environment and fails if they
  disagree.
- `artifact-control.sh` — renders the `artifacts` job's report: what an action
  step is given with nothing overridden, and whether a real artifact round trip
  completes on that Profile.
- `verdict.sh` — turns the tier snapshots and the capture log into the Markdown
  that lands in the job summary.
- `probe.test.sh` — the self-test CI runs on every pull request. The workflow is
  dispatched by hand against a live Profile, so without this a probe that had
  quietly stopped measuring anything would be indistinguishable from one that
  simply had not been dispatched yet.

### Running it

`gh workflow run cache-env-probe.yml -f cache_service_v2=true` (or `false`), or
the Actions tab. That input is the value the overriding tiers set for
`ACTIONS_CACHE_SERVICE_V2`, so both generations can be asked for on separate
runs — the answers are allowed to differ, and if they do that is the finding.
