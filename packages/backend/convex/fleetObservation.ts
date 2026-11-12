import type { Doc, Id } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";
import { queueWaitMs } from "./attempts";
import { isSchedulableReadiness } from "./attemptScheduler";
import { ACTIVE_ATTEMPT_STATES, type ActiveAttemptState } from "./attemptStates";
import { controllerLiveness, type ControllerLiveness } from "./controllerLiveness";
import { profileEgressOf, type ProfileEgress } from "./egress";
import { pinDetail } from "./hostLabels";
import { hasLiveCredential } from "./infra/nodes";
import { isNodeLive } from "./infra/policy";
import { readinessAdmissionError } from "./isolation";
import {
  compareRunnerVersions,
  runnerVersionFromImageRelease,
  runnerVersionOf,
  type RunnerRelease,
} from "./runnerReleaseModel";
import { loadRunnerReleases } from "./runnerReleases";
import { conflictsOf } from "./scaleSetLabels";
import { WORKER_OFFLINE_AFTER_MS } from "./workerPolicy";

// What `/metrics` and the alert evaluator both read about the fleet, loaded through indexes with a
// cap on every range. `/metrics` is scraped every 15 to 60 seconds and the alert cron runs every
// minute, so neither may read a table's history. The caps are far above a self-hosted fleet's
// size; a range that reaches one is reported as truncated rather than silently undercounted.

/** Profiles, Workers and readiness rows read per pass. */
export const OBSERVATION_DIMENSION_LIMIT = 1_000;
/** Live Attempts read per Profile and state. */
export const LIVE_ATTEMPT_LIMIT = 1_000;
/** Newest Attempts read per Profile for the recent window. */
export const RECENT_ATTEMPT_SAMPLE = 200;
/** Controller heartbeat rows read per Profile: one per host that has run its controller. */
export const CONTROLLER_ROW_LIMIT = 50;

export const READINESS_STATES = ["preparing", "ready", "degraded", "failed"] as const;
export type ReadinessState = (typeof READINESS_STATES)[number];

/**
 * How a finished Attempt ended, as a closed set so it can be a metric label and an alert input.
 * GitHub reports the job result as free text on JobCompleted (`succeeded`, `failed`, `canceled`);
 * anything else, or a completed Attempt with no result, is `unknown`. An Attempt the control plane
 * itself failed (lost Worker, provisioning error) is `failed`, because the job did not run to a
 * result either way.
 */
export const ATTEMPT_OUTCOMES = ["succeeded", "failed", "cancelled", "unknown"] as const;
export type AttemptOutcome = (typeof ATTEMPT_OUTCOMES)[number];

export function attemptOutcome(attempt: Pick<Doc<"attempts">, "state" | "result">): AttemptOutcome {
  if (attempt.state === "failed") return "failed";
  if (attempt.state === "cancelled") return "cancelled";
  switch (attempt.result?.trim().toLowerCase()) {
    case "succeeded":
    case "success":
      return "succeeded";
    case "failed":
    case "failure":
      return "failed";
    case "canceled":
    case "cancelled":
      return "cancelled";
    default:
      return "unknown";
  }
}

/**
 * The readiness state the dashboard shows. A Worker that reports `ready` but whose evidence fails
 * admission is not ready: it reads as `degraded` once it has prepared before, and `failed` if it
 * never has.
 */
export function effectiveReadinessState(
  readiness: Doc<"workerReadiness">,
  evidence: Doc<"readinessEvidence"> | undefined,
  profileEgress: ProfileEgress,
): ReadinessState {
  if (readiness.state !== "ready") return readiness.state;
  if (readinessAdmissionError(readiness, evidence, profileEgress) === undefined) return "ready";
  return readiness.preparedAt === undefined ? "failed" : "degraded";
}

export type ObservedWorker = {
  machineId: Id<"machines">;
  machineName: string;
  state: ReadinessState;
  schedulable: boolean;
  detail?: string;
};

export type FinishedAttempt = {
  outcome: AttemptOutcome;
  finishedAt: number;
  queueWaitMs: number | null;
  runDurationMs: number | null;
  /** Why a failed Attempt failed, for an alert to name. Absent for any other outcome. */
  error?: string;
};

export type RunningAttempt = {
  runnerName: string;
  startedAt: number;
  repo?: string;
  displayName?: string;
};

