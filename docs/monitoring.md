# Monitor the fleet

The control plane exports fleet state to Prometheus and evaluates its own alert rules. Both are
configured on the dashboard's **Settings** page (the gear in the rail).

## Prometheus metrics

`GET https://<deployment>.convex.site/metrics` serves the Prometheus text format (version 0.0.4).
It needs a bearer token: create a `metrics` token under Settings, Metrics (or Settings, API tokens),
which can scrape and do nothing else. A `read` or `admin` token also scrapes. The token is shown once
and only its SHA-256 is stored. Several tokens can be live at once, so rotate by creating a new
token, reloading Prometheus, and revoking the old one under Settings, API tokens. A revoked or
unknown token gets 401 with no reason.

```yaml
scrape_configs:
  - job_name: erainfra
    scrape_interval: 30s
    scheme: https
    metrics_path: /metrics
    authorization:
      type: Bearer
      credentials_file: /etc/prometheus/erainfra-metrics-token
    static_configs:
      - targets: ["<deployment>.convex.site"]
```

A token rather than a `METRICS_TOKEN` environment variable: an env var takes deploy credentials
to change, allows one value at a time (so rotation has a scrape gap), and sits in the deployment
in plaintext. A minted token can be revoked by any operator from the dashboard.

Every metric is a gauge. The endpoint keeps no process state: each scrape is computed from stored
rows, and finished Attempts are read through a one-hour window. A counter rebuilt from that window
would drop whenever an old Attempt left it, which `rate()` reads as a reset. So outcomes are counts
over the last hour and durations are quantiles over the same hour; use them directly, without
`rate()`. Labels come from small operator-owned sets. No series carries a repository, branch,
workflow, Runner or job id.

