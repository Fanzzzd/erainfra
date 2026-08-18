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

The probe reports four variables across four tiers:

| tier | where the value comes from                    | who could write it                                               |
| ---- | --------------------------------------------- | ---------------------------------------------------------------- |
| T0   | the container environment (`/proc/1/environ`) | `apps/action-runner-agent`, when it composes the per-Attempt env |
| T1   | a step with no override                       | the runner, from the job message                                 |
| T2   | a step-level `env:` block                     | a workflow author                                                |
| T3   | `$GITHUB_ENV`, written by an earlier step     | a runner job-started hook                                        |

T0 and T3 are the two that decide a design rather than a preference. T0 is the
only tier that exists **before** the runner starts, and T3 is the only one that
exists **after** a job has been bound to a repository — which matters because a
scale-set Attempt is created before GitHub assigns it any job at all
(`packages/backend/convex/schema.ts`, the `attempts` table), so a token minted
from `JobStarted` facts has no container environment left to be written into.

Each measured tier points `ACTIONS_CACHE_URL` and `ACTIONS_RESULTS_URL` at a
local capture endpoint under a distinct path prefix, and a real
`actions/cache` v6.1.0 — the release the stage-A capture drove — is run against
it. A tier survived if a step saw the probe's own URL; a client honoured it if
a request with that prefix reaches the capture log. Those are two different
claims and the verdict reports them separately, because they can disagree:

- **The tier claim** is read out of the step's own environment. It settles what
  a client _would_ see and needs no client at all.
- **The client claim** has three outcomes, not two. Both client steps are
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
- `tiers.sh` — reads the four variables out of one environment and renders them.
  `ACTIONS_RUNTIME_TOKEN` is rendered by presence and length only.
- `verdict.sh` — turns the tier snapshots and the capture log into the Markdown
  that lands in the job summary.
- `probe.test.sh` — the self-test CI runs on every pull request. The workflow is
  dispatched by hand against a live Profile, so without this a probe that had
  quietly stopped measuring anything would be indistinguishable from one that
  simply had not been dispatched yet.

### Running it

`gh workflow run "EraInfra cache environment probe"`, or the Actions tab. The
`cache_service_v2` input is the value tiers T2 and T3 set for
`ACTIONS_CACHE_SERVICE_V2`, so both generations can be asked for on separate
runs.
