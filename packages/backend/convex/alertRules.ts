// Alert conditions and their evaluation against a FleetObservation. Pure, so every rule kind is
// tested without a database. The incident lifecycle (pending, firing, resolved, cooldown, mute)
// lives in alerts.ts; this file only answers "which subjects breach this condition right now".

import { v, type Infer } from "convex/values";
import { CONTROLLER_OFFLINE_AFTER_MS, controllerSilentForMs } from "./controllerLiveness";
import type { FleetObservation, ObservedProfile } from "./fleetObservation";
import { WORKER_OFFLINE_AFTER_MS } from "./workerPolicy";

export const alertConditionValidator = v.union(
  // A Worker that has heartbeated before and has been silent for `minutes`.
  v.object({ kind: v.literal("worker-offline"), minutes: v.number() }),
  // An active Profile with no Worker the scheduler would place work on.
  v.object({ kind: v.literal("profile-no-ready-worker") }),
  // A Worker reporting degraded or failed readiness for an active Profile.
  v.object({ kind: v.literal("profile-readiness-degraded") }),
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
  "queue-backlog",
  "failure-rate",
  "consecutive-failures",
  "attempt-duration",
  "controller-silent",
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
    case "queue-backlog":
    case "attempt-duration":
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
          const reported = profile.workers.map((worker) => `${worker.machineName} ${worker.state}`);
          return {
            subject: profile.name,
            summary:
              reported.length === 0
                ? `Profile ${profile.name} has no Worker reporting readiness for its current Image Release.`
                : `Profile ${profile.name} has no schedulable Worker (${reported.join(", ")}).`,
          };
        });
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
        const failed = window.filter((attempt) => attempt.outcome === "failed").length;
        const rate = (failed / window.length) * 100;
        if (rate < condition.percent) return [];
        return [
          {
            subject: profile.name,
            summary: `${failed} of ${window.length} Attempts on Profile ${profile.name} failed in the last ${condition.windowMinutes}m (${Math.round(rate)}%).`,
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
            summary: `The last ${streak} finished Attempts on Profile ${profile.name} all failed.`,
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

function describeSilentController(profile: ObservedProfile, silentMs: number, now: number) {
  const controller = profile.controller;
  const primary = controller.primary;
  const subject = `Profile ${profile.name} has had no listening controller for ${formatAge(silentMs)}`;
  if (primary === undefined) return `${subject}.`;
  const who = `${primary.hostname} (${primary.version})`;
  const why = primary.lastError === undefined ? "" : `: ${primary.lastError}`;
  if (controller.status === "waiting") {
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
  }
}
