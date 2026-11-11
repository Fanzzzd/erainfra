# Job metrics, test results and exit reasons

What EraInfra records about each Attempt beyond its result: resource charts, Profile size
recommendations, JUnit test results, and why a runner exited without a job.

## Job metrics

Every Linux Attempt gets a CPU, memory, network and disk chart. The **Runs** page shows each run's
summary (for example `peak 11.2/16 GiB · cpu p95 3.6/4`, and any OOM kills); the summary links to the
Attempt page with the charts, the totals and a table of every point.

The Worker measures the boundary from the host and never asks the job:

| Executor    | Source                                                                           | CPU                                   | Memory                                                                          | Network                                                               | Disk                                                   | OOM kills                                                       |
| ----------- | -------------------------------------------------------------------------------- | ------------------------------------- | ------------------------------------------------------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------ | --------------------------------------------------------------- |
| Firecracker | the VMM process, read by the privileged runtime                                  | `utime + stime` in `/proc/<pid>/stat` | `VmRSS`, peak from `VmHWM`                                                      | the VM's tap, through `/proc/<pid>/net/dev`                           | `read_bytes` / `write_bytes` in `/proc/<pid>/io`       | kernel OOM lines on the serial console                          |
| Docker      | the container's cgroup, read by `runner-center-runtime sample` as the Agent user | `cpu.stat` (v2), `cpuacct.usage` (v1) | `memory.current` (v2) or `memory.usage_in_bytes` (v1), less inactive page cache | the container's interfaces except `lo`, through `/proc/<pid>/net/dev` | `io.stat` (v2), `blkio.throttle.io_service_bytes` (v1) | `oom_kill` in `memory.events` (v2) or `memory.oom_control` (v1) |

Tart and Hyper-V Attempts are not measured.

Things to know when reading the charts:

- **Firecracker memory is what the host has backed for the guest.** A guest that touched 12 GiB
  once, page cache included, keeps 12 GiB resident even after it frees it, because nothing balloons
  memory back. The chart answers "how much of the Worker did this job take", which is close to, but
  not the same as, what the guest's own `free` reports.
- **Docker memory is the working set**, the number `docker stats` and Kubernetes report: charged
  memory less inactive page cache, which the kernel reclaims before it OOM-kills anything.
- **The Firecracker OOM count is the one number the guest writes.** The host captures the serial
  console, but the guest kernel prints the line. It covers the guest running dry and a memory cgroup
  inside the job hitting its own limit. A job that forges the line misleads only its own page.
- **Cgroup v1 disk writes are low.** v1 charges buffered writes to the kernel thread that flushes
  them, not the container; reads and direct I/O are exact. cgroup v2 charges both correctly.
- **CPU p95 is over bucket averages.** A burst shorter than one bucket is averaged into it, which
  is why the busiest single sample interval is shown beside it as the maximum. All CPU numbers are
  vCPUs in use against the vCPUs the Profile allots.

How the data moves, and what bounds it:

1. A reading every 5 seconds: a few small procfs or cgroupfs files, no `docker stats`.
2. A bounded series of at most 360 points per Attempt, whatever its length. Buckets start at 5
   seconds and double, with adjacent pairs merged, each time the Attempt outlives 360 of them: a
   10-minute job keeps 5-second points, a 6-hour job ends with 80-second ones. CPU time, traffic and
   disk bytes add up when buckets merge, memory keeps its maximum, and the busiest sample interval
   survives.
3. Every 30 seconds while the series grows, and once when the executor exits, the Agent uploads the
   whole snapshot with `workerApi:reportAttemptMetrics`, authenticated by the Worker's machine token.
   A snapshot is complete, so the upload is idempotent: the control plane keeps the one with the
   most samples, ignores replays and late duplicates, and accepts nothing after the final one or
   later than 15 minutes after the Attempt settled.
4. The control plane stores the series in `attemptMetrics` and its summary in
   `attemptMetricSummaries`, refuses anything over the bounds (360 points per column, non-negative
   integers, offsets on the bucket grid), and an hourly cron deletes both 14 days after the last
   upload.

Measurement never touches the job. The sampler only reads; at most one upload is in flight and only
the newest waiting snapshot is kept behind it; the final collection and upload are bounded and run
beside `reportAttempt`, never in front of it; and a sampler or upload failure is logged once and
costs the chart, not the Attempt.

## Right-size recommendations

The **Rightsize** page and `erainfra rightsize` use these metrics to say which Profile each workflow
job should run on. For every repository, job name and Profile seen in the window (default and
maximum 14 days, the metrics retention), they compare the job's CPU p95 and memory peak with the
Profile and give one of four verdicts: larger, smaller, right size, or not enough data. A
recommendation names a registered, active Profile of the same family (same executor; same OS,
architecture, flavour and canary-ness for [ADR 0010](adr/0010-name-profiles-the-way-runner-vendors-name-labels.md)
names, or the same image for older names). When none fits, it names the Profile to register, for
example `erainfra-8vcpu-ubuntu-2404`. Every recommendation carries a sentence saying why.

