import { ConvexError, v, type Infer } from "convex/values";

import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import { mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { recordAttemptMetrics } from "./attemptMetrics";
import { metricsSnapshotValidator } from "./attemptMetricsModel";
import { releaseAttemptSlot, releaseMachineSlot } from "./attemptScheduler";
import { deleteAttemptSecret } from "./attemptSecrets";
import { ACTIVE_ATTEMPT_STATES, ACTIVE_EXPERIMENT_STATES } from "./attemptStates";
import {
  benchmarkRecommendedSlots,
  benchmarkReportValidator,
  benchmarkScoresValidator,
  normalizeBenchmark,
  resourceRecommendedSlots,
} from "./benchmark";
import {
  egressRecordValidator,
  profileEgressOf,
  boundedEgressRecord,
  profileEgressValidator,
} from "./egress";
import { effectiveReadinessState } from "./fleetObservation";
import { missingHostLabels, missingHostLabelsDetail } from "./hostLabels";
import {
  assertReadinessContract,
  placementStorageOf,
  readinessAdmissionError,
  readinessFactsValidator,
} from "./isolation";
import { readinessStateValidator } from "./readinessStates";
import { runnerVersionOf } from "./runnerReleaseModel";
import { recordAttemptTests } from "./testReports";
import { testReportValidator } from "./testReportsModel";
import { largestServedProfileMemoryMiB, servedProfiles } from "./workerPolicy";

const completedExecutorDrainMs = 30_000;

const executorValidator = v.union(
  v.literal("docker"),
  v.literal("firecracker"),
  v.literal("tart"),
  v.literal("hyperv"),
);

const profileSpecValidator = v.object({
  profile: v.string(),
  executor: executorValidator,
  imageRelease: v.string(),
  vcpus: v.number(),
  memoryMiB: v.number(),
  warmPool: v.number(),
  egress: profileEgressValidator,
});

async function machineForToken(ctx: QueryCtx | MutationCtx, token: string) {
  const machine = await ctx.db
    .query("machines")
    .withIndex("by_token", (q) => q.eq("token", token))
    .unique();
  if (machine === null) throw new ConvexError("Invalid machine token");
  return machine;
}

/**
 * The egress a claimed Attempt or Experiment runs under: its Profile's, read at
 * claim. The scheduler only assigned the work to a Worker whose evidence proves
 * that same policy, so the two agree; a Profile that is gone means public,
 * which is also what the Worker would have been checked against.
 */
async function claimEgress(ctx: MutationCtx, profileName: string) {
  const profile = await ctx.db
    .query("profiles")
    .withIndex("by_name", (q) => q.eq("name", profileName))
    .unique();
  return profile === null ? profileEgressOf({}) : profileEgressOf(profile);
}

export const profiles = query({
  args: { token: v.string() },
  returns: v.array(profileSpecValidator),
  handler: async (ctx, args) => {
    const machine = await machineForToken(ctx, args.token);
    // A pinned Profile is invisible to a Worker without its labels, so that Worker never
    // prepares its image, parks warm guests for it or reports readiness for it (ADR 0017).
    return (await servedProfiles(ctx, machine)).map((profile) => ({
      profile: profile.name,
      executor: profile.executor,
      imageRelease: profile.imageRelease,
      vcpus: profile.vcpus,
      memoryMiB: profile.memoryMiB,
      warmPool: profile.warmPool ?? 0,
      egress: profileEgressOf(profile),
    }));
  },
});

export const reportHostFacts = mutation({
  args: {
    token: v.string(),
    arch: v.string(),
    cpus: v.number(),
    memoryMiB: v.number(),
  },
  returns: v.object({ maxSlots: v.number(), recommendedSlots: v.number() }),
  handler: async (ctx, args) => {
    if (
      !Number.isInteger(args.cpus) ||
      args.cpus < 1 ||
      !Number.isInteger(args.memoryMiB) ||
      args.memoryMiB < 256 ||
      args.arch.trim().length === 0
    ) {
      throw new ConvexError("Invalid Worker host facts");
    }
    const machine = await machineForToken(ctx, args.token);
    const now = Date.now();
    const resourceSlots = resourceRecommendedSlots(
      machine.os,
      args.cpus,
      args.memoryMiB,
      await largestServedProfileMemoryMiB(ctx, machine),
    );
    const evidence = await ctx.db
      .query("benchmarkEvidence")
      .withIndex("by_machine", (q) => q.eq("machineId", machine._id))
      .unique();
    const recommendedSlots = benchmarkRecommendedSlots(resourceSlots, evidence?.benchmark, now);
    // Machines registered before slot policies existed are automatic. Only an
    // explicit operator choice is fixed; the first v0.2 heartbeat persists the
    // migrated policy so every later read is unambiguous.
    const slotPolicy = machine.slotPolicy === "fixed" ? "fixed" : "auto";
    const configuredSlots =
      slotPolicy === "fixed" ? (machine.configuredSlots ?? machine.maxSlots) : undefined;
    // A lower automatic recommendation drains naturally: existing work keeps
    // running even when usedSlots is temporarily above maxSlots, while both
    // schedulers stop backfilling until the Worker is under the new ceiling.
    const maxSlots = slotPolicy === "auto" ? recommendedSlots : machine.maxSlots;
    await ctx.db.patch(machine._id, {
      arch: args.arch.trim(),
      cpus: args.cpus,
      memoryMiB: args.memoryMiB,
      slotPolicy,
      configuredSlots,
      resourceRecommendedSlots: resourceSlots,
      recommendedSlots,
      maxSlots,
    });
    await ctx.scheduler.runAfter(0, internal.attemptScheduler.tryAssign, {});
    return { maxSlots, recommendedSlots };
  },
});

export const reportBenchmark = mutation({
  args: {
    token: v.string(),
    report: benchmarkReportValidator,
  },
  returns: v.object({
    maxSlots: v.number(),
    recommendedSlots: v.number(),
    scores: benchmarkScoresValidator,
  }),
  handler: async (ctx, args) => {
    const machine = await machineForToken(ctx, args.token);
    const now = Date.now();
    const benchmark = normalizeBenchmark(args.report, now);
    const resourceSlots =
      machine.cpus !== undefined && machine.memoryMiB !== undefined
        ? resourceRecommendedSlots(
            machine.os,
            machine.cpus,
            machine.memoryMiB,
            await largestServedProfileMemoryMiB(ctx, machine),
          )
        : (machine.resourceRecommendedSlots ?? machine.recommendedSlots ?? machine.maxSlots);
    const recommendedSlots = benchmarkRecommendedSlots(resourceSlots, benchmark, now);
    const slotPolicy = machine.slotPolicy === "fixed" ? "fixed" : "auto";
    const configuredSlots =
      slotPolicy === "fixed" ? (machine.configuredSlots ?? machine.maxSlots) : undefined;
    const maxSlots =
      slotPolicy === "auto" ? recommendedSlots : (configuredSlots ?? machine.maxSlots);
    const existingEvidence = await ctx.db
      .query("benchmarkEvidence")
      .withIndex("by_machine", (q) => q.eq("machineId", machine._id))
      .unique();
    if (existingEvidence === null) {
      await ctx.db.insert("benchmarkEvidence", { machineId: machine._id, benchmark });
    } else {
      await ctx.db.patch(existingEvidence._id, { benchmark });
    }
    await ctx.db.patch(machine._id, {
      benchmark: { measuredAt: benchmark.measuredAt, scores: benchmark.scores },
      slotPolicy,
      configuredSlots,
      resourceRecommendedSlots: resourceSlots,
      recommendedSlots,
      maxSlots,
    });
    await ctx.scheduler.runAfter(0, internal.attemptScheduler.tryAssign, {});
    return { maxSlots, recommendedSlots, scores: benchmark.scores };
  },
});

export const pendingAttempts = query({
  args: { token: v.string() },
  returns: v.object({
    maxSlots: v.number(),
    attempts: v.array(
      v.object({
        attemptId: v.id("attempts"),
        runnerName: v.string(),
      }),
    ),
    liveAttemptIds: v.array(v.id("attempts")),
  }),
  handler: async (ctx, args) => {
    const machine = await machineForToken(ctx, args.token);
    const now = Date.now();
    // This subscription re-runs on every heartbeat (the lastSeen patch dirties
    // the machines row), so the completed range must stay bounded: only the
    // drain window matters, while the machine's full completed history grows
    // without limit.
    const ranges = await Promise.all([
      ...ACTIVE_ATTEMPT_STATES.map((state) =>
        ctx.db
          .query("attempts")
          .withIndex("by_machine_state_finishedAt", (q) =>
            q.eq("machineId", machine._id).eq("state", state),
          )
          .collect(),
      ),
      ctx.db
        .query("attempts")
        .withIndex("by_machine_state_finishedAt", (q) =>
          q
            .eq("machineId", machine._id)
            .eq("state", "completed")
            .gt("finishedAt", now - completedExecutorDrainMs),
        )
        .collect(),
    ]);
    const owned = ranges.flat();
    return {
      maxSlots: machine.maxSlots,
      attempts: owned
        .filter((attempt) => attempt.state === "pending")
        .map((attempt) => ({ attemptId: attempt._id, runnerName: attempt.runnerName })),
      liveAttemptIds: owned
        .filter(
          (attempt) =>
            attempt.state === "pending" ||
            attempt.state === "preparing" ||
            attempt.state === "ready" ||
            attempt.state === "running" ||
            (attempt.state === "completed" && attempt.executorFinishedAt === undefined),
        )
        .map((attempt) => attempt._id),
    };
  },
});

export const pendingExperiments = query({
  args: { token: v.string() },
  returns: v.object({
    maxSlots: v.number(),
    experiments: v.array(
      v.object({
        experimentId: v.id("experiments"),
        name: v.string(),
      }),
    ),
    liveExperimentIds: v.array(v.id("experiments")),
  }),
  handler: async (ctx, args) => {
    const machine = await machineForToken(ctx, args.token);
    const ranges = await Promise.all(
      ACTIVE_EXPERIMENT_STATES.map((state) =>
        ctx.db
          .query("experiments")
          .withIndex("by_machine_state", (q) => q.eq("machineId", machine._id).eq("state", state))
          .collect(),
      ),
    );
    const owned = ranges.flat();
    return {
      maxSlots: machine.maxSlots,
      experiments: owned
        .filter((experiment) => experiment.state === "queued")
        .map((experiment) => ({ experimentId: experiment._id, name: experiment.name })),
      liveExperimentIds: owned
        .filter(
          (experiment) =>
            experiment.state === "queued" ||
            experiment.state === "preparing" ||
            experiment.state === "running",
        )
        .map((experiment) => experiment._id),
    };
  },
});

export const claimExperiment = mutation({
  args: { token: v.string(), experimentId: v.id("experiments") },
  returns: v.union(
    v.null(),
    v.object({
      name: v.string(),
      profile: v.string(),
      executor: v.literal("firecracker"),
      imageRelease: v.string(),
      vcpus: v.number(),
      memoryMiB: v.number(),
      command: v.array(v.string()),
      timeoutSeconds: v.number(),
      egress: profileEgressValidator,
    }),
  ),
  handler: async (ctx, args) => {
    const machine = await machineForToken(ctx, args.token);
    const experiment = await ctx.db.get(args.experimentId);
    if (
      experiment === null ||
      experiment.machineId !== machine._id ||
      experiment.state !== "queued"
    ) {
      return null;
    }
    await ctx.db.patch(experiment._id, {
      state: "preparing",
      claimedAt: Date.now(),
    });
    return {
      name: experiment.name,
      profile: experiment.profile,
      executor: experiment.executor,
      imageRelease: experiment.imageRelease,
      vcpus: experiment.vcpus,
      memoryMiB: experiment.memoryMiB,
      command: experiment.command,
      timeoutSeconds: experiment.timeoutSeconds,
      egress: await claimEgress(ctx, experiment.profile),
    };
  },
});

export const markExperimentRunning = mutation({
  args: { token: v.string(), experimentId: v.id("experiments") },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const machine = await machineForToken(ctx, args.token);
    const experiment = await ctx.db.get(args.experimentId);
    if (
      experiment === null ||
      experiment.machineId !== machine._id ||
      experiment.state !== "preparing"
    ) {
      return false;
    }
    await ctx.db.patch(experiment._id, { state: "running", startedAt: Date.now() });
    return true;
  },
});

