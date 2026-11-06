// Prometheus text exposition (format 0.0.4) for fleet state. Pure: the HTTP route loads a
// FleetObservation and the open alert incidents, and this file turns them into text. Kept free of
// Convex bindings so the format can be tested line by line.
//
// Naming follows https://prometheus.io/docs/practices/naming/: an `erainfra_` prefix, base units
// (`_seconds`), and labels only from small operator-owned sets (profile, machine, node, executor, state, reason,
// result). Nothing here is labelled by repository, branch, workflow, runner or job id; those grow
// without bound and belong in the Runs page.
//
// Every metric is a gauge. Prometheus counters and histograms must be monotonic for the life of
// the process that exports them, and this endpoint has no process: each scrape is computed from
// stored rows, and terminal Attempts are read through a recent window, not a running total. A
// counter rebuilt from that window would fall whenever an old Attempt left it, which `rate()`
// reads as a reset. So outcomes are counts over the last hour, durations are quantiles over the
// same hour, and the HELP text of each says so.

import type { BenchmarkDimension, FleetObservation, ObservedProfile } from "./fleetObservation";
import {
  ATTEMPT_OUTCOMES,
  BENCHMARK_DIMENSIONS,
  LIVE_ATTEMPT_STATES,
  READINESS_STATES,
} from "./fleetObservation";
import { runnerReleaseStanding } from "./runnerReleaseModel";

export const METRICS_CONTENT_TYPE = "text/plain; version=0.0.4; charset=utf-8";
export const METRICS_RECENT_WINDOW_MS = 60 * 60_000;
export const RECENT_QUANTILES = [0.5, 0.9, 0.99, 1] as const;

type Labels = Record<string, string>;
type Sample = { labels: Labels; value: number };
export type MetricFamily = { name: string; help: string; samples: Sample[] };

export type OpenIncidentCount = { rule: string; firing: number };

function escapeLabelValue(value: string) {
  return value.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, '\\"');
}

function escapeHelp(value: string) {
  return value.replace(/\\/g, "\\\\").replace(/\n/g, "\\n");
}

export function formatSampleValue(value: number) {
  if (Number.isNaN(value)) return "NaN";
  if (value === Infinity) return "+Inf";
  if (value === -Infinity) return "-Inf";
  return Number.isInteger(value) ? value.toString() : Number(value.toPrecision(12)).toString();
}