The policy leaves a job alone unless the evidence is clear:

- A verdict needs five qualifying Attempts. An Attempt qualifies when its final snapshot arrived, it
  was measured for at least 30 seconds, and no more than 10% of its readings failed.
- CPU p95 across Attempts is the nearest-rank p95 of each Attempt's own p95, so with fewer than 20
  Attempts it is the busiest one.
- Smaller: the Profile must keep that p95 at or under 70% of its vCPUs and hold the memory peak with
  30% to spare. Without an OOM kill or memory pressure the current memory counts as enough, so a
  job can drop vCPUs and keep its memory.
- Larger on CPU: the median Attempt's p95 is at 90% or more of the Profile. The gap between 70% and
  90% keeps a recommendation from flipping back in the next window.
- Larger on memory: any OOM kill, or, on Docker, a working set at 90% or more of the limit. A job
  with an OOM kill is never offered less memory. Firecracker memory is the VM's host-resident
  memory, which fills with page cache, so on Firecracker only an OOM kill asks for more; the peak
  still bounds a move down from above.

Nothing is stored. The report reads at most the newest 2,000 metric summaries in the window and
says so (`truncated`) when there were more. With `--repo` (or `repo=`) it reads only that
repository's finished Attempts, by an index on the repository name, so a busy repository never
crowds a quiet one out of the 2,000. Write the repository as GitHub spells it or in lower case,
with or without the owner. The dashboard reads it on opening and on **Refresh**
rather than live, because live Attempts rewrite their summaries every 30 seconds.

`erainfra rightsize --map` prints only the recommendations that name a registered Profile, as the
`runs-on` rewrite a migration tool can apply. The keys are the repository, the job's name as GitHub
shows it, and the current Profile:

```json
{
  "acme/web": {
    "test": { "erainfra-4vcpu-ubuntu-2404": "erainfra-8vcpu-ubuntu-2404" },
    "lint": { "erainfra-4vcpu-ubuntu-2404": "erainfra-2vcpu-ubuntu-2404" }
  }
}
```

The same object is the `map` field of `GET /api/v1/rightsize` and of `erainfra rightsize --json`.

## Test results

If a job writes JUnit XML into its workspace, the **Tests** page shows it: the runs with failures and
the tests that failed in each, the tests that are flaky, and the slowest tests across recent runs.
Each Attempt page lists that run's failed, errored and flaky tests and its slowest passes.
`erainfra tests list` and `erainfra tests flaky` read the same data. Nothing in the workflow
changes; the job only has to write the file.