export const reportExperiment = mutation({
  args: {
    token: v.string(),
    experimentId: v.id("experiments"),
    exitCode: v.number(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    if (!Number.isInteger(args.exitCode)) throw new ConvexError("Exit code must be an integer");
    const machine = await machineForToken(ctx, args.token);
    const experiment = await ctx.db.get(args.experimentId);
    if (experiment === null || experiment.machineId !== machine._id) return false;
    if (
      experiment.state === "completed" ||
      experiment.state === "cancelled" ||
      experiment.state === "failed"
    ) {
      return true;
    }
    await releaseMachineSlot(ctx, experiment.machineId);
    await ctx.db.patch(experiment._id, {
      state: args.exitCode === 0 ? "completed" : "failed",
      exitCode: args.exitCode,
      finishedAt: Date.now(),
      lastError: args.exitCode === 0 ? undefined : `Experiment exited with code ${args.exitCode}`,
    });
    await ctx.scheduler.runAfter(0, internal.attemptScheduler.tryAssign, {});
    return true;
  },
});

export const claimAttempt = mutation({
  args: { token: v.string(), attemptId: v.id("attempts") },
  returns: v.union(
    v.null(),
    v.object({
      runnerName: v.string(),
      profile: v.string(),
      executor: executorValidator,
      imageRelease: v.string(),
      vcpus: v.number(),
      memoryMiB: v.number(),
      jitConfig: v.string(),
      egress: profileEgressValidator,
    }),
  ),
  handler: async (ctx, args) => {
    const machine = await machineForToken(ctx, args.token);
    const attempt = await ctx.db.get(args.attemptId);
    if (attempt === null || attempt.machineId !== machine._id || attempt.state !== "pending") {
      return null;
    }
    // This is the only read of the new secret row. The mutation returns the
    // value and deletes it atomically, so a second claim cannot recover it.
    const secret = await ctx.db
      .query("attemptSecrets")
      .withIndex("by_attempt", (q) => q.eq("attemptId", attempt._id))
      .unique();
    if (secret === null) return null;
    const jitConfig = secret.jitConfig;
    await ctx.db.delete(secret._id);
    await ctx.db.patch(attempt._id, {
      state: "preparing",
      claimedAt: Date.now(),
    });
    return {
      runnerName: attempt.runnerName,
      profile: attempt.profile,
      executor: attempt.executor,
      imageRelease: attempt.imageRelease,
      vcpus: attempt.vcpus,
      memoryMiB: attempt.memoryMiB,
      jitConfig,
      egress: await claimEgress(ctx, attempt.profile),
    };
  },
});

export const markReady = mutation({
  args: { token: v.string(), attemptId: v.id("attempts") },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const machine = await machineForToken(ctx, args.token);
    const attempt = await ctx.db.get(args.attemptId);
    if (attempt === null || attempt.machineId !== machine._id || attempt.state !== "preparing") {
      return false;
    }
    await ctx.db.patch(attempt._id, { state: "ready", readyAt: Date.now() });
    return true;
  },
});