export type ObservedProfile = {
  name: string;
  executor: Doc<"profiles">["executor"];
  state: Doc<"profiles">["state"];
  minRunners: number;
  maxRunners: number;
  /** Host labels a Worker must carry to serve the Profile (ADR 0017); empty when not pinned. */
  workerLabels: string[];
  /**
   * Why the Profile's scale set and another active Profile's can take each other's jobs, one line
   * per such Profile (scaleSetLabels.ts). The control plane refuses a registration that adds one;
   * these predate that check. Empty for a paused Profile.
   */
  labelConflicts: string[];
  /** Readiness rows for this Profile's current executor and Image Release only. */
  workers: ObservedWorker[];
  liveAttempts: Record<ActiveAttemptState, number>;
  liveAttemptsTruncated: boolean;
  oldestPendingCreatedAt?: number;
  /** Running Attempts, oldest first. */
  running: RunningAttempt[];
  /** Attempts that finished inside the requested window, newest finish first. */
  recentFinished: FinishedAttempt[];
  /** True when the sample was full and its oldest Attempt was created inside the window. */
  recentTruncated: boolean;
  /** Whether a controller is listening for the Profile; `unknown` until one first reports. */
  controller: ControllerLiveness;
  /**
   * The actions/runner version the Profile's Image Release carries: the image tag for the Docker
   * executor, otherwise the oldest version its Workers read from the image. Absent when no Worker
   * reported one.
   */
  runnerVersion?: string;
};

export type ObservedMachine = {
  id: Id<"machines">;
  name: string;
  os: Doc<"machines">["os"];
  arch?: string;
  slotPolicy: "auto" | "fixed";
  configuredSlots?: number;
  recommendedSlots?: number;
  maxSlots: number;
  usedSlots: number;
  /** Zero until the Worker's first heartbeat. */
  lastSeen: number;
  online: boolean;
  benchmark?: { measuredAt: number; scores: Record<BenchmarkDimension, number> };
};

/**
 * An infrastructure Node that has heartbeated over the Node API (connect-convex), with the command
 * health its Infra Agent reports. A Node the Hub still drives sends no such heartbeat and is left
 * out, and so is a Node whose credentials are all revoked: an operator retired it, and it can no
 * longer heartbeat, so it is neither offline nor blocked.
 */
export type ObservedNode = {
  name: string;
  online: boolean;
  lastSeenAt: number;
  /** Why the Node cannot run commands, while it says so (nodeState.COMMANDS_BLOCKED_REASONS). */
  commandsBlocked?: string;
  commandsBlockedSince?: number;
  journalKeys?: number;
  journalKeyLimit?: number;
};

export const BENCHMARK_DIMENSIONS = ["cpu", "memory", "disk", "network", "balanced"] as const;
export type BenchmarkDimension = (typeof BENCHMARK_DIMENSIONS)[number];

export type FleetObservation = {
  now: number;
  recentWindowMs: number;
  profiles: ObservedProfile[];
  machines: ObservedMachine[];
  /** Infrastructure Nodes on the Convex transport, by name. */
  nodes: ObservedNode[];
  /** True when the Profile, Worker, Node or readiness range reached its cap. */
  dimensionsTruncated: boolean;
  /** GitHub's actions/runner releases, absent until the first successful fetch. */
  runnerReleases?: { releases: RunnerRelease[]; fetchedAt: number };
};

