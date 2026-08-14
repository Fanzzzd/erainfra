import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import { internalMutation, internalQuery } from "./_generated/server";
import { releaseAttemptSlot } from "./attemptScheduler";
import { deleteAttemptSecret } from "./attemptSecrets";
import { fitPolicyValidator } from "./benchmark";

const activeAttemptState = v.union(
  v.literal("pending"),
  v.literal("preparing"),
  v.literal("ready"),
  v.literal("running"),
);

const terminalStates = new Set(["completed", "cancelled", "failed"]);
const activeAttemptStates = ["pending", "preparing", "ready", "running"] as const;

export const registerProfile = internalMutation({
  args: {
    name: v.string(),
    scaleSetName: v.string(),
    executor: v.union(
      v.literal("docker"),
      v.literal("firecracker"),
      v.literal("tart"),
      v.literal("hyperv"),
    ),
    imageRelease: v.string(),
    vcpus: v.number(),
    memoryMiB: v.number(),
    fitPolicy: v.optional(fitPolicyValidator),
    minRunners: v.number(),
    maxRunners: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("profiles")
      .withIndex("by_name", (q) => q.eq("name", args.name))
      .unique();
    const value = {
      ...args,
      fitPolicy: args.fitPolicy ?? "balanced",
      state: "active" as const,
      updatedAt: Date.now(),
    };
    if (existing === null) {
      await ctx.db.insert("profiles", value);
    } else {
      await ctx.db.patch(existing._id, value);
    }
    return null;
  },
});

export const listActiveAttempts = internalQuery({
  args: { profile: v.string() },
  returns: v.array(
    v.object({
      runnerName: v.string(),
      runnerId: v.number(),
      state: activeAttemptState,
      createdAt: v.number(),
    }),
  ),
  handler: async (ctx, args) => {
    const ranges = await Promise.all(
      activeAttemptStates.map(async (state) => {
        const attempts = await ctx.db
          .query("attempts")
          .withIndex("by_profile_state", (query) =>
            query.eq("profile", args.profile).eq("state", state),
          )
          .collect();
        return attempts.map(({ runnerName, runnerId, createdAt }) => ({
          runnerName,
          runnerId,
          state,
          createdAt,
        }));
      }),
    );
    return ranges.flat();
  },
});

export const listRunnerCleanups = internalQuery({
  args: { profile: v.string() },
  returns: v.array(
    v.object({
      runnerName: v.string(),
      runnerId: v.number(),
    }),
  ),
  handler: async (ctx, args) => {
    const attempts = await ctx.db
      .query("attempts")
      .withIndex("by_profile_cleanupPending", (query) =>
        query.eq("profile", args.profile).eq("runnerCleanupPending", true),
      )
      .collect();
    return attempts.map(({ runnerName, runnerId }) => ({ runnerName, runnerId }));
  },
});