/**
 * Whether an Attempt's Runner may still be registered with GitHub after its executor exited, so
 * the controller must delete it (`listRunnerCleanups`). GitHub removes an ephemeral Runner itself
 * only once the Runner has run a job, so the registration outlives the executor when:
 *
 * - the Attempt never reached `running`: no JobStarted, so GitHub never handed the Runner a job.
 *   The executor's exit code says nothing here. A Firecracker guest resets cleanly and reports 0
 *   whatever the runner did, so a runner GitHub refused at session start (a deprecated version)
 *   used to end `completed` with its registration left behind, one per Attempt;
 * - the executor failed, so the job may not have finished;
 * - the Attempt was retiring.
 *
 * Deleting a Runner GitHub already removed succeeds (githubscale.Issuer.RemoveRunner), so asking
 * for a delete that turns out to be unneeded costs one API call.
 */
function runnerOutlivesExecutor(attempt: Doc<"attempts">, exitCode: number) {
  return attempt.state !== "running" || exitCode !== 0 || attempt.retirement !== undefined;
}

/**
 * How the guest's GitHub runner ended, as the Firecracker guest reports it
 * (apps/runtime/internal/runnerexit). Agents, runtimes and guests that predate it send none.
 */
const runnerExitValidator = v.object({
  exitCode: v.number(),
  // The runner started a job: the guest found a Worker log in its diagnostic folder.
  ranJob: v.boolean(),
  // The last error line of the runner's diagnostic log, sanitized by the guest.
  diagnostic: v.optional(v.string()),
});
type RunnerExit = Infer<typeof runnerExitValidator>;

