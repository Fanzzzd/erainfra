// Alert conditions and their evaluation against a FleetObservation. Pure, so every rule kind is
// tested without a database. The incident lifecycle (pending, firing, resolved, cooldown, mute)
// lives in alerts.ts; this file only answers "which subjects breach this condition right now".

import { v, type Infer } from "convex/values";
import { CONTROLLER_OFFLINE_AFTER_MS, controllerSilentForMs } from "./controllerLiveness";
import type { FleetObservation, ObservedProfile } from "./fleetObservation";
import { COMMANDS_BLOCKED_REASONS } from "./infra/nodeCommandModel";
import { NODE_SILENCE_MS } from "./infra/policy";
import { runnerReleaseStanding, type RunnerReleaseStanding } from "./runnerReleaseModel";
import { WORKER_OFFLINE_AFTER_MS } from "./workerPolicy";

export const alertConditionValidator = v.union(
  // A Worker that has heartbeated before and has been silent for `minutes`.
  v.object({ kind: v.literal("worker-offline"), minutes: v.number() }),
  // An active Profile with no Worker the scheduler would place work on.
  v.object({ kind: v.literal("profile-no-ready-worker") }),
  // A Worker reporting degraded or failed readiness for an active Profile.
  v.object({ kind: v.literal("profile-readiness-degraded") }),
  // An active Profile whose scale set and another active Profile's can take each other's jobs
  // (scaleSetLabels.ts). The control plane refuses a registration that adds such a conflict, so
  // this fires for one that predates that check, until an operator relabels one side.
  v.object({ kind: v.literal("profile-label-conflict") }),
  // The oldest unassigned Attempt on a Profile has waited `minutes`.
  v.object({ kind: v.literal("queue-backlog"), minutes: v.number() }),
  // At least `percent` of the Attempts that finished in the window failed, once `minAttempts`
  // have finished. Cancelled Attempts and ones without a result count toward neither side.
  v.object({
    kind: v.literal("failure-rate"),
    percent: v.number(),
    windowMinutes: v.number(),
    minAttempts: v.number(),
  }),
  // The newest `count` finished Attempts on a Profile all failed. Cancellations are skipped.
  v.object({ kind: v.literal("consecutive-failures"), count: v.number() }),
  // An Attempt on the Profile has been running for `minutes`.
  v.object({ kind: v.literal("attempt-duration"), minutes: v.number() }),
  // No controller has held an active Profile's GitHub message session for `minutes`: it stopped
  // reporting, or reports but cannot get the session. A Profile no controller has ever reported
  // for is not tracked (controllerLiveness.ts), so controllers older than the heartbeat never fire.
  v.object({ kind: v.literal("controller-silent"), minutes: v.number() }),
  // An online infrastructure Node has reported for `minutes` that it cannot run commands: its
  // execution journal is full or unwritable, or its command requests fail. Such a Node keeps
  // heartbeating, so worker-offline and failover never see it. Nodes belong to no Profile, so a
  // Profile scope does not narrow this rule.
  // A Node stays blocked while it is silent: its last heartbeat said so and nothing since says
  // otherwise, so an open incident does not resolve because the Node died.
  v.object({ kind: v.literal("node-commands-blocked"), minutes: v.number() }),
  // An infrastructure Node that has heartbeated over the Node API (connect-convex) and has been
  // silent for `minutes`. A Node whose credentials are all revoked has been retired by an
  // operator and is not tracked. Nodes belong to no Profile, so a Profile scope does not narrow it.
  v.object({ kind: v.literal("node-offline"), minutes: v.number() }),
  // An active Profile whose image carries an actions/runner release GitHub stops serving within
  // five days, or already has: 25 days or more since the next release was published
  // (runnerReleases.ts). Runners register with automatic updates off, so nothing else moves them.
  // A Profile whose version no Worker reported, or before the first release fetch, never fires.
  v.object({ kind: v.literal("runner-release-expiring") }),
);

export type AlertCondition = Infer<typeof alertConditionValidator>;
export type AlertConditionKind = AlertCondition["kind"];

/**
 * How far back the evaluator reads finished Attempts. Failure-rate windows are capped to it, and
 * a consecutive-failure streak only counts Attempts that finished inside it.
 */