export function renderExposition(families: MetricFamily[]) {
  const lines: string[] = [];
  for (const metric of families) {
    lines.push(`# HELP ${metric.name} ${escapeHelp(metric.help)}`);
    lines.push(`# TYPE ${metric.name} gauge`);
    for (const sample of metric.samples) {
      const labels = Object.entries(sample.labels);
      const labelText =
        labels.length === 0
          ? ""
          : `{${labels.map(([key, value]) => `${key}="${escapeLabelValue(value)}"`).join(",")}}`;
      lines.push(`${metric.name}${labelText} ${formatSampleValue(sample.value)}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

/** Nearest-rank quantile over an ascending array. */
export function quantile(sorted: number[], q: number) {
  if (sorted.length === 0) return Number.NaN;
  const rank = Math.max(1, Math.ceil(q * sorted.length));
  return sorted[Math.min(sorted.length, rank) - 1] ?? Number.NaN;
}

function family(name: string, help: string, samples: Sample[] = []): MetricFamily {
  return { name, help, samples };
}

function recentQuantileSamples(profile: ObservedProfile, values: number[]) {
  const sorted = values.toSorted((left, right) => left - right);
  if (sorted.length === 0) return [];
  return RECENT_QUANTILES.map((q) => ({
    labels: { profile: profile.name, quantile: q.toString() },
    value: quantile(sorted, q) / 1_000,
  }));
}

export function buildMetricFamilies(
  observation: FleetObservation,
  incidents: OpenIncidentCount[],
): MetricFamily[] {
  const now = observation.now;
  const windowSeconds = observation.recentWindowMs / 1_000;
  const windowText = `the last ${windowSeconds / 60} minutes`;

  const profileInfo = family(
    "erainfra_profile_info",
    "Always 1. Joins a Profile to its executor and whether it is active or paused.",
  );
  const runnersMin = family(
    "erainfra_profile_runners_min",
    "Runners the Profile's controller keeps warm (minRunners).",
  );
  const runnersMax = family(
    "erainfra_profile_runners_max",
    "Upper bound on the Profile's live Attempts (maxRunners).",
  );
  const workers = family(
    "erainfra_profile_workers",
    "Workers by the readiness state they report for the Profile's current executor and Image Release. A ready report whose evidence fails admission counts as degraded, or failed if the Worker never prepared.",
  );
  const schedulable = family(
    "erainfra_profile_workers_schedulable",
    "Workers the scheduler would place this Profile's work on now: ready, admitted, fresh readiness, and an online heartbeat. Zero for a paused Profile.",
  );
  const labelConflicts = family(
    "erainfra_profile_label_conflicts",
    "Other active Profiles whose scale set shares labels with this one's, so GitHub can run either one's jobs on the other. The control plane refuses a registration that adds one; a nonzero value predates that check. Zero for a paused Profile.",
  );
  const attempts = family(
    "erainfra_attempts",
    'Live Attempts by state. state="pending" is the queue: Attempts not yet assigned to a Worker.',
  );
  const oldestQueued = family(
    "erainfra_attempt_queue_oldest_age_seconds",
    "Age of the oldest pending (unassigned) Attempt. 0 when nothing is queued.",
  );
  const finished = family(
    "erainfra_recent_attempts_finished",
    `Gauge, not a counter: Attempts that finished in ${windowText}, by result. Use the value directly rather than rate() or increase().`,
  );
  const queueWait = family(
    "erainfra_recent_attempt_queue_wait_seconds",
    `Gauge: nearest-rank quantiles of how long GitHub held a job before one of this Profile's Runners took it, over Attempts that finished in ${windowText}. quantile="1" is the maximum. Absent when no finished Attempt has a known queue time.`,
  );
  const runDuration = family(
    "erainfra_recent_attempt_run_duration_seconds",
    `Gauge: nearest-rank quantiles of job run time (JobStarted to finish) over Attempts that finished in ${windowText}. quantile="1" is the maximum. Absent when none started.`,
  );
  const sampleTruncated = family(
    "erainfra_recent_attempts_sample_truncated",
    "1 when the Profile ran more Attempts in the window than one scrape reads, so the recent-window gauges describe only the newest of them.",
  );
  const controllerUp = family(
    "erainfra_controller_up",
    "1 when a controller for the Profile reported within the last 90 seconds and holds the GitHub message session. Absent until a controller first reports for the Profile, so a controller older than the heartbeat is never reported down.",
  );
  const controllerAge = family(
    "erainfra_controller_last_heartbeat_age_seconds",
    "Seconds since any controller for the Profile last reported, at scrape time. Absent until a controller first reports for the Profile.",
  );
  const runnerCutoff = family(
    "erainfra_profile_runner_release_cutoff_seconds",
    "Seconds until GitHub stops sending jobs to the actions/runner version in the Profile's image: 30 days after the next release was published. Negative once past. Absent while no newer release exists, no Worker has reported the version, or the release list has not been fetched.",
  );

  for (const profile of observation.profiles) {
    const labels = { profile: profile.name };
    profileInfo.samples.push({
      labels: { profile: profile.name, executor: profile.executor, state: profile.state },
      value: 1,
    });
    runnersMin.samples.push({ labels, value: profile.minRunners });
    runnersMax.samples.push({ labels, value: profile.maxRunners });
    for (const state of READINESS_STATES) {
      workers.samples.push({
        labels: { profile: profile.name, state },
        value: profile.workers.filter((worker) => worker.state === state).length,
      });
    }
    schedulable.samples.push({
      labels,
      value: profile.workers.filter((worker) => worker.schedulable).length,
    });
    labelConflicts.samples.push({ labels, value: profile.labelConflicts.length });
    for (const state of LIVE_ATTEMPT_STATES) {
      attempts.samples.push({
        labels: { profile: profile.name, state },
        value: profile.liveAttempts[state],
      });
    }
    oldestQueued.samples.push({
      labels,
      value:
        profile.oldestPendingCreatedAt === undefined
          ? 0
          : Math.max(0, now - profile.oldestPendingCreatedAt) / 1_000,
    });
    for (const result of ATTEMPT_OUTCOMES) {
      finished.samples.push({
        labels: { profile: profile.name, result },
        value: profile.recentFinished.filter((attempt) => attempt.outcome === result).length,
      });
    }
    queueWait.samples.push(
      ...recentQuantileSamples(
        profile,
        profile.recentFinished.flatMap((attempt) =>
          attempt.queueWaitMs === null ? [] : [attempt.queueWaitMs],
        ),
      ),
    );
    runDuration.samples.push(
      ...recentQuantileSamples(
        profile,
        profile.recentFinished.flatMap((attempt) =>
          attempt.runDurationMs === null ? [] : [attempt.runDurationMs],
        ),
      ),
    );
    sampleTruncated.samples.push({ labels, value: profile.recentTruncated ? 1 : 0 });
    const controller = profile.controller;
    if (controller.status !== "unknown" && controller.lastHeartbeatAt !== undefined) {
      controllerUp.samples.push({ labels, value: controller.status === "online" ? 1 : 0 });
      controllerAge.samples.push({
        labels,
        value: Math.max(0, now - controller.lastHeartbeatAt) / 1_000,
      });
    }
    const standing =
      profile.runnerVersion === undefined || observation.runnerReleases === undefined
        ? undefined
        : runnerReleaseStanding(profile.runnerVersion, observation.runnerReleases.releases, now);
    if (standing !== undefined && standing.state !== "current") {
      // A version older than the whole list is past its cutoff whatever the oldest listed date says.
      const seconds = (standing.deadline - now) / 1_000;
      runnerCutoff.samples.push({
        labels,
        value: standing.state === "expired" ? Math.min(0, seconds) : seconds,
      });
    }
  }

  const machineInfo = family(
    "erainfra_machine_info",
    "Always 1. Joins a Worker to its OS, architecture and slot policy (auto follows the benchmark, fixed is operator-set).",
  );
  const online = family(
    "erainfra_machine_online",
    "1 when the Worker heartbeated within the last two minutes, the cutoff the scheduler uses.",
  );
  const heartbeatTimestamp = family(
    "erainfra_machine_last_heartbeat_timestamp_seconds",
    "Unix time of the Worker's last heartbeat. Absent until the first one.",
  );
  const heartbeatAge = family(
    "erainfra_machine_heartbeat_age_seconds",
    "Seconds since the Worker's last heartbeat, at scrape time. Absent until the first one.",
  );
  const slotsConfigured = family(
    "erainfra_machine_slots_configured",
    "Slots an operator fixed for the Worker. Absent when the slot policy is auto.",
  );
  const slotsRecommended = family(
    "erainfra_machine_slots_recommended",
    "Slots the Worker's resources and benchmark recommend.",
  );
  const slotsEffective = family(
    "erainfra_machine_slots_effective",
    "Slots the scheduler fills on the Worker: the configured value under a fixed policy, the recommendation under auto.",
  );
  const slotsUsed = family(
    "erainfra_machine_slots_used",
    "Slots held by Attempts, Experiments and legacy jobs on the Worker.",
  );
  const benchmarkScore = family(
    "erainfra_machine_benchmark_score",
    "Worker benchmark score by dimension, 0 to 100, as the scheduler's fit policies read it. Absent until the first benchmark.",
  );
  const benchmarkTimestamp = family(
    "erainfra_machine_benchmark_timestamp_seconds",
    "Unix time the Worker's benchmark was measured. The scheduler treats a benchmark older than seven days as missing.",
  );

  for (const machine of observation.machines) {
    const labels = { machine: machine.name };
    machineInfo.samples.push({
      labels: {
        machine: machine.name,
        os: machine.os,
        arch: machine.arch ?? "",
        slot_policy: machine.slotPolicy,
      },
      value: 1,
    });
    online.samples.push({ labels, value: machine.online ? 1 : 0 });
    if (machine.lastSeen > 0) {
      heartbeatTimestamp.samples.push({ labels, value: machine.lastSeen / 1_000 });
      heartbeatAge.samples.push({ labels, value: Math.max(0, now - machine.lastSeen) / 1_000 });
    }
    if (machine.configuredSlots !== undefined) {
      slotsConfigured.samples.push({ labels, value: machine.configuredSlots });
    }
    if (machine.recommendedSlots !== undefined) {
      slotsRecommended.samples.push({ labels, value: machine.recommendedSlots });
    }
    slotsEffective.samples.push({ labels, value: machine.maxSlots });
    slotsUsed.samples.push({ labels, value: machine.usedSlots });
    if (machine.benchmark !== undefined) {
      const scores = machine.benchmark.scores;
      for (const dimension of BENCHMARK_DIMENSIONS) {
        benchmarkScore.samples.push({
          labels: { machine: machine.name, dimension },
          value: scores[dimension satisfies BenchmarkDimension],
        });
      }
      benchmarkTimestamp.samples.push({ labels, value: machine.benchmark.measuredAt / 1_000 });
    }
  }

  const nodeOnline = family(
    "erainfra_node_online",
    "1 when the infrastructure Node's Infra Agent heartbeated over the Node API (connect-convex) within the silence window. Absent for a Node only the Hub drives.",
  );
  const nodeBlocked = family(
    "erainfra_node_commands_blocked",
    'Gauge: 1 while the Node reports that it cannot run commands, by reason (journal_full, journal_error, command_api, command_error); 0 with reason="" otherwise. Read it with erainfra_node_online: an offline Node reports nothing.',
  );
  const nodeBlockedSeconds = family(
    "erainfra_node_commands_blocked_seconds",
    "Seconds since the Node first reported that it cannot run commands, at scrape time. Absent while it can.",
  );
  const nodeJournalKeys = family(
    "erainfra_node_journal_keys",
    "Keys in the Node's execution journal: commands Convex may still deliver or does not know. Keys of finished commands are forgotten. New builds, deploys and operations stop at erainfra_node_journal_key_limit. Absent until the Infra Agent reports it.",
  );
  const nodeJournalLimit = family(
    "erainfra_node_journal_key_limit",
    "The Node's execution journal key limit. Absent until the Infra Agent reports it.",
  );
  for (const node of observation.nodes) {
    const labels = { node: node.name };
    nodeOnline.samples.push({ labels, value: node.online ? 1 : 0 });
    nodeBlocked.samples.push({
      labels: { node: node.name, reason: node.commandsBlocked ?? "" },
      value: node.commandsBlocked === undefined ? 0 : 1,
    });
    if (node.commandsBlocked !== undefined && node.commandsBlockedSince !== undefined) {
      nodeBlockedSeconds.samples.push({
        labels: { node: node.name, reason: node.commandsBlocked },
        value: Math.max(0, now - node.commandsBlockedSince) / 1_000,
      });
    }
    if (node.journalKeys !== undefined) {
      nodeJournalKeys.samples.push({ labels, value: node.journalKeys });
    }
    if (node.journalKeyLimit !== undefined) {
      nodeJournalLimit.samples.push({ labels, value: node.journalKeyLimit });
    }
  }

  const alertsFiring = family(
    "erainfra_alerts_firing",
    "Open firing alert incidents by rule name, from the dashboard's alert rules.",
    incidents.map((incident) => ({ labels: { rule: incident.rule }, value: incident.firing })),
  );
  const window = family(
    "erainfra_recent_window_seconds",
    "Length of the window the erainfra_recent_* gauges cover.",
    [{ labels: {}, value: windowSeconds }],
  );
  const truncated = family(
    "erainfra_scrape_truncated",
    "1 when a Profile, Worker, readiness or live Attempt range reached its per-scrape read cap, so counts may be low.",
    [
      {
        labels: {},
        value:
          observation.dimensionsTruncated ||
          observation.profiles.some((profile) => profile.liveAttemptsTruncated)
            ? 1
            : 0,
      },
    ],
  );

  return [
    profileInfo,
    runnersMin,
    runnersMax,
    workers,
    schedulable,
    labelConflicts,
    attempts,
    oldestQueued,
    finished,
    queueWait,
    runDuration,
    sampleTruncated,
    controllerUp,
    controllerAge,
    runnerCutoff,
    window,
    machineInfo,
    online,
    heartbeatTimestamp,
    heartbeatAge,
    slotsConfigured,
    slotsRecommended,
    slotsEffective,
    slotsUsed,
    benchmarkScore,
    benchmarkTimestamp,
    nodeOnline,
    nodeBlocked,
    nodeBlockedSeconds,
    nodeJournalKeys,
    nodeJournalLimit,
    alertsFiring,
    truncated,
  ];
}