const MAX_RUNNER_DIAGNOSTIC_CHARS = 300;

/**
 * Why an Attempt failed when its runner exited without ever taking a job, or undefined when it
 * did not. Both sides must agree: GitHub never reported a JobStarted (the Attempt is not
 * `running`), and the guest saw no job either, which covers a JobStarted still on its way for a
 * job that ran. Such a runner registered, was refused or gave up, and left the job queued: a
 * runner version GitHub has deprecated exits like this seconds after it starts, for every
 * Attempt. Without the guest's report the Attempt ends as it always did.
 */
function joblessRunnerFailure(
  attempt: Pick<Doc<"attempts">, "state">,
  runnerExit: RunnerExit | undefined,
) {
  if (runnerExit === undefined || runnerExit.ranJob || attempt.state === "running") {
    return undefined;
  }
  // The Agent passes on what the guest wrote. The guest sanitized it; the control plane bounds it
  // again because it is shown in the dashboard, the CLI and alert notifications.
  const diagnostic = Array.from(
    // oxlint-disable-next-line no-control-regex -- stripping control characters is the point
    (runnerExit.diagnostic ?? "").replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").trim(),
  )
    .slice(0, MAX_RUNNER_DIAGNOSTIC_CHARS)
    .join("");
  return (
    `GitHub runner exited with code ${runnerExit.exitCode} without taking a job` +
    (diagnostic === "" ? "" : `: ${diagnostic}`)
  );
}