export const ALERT_HISTORY_WINDOW_MS = 24 * 60 * 60_000;

export const ALERT_CONDITION_KINDS = [
  "worker-offline",
  "profile-no-ready-worker",
  "profile-readiness-degraded",
  "profile-label-conflict",
  "queue-backlog",
  "failure-rate",
  "consecutive-failures",
  "attempt-duration",
  "controller-silent",
  "node-commands-blocked",
  "node-offline",
  "runner-release-expiring",
] as const satisfies readonly AlertConditionKind[];

/** The threshold a new controller-silent rule starts from. */
export const DEFAULT_CONTROLLER_SILENT_MINUTES = 3;

function integerIn(value: number, min: number, max: number) {
  return Number.isInteger(value) && value >= min && value <= max;
}

/** Why a condition's thresholds are unusable, or undefined when they are fine. */
export function conditionError(condition: AlertCondition): string | undefined {
  switch (condition.kind) {
    case "worker-offline":
      // The scheduler already stops using a Worker after two silent minutes, so a shorter
      // threshold would page on every heartbeat hiccup the scheduler itself tolerates.
      return integerIn(condition.minutes, WORKER_OFFLINE_AFTER_MS / 60_000, 7 * 24 * 60)
        ? undefined
        : `Offline minutes must be a whole number from ${WORKER_OFFLINE_AFTER_MS / 60_000} to 10080`;
    case "controller-silent": {
      // Below the offline cutoff a single late report would page.
      const floor = Math.ceil(CONTROLLER_OFFLINE_AFTER_MS / 60_000);
      return integerIn(condition.minutes, floor, 7 * 24 * 60)
        ? undefined
        : `Silent minutes must be a whole number from ${floor} to 10080`;
    }
    case "node-offline": {
      // Below the missed-heartbeat window that deploys and failover use, one late heartbeat
      // would page.
      const floor = Math.ceil(NODE_SILENCE_MS / 60_000);
      return integerIn(condition.minutes, floor, 7 * 24 * 60)
        ? undefined
        : `Offline minutes must be a whole number from ${floor} to 10080`;
    }
    case "queue-backlog":
    case "attempt-duration":
    case "node-commands-blocked":
      return integerIn(condition.minutes, 1, 7 * 24 * 60)
        ? undefined
        : "Minutes must be a whole number from 1 to 10080";
    case "failure-rate":
      if (!(condition.percent > 0 && condition.percent <= 100)) {
        return "Failure rate must be above 0 and at most 100 percent";
      }
      if (!integerIn(condition.windowMinutes, 5, ALERT_HISTORY_WINDOW_MS / 60_000)) {
        return "The failure-rate window must be 5 to 1440 minutes";
      }
      return integerIn(condition.minAttempts, 1, 200)
        ? undefined
        : "Minimum Attempts must be a whole number from 1 to 200";
    case "consecutive-failures":
      return integerIn(condition.count, 1, 50)
        ? undefined
        : "Consecutive failures must be a whole number from 1 to 50";
    case "profile-no-ready-worker":
    case "profile-readiness-degraded":
    case "profile-label-conflict":
    case "runner-release-expiring":
      return undefined;
  }
}

export type Breach = { subject: string; summary: string };