| Metric                                              | Labels                                 | Meaning                                                                                                                    |
| --------------------------------------------------- | -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `erainfra_profile_info`                             | `profile`, `executor`, `state`         | Always 1. Join it to add `executor` to any per-Profile series.                                                             |
| `erainfra_profile_runners_min` / `_max`             | `profile`                              | `minRunners` and `maxRunners`.                                                                                             |
| `erainfra_profile_workers`                          | `profile`, `state`                     | Workers by readiness (`preparing`, `ready`, `degraded`, `failed`). A ready report that fails admission counts as degraded. |
| `erainfra_profile_workers_schedulable`              | `profile`                              | Workers the scheduler would use now: ready, admitted, fresh, online. 0 when paused.                                        |
| `erainfra_profile_label_conflicts`                  | `profile`                              | Other active Profiles whose scale set shares labels with this one's. Nonzero only for a pair stored before 409s.           |
| `erainfra_attempts`                                 | `profile`, `state`                     | Live Attempts. `state="pending"` is the queue of unassigned Attempts.                                                      |
| `erainfra_attempt_queue_oldest_age_seconds`         | `profile`                              | Age of the oldest pending Attempt, 0 when the queue is empty.                                                              |
| `erainfra_recent_attempts_finished`                 | `profile`, `result`                    | Attempts finished in the last hour by `succeeded`, `failed`, `cancelled`, `unknown`.                                       |
| `erainfra_recent_attempt_queue_wait_seconds`        | `profile`, `quantile`                  | p50, p90, p99 and max (`quantile="1"`) of GitHub queue wait over the last hour.                                            |
| `erainfra_recent_attempt_run_duration_seconds`      | `profile`, `quantile`                  | The same quantiles of run time, JobStarted to finish.                                                                      |
| `erainfra_recent_attempts_sample_truncated`         | `profile`                              | 1 when the Profile ran more than 200 Attempts in the hour, so the window gauges cover the newest 200.                      |
| `erainfra_recent_window_seconds`                    |                                        | 3600.                                                                                                                      |
| `erainfra_machine_info`                             | `machine`, `os`, `arch`, `slot_policy` | Always 1.                                                                                                                  |
| `erainfra_machine_online`                           | `machine`                              | 1 when the Worker heartbeated in the last two minutes.                                                                     |
| `erainfra_machine_last_heartbeat_timestamp_seconds` | `machine`                              | Unix time of the last heartbeat. Absent before the first.                                                                  |
| `erainfra_machine_heartbeat_age_seconds`            | `machine`                              | Seconds since that heartbeat, at scrape time.                                                                              |
| `erainfra_machine_slots_configured`                 | `machine`                              | Operator-fixed slots. Absent under the auto policy.                                                                        |
| `erainfra_machine_slots_recommended`                | `machine`                              | Slots the resources and benchmark recommend.                                                                               |
| `erainfra_machine_slots_effective`                  | `machine`                              | Slots the scheduler fills.                                                                                                 |
| `erainfra_machine_slots_used`                       | `machine`                              | Slots in use.                                                                                                              |
| `erainfra_machine_benchmark_score`                  | `machine`, `dimension`                 | Benchmark score, 0 to 100, for `cpu`, `memory`, `disk`, `network`, `balanced`.                                             |
| `erainfra_machine_benchmark_timestamp_seconds`      | `machine`                              | When the benchmark ran. Older than seven days, the scheduler ignores it.                                                   |
| `erainfra_controller_up`                            | `profile`                              | 1 when a controller reported in the last 90 seconds and holds the GitHub session. Absent until the first heartbeat.        |
| `erainfra_controller_last_heartbeat_age_seconds`    | `profile`                              | Seconds since any of the Profile's controllers reported. Absent until the first heartbeat.                                 |
| `erainfra_profile_runner_release_cutoff_seconds`    | `profile`                              | Seconds until GitHub stops serving the actions/runner in the Profile's image; negative past it. See Alerts.                |
| `erainfra_node_online`                              | `node`                                 | 1 when the Node's Infra Agent heartbeated in `connect-convex` mode in the last two minutes. Absent for Hub-only Nodes.     |
| `erainfra_node_commands_blocked`                    | `node`, `reason`                       | 1 while the Node reports it cannot run commands (`journal_full`, `journal_error`, `command_api`, `command_error`), else 0. |
| `erainfra_node_commands_blocked_seconds`            | `node`, `reason`                       | Seconds since the Node first reported the block. Absent while it can run commands.                                         |
| `erainfra_node_journal_keys` / `_key_limit`         | `node`                                 | Keys in the Node's execution journal, and the limit at which it refuses new builds, deploys and operations.                |
| `erainfra_alerts_firing`                            | `rule`                                 | Firing incidents per enabled alert rule.                                                                                   |
| `erainfra_scrape_truncated`                         |                                        | 1 when a read cap (1,000 Profiles, Workers, readiness rows, or live Attempts per state) was reached.                       |

Cache hit rates are not here: the control plane does not see cache traffic. The cache service
logs it.

Example Prometheus alerting rules, if you prefer Alertmanager to the built-in alerts:

```yaml
groups:
  - name: erainfra
    rules:
      - alert: ErainfraProfileWithoutWorker
        expr: erainfra_profile_workers_schedulable == 0 and on (profile) erainfra_profile_info{state="active"} == 1
        for: 5m
      - alert: ErainfraQueueBacklog
        expr: erainfra_attempt_queue_oldest_age_seconds > 900
      - alert: ErainfraWorkerSilent
        expr: erainfra_machine_heartbeat_age_seconds > 300
      - alert: ErainfraControllerDown
        expr: erainfra_controller_up == 0 and on (profile) erainfra_profile_info{state="active"} == 1
        for: 3m
      - alert: ErainfraNodeOffline
        expr: erainfra_node_online == 0
        for: 3m
      - alert: ErainfraNodeCommandsBlocked
        expr: erainfra_node_commands_blocked_seconds > 600 and on (node) erainfra_node_online == 1
      - alert: ErainfraNodeJournalNearlyFull
        expr: erainfra_node_journal_keys > 0.9 * erainfra_node_journal_key_limit
```

