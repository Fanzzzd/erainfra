import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import { mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { releaseAttemptSlot, releaseMachineSlot } from "./attemptScheduler";
import { assertReadinessContract, readinessFactsValidator } from "./isolation";

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
    return (await ctx.db.query("profiles").collect())
      .filter((profile) => profile.state === "active" && compatibleExecutors.has(profile.executor))
      .toSorted((left, right) => left.name.localeCompare(right.name))
      .map((profile) => ({
        profile: profile.name,
        executor: profile.executor,
        imageRelease: profile.imageRelease,
        vcpus: profile.vcpus,
        memoryMiB: profile.memoryMiB,
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
    const cpuSlots = Math.max(1, Math.floor(args.cpus / 4));
    const memorySlots = Math.max(1, Math.floor(args.memoryMiB / 8_192));
    const recommendedSlots =
      machine.os === "linux"
        ? Math.min(16, cpuSlots, memorySlots)
        : machine.os === "mac"
          ? Math.min(2, cpuSlots, memorySlots)
          : 1;
    // Machines registered before slot policies existed are automatic. Only an
    // explicit operator choice is fixed; the first v0.2 heartbeat persists the
    // migrated policy so every later read is unambiguous.
    const slotPolicy = machine.slotPolicy === "fixed" ? "fixed" : "auto";
    const maxSlots =
      slotPolicy === "auto" ? Math.max(machine.usedSlots, recommendedSlots) : machine.maxSlots;
    await ctx.db.patch(machine._id, {
      arch: args.arch.trim(),
      cpus: args.cpus,
      memoryMiB: args.memoryMiB,
      slotPolicy,
      recommendedSlots,
      maxSlots,
    });
    await ctx.scheduler.runAfter(0, internal.attemptScheduler.tryAssign, {});
    return { maxSlots, recommendedSlots };
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
    const attempts = await ctx.db.query("attempts").collect();
    const owned = attempts.filter((attempt) => attempt.machineId === machine._id);
    const now = Date.now();
    return {
      maxSlots: machine.maxSlots,
      attempts: owned
        .filter((attempt) => attempt.state === "pending" && attempt.jitConfig !== undefined)
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
    const experiments = await ctx.db.query("experiments").collect();
    const owned = experiments.filter((experiment) => experiment.machineId === machine._id);
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
    if (
      attempt === null ||
      attempt.machineId !== machine._id ||
      attempt.state !== "pending" ||
      attempt.jitConfig === undefined
    ) {
      return null;
    }
    const jitConfig = attempt.jitConfig;
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
      await ctx.db.patch(attempt._id, { executorFinishedAt, executorExitCode: args.exitCode });
      return true;
    }
    await releaseAttemptSlot(ctx, attempt);
    await ctx.db.patch(attempt._id, {
      state: args.exitCode === 0 ? "completed" : "failed",
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
      profile.imageRelease !== args.imageRelease
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
    const checkedAt = Date.now();
    const sameContract =
      existing !== null &&
      existing.executor === args.executor &&
      existing.imageRelease === args.imageRelease;
    const preparedAt =
      args.state === "ready" ? checkedAt : sameContract ? existing.preparedAt : undefined;
    // "Degraded" means this exact contract once passed and no longer does. It
    // remains fail-closed: the scheduler admits only state="ready". A first
    // failure is "failed" because there is no successful baseline to regress.
    const state: Doc<"workerReadiness">["state"] =
      args.state === "failed" && preparedAt !== undefined ? "degraded" : args.state;
    const patch: Omit<Doc<"workerReadiness">, "_id" | "_creationTime" | "machineId"> = {
      profile: args.profile,
      executor: args.executor,
      imageRelease: args.imageRelease,
      state,
      checkedAt,
      preparedAt,
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
    };
    if (existing === null) {
      await ctx.db.insert("workerReadiness", { machineId: machine._id, ...patch });
    } else {
      await ctx.db.patch(existing._id, patch);
    }
    if (args.state === "ready") {
      await ctx.scheduler.runAfter(0, internal.attemptScheduler.tryAssign, {});
    }
    return { state };
  },
});