function formatAge(milliseconds: number) {
  const minutes = Math.floor(milliseconds / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

function plural(count: number, noun: string) {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function profilesInScope(observation: FleetObservation, scope: string | undefined) {
  return observation.profiles.filter(
    (profile) => profile.state === "active" && (scope === undefined || profile.name === scope),
  );
}

/**
 * " The latest failure: <why>." for the newest failure that recorded a reason, or "". A Profile
 * whose every Attempt fails the same way (a runner version GitHub refuses) says why in the alert
 * itself, not only in each Attempt. `failures` is newest first, as recentFinished is.
 */
function latestFailure(failures: readonly ObservedProfile["recentFinished"][number][]) {
  const error = failures.find((attempt) => attempt.error !== undefined)?.error;
  return error === undefined ? "" : ` The latest failure: ${error}`;
}

function decided(profile: ObservedProfile, since: number) {
  return profile.recentFinished.filter(
    (attempt) =>
      attempt.finishedAt >= since &&
      (attempt.outcome === "succeeded" || attempt.outcome === "failed"),
  );
}

/** Subjects that breach the condition now, each with a one-line human summary. */
export function evaluateCondition(
  condition: AlertCondition,
  scope: string | undefined,
  observation: FleetObservation,
): Breach[] {
  const now = observation.now;
  switch (condition.kind) {
    case "worker-offline": {
      const thresholdMs = condition.minutes * 60_000;
      const scopedMachines =
        scope === undefined
          ? undefined
          : new Set(
              observation.profiles
                .filter((profile) => profile.name === scope)
                .flatMap((profile) => profile.workers.map((worker) => worker.machineId)),
            );
      return observation.machines
        .filter(
          (machine) =>
            // A Worker that never heartbeated was registered but not installed; that is an
            // unfinished setup, not an outage.
            machine.lastSeen > 0 &&
            now - machine.lastSeen >= thresholdMs &&
            (scopedMachines === undefined || scopedMachines.has(machine.id)),
        )
        .map((machine) => ({
          subject: machine.name,
          summary: `Worker ${machine.name} has not sent a heartbeat for ${formatAge(now - machine.lastSeen)}.`,
        }));
    }
    case "profile-no-ready-worker":
      return profilesInScope(observation, scope)
        .filter((profile) => !profile.workers.some((worker) => worker.schedulable))
        .map((profile) => {
          // A Worker that lost a pinned label still has its ready row; its detail says why it does
          // not count, which "w1 ready" alone would hide.
          const withDetail = profile.workers.some((worker) => worker.detail !== undefined);
          const reported = profile.workers.map(
            (worker) =>
              `${worker.machineName} ${worker.state}${
                worker.detail === undefined ? "" : `: ${worker.detail}`
              }`,
          );
          const one = profile.workerLabels.length === 1;
          const pinned =
            profile.workerLabels.length === 0
              ? ""
              : ` It is pinned to the ${one ? "host label" : "host labels"} ${profile.workerLabels.join(", ")}; only Workers carrying ${one ? "it" : "every one"} count.`;
          return {
            subject: profile.name,
            summary:
              reported.length === 0
                ? `Profile ${profile.name} has no Worker reporting readiness for its current Image Release.${pinned}`
                : `Profile ${profile.name} has no schedulable Worker (${reported.join(withDetail ? "; " : ", ")}).${pinned}`,
          };
        });
    case "profile-label-conflict":
      return profilesInScope(observation, scope).flatMap((profile) =>
        profile.labelConflicts.length === 0
          ? []
          : [
              {
                subject: profile.name,
                summary: `Profile ${profile.name} shares scale-set labels with another active Profile, so GitHub can run either one's jobs on the other: ${profile.labelConflicts.join("; ")}. Give one of them labels that do not include the other's name.`,
              },
            ],
      );
    case "profile-readiness-degraded":
      return profilesInScope(observation, scope).flatMap((profile) =>
        profile.workers
          .filter((worker) => worker.state === "degraded" || worker.state === "failed")
          .map((worker) => ({
            subject: `${profile.name}/${worker.machineName}`,
            summary: `Worker ${worker.machineName} reports ${worker.state} readiness for Profile ${profile.name}${
              worker.detail === undefined ? "." : `: ${worker.detail}`
            }`,
          })),
      );
    case "queue-backlog": {
      const thresholdMs = condition.minutes * 60_000;
      return profilesInScope(observation, scope).flatMap((profile) => {
        const oldest = profile.oldestPendingCreatedAt;
        if (oldest === undefined || now - oldest < thresholdMs) return [];
        return [
          {
            subject: profile.name,
            summary: `${plural(profile.liveAttempts.pending, "Attempt")} queued on Profile ${profile.name}; the oldest has waited ${formatAge(now - oldest)}.`,
          },
        ];
      });
    }
    case "failure-rate": {
      const since = now - Math.min(condition.windowMinutes * 60_000, ALERT_HISTORY_WINDOW_MS);
      return profilesInScope(observation, scope).flatMap((profile) => {
        const window = decided(profile, since);
        if (window.length < condition.minAttempts) return [];
        const failures = window.filter((attempt) => attempt.outcome === "failed");
        const rate = (failures.length / window.length) * 100;
        if (rate < condition.percent) return [];
        return [
          {
            subject: profile.name,
            summary: `${failures.length} of ${window.length} Attempts on Profile ${profile.name} failed in the last ${condition.windowMinutes}m (${Math.round(rate)}%).${latestFailure(failures)}`,
          },
        ];
      });
    }
    case "consecutive-failures":
      return profilesInScope(observation, scope).flatMap((profile) => {
        const window = decided(profile, now - ALERT_HISTORY_WINDOW_MS);
        let streak = 0;
        for (const attempt of window) {
          if (attempt.outcome !== "failed") break;
          streak += 1;
        }
        if (streak < condition.count) return [];
        return [
          {
            subject: profile.name,
            summary: `The last ${streak} finished Attempts on Profile ${profile.name} all failed.${latestFailure(window.slice(0, streak))}`,
          },
        ];
      });
    case "controller-silent": {
      const thresholdMs = condition.minutes * 60_000;
      return profilesInScope(observation, scope).flatMap((profile) => {
        const silentMs = controllerSilentForMs(profile.controller, now);
        if (silentMs === undefined || silentMs < thresholdMs) return [];
        return [
          { subject: profile.name, summary: describeSilentController(profile, silentMs, now) },
        ];
      });
    }
    case "node-commands-blocked": {
      const thresholdMs = condition.minutes * 60_000;
      return observation.nodes.flatMap((node) => {
        const reason = node.commandsBlocked;
        const since = node.commandsBlockedSince;
        if (reason === undefined || since === undefined) return [];
        // A silent Node is judged by what it last said: blocked for as long as it was when its
        // heartbeats stopped. That keeps an open incident open (the Node never said it recovered)
        // without a stale report starting a new one; node-offline pages for the silence itself.
        const blockedFor = (node.online ? now : node.lastSeenAt) - since;
        if (blockedFor < thresholdMs) return [];
        const keys =
          node.journalKeys === undefined
            ? ""
            : ` Its journal holds ${node.journalKeys}${
                node.journalKeyLimit === undefined ? "" : ` of ${node.journalKeyLimit}`
              } keys.`;
        const why = describeBlocked(reason);
        return [
          {
            subject: node.name,
            summary: node.online
              ? `Node ${node.name} has not been able to run commands for ${formatAge(blockedFor)}: ${why}.${keys}`
              : `Node ${node.name} could not run commands for ${formatAge(blockedFor)} before its heartbeats stopped ${formatAge(now - node.lastSeenAt)} ago: ${why}.${keys}`,
          },
        ];
      });
    }
    case "node-offline": {
      const thresholdMs = condition.minutes * 60_000;
      return observation.nodes
        .filter((node) => !node.online && now - node.lastSeenAt >= thresholdMs)
        .map((node) => ({
          subject: node.name,
          summary: `Node ${node.name} has not sent a heartbeat for ${formatAge(now - node.lastSeenAt)}; its Infra Agent or host is down, or it cannot reach Convex.${
            node.commandsBlocked === undefined
              ? ""
              : ` Its last heartbeat said it could not run commands: ${describeBlocked(node.commandsBlocked)}.`
          }`,
        }));
    }
    case "runner-release-expiring": {
      const releases = observation.runnerReleases?.releases;
      if (releases === undefined) return [];
      return profilesInScope(observation, scope).flatMap((profile) => {
        if (profile.runnerVersion === undefined) return [];
        const standing = runnerReleaseStanding(profile.runnerVersion, releases, now);
        if (
          standing === undefined ||
          (standing.state !== "expiring" && standing.state !== "expired")
        ) {
          return [];
        }
        return [
          { subject: profile.name, summary: describeRunnerRelease(profile.name, standing, now) },
        ];
      });
    }
    case "attempt-duration": {
      const thresholdMs = condition.minutes * 60_000;
      return profilesInScope(observation, scope).flatMap((profile) => {
        const long = profile.running.filter((attempt) => now - attempt.startedAt >= thresholdMs);
        const longest = long[0];
        if (longest === undefined) return [];
        const what = [longest.repo, longest.displayName].filter(Boolean).join(" ");
        return [
          {
            subject: profile.name,
            summary: `${plural(long.length, "Attempt")} on Profile ${profile.name} running longer than ${condition.minutes}m; the longest is ${longest.runnerName}${
              what.length === 0 ? "" : ` (${what})`
            } at ${formatAge(now - longest.startedAt)}.`,
          },
        ];
      });
    }
  }
}

function isoDay(milliseconds: number) {
  return new Date(milliseconds).toISOString().slice(0, 10);
}

/**
 * One line for an expiring or expired runner: the version, the release that started its clock and
 * when, the cutoff, and what to do. The cutoff is GitHub's documented 30 days.
 */
export function describeRunnerRelease(
  profileName: string,
  standing: Extract<RunnerReleaseStanding, { successor: unknown }>,
  now: number,
) {
  const subject = `Profile ${profileName}'s image runs actions/runner ${standing.version}`;
  const fix = `Rebuild the image on actions/runner ${standing.newest.version} and move the Profile to it.`;
  if (standing.successorBeforeList) {
    return `${subject}, older than every release GitHub lists, so GitHub no longer sends it jobs. ${fix}`;
  }
  const clock = `GitHub published ${standing.successor.version} on ${isoDay(standing.successor.publishedAt)}`;
  if (standing.state === "expired") {
    return `${subject}. ${clock}, so it stopped sending jobs to ${standing.version} on ${isoDay(standing.deadline)}, ${formatAge(now - standing.deadline)} ago. ${fix}`;
  }
  return `${subject}. ${clock}, so it stops sending jobs to ${standing.version} on ${isoDay(standing.deadline)}, in ${formatAge(standing.deadline - now)}. ${fix}`;
}

function describeSilentController(profile: ObservedProfile, silentMs: number, now: number) {
  const controller = profile.controller;
  const primary = controller.primary;
  const subject = `Profile ${profile.name} has had no listening controller for ${formatAge(silentMs)}`;
  if (primary === undefined) return `${subject}.`;
  const who = `${primary.hostname} (${primary.version})`;
  const why = primary.lastError === undefined ? "" : `: ${primary.lastError}`;
  if (controller.status === "waiting") {
    if (primary.sessionState === "standby") {
      return `${subject}; ${who} is standing by, waiting for the Profile's controller lease${why}`;
    }
    return primary.sessionState === "conflict"
      ? `${subject}; ${who} is reporting but GitHub refuses it the session because another one exists${why}`
      : `${subject}; ${who} is reporting but has not opened a session yet${why}`;
  }
  const last =
    controller.lastHeartbeatAt === undefined
      ? ""
      : ` ${formatAge(Math.max(0, now - controller.lastHeartbeatAt))} ago`;
  return primary.sessionState === "stopped"
    ? `${subject}; ${who} stopped${last}${why}`
    : `${subject}; the last report came from ${who}${last}.`;
}

/** One line describing the condition, for notifications and the dashboard. */
export function describeCondition(condition: AlertCondition) {
  switch (condition.kind) {
    case "worker-offline":
      return `Worker offline for ${condition.minutes}m`;
    case "profile-no-ready-worker":
      return "Profile has no ready Worker";
    case "profile-readiness-degraded":
      return "Worker readiness degraded or failed";
    case "profile-label-conflict":
      return "Profiles' scale-set labels overlap";
    case "queue-backlog":
      return `Oldest queued Attempt older than ${condition.minutes}m`;
    case "failure-rate":
      return `${condition.percent}% of Attempts failed over ${condition.windowMinutes}m (at least ${condition.minAttempts})`;
    case "consecutive-failures":
      return `${condition.count} consecutive failed Attempts`;
    case "attempt-duration":
      return `Attempt running longer than ${condition.minutes}m`;
    case "controller-silent":
      return `No controller listening for ${condition.minutes}m`;
    case "node-commands-blocked":
      return `Node unable to run commands for ${condition.minutes}m`;
    case "node-offline":
      return `Node offline for ${condition.minutes}m`;
    case "runner-release-expiring":
      return "Image's actions/runner within 5 days of GitHub's cutoff or past it";
  }
}

function describeBlocked(reason: string) {
  return Object.hasOwn(COMMANDS_BLOCKED_REASONS, reason)
    ? `${COMMANDS_BLOCKED_REASONS[reason as keyof typeof COMMANDS_BLOCKED_REASONS]} (${reason})`
    : reason;
}