export const reportAttempt = mutation({
  args: {
    token: v.string(),
    attemptId: v.id("attempts"),
    exitCode: v.number(),
    // What the guest talked to, for an audit or allowlist Profile. Older
    // Agents send none.
    egress: v.optional(egressRecordValidator),
    runnerExit: v.optional(runnerExitValidator),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    if (!Number.isInteger(args.exitCode)) throw new ConvexError("Exit code must be an integer");
    const runnerExitCode = args.runnerExit?.exitCode;
    if (
      runnerExitCode !== undefined &&
      !(Number.isInteger(runnerExitCode) && runnerExitCode >= 0 && runnerExitCode <= 255)
    ) {
      throw new ConvexError("runnerExit exit code must be an integer from 0 to 255");
    }
    const machine = await machineForToken(ctx, args.token);
    const attempt = await ctx.db.get(args.attemptId);
    if (attempt === null || attempt.machineId !== machine._id) return false;
    const executorFinishedAt = Date.now();
    if (args.egress !== undefined) {
      const existing = await ctx.db
        .query("attemptEgress")
        .withIndex("by_attempt", (q) => q.eq("attemptId", attempt._id))
        .unique();
      const row = {
        attemptId: attempt._id,
        machineId: machine._id,
        profile: attempt.profile,
        recordedAt: executorFinishedAt,
        record: boundedEgressRecord(args.egress),
      };
      if (existing === null) await ctx.db.insert("attemptEgress", row);
      else await ctx.db.replace(existing._id, row);
    }
    if (
      attempt.state === "completed" ||
      attempt.state === "cancelled" ||
      attempt.state === "failed"
    ) {
      await deleteAttemptSecret(ctx, attempt._id);
      await ctx.db.patch(attempt._id, {
        executorFinishedAt,
        executorExitCode: args.exitCode,
      });
      return true;
    }
    await releaseAttemptSlot(ctx, attempt);
    await deleteAttemptSecret(ctx, attempt._id);
    const retirement = attempt.retirement;
    if (retirement !== undefined && attempt.state !== "running") {
      // An idle Runner that exits while retiring most likely saw GitHub delete it before the
      // controller acknowledged the delete. It ends as the retirement asked, not as a failure the
      // failure-rate alert would count; the controller's delete of a Runner already gone succeeds.
      await ctx.db.patch(attempt._id, {
        state: retirement.outcome,
        executorFinishedAt,
        executorExitCode: args.exitCode,
        finishedAt: executorFinishedAt,
        ...(retirement.outcome === "cancelled"
          ? { cancelReason: retirement.reason }
          : { lastError: retirement.reason }),
        runnerCleanupPending: true,
        retirement: undefined,
      });
      await ctx.scheduler.runAfter(0, internal.attemptScheduler.tryAssign, {});
      return true;
    }
    const runnerFailure = joblessRunnerFailure(attempt, args.runnerExit);
    await ctx.db.patch(attempt._id, {
      state: args.exitCode === 0 && runnerFailure === undefined ? "completed" : "failed",
      executorFinishedAt,
      executorExitCode: args.exitCode,
      finishedAt: executorFinishedAt,
      lastError:
        runnerFailure ??
        (args.exitCode === 0 ? undefined : `Executor exited with code ${args.exitCode}`),
      runnerCleanupPending: runnerOutlivesExecutor(attempt, args.exitCode) ? true : undefined,
      retirement: undefined,
    });
    await ctx.scheduler.runAfter(0, internal.attemptScheduler.tryAssign, {});
    return true;
  },
});