export async function loadFleetObservation(
  ctx: QueryCtx,
  now: number,
  options: { recentWindowMs: number; profile?: string },
): Promise<FleetObservation> {
  const [activeProfiles, pausedProfiles, machineRows] = await Promise.all([
    ctx.db
      .query("profiles")
      .withIndex("by_state", (q) => q.eq("state", "active"))
      .take(OBSERVATION_DIMENSION_LIMIT),
    ctx.db
      .query("profiles")
      .withIndex("by_state", (q) => q.eq("state", "paused"))
      .take(OBSERVATION_DIMENSION_LIMIT),
    ctx.db
      .query("machines")
      .withIndex("by_lastSeen")
      .order("desc")
      .take(OBSERVATION_DIMENSION_LIMIT),
  ]);
  let dimensionsTruncated =
    activeProfiles.length === OBSERVATION_DIMENSION_LIMIT ||
    pausedProfiles.length === OBSERVATION_DIMENSION_LIMIT ||
    machineRows.length === OBSERVATION_DIMENSION_LIMIT;
  const profileRows = [...activeProfiles, ...pausedProfiles]
    .filter((profile) => options.profile === undefined || profile.name === options.profile)
    .toSorted((left, right) => left.name.localeCompare(right.name));
  const machineById = new Map(machineRows.map((machine) => [machine._id, machine]));

  const profiles = await Promise.all(
    profileRows.map(async (profile): Promise<ObservedProfile> => {
      const [readinessByState, liveByState, recent, controllers] = await Promise.all([
        Promise.all(
          READINESS_STATES.map((state) =>
            ctx.db
              .query("workerReadiness")
              .withIndex("by_profile_state", (q) =>
                q.eq("profile", profile.name).eq("state", state),
              )
              .take(OBSERVATION_DIMENSION_LIMIT),
          ),
        ),
        Promise.all(
          ACTIVE_ATTEMPT_STATES.map((state) =>
            ctx.db
              .query("attempts")
              .withIndex("by_profile_state", (q) =>
                q.eq("profile", profile.name).eq("state", state),
              )
              .take(LIVE_ATTEMPT_LIMIT),
          ),
        ),
        ctx.db
          .query("attempts")
          .withIndex("by_profile", (q) => q.eq("profile", profile.name))
          .order("desc")
          .take(RECENT_ATTEMPT_SAMPLE),
        ctx.db
          .query("controllerHeartbeats")
          .withIndex("by_profile_hostname", (q) => q.eq("profile", profile.name))
          .take(CONTROLLER_ROW_LIMIT),
      ]);
      if (readinessByState.some((rows) => rows.length === OBSERVATION_DIMENSION_LIMIT)) {
        dimensionsTruncated = true;
      }

      const readiness = readinessByState
        .flat()
        .filter(
          (row) => row.executor === profile.executor && row.imageRelease === profile.imageRelease,
        );
      const evidence = await Promise.all(
        readiness.map((row) =>
          ctx.db
            .query("readinessEvidence")
            .withIndex("by_machine_profile", (q) =>
              q.eq("machineId", row.machineId).eq("profile", row.profile),
            )
            .unique(),
        ),
      );
      const workers = readiness.flatMap((row, index): ObservedWorker[] => {
        const machine = machineById.get(row.machineId);
        if (machine === undefined) return [];
        const rowEvidence = evidence[index] ?? undefined;
        const currentEvidence = rowEvidence?.checkedAt === row.checkedAt ? rowEvidence : undefined;
        // The same order the Profile list uses: a missing pin label outranks anything the Worker
        // itself reported, because it is why the row does not count.
        const detail =
          pinDetail(profile.workerLabels, machine.labels) ??
          currentEvidence?.lastError ??
          readinessAdmissionError(row, rowEvidence, profileEgressOf(profile)) ??
          currentEvidence?.statusDetail;
        return [
          {
            machineId: row.machineId,
            machineName: machine.name,
            state: effectiveReadinessState(row, rowEvidence, profileEgressOf(profile)),
            schedulable:
              profile.state === "active" &&
              isSchedulableReadiness(
                row,
                rowEvidence,
                machine,
                profile,
                profileEgressOf(profile),
                now,
              ),
            ...(detail === undefined ? {} : { detail }),
          },
        ];
      });

      const runnerVersion =
        profile.executor === "docker"
          ? runnerVersionFromImageRelease(profile.imageRelease)
          : oldestRunnerVersion(
              evidence.map((row) =>
                row?.imageRelease === profile.imageRelease ? row.runnerVersion : undefined,
              ),
            );

      const [pending = [], preparing = [], ready = [], running = []] = liveByState;
      const since = now - options.recentWindowMs;
      const finished = recent.filter(
        (attempt) =>
          (attempt.state === "completed" ||
            attempt.state === "cancelled" ||
            attempt.state === "failed") &&
          attempt.finishedAt !== undefined &&
          attempt.finishedAt >= since,
      );
      const oldestSampled = recent.at(-1);
      return {
        name: profile.name,
        executor: profile.executor,
        state: profile.state,
        minRunners: profile.minRunners,
        maxRunners: profile.maxRunners,
        workerLabels: profile.workerLabels ?? [],
        labelConflicts:
          profile.state === "active"
            ? conflictsOf(profile, activeProfiles).map((conflict) => conflict.reason)
            : [],
        workers: workers.toSorted((left, right) =>
          left.machineName.localeCompare(right.machineName),
        ),
        liveAttempts: {
          pending: pending.length,
          preparing: preparing.length,
          ready: ready.length,
          running: running.length,
        },
        liveAttemptsTruncated: liveByState.some((rows) => rows.length === LIVE_ATTEMPT_LIMIT),
        // The index orders equal (profile, state) keys by creation time, so the first pending row
        // is the one that has waited longest.
        ...(pending[0] === undefined ? {} : { oldestPendingCreatedAt: pending[0].createdAt }),
        running: running
          .map((attempt) => ({
            runnerName: attempt.runnerName,
            startedAt: attempt.startedAt ?? attempt.claimedAt ?? attempt.createdAt,
            ...(attempt.repo === undefined ? {} : { repo: attempt.repo }),
            ...(attempt.displayName === undefined ? {} : { displayName: attempt.displayName }),
          }))
          .toSorted((left, right) => left.startedAt - right.startedAt),
        recentFinished: finished
          .map((attempt) => ({
            outcome: attemptOutcome(attempt),
            finishedAt: attempt.finishedAt ?? now,
            queueWaitMs: queueWaitMs(attempt),
            runDurationMs:
              attempt.startedAt === undefined || attempt.finishedAt === undefined
                ? null
                : Math.max(0, attempt.finishedAt - attempt.startedAt),
            ...(attempt.state === "failed" && attempt.lastError !== undefined
              ? { error: attempt.lastError }
              : {}),
          }))
          .toSorted((left, right) => right.finishedAt - left.finishedAt),
        recentTruncated:
          recent.length === RECENT_ATTEMPT_SAMPLE &&
          oldestSampled !== undefined &&
          oldestSampled.createdAt >= since,
        controller: controllerLiveness(controllers, now),
        ...(runnerVersion === undefined ? {} : { runnerVersion }),
      };
    }),
  );

  const machines = machineRows
    .map((machine): ObservedMachine => {
      const benchmark = machine.benchmark;
      return {
        id: machine._id,
        name: machine.name,
        os: machine.os,
        ...(machine.arch === undefined ? {} : { arch: machine.arch }),
        slotPolicy: machine.slotPolicy === "fixed" ? "fixed" : "auto",
        ...(machine.slotPolicy === "fixed"
          ? { configuredSlots: machine.configuredSlots ?? machine.maxSlots }
          : {}),
        ...(machine.recommendedSlots === undefined
          ? {}
          : { recommendedSlots: machine.recommendedSlots }),
        maxSlots: machine.maxSlots,
        usedSlots: machine.usedSlots,
        lastSeen: machine.lastSeen,
        online: machine.lastSeen > 0 && now - machine.lastSeen < WORKER_OFFLINE_AFTER_MS,
        ...(benchmark === undefined
          ? {}
          : { benchmark: { measuredAt: benchmark.measuredAt, scores: benchmark.scores } }),
      };
    })
    .toSorted((left, right) => left.name.localeCompare(right.name));

  const nodeRows = await ctx.db.query("nodes").take(OBSERVATION_DIMENSION_LIMIT);
  if (nodeRows.length === OBSERVATION_DIMENSION_LIMIT) dimensionsTruncated = true;
  const nodes = (
    await Promise.all(
      nodeRows.map(async (node): Promise<ObservedNode[]> => {
        const lastSeenAt = node.lastSeenAt;
        if (lastSeenAt === undefined || !(await hasLiveCredential(ctx, node._id))) return [];
        return [
          {
            name: node.name,
            online: isNodeLive(lastSeenAt, now),
            lastSeenAt,
            ...(node.commandsBlocked === undefined
              ? {}
              : {
                  commandsBlocked: node.commandsBlocked,
                  commandsBlockedSince: node.commandsBlockedSince ?? lastSeenAt,
                }),
            ...(node.journalKeys === undefined ? {} : { journalKeys: node.journalKeys }),
            ...(node.journalKeyLimit === undefined
              ? {}
              : { journalKeyLimit: node.journalKeyLimit }),
          },
        ];
      }),
    )
  )
    .flat()
    .toSorted((left, right) => left.name.localeCompare(right.name));

  const runnerReleases = await loadRunnerReleases(ctx);
  return {
    now,
    recentWindowMs: options.recentWindowMs,
    profiles,
    machines,
    nodes,
    dimensionsTruncated,
    ...(runnerReleases === undefined ? {} : { runnerReleases }),
  };
}

/**
 * The oldest valid version among those a Profile's Workers reported. One Image Release carries one
 * runner, so they agree unless a report is malformed; the oldest is the one GitHub refuses first.
 */
export function oldestRunnerVersion(reported: readonly (string | undefined)[]) {
  return reported
    .map(runnerVersionOf)
    .filter((version) => version !== undefined)
    .toSorted(compareRunnerVersions)[0];
}
