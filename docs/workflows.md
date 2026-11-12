# Use Profiles in workflows

How a workflow targets a Profile, how to move a repository's workflows onto Profiles, how to fall
back to GitHub-hosted runners, and how to run a one-off command on a Profile.

## Target a Profile from GitHub Actions

No router job, machine name, or `.runner-center-migration-meta` file is required:

```yaml
jobs:
  test:
    runs-on: erainfra-4vcpu-ubuntu-2404
    steps:
      - uses: actions/checkout@<commit-sha>
      - uses: pnpm/action-setup@<commit-sha>
      - uses: actions/setup-node@<commit-sha>
        with:
          node-version: 22
          cache: false
      - run: pnpm install --frozen-lockfile
      - run: pnpm test
```

Node is already in the Image Release's toolcache, so `setup-node` validates/selects it without a
network download. `actions/cache` and the `cache:` input of the setup actions work unchanged: on a
Firecracker Worker with [the job cache](job-cache.md) turned on, EraInfra's cache service answers
them, and everywhere else GitHub's cache does, counted against the repository's Actions storage.
With the job cache on, `turbo run` also caches in EraInfra's cache service with no change, and Go
does with `GOCACHEPROG: erainfra-gocacheprog`
([build-system caches](runbooks/operate-the-job-cache.md#10-build-system-caches-turborepo-and-go)).
Another remote build cache works over allowed egress. Any cache can still be slower than
a warm immutable image, so prefer prewarming the Image Release for anything that changes rarely.
A Profile on allowlist egress needs every cache endpoint a job uses on its list:
`RC_EGRESS_PRESETS=github` covers `actions/cache`, and EraInfra's own cache service is allowed
automatically.

## Move a repository's workflows onto Profiles

`erainfra migrate runs-on` does the label change for a whole repository, the way Blacksmith's
Migration Wizard does it for theirs. Run it in the repository:

```bash
erainfra migrate runs-on                       # print a unified diff, change nothing
erainfra migrate runs-on --write               # apply it
erainfra migrate runs-on --repo ../web --map ubuntu-latest=erainfra-8vcpu-ubuntu-2404 --json
```

It reads `.github/workflows/*.yml` and `*.yaml` and replaces only the text of each label, so
comments, quoting and layout stay as they were and the diff applies with `git apply`. Each
GitHub-hosted label (`ubuntu-latest`, `ubuntu-24.04-arm`, `windows-2025`, `macos-15`, ...) goes to
the active Profile with the same OS, version and architecture: the smallest with at least 4 vCPU,
which is GitHub's standard runner, and the newest version for a `-latest` label. A Blacksmith or
BuildJet label keeps its size (`blacksmith-8vcpu-ubuntu-2404` becomes
`erainfra-8vcpu-ubuntu-2404`), and `rc-linux-js` and `rc-e2e` move to their
[ADR 0010](adr/0010-name-profiles-the-way-runner-vendors-name-labels.md) names once those
are registered. When the CLI is logged in, it proposes only Profiles registered in the control
plane. Logged out, or with `--offline`, it builds names from ADR 0010's scheme without checking
them. If it is logged in and the control plane cannot be read, it stops rather than guess. `--map
<label>=<profile>`, repeatable, wins over every default.

It changes `runs-on` written as a string, a one-item list, or the `labels` of a `group`/`labels`
mapping. In a reusable workflow whose `runs-on` is an input, it changes that input's default and
the `with:` value of each call in the repository, as long as the workflow reads the input only as
its `runs-on` label (`${{ inputs.runner }}`, or `${{ inputs.runner || 'ubuntu-latest' }}`). If
anything else in the workflow reads it, such as an `if:`, an `env:` value, a script, a cache key
or a `with:` to another workflow, renaming the label would change what that sees, so the default
and the calls stay as they are and an `input-shared` note names the first such read. In a [router job](#fall-back-to-github-hosted-runners),
it renames the Profile the router asks about (a `PROFILE` variable or a `profile=` query) and
leaves the router's own `runs-on`, which has to stay GitHub-hosted. A router job is one that
declares `outputs:` and has a step calling the `/runs-on` endpoint with `profile=` or `labels=`;
a script that only mentions a path such as `.github/runs-on.yml` is an ordinary job. It leaves the
rest unchanged and prints a note for each one, on stderr, or under `notes` with `--json`: matrix
and other expressions (the note lists what each matrix value would become), lists of several
labels, which no scale set matches, a runner group with no labels, YAML aliases, Intel macOS and
larger-runner labels, and labels it does not know. A `runs-on` label that carries a YAML anchor
is rewritten when only other jobs' `runs-on` alias it, and those jobs move with it. When an `env:`
value or anything else also reads the anchor, the label is left unchanged with a note, because
rewriting it would change that value too.

Before it prints or writes a file, the command parses the rewritten file again and compares it
with the original, node by node with aliases expanded. Every value must be the same except the
labels it reported as changed. If anything else differs, it changes nothing in that file and
prints a `verify` note. It skips UTF-16 files and files that are not valid YAML, with a note.

## Fall back to GitHub-hosted runners

GitHub has no runner fallback of its own: a job queued on a Profile label waits for that Profile,
and GitHub cancels a queued self-hosted job only after 24 hours. The control plane answers the
question a workflow needs instead. `GET /runs-on?profile=<name>&fallback=<label>` on the
deployment's site URL returns `{"runs-on": "<name>"}` when a job sent to the Profile now would
start without waiting, and `{"runs-on": "<label>"}` otherwise. A Profile has room when it is
active, a controller holds its lease (so a listener takes the job from GitHub), at least one Worker
is ready for it, its live Attempts are below `maxRunners`, and either
one of its `minRunners` warm Runners is idle or the scheduler would place one more Attempt on a
ready Worker behind everything already queued. Readiness, slots, CPU, memory, disk and warm-pool
rules are the scheduler's own. An unknown or paused Profile, no controller, no ready Worker, or a full Profile all
answer the fallback, which defaults to `ubuntu-latest` (`macos-latest` for Tart, `windows-latest` for
Hyper-V).

A small router job at the top of the workflow asks once and every other job reads its answer:

```yaml
jobs:
  route:
    runs-on: ubuntu-latest
    timeout-minutes: 2
    outputs:
      runs-on: ${{ steps.route.outputs.runs-on }}
    steps:
      - id: route
        env:
          CONTROL_PLANE: https://<deployment>.convex.site
          PROFILE: erainfra-4vcpu-ubuntu-2404
          FALLBACK: ubuntu-24.04
        run: |
          # Any failure (control plane down, timeout, unexpected body) routes to FALLBACK.
          label=$(curl --fail --silent --show-error --max-time 10 --retry 2 --get \
            --data-urlencode "profile=$PROFILE" --data-urlencode "fallback=$FALLBACK" \
            --data-urlencode "repo=$GITHUB_REPOSITORY" \
            "$CONTROL_PLANE/runs-on" | jq -er '."runs-on" | strings') || label=$FALLBACK
          echo "routing to $label"
          echo "runs-on=$label" >> "$GITHUB_OUTPUT"

  test:
    needs: route
    runs-on: ${{ needs.route.outputs.runs-on }}
    steps:
      - uses: actions/checkout@<commit-sha>
      - run: pnpm test
```

The endpoint takes no credential, on purpose. Pull requests from forks get no secrets, so an
authenticated probe would fail exactly where routing matters, or need a token committed to the
workflow. It returns only the Profile's name or the caller's own fallback label, so an anonymous
caller learns whether that Profile has room right now and nothing else; the reason for a fallback
goes to the deployment's log. It makes no GitHub API call, so callers cannot spend the GitHub
App's rate limit, and it reads only indexed rows bounded by live work and Worker count. It
rejects labels outside `[A-Za-z0-9._-]` (up to 100 characters) rather than echo them.

The control plane stores each answer as a row in `routerDecisions`: the Profile (or labels), the
returned label, the route (`profile` or `fallback`) and the fallback reason (`unknown-profile`,
`paused`, `no-ready-worker` or `saturated`). Add `repo=OWNER/NAME` to the query to store the
repository with it, as the router step above does. The parameter is optional and does not change the answer; a value that is not
`OWNER/NAME` gets a 400. Rows are kept 90 days. `internal.routerDecisions.counts` counts them per
UTC day, route and reason for a repository and time range, for billing reconciliation.

The answer covers one job. Jobs that share it, such as a matrix, all go to the Profile on a "yes"
even when only one slot was free; the rest queue there. The router itself runs on a GitHub-hosted
runner, a few seconds per workflow run.

The older form `/runs-on?labels=rc-linux` still answers for the pre-Profile webhook path, from that
path's machine slots. It knows nothing of Profiles.

Agree on a queue limit with whoever operates the Profile. Before an operation takes a Profile's
only Worker away for longer than that limit, the operator follows
[docs/runbooks/take-the-only-worker-away.md](runbooks/take-the-only-worker-away.md).

### When a Worker drops after routing

The router decides once, when the workflow starts. A job waiting for a Worker that stops reporting
moves to another ready Worker of the same Profile. If the Profile has no ready Worker left, the job
waits in GitHub's queue until GitHub cancels it after 24 hours. GitHub-hosted runners and Blacksmith
do not strand a job this way.

Stranded job recovery handles that case. A job is stranded when it has not started, has waited
longer than `ERAINFRA_STRANDED_JOB_AFTER_MINUTES` (default 5, from 1 to 1440), and its Profile has
no Worker that passes the router's readiness check. `ERAINFRA_STRANDED_JOB_ACTION` on the
deployment chooses what happens:

| value            | what the control plane does                                                           |
| ---------------- | ------------------------------------------------------------------------------------- |
| `wait` (default) | nothing; the job waits as before                                                      |
| `cancel`         | cancels the workflow run, so it fails within minutes                                  |
| `rerun`          | cancels the run, waits up to 5 minutes for it to finish, then asks GitHub to rerun it |

One waiting Attempt of the Profile records the cause, for example "No ready Worker for
erainfra-4vcpu-ubuntu-2404 within 5 minutes; cancelled the run and asked GitHub to rerun it". The
dashboard and `erainfra jobs view` show it with a link to GitHub's
[re-run documentation](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/re-run-workflows-and-jobs).

Limits:

- A rerun repeats the whole workflow, including jobs that had already passed. GitHub can rerun only
  a completed run, and a cancelled run's failed jobs include every job the cancel stopped.
- `rerun` helps only a workflow with a router job. The rerun asks the router again, which now
  answers the fallback. A workflow that names the Profile label directly queues on it again.
- The control plane reruns a run at most once. If the rerun's jobs strand again, it only cancels
  the run.
- Both actions need the controller's GitHub App to hold Repository: Actions, Read and write, on
  every repository whose jobs the Profile serves. The App's key must be in the deployment
  (`CONTROLLER_GITHUB_APP_CLIENT_ID` and `CONTROLLER_GITHUB_APP_PRIVATE_KEY`). Without the
  permission, GitHub refuses the cancel, the deployment log says the App lacks Actions write, and
  the job waits as it would under `wait`.
- The controller reports each job it acquires so the control plane knows the job's workflow run.
  A controller older than this release does not, and its jobs always wait.

## Experiments

The **Experiments** page runs a shell command in the selected Linux Profile. An Experiment:

- copies the current immutable Profile contract at creation;
- waits in the same fair queue and reserves the same CPU/memory/slot capacity as CI;
- executes as the unprivileged `runner` user in a fresh Firecracker microVM;
- has a 1–21,600 second timeout and is cancellable;
- records Worker, timestamps, exit code, and failure reason;
- is reconciled after Worker loss and cannot keep a slot stuck indefinitely.

This is intentionally non-interactive. Interactive workspaces need a separate image and audited
control channel; weakening the CI image with SSH would make both products less safe. The current
Experiment image grants the `runner` user passwordless sudo, so Experiment authors are trusted with
root inside their disposable guest. The same image under the shared-kernel Docker executor is only
for mutually trusted jobs in one trust domain; use Firecracker for untrusted workloads.