/**
 * A Worker's resource snapshot for an Attempt it runs: sent every 30 seconds while the Attempt
 * runs and once more, `final`, after its executor exits. Never on the path that settles the
 * Attempt; `reportAttempt` does not wait for it and a rejected upload costs only the chart.
 */
export const reportAttemptMetrics = mutation({
  args: {
    token: v.string(),
    attemptId: v.id("attempts"),
    final: v.boolean(),
    snapshot: metricsSnapshotValidator,
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const machine = await machineForToken(ctx, args.token);
    return recordAttemptMetrics(ctx, machine._id, args);
  },
});

/**
 * The JUnit results the guest reported for an Attempt, sent once by the Agent after
 * reportAttempt. Returns false when the Attempt is not this Worker's or no longer accepts writes.
 */
export const reportAttemptTests = mutation({
  args: {
    token: v.string(),
    attemptId: v.id("attempts"),
    report: testReportValidator,
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const machine = await machineForToken(ctx, args.token);
    return recordAttemptTests(ctx, machine._id, args);
  },
});

export const reportReadiness = mutation({
  args: {
    token: v.string(),
    profile: v.string(),
    executor: executorValidator,
    imageRelease: v.string(),
    vcpus: v.optional(v.number()),
    memoryMiB: v.optional(v.number()),
    state: v.union(v.literal("preparing"), v.literal("ready"), v.literal("failed")),
    statusDetail: v.optional(v.string()),
    error: v.optional(v.string()),
    ...readinessFactsValidator,
  },
  returns: v.object({
    state: readinessStateValidator,
  }),
  handler: async (ctx, args) => {
    const machine = await machineForToken(ctx, args.token);
    const profile = await ctx.db
      .query("profiles")
      .withIndex("by_name", (q) => q.eq("name", args.profile))
      .unique();
    if (
      profile === null ||
      profile.state !== "active" ||
      profile.executor !== args.executor ||
      profile.imageRelease !== args.imageRelease ||
      (args.vcpus !== undefined && args.vcpus !== profile.vcpus) ||
      (args.memoryMiB !== undefined && args.memoryMiB !== profile.memoryMiB) ||
      ((profile.warmPool ?? 0) > 0 && (args.vcpus === undefined || args.memoryMiB === undefined)) ||
      (args.warmPool !== undefined && args.warmPool.target !== (profile.warmPool ?? 0)) ||
      (args.state === "ready" && (profile.warmPool ?? 0) > 0 && args.warmPool === undefined)
    ) {
      throw new ConvexError("Readiness does not match an active Profile contract");
    }
    const missing = missingHostLabels(profile.workerLabels, machine.labels);
    if (missing.length > 0) {
      throw new ConvexError(`Readiness refused: ${missingHostLabelsDetail(missing)}`);
    }
    // A Worker measures its own host, so the control plane cannot re-run these
    // checks. It can, and does, refuse a report that contradicts itself.
    assertReadinessContract(args.state, args.executor, args, profileEgressOf(profile));
    const existing = await ctx.db
      .query("workerReadiness")
      .withIndex("by_machine_profile", (q) =>
        q.eq("machineId", machine._id).eq("profile", args.profile),
      )
      .unique();
    const existingEvidence = await ctx.db
      .query("readinessEvidence")
      .withIndex("by_machine_profile", (q) =>
        q.eq("machineId", machine._id).eq("profile", args.profile),
      )
      .unique();
    const checkedAt = Date.now();
    const sameContract =
      existing !== null &&
      existing.executor === args.executor &&
      existing.imageRelease === args.imageRelease &&
      (existing.vcpus ?? profile.vcpus) === profile.vcpus &&
      (existing.memoryMiB ?? profile.memoryMiB) === profile.memoryMiB &&
      (existing.warmPool?.target ?? 0) === (profile.warmPool ?? 0);
    const preparedAt =
      args.state === "ready" ? checkedAt : sameContract ? existing.preparedAt : undefined;
    // "Degraded" means this exact contract once passed and no longer does. It
    // remains fail-closed: the scheduler admits only state="ready". A first
    // failure is "failed" because there is no successful baseline to regress.
    const state: Doc<"workerReadiness">["state"] =
      args.state === "failed" && preparedAt !== undefined ? "degraded" : args.state;
    const patch = {
      profile: args.profile,
      executor: args.executor,
      imageRelease: args.imageRelease,
      vcpus: args.vcpus,
      memoryMiB: args.memoryMiB,
      state,
      checkedAt,
      preparedAt,
      // Placement reads only these storage facts. The rest goes to readinessEvidence below.
      storage: placementStorageOf(args.storage),
      warmPool: args.warmPool ?? (sameContract ? existing?.warmPool : undefined),
    };
    if (existing === null) {
      await ctx.db.insert("workerReadiness", { machineId: machine._id, ...patch });
    } else {
      await ctx.db.patch(existing._id, patch);
    }
    const evidence = {
      machineId: machine._id,
      profile: args.profile,
      executor: args.executor,
      imageRelease: args.imageRelease,
      vcpus: args.vcpus,
      memoryMiB: args.memoryMiB,
      checkedAt,
      statusDetail: args.statusDetail?.slice(0, 1_000),
      lastError: args.error?.slice(0, 1_000),
      isolation: args.isolation,
      boundary: args.boundary,
      checks: args.checks?.slice(0, 32),
      cacheScope: args.cacheScope,
      cacheSharedWritable: args.cacheSharedWritable,
      hardware: args.hardware,
      storage: args.storage,
      network: args.network,
      warmPool: args.warmPool,
      // A property of the image, so a report that could not read it (a failed preflight) keeps
      // what an earlier report for the same Image Release said.
      runnerVersion:
        runnerVersionOf(args.runnerVersion) ??
        (existingEvidence?.imageRelease === args.imageRelease
          ? existingEvidence.runnerVersion
          : undefined),
    };
    if (existingEvidence === null) {
      await ctx.db.insert("readinessEvidence", evidence);
    } else {
      await ctx.db.patch(existingEvidence._id, evidence);
    }
    if (args.state === "ready") {
      await ctx.scheduler.runAfter(0, internal.attemptScheduler.tryAssign, {});
    }
    return { state };
  },
});