## Alerts

Settings, Alerts holds rules, destinations and incidents. A cron evaluates every enabled rule each
minute against the same fleet state `/metrics` reads.

| Condition                           | Subject        | Fires when                                                                                                                         |
| ----------------------------------- | -------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Worker offline                      | Worker         | No heartbeat for N minutes (2 or more). A Worker that never connected is ignored.                                                  |
| Profile has no ready Worker         | Profile        | An active Profile has no schedulable Worker.                                                                                       |
| Worker readiness degraded or failed | Profile/Worker | A Worker reports degraded or failed readiness for an active Profile.                                                               |
| Profiles' scale-set labels overlap  | Profile        | An active Profile's scale set shares labels with another active Profile's, so GitHub can run either one's jobs on the other.       |
| Queue backlog                       | Profile        | The oldest pending Attempt has waited N minutes.                                                                                   |
| Attempt failure rate                | Profile        | At least P% of Attempts finished in the last W minutes failed, once M have finished. Cancelled Attempts count toward neither side. |
| Consecutive failed Attempts         | Profile        | The newest N finished Attempts (in the last 24 hours, cancellations skipped) all failed.                                           |
| Attempt running too long            | Profile        | An Attempt has been running for N minutes.                                                                                         |
| No controller listening             | Profile        | No controller has held an active Profile's GitHub session for N minutes (2 or more; 3 by default). See below.                      |
| Node unable to run commands         | Node           | A `connect-convex` Node has reported for N minutes that it cannot run commands. See below.                                         |
| Node offline                        | Node           | A `connect-convex` Node has sent no heartbeat for N minutes (2 or more; 5 by default). See below.                                  |
| actions/runner near GitHub's cutoff | Profile        | The image's actions/runner is within five days of GitHub's cutoff, or past it. See below.                                          |

A dead controller creates no Attempts, so without its own signal it looks like an idle Profile.
Every controller reports a heartbeat to the control plane every 30 seconds and whenever its session
state changes, and the **Controller** column on the Profiles table shows the result. A Profile no
controller has ever reported for shows _Not reporting_ and is never alerted on: controllers built
before the heartbeat send none, so the first heartbeat ever received for a Profile is what starts
tracking it. After that, a controller that stops reporting, stops cleanly, or keeps reporting
while GitHub refuses it the session counts as silent. A paused (retired) Profile is not alerted
on.

The two Node rules cover infrastructure Nodes on the Convex transport, which belong to no Profile,
so a Profile scope does not narrow them. **Node offline** watches a Node that has heartbeated at
least once; its floor of two minutes is the silence after which deploys and failover treat the
Node as gone. A Node whose credentials are all revoked (`erainfra nodes revoke`) is retired: it is
left out of both rules and of the `erainfra_node_*` metrics. A Node that stops heartbeating while
**Node unable to run commands** fires stays in breach, judged by how long it was blocked when its
heartbeats stopped, so the incident does not resolve because the Node died. It resolves when the
Node reports again without the block, or is retired.