export const completeRunnerCleanup = internalMutation({
  args: {
    profile: v.string(),
    runnerName: v.string(),
    runnerId: v.number(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const attempt = await ctx.db
      .query("attempts")
      .withIndex("by_runnerName", (query) => query.eq("runnerName", args.runnerName))
      .unique();
    if (
      attempt === null ||
      attempt.profile !== args.profile ||
      attempt.runnerId !== args.runnerId
    ) {
      return false;
    }
    if (attempt.runnerCleanupPending !== true) return true;
    await ctx.db.patch(attempt._id, { runnerCleanupPending: undefined });
    return true;
  },
});

export const createAttempt = internalMutation({
  args: {
    profile: v.string(),
    executor: v.union(
      v.literal("docker"),
      v.literal("firecracker"),
      v.literal("tart"),
      v.literal("hyperv"),
    ),
    imageRelease: v.string(),
    vcpus: v.number(),
    memoryMiB: v.number(),
    runnerName: v.string(),
    runnerId: v.number(),
    encodedJITConfig: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const profile = await ctx.db
      .query("profiles")
      .withIndex("by_name", (q) => q.eq("name", args.profile))
      .unique();
    if (
      profile === null ||
      profile.state !== "active" ||
      profile.executor !== args.executor ||
      profile.imageRelease !== args.imageRelease ||
      profile.vcpus !== args.vcpus ||
      profile.memoryMiB !== args.memoryMiB
    ) {
      throw new ConvexError("Attempt does not match the registered Profile contract");
    }
    const existing = await ctx.db
      .query("attempts")
      .withIndex("by_runnerName", (query) => query.eq("runnerName", args.runnerName))
      .unique();
    if (existing !== null) {
      if (
        existing.profile === args.profile &&
        existing.executor === args.executor &&
        existing.imageRelease === args.imageRelease &&
        existing.vcpus === args.vcpus &&
        existing.memoryMiB === args.memoryMiB &&
        existing.runnerId === args.runnerId
      ) {
        return null;
      }
      throw new ConvexError("Runner name already belongs to another Attempt");
    }
    const attemptId = await ctx.db.insert("attempts", {
      profile: args.profile,
      executor: args.executor,
      imageRelease: args.imageRelease,
      vcpus: args.vcpus,
      memoryMiB: args.memoryMiB,
      runnerName: args.runnerName,
      runnerId: args.runnerId,
      state: "pending",
      createdAt: Date.now(),
    });
    await ctx.db.insert("attemptSecrets", {
      attemptId,
      jitConfig: args.encodedJITConfig,
      createdAt: Date.now(),
    });
    await ctx.scheduler.runAfter(0, internal.attemptScheduler.tryAssign, {});
    return null;
  },
});

export const cancelAttempt = internalMutation({
  args: {
    profile: v.string(),
    runnerName: v.string(),
    reason: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const attempt = await ctx.db
      .query("attempts")
      .withIndex("by_runnerName", (query) => query.eq("runnerName", args.runnerName))
      .unique();
    if (attempt === null || attempt.profile !== args.profile || terminalStates.has(attempt.state)) {
      return null;
    }
    if (attempt.state === "running") {
      throw new ConvexError("A running Attempt cannot be removed by a scale-down reconciliation");
    }
    await releaseAttemptSlot(ctx, attempt);
    await deleteAttemptSecret(ctx, attempt._id);
    await ctx.db.patch(attempt._id, {
      state: "cancelled",
      jitConfig: undefined,
      cancelReason: args.reason.slice(0, 500),
      finishedAt: Date.now(),
      runnerCleanupPending: true,
    });
    await ctx.scheduler.runAfter(0, internal.attemptScheduler.tryAssign, {});
    return null;
  },
});

export const markJobStarted = internalMutation({
  args: {
    profile: v.string(),
    runnerName: v.string(),
    runnerRequestId: v.optional(v.string()),
    repository: v.optional(v.string()),
    owner: v.optional(v.string()),
    jobId: v.optional(v.string()),
    workflowRef: v.optional(v.string()),
    displayName: v.optional(v.string()),
    workflowRunId: v.optional(v.number()),
    eventName: v.optional(v.string()),
    queueTime: v.optional(v.number()),
    assignedAt: v.optional(v.number()),
    runnerAssignedAt: v.optional(v.number()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const attempt = await ctx.db
      .query("attempts")
      .withIndex("by_runnerName", (query) => query.eq("runnerName", args.runnerName))
      .unique();
    if (attempt === null || attempt.profile !== args.profile) {
      throw new ConvexError("Job started for an unknown Attempt");
    }
    if (terminalStates.has(attempt.state)) {
      return null;
    }
    await ctx.db.patch(attempt._id, {
      state: "running",
      startedAt: attempt.startedAt ?? Date.now(),
      ...(args.runnerRequestId === undefined ? {} : { runnerRequestId: args.runnerRequestId }),
      ...(args.repository === undefined ? {} : { repo: args.repository }),
      ...(args.owner === undefined ? {} : { owner: args.owner }),
      ...(args.jobId === undefined ? {} : { jobId: args.jobId }),
      ...(args.workflowRef === undefined ? {} : { workflowRef: args.workflowRef }),
      ...(args.displayName === undefined ? {} : { displayName: args.displayName }),
      ...(args.workflowRunId === undefined ? {} : { workflowRunId: args.workflowRunId }),
      ...(args.eventName === undefined ? {} : { eventName: args.eventName }),
      queueTime: args.queueTime,
      assignedAt: args.assignedAt,
      runnerAssignedAt: args.runnerAssignedAt,
    });
    return null;
  },
});

export const markJobCompleted = internalMutation({
  args: {
    profile: v.string(),
    runnerName: v.string(),
    runnerRequestId: v.optional(v.string()),
    jobId: v.optional(v.string()),
    result: v.optional(v.string()),
    finishedAt: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const attempt = await ctx.db
      .query("attempts")
      .withIndex("by_runnerName", (query) => query.eq("runnerName", args.runnerName))
      .unique();
    if (attempt === null || attempt.profile !== args.profile) {
      throw new ConvexError("Job completed for an unknown Attempt");
    }
    if (!terminalStates.has(attempt.state)) {
      await releaseAttemptSlot(ctx, attempt);
    }
    await deleteAttemptSecret(ctx, attempt._id);
    await ctx.db.patch(attempt._id, {
      state: "completed",
      jitConfig: undefined,
      runnerCleanupPending: undefined,
      ...(args.runnerRequestId === undefined ? {} : { runnerRequestId: args.runnerRequestId }),
      ...(args.jobId === undefined ? {} : { jobId: args.jobId }),
      ...(args.result === undefined ? {} : { result: args.result }),
      finishedAt: args.finishedAt,
    });
    await ctx.scheduler.runAfter(0, internal.attemptScheduler.tryAssign, {});
    return null;
  },
});