const updateReadinessValidator = v.object({
  profile: v.string(),
  // "unreported": the Worker has no report for the Profile's current executor and Image Release.
  state: v.union(readinessStateValidator, v.literal("unreported")),
  checkedAt: v.optional(v.number()),
  failedChecks: v.array(v.string()),
  detail: v.optional(v.string()),
});

/**
 * This Worker's readiness for every Profile it serves, judged the way the scheduler and the
 * dashboard judge it: a ready report whose evidence fails admission reads as degraded. The Worker
 * installer reads it through GET /agents/readiness before and after it replaces the Action Runner
 * Agent, and rolls the update back when a Profile that was ready does not report ready again.
 */
export const readiness = query({
  args: { token: v.string() },
  returns: v.array(updateReadinessValidator),
  handler: async (ctx, args) => {
    const machine = await machineForToken(ctx, args.token);
    const served = await servedProfiles(ctx, machine);
    return Promise.all(
      served.map(async (profile): Promise<Infer<typeof updateReadinessValidator>> => {
        const row = await ctx.db
          .query("workerReadiness")
          .withIndex("by_machine_profile", (q) =>
            q.eq("machineId", machine._id).eq("profile", profile.name),
          )
          .unique();
        if (
          row === null ||
          row.executor !== profile.executor ||
          row.imageRelease !== profile.imageRelease
        ) {
          return { profile: profile.name, state: "unreported", failedChecks: [] };
        }
        const evidence =
          (await ctx.db
            .query("readinessEvidence")
            .withIndex("by_machine_profile", (q) =>
              q.eq("machineId", machine._id).eq("profile", profile.name),
            )
            .unique()) ?? undefined;
        const current = evidence?.checkedAt === row.checkedAt ? evidence : undefined;
        const egress = profileEgressOf(profile);
        const failedChecks = (current?.checks ?? [])
          .filter((check) => !check.passed)
          .map((check) => (check.detail ? `${check.name}: ${check.detail}` : check.name));
        const detail =
          current?.lastError ??
          readinessAdmissionError(row, evidence, egress) ??
          current?.statusDetail;
        return {
          profile: profile.name,
          state: effectiveReadinessState(row, evidence, egress),
          checkedAt: row.checkedAt,
          failedChecks,
          ...(detail === undefined ? {} : { detail }),
        };
      }),
    );
  },
});
