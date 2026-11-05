import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import { internalMutation, internalQuery } from "./_generated/server";
import { releaseAttemptSlot } from "./attemptScheduler";
import { deleteAttemptSecret } from "./attemptSecrets";
import { fitPolicyValidator } from "./benchmark";
import { profileEgressValidator } from "./egress";
import {
  authorizeController,
  authorizeStandbyReport,
  controllerCallerValidator,
  requireControllerToken,
  type ControllerCaller,
} from "./controllerLease";

// Every function below takes the caller its HTTP route resolved, and the lease check runs inside
// the same transaction as the read or write it guards (controllerLease.ts). Every route passes a
// caller. Server code and tests that call these directly pass none: they are not a controller.
const callerArg = v.optional(controllerCallerValidator);

async function authorize(
  ctx: Parameters<typeof authorizeController>[0],
  profile: string,
  caller: ControllerCaller | undefined,
) {
  if (caller === undefined) return;
  await authorizeController(ctx, profile, caller);
}

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
    warmPool: v.optional(v.number()),
    fitPolicy: v.optional(fitPolicyValidator),
    minRunners: v.number(),
    maxRunners: v.number(),
    egress: v.optional(profileEgressValidator),
    githubConfigUrl: v.optional(v.string()),
    githubCacheFacts: v.optional(v.boolean()),
    runnerGroup: v.optional(v.string()),
    labels: v.optional(v.array(v.string())),
    caller: callerArg,
  },
  returns: v.null(),
  handler: async (ctx, { caller, ...args }) => {
    // Only the controller token publishes a Profile. A Worker that could rewrite one could point
    // every other Worker at an image of its choosing, which is more than serving the Profiles it
    // already serves (ADR 0014).
    await authorize(ctx, args.name, caller);
    if (caller !== undefined) requireControllerToken(caller);
    const existing = await ctx.db
      .query("profiles")
      .withIndex("by_name", (q) => q.eq("name", args.name))
      .unique();
    const value = {
      ...args,
      // A controller that predates these fields sends none. Keep what a newer one published rather
      // than erase the settings a standby depends on.
      githubConfigUrl: args.githubConfigUrl ?? existing?.githubConfigUrl,
      // Current registrations replace the whole GitHub contract. In particular Go omits a false
      // bool, so an absent flag must clear a previously granted cache-read permission.
      githubCacheFacts:
        args.githubConfigUrl === undefined
          ? existing?.githubCacheFacts
          : args.githubCacheFacts === true,
      runnerGroup: args.githubConfigUrl === undefined ? existing?.runnerGroup : args.runnerGroup,
      labels: args.githubConfigUrl === undefined ? existing?.labels : args.labels,
      fitPolicy: args.fitPolicy ?? "balanced",
      warmPool: args.warmPool ?? 0,
      // Public is stored as no field at all, the same shape every Profile
      // registered before egress existed has, so one reading covers both. A
      // controller that drops its policy clears it: patch removes an
      // undefined field.
      egress: args.egress === undefined || args.egress.mode === "public" ? undefined : args.egress,
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

// The inverse of registerProfile, for a Profile whose scale set has been retired. A paused Profile
// is invisible to Worker discovery, the scheduler and the /runs-on router, so Workers stop
// prewarming and advertising it. Restarting the Profile's controller registers it as active
// again, which is the intended way to bring a retired Profile back.
//
// The retire command acquires the lease, checks GitHub's busy counters, pauses the Profile, then
// deletes its scale set. No standby can take the lease while it is paused, so no standby can
// recreate the scale set during retirement. The retire process keeps renewing until deletion is
// done, then releases the lease. Restarting a dedicated controller explicitly activates it again.
export const pauseProfile = internalMutation({
  args: { name: v.string(), caller: callerArg },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    if (args.caller !== undefined) {
      await authorize(ctx, args.name, args.caller);
      requireControllerToken(args.caller);
    }
    const existing = await ctx.db
      .query("profiles")
      .withIndex("by_name", (q) => q.eq("name", args.name))
      .unique();
    if (existing === null) return false;
    if (existing.state !== "paused") {
      await ctx.db.patch(existing._id, { state: "paused", updatedAt: Date.now() });
    }
    return true;
  },
});

/**
 * Upserts one controller's report, keyed by Profile and host. Staleness is judged by
 * `receivedAt`, this deployment's clock, never by a time the controller sent: a controller host
 * with a wrong clock must not look alive or dead because of it.
 */
export const recordHeartbeat = internalMutation({
  args: {
    profile: v.string(),
    hostname: v.string(),
    version: v.string(),
    scaleSetId: v.optional(v.number()),
    sessionState: v.union(
      v.literal("starting"),
      v.literal("standby"),
      v.literal("listening"),
      v.literal("conflict"),
      v.literal("stopped"),
    ),
    leaseRole: v.optional(v.union(v.literal("holder"), v.literal("standby"))),
    leaseEpoch: v.optional(v.number()),
    lastMessageAt: v.optional(v.number()),
    startedAt: v.optional(v.number()),
    assignedJobs: v.number(),
    runningJobs: v.number(),
    lastError: v.optional(v.string()),
    tokenSlot: v.union(v.literal("current"), v.literal("next"), v.literal("machine")),
    caller: callerArg,
  },
  returns: v.null(),
  handler: async (ctx, { caller, ...args }) => {
    // A holder's report is a write like any other and must carry the current epoch, so a stale
    // holder learns from the refusal that it lost the lease. A standby's report claims nothing and
    // writes only its own row. A report with no lease state is from a controller built before it.
    if (caller !== undefined) {
      if (args.leaseRole === "holder") {
        await authorizeController(ctx, args.profile, caller);
      } else if (args.leaseRole === "standby") {
        if (caller.epoch !== undefined) await authorizeController(ctx, args.profile, caller);
        await authorizeStandbyReport(ctx, args.profile, caller);
      } else {
        await authorize(ctx, args.profile, caller);
      }
    }
    const now = Date.now();
    const machine =
      caller?.kind === "machine"
        ? await ctx.db
            .query("machines")
            .withIndex("by_token", (q) => q.eq("token", caller.token))
            .unique()
        : null;
    const reporter = machine === null ? `controller:${args.hostname}` : `machine:${machine._id}`;
    let existing = await ctx.db
      .query("controllerHeartbeats")
      .withIndex("by_profile_reporter", (q) =>
        q.eq("profile", args.profile).eq("reporter", reporter),
      )
      .unique();
    // Reuse a dedicated host's pre-lease row once, preserving its outage history. Worker reports
    // never adopt a hostname-keyed row: the name is not proof of identity.
    if (existing === null && machine === null) {
      existing = await ctx.db
        .query("controllerHeartbeats")
        .withIndex("by_profile_hostname", (q) =>
          q.eq("profile", args.profile).eq("hostname", args.hostname),
        )
        .filter((q) => q.eq(q.field("reporter"), undefined))
        .first();
    }
    const report = {
      ...args,
      reporter,
      receivedAt: now,
      // Optional fields are written explicitly so a report that no longer carries one (a
      // restarted controller has no lastMessageAt yet, a recovered one no lastError) clears it.
      scaleSetId: args.scaleSetId,
      lastMessageAt: args.lastMessageAt,
      startedAt: args.startedAt,
      lastError: args.lastError,
      leaseRole: args.leaseRole,
      leaseEpoch: args.leaseEpoch,
      lastListeningAt: args.sessionState === "listening" ? now : existing?.lastListeningAt,
    };
    if (existing === null) {
      await ctx.db.insert("controllerHeartbeats", { ...report, firstSeenAt: now });
    } else {
      await ctx.db.patch(existing._id, report);
    }
    return null;
  },
});

export const listActiveAttempts = internalQuery({
  args: { profile: v.string(), caller: callerArg },
  returns: v.array(
    v.object({
      runnerName: v.string(),
      runnerId: v.number(),
      state: activeAttemptState,
      createdAt: v.number(),
    }),
  ),
  handler: async (ctx, args) => {
    await authorize(ctx, args.profile, args.caller);
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
  args: { profile: v.string(), caller: callerArg },
  returns: v.array(
    v.object({
      runnerName: v.string(),
      runnerId: v.number(),
    }),
  ),
  handler: async (ctx, args) => {
    await authorize(ctx, args.profile, args.caller);
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
    caller: callerArg,
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    await authorize(ctx, args.profile, args.caller);
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
    caller: callerArg,
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await authorize(ctx, args.profile, args.caller);
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
    caller: callerArg,
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await authorize(ctx, args.profile, args.caller);
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
    caller: callerArg,
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await authorize(ctx, args.profile, args.caller);
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
    caller: callerArg,
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await authorize(ctx, args.profile, args.caller);
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
