import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import { mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { releaseAttemptSlot, releaseMachineSlot } from "./attemptScheduler";
import { deleteAttemptSecret } from "./attemptSecrets";
import {
  benchmarkRecommendedSlots,
  benchmarkReportValidator,
  benchmarkScoresValidator,
  isStoredBenchmark,
  normalizeBenchmark,
  resourceRecommendedSlots,
} from "./benchmark";
import { assertReadinessContract, readinessFactsValidator } from "./isolation";

const completedExecutorDrainMs = 30_000;
const liveAttemptStates = ["pending", "preparing", "ready", "running"] as const;
const liveExperimentStates = ["queued", "preparing", "running"] as const;

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
});

async function machineForToken(ctx: QueryCtx | MutationCtx, token: string) {
  const machine = await ctx.db
    .query("machines")
    .withIndex("by_token", (q) => q.eq("token", token))
    .unique();
  if (machine === null) throw new ConvexError("Invalid machine token");
  return machine;
}

export const profiles = query({
  args: { token: v.string() },
  returns: v.array(profileSpecValidator),
  handler: async (ctx, args) => {
    const machine = await machineForToken(ctx, args.token);
    const compatibleExecutors =
      machine.os === "linux"
        ? new Set(["docker", "firecracker"])
        : new Set([machine.os === "mac" ? "tart" : "hyperv"]);
    return (
      await ctx.db
        .query("profiles")
        .withIndex("by_state", (q) => q.eq("state", "active"))
        .collect()
    )
      .filter((profile) => compatibleExecutors.has(profile.executor))
      .toSorted((left, right) => left.name.localeCompare(right.name))
      .map((profile) => ({
        profile: profile.name,
        executor: profile.executor,
        imageRelease: profile.imageRelease,
        vcpus: profile.vcpus,
        memoryMiB: profile.memoryMiB,
        warmPool: profile.warmPool ?? 0,
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
    const resourceSlots = resourceRecommendedSlots(machine.os, args.cpus, args.memoryMiB);
    const evidence = await ctx.db
      .query("benchmarkEvidence")
      .withIndex("by_machine", (q) => q.eq("machineId", machine._id))
      .unique();
    // During the no-migration rollout, a machine may have either a legacy full
    // inline benchmark or the new summary + evidence shape.
    const benchmark =
      evidence?.benchmark ?? (isStoredBenchmark(machine.benchmark) ? machine.benchmark : undefined);
    const recommendedSlots = benchmarkRecommendedSlots(resourceSlots, benchmark, now);
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
        ? resourceRecommendedSlots(machine.os, machine.cpus, machine.memoryMiB)
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
      // Write the compact hot shape on the next report; the schema still
      // accepts an old full report for one refresh cycle, so no migration runs.
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
    const ranges = await Promise.all(
      [...liveAttemptStates, "completed" as const].map((state) =>
        ctx.db
          .query("attempts")
          .withIndex("by_machine_state", (q) => q.eq("machineId", machine._id).eq("state", state))
          .collect(),
      ),
    );
    const owned = ranges.flat();
    const now = Date.now();
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
            (attempt.state === "completed" &&
              attempt.executorFinishedAt === undefined &&
              attempt.finishedAt !== undefined &&
              now - attempt.finishedAt < completedExecutorDrainMs),
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
      liveExperimentStates.map((state) =>
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
    const jitConfig = secret?.jitConfig ?? attempt.jitConfig;
    if (jitConfig === undefined) return null;
    if (secret !== null) await ctx.db.delete(secret._id);
    await ctx.db.patch(attempt._id, {
      state: "preparing",
      claimedAt: Date.now(),
      jitConfig: undefined,
    });
    return {
      runnerName: attempt.runnerName,
      profile: attempt.profile,
      executor: attempt.executor,
      imageRelease: attempt.imageRelease,
      vcpus: attempt.vcpus,
      memoryMiB: attempt.memoryMiB,
      jitConfig,
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

export const reportAttempt = mutation({
  args: {
    token: v.string(),
    attemptId: v.id("attempts"),
    exitCode: v.number(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    if (!Number.isInteger(args.exitCode)) throw new ConvexError("Exit code must be an integer");
    const machine = await machineForToken(ctx, args.token);
    const attempt = await ctx.db.get(args.attemptId);
    if (attempt === null || attempt.machineId !== machine._id) return false;
    const executorFinishedAt = Date.now();
    if (
      attempt.state === "completed" ||
      attempt.state === "cancelled" ||
      attempt.state === "failed"
    ) {
      await deleteAttemptSecret(ctx, attempt._id);
      await ctx.db.patch(attempt._id, {
        jitConfig: undefined,
        executorFinishedAt,
        executorExitCode: args.exitCode,
      });
      return true;
    }
    await releaseAttemptSlot(ctx, attempt);
    await deleteAttemptSecret(ctx, attempt._id);
    await ctx.db.patch(attempt._id, {
      state: args.exitCode === 0 ? "completed" : "failed",
      jitConfig: undefined,
      executorFinishedAt,
      executorExitCode: args.exitCode,
      finishedAt: executorFinishedAt,
      lastError: args.exitCode === 0 ? undefined : `Executor exited with code ${args.exitCode}`,
      runnerCleanupPending: args.exitCode === 0 ? undefined : true,
    });
    await ctx.scheduler.runAfter(0, internal.attemptScheduler.tryAssign, {});
    return true;
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
    state: v.union(
      v.literal("preparing"),
      v.literal("ready"),
      v.literal("degraded"),
      v.literal("failed"),
    ),
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
    // A Worker measures its own host, so the control plane cannot re-run these
    // checks. It can, and does, refuse a report that contradicts itself.
    assertReadinessContract(args.state, args.executor, args);
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
      // Scheduling needs only numeric capacity facts. The next report removes
      // legacy evidence fields from this hot row; older rows remain readable
      // for one cycle and dashboard queries fall back to them below.
      storage:
        args.storage === undefined
          ? undefined
          : {
              poolTotalMiB: args.storage.poolTotalMiB,
              poolFreeMiB: args.storage.poolFreeMiB,
            },
      warmPool: args.warmPool ?? (sameContract ? existing?.warmPool : undefined),
      statusDetail: undefined,
      lastError: undefined,
      isolation: undefined,
      boundary: undefined,
      checks: undefined,
      cacheScope: undefined,
      cacheSharedWritable: undefined,
      hardware: undefined,
      network: undefined,
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