The collector looks in each workspace (`/home/runner/work/<repository>/<repository>`, the
GitHub-hosted runner's layout) for these paths, which
cover jest-junit, Vitest's `junit` reporter, pytest's `--junitxml`, gotestsum's `--junitfile`,
Maven Surefire and Failsafe, and Gradle:

```text
**/junit*.xml   **/TEST-*.xml   **/test-results/**/*.xml   **/test-reports/**/*.xml
**/*.junit.xml  **/surefire-reports/*.xml   **/failsafe-reports/*.xml
```

A repository adds its own paths in `.github/erainfra-test-reports`, one glob per line relative to
the workspace, `#` for comments. They add to the defaults. A matching file whose root element is not
`<testsuites>` or `<testsuite>` is skipped. `.git`, `node_modules`, `testdata`, `__fixtures__`,
`vendor`, `.venv`, `.pnpm-store`, `.gradle` and `.m2` are never searched, because the JUnit files in
them belong to dependencies or fixtures, not to this run.

```text
# .github/erainfra-test-reports
build/reports/*.xml
packages/*/results/**/*.xml
```

What counts as what:

- **A test** is identified by its suite (the `classname`, or the enclosing `<testsuite>` when the
  classname is empty or repeats the name, as jest-junit writes it) and its name.
- **Failed** and **errored** follow JUnit's `<failure>` and `<error>`. A test listed more than once
  in a run takes its worst outcome.
- **Flaky** has two kinds of evidence. Within one run, the test runner retried a test into a pass:
  Surefire's `<flakyFailure>`, or a test listed as failed and then passed, which is how gotestsum
  `--rerun-fails` writes it. Across runs, the test failed in one Attempt and passed in another of the
  same job on the same code. The job is GitHub's job name, which includes the matrix values
  (`test (ubuntu, 18)`), so a test that always fails on one matrix leg and passes on another is
  a real difference between the legs, not a flaky test. Attempts of one workflow run are always the
  same code: GitHub reruns a run at its original commit and ref. Attempts of different runs count
  as the same code only when both were a `push`, `schedule`, `workflow_dispatch` or `merge_group`
  run on the same branch and their workspaces' `.git` named the same commit. The event comes from
  GitHub's job message to the controller. The branch is the workflow run's `head_branch`, which the
  controller reads from GitHub's REST API with the same lookup it makes for the
  [job cache](job-cache.md) scope. The job message's workflow ref cannot stand in for it, because
  for a job of a called workflow it names the called file's ref. A controller that does not read
  workflow runs (no `RC_CACHE_FACTS_URL`, or a version before this one) records no branch, and its
  Attempts are compared only within their own workflow run. The commit is the job's own claim, so
  it never joins runs on its own: a pull request, or any other job, that writes main's commit into
  its `.git` is compared only with its own workflow run and cannot make main's tests look flaky.
  Flaky tests are found when a report arrives, against at most 20 earlier reports of the same code,
  and one report marks at most 500.
- **Slowest** is built from the 50 slowest passing tests each run keeps, grouped by test and ordered
  by mean duration.

Where it runs, and what bounds it:

1. After the runner exits, `runner-center-guest` (root, inside the microVM) walks the workspaces and
   parses the files. The job sees no extra step and cannot skip it. The walk stops at 200,000
   entries, 200 files, 16 MiB per file, 128 MiB in total and 20 seconds, and never follows a symbolic
   link or opens anything that is not a regular file. Matching a path against a glob takes time
   proportional to the pattern's segments times the path's depth, however many `**` the pattern
   has, and it stops when the 20 seconds are up. The report counts every test and lists up to
   500 cases (every failed, errored and flaky one first, then the 50 slowest passes, with messages
   cut to 1 KiB). It also carries a 12-character SHA-256 prefix of every passing test's id, up to
   20,000, which is what lets a later run of the same commit say "this passed before".
2. The guest writes the report to its serial console as gzip and base64 in numbered lines, at most
   512 KiB, the channel the Experiment result already takes. The runtime reads the console after the
   VM exits, checks every bound again, cuts the report to 1 MiB of JSON if it must, and hands it to
   the Agent beside the egress record.
3. The Agent sends it with `workerApi:reportAttemptTests` after `reportAttempt`, so a refused or
   failed upload never touches the Attempt's own result. The control plane checks the bounds a third
   time, refuses control characters, keeps the first report per Attempt, accepts none later than 15
   minutes after the Attempt settled, and deletes reports, and flaky rows not seen since, after 30
   days. The passing-test hashes are stored beside each report rather than in it, and the hourly
   purge deletes at most 1,000 cases per transaction and schedules itself again until it is done,
   so every read and write stays inside Convex's per-transaction limits at the largest report.

The XML is the job's own output and is treated as hostile. Go's `encoding/xml` resolves no external
entity and fetches no DTD, refuses any entity it does not define (so neither XXE nor entity expansion
works), and refuses encodings other than UTF-8; nesting deeper than 64 elements fails the file. Names
and messages lose control characters before they leave the guest, the dashboard renders them only as
text, and the CLI prints them with control characters replaced.

Only the Firecracker executor collects test results. A Docker Attempt's container is removed with
`--rm` when the runner exits, so its workspace is gone before anything could read it; Tart and
Hyper-V are not covered. An Attempt on an Image Release older than the collector reports none.

## Why a runner exited

A Firecracker guest resets cleanly whatever its runner did, so the executor's exit code cannot
tell a finished job from a runner GitHub refused at session start. After the runner exits, and
after the test report, `runner-center-guest` writes one more console line: run.sh's exit status
(128 plus the signal if one ended it), whether the runner ran a job (a `Worker_*.log` in
`/opt/runner/_diag`), and the last `ERR` line of the newest `Runner_*.log`. The guest drops control
characters, redacts any run of 40 or more token-alphabet characters, and cuts the line to 300
bytes. The runtime validates it again, logs it in its journal, and hands it to the Agent, which
logs it in its own log and sends it with `reportAttempt`.

An Attempt whose runner exited without a job, with no JobStarted from GitHub and no job seen by the
guest, ends `failed` with an error such as `GitHub runner exited with code 1 without taking a job:
Runner version v2.336.0 is deprecated and cannot receive messages.` That error is what
`erainfra jobs view` shows as the last error, what the dashboard shows on the Attempt, and how the
failure-rate and consecutive-failure alerts end their summary. Its Runner registration is deleted
by the controller.

A guest image older than this report writes no line, and its Attempt ends as before: `completed`,
with its Runner still deleted when it never took a job. A runtime older than the report leaves the
line in the console log unread. Docker, Tart and Hyper-V Attempts send no report.