**actions/runner near GitHub's cutoff** watches the runner pin described in
[How pins move](images.md#how-pins-move). Every Runner registers with automatic updates disabled, and GitHub stops queueing
jobs to such a runner 30 days after the next actions/runner release is published, at which point
the Runner registers, opens a session and exits a few seconds later with "Runner version vX is
deprecated and cannot receive messages". The clock starts at the release right after the image's
version, not the newest one: an image on 2.336.0 has 30 days from 2.337.0, however recently 2.338.0
came out. The rule fires 25 days in, naming the version, the release that started the clock, the
cutoff date and the release to move to, and keeps firing once the cutoff has passed. The
`erainfra_profile_runner_release_cutoff_seconds` gauge carries the same countdown.

Where the version comes from: a Firecracker Worker reads it from the Image Release it pulled,
first the `dev.erainfra.actions-runner.version` label (`images/ubuntu-24.04-js/Dockerfile` sets it
from `ARG RUNNER_VERSION`), then the `RUNNER_VERSION` build argument BuildKit records in the
image's history, so images built before the label also report. It travels with readiness and
never changes a Worker's readiness state. A Docker Profile's version is the tag of its
`ghcr.io/actions/actions-runner` image. Tart and Hyper-V Profiles report none yet, and the rule
never fires for a Profile whose version is unknown. The release list is GitHub's
`/repos/actions/runner/releases`, fetched every six hours (retried hourly on failure) with the
GitHub App's installation token, the legacy `GITHUB_PAT`, or anonymously; a failed fetch keeps
the previous list. Until the first fetch succeeds after a deploy, the rule has nothing to compare
against and stays quiet.

A rule can be limited to one Profile. Each rule and subject has at most one open incident, so a
condition that keeps holding notifies once. The lifecycle:

- The incident is pending until the condition has held for the rule's pending time, then it fires.
  A condition that clears while pending is dropped without a notification.
- A firing incident notifies every enabled destination on the rule, unless the rule is muted or
  the same rule and subject notified within the cooldown. Either way the incident still shows on
  the dashboard and in `erainfra_alerts_firing`, and it is announced at the first evaluation after
  the mute or cooldown ends, if it is still firing.
- When the condition clears, the incident resolves and a resolved notification goes out, but only
  if the firing one did.
- Disabling a rule closes its incidents without notifying. Resolved incidents are kept 30 days.

Destinations are a Slack incoming webhook (any Slack-compatible receiver works) or a generic
webhook. Both need https. URLs and signing secrets are write-only: the dashboard shows the host
and the last four characters of the path. Each destination has a Test button.

Delivery never blocks evaluation. The cron writes a delivery row and schedules a send. A 2xx is
delivered; 408, 429, 5xx, timeouts (10 seconds) and network errors are retried with exponential
backoff from 30 seconds, plus up to 20% jitter, honouring `Retry-After`, for 8 attempts in about an
hour; any other status fails at once. Delivery is at least once, so dedupe on
`X-EraInfra-Delivery`.

A generic webhook receives:

```json
{
  "version": 1,
  "event": "alert.firing",
  "rule": {
    "id": "…",
    "name": "Queue backlog",
    "kind": "queue-backlog",
    "condition": "Oldest queued Attempt older than 15m",
    "profile": "erainfra-4vcpu-ubuntu-2404"
  },
  "incident": {
    "id": "…",
    "status": "firing",
    "subject": "erainfra-4vcpu-ubuntu-2404",
    "summary": "3 Attempts queued on Profile erainfra-4vcpu-ubuntu-2404; the oldest has waited 16m.",
    "since": "2026-11-05T11:44:00.000Z",
    "firedAt": "2026-11-05T12:00:00.000Z",
    "resolvedAt": null
  },
  "sentAt": "2026-11-05T12:00:00.000Z"
}
```

`event` is `alert.firing`, `alert.resolved` or `alert.test`. The request carries
`X-EraInfra-Event`, `X-EraInfra-Delivery` and `X-EraInfra-Signature: t=<unix seconds>,v1=<hex>`,
where `v1` is HMAC-SHA256 of `<t>.<raw body>` keyed with the whole signing secret (`whsec_…`),
the scheme Stripe uses. The timestamp lets a receiver refuse replays. To verify in Node:

```js
import { createHmac, timingSafeEqual } from "node:crypto";

function verify(secret, header, rawBody, toleranceSeconds = 300) {
  const { t, v1 } = Object.fromEntries(header.split(",").map((part) => part.split("=")));
  if (Math.abs(Date.now() / 1000 - Number(t)) > toleranceSeconds) return false;
  const expected = createHmac("sha256", secret).update(`${t}.${rawBody}`).digest();
  const given = Buffer.from(v1 ?? "", "hex");
  return given.length === expected.length && timingSafeEqual(given, expected);
}
```

The signing secret is shown once when the destination is created or rotated. Rotation takes
effect at once.
