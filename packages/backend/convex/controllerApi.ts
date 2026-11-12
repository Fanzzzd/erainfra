import { ConvexError, v } from "convex/values";

import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import { internalMutation, internalQuery, type MutationCtx } from "./_generated/server";
import { endIdleAttempt, finishRetirement, isRetiring, keepForJob } from "./attemptRetirement";
import { releaseAttemptSlot } from "./attemptScheduler";
import { deleteAttemptSecret } from "./attemptSecrets";
import { fitPolicyValidator } from "./benchmark";
import {
  authorizeController,
  authorizeStandbyReport,
  controllerCallerValidator,
  requireControllerToken,
  type ControllerCaller,
} from "./controllerLease";
import { profileEgressValidator } from "./egress";
import { retireOffPinForProfile } from "./pinnedAttempts";
import { conflictsOf, type ScaleSetProfile } from "./scaleSetLabels";
import { recordAcquiredJobs, settleScaleSetJob } from "./strandedJobs";

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
    workerLabels: v.optional(v.array(v.string())),
    caller: callerArg,
  },
  // A conflict is refused rather than thrown, so the controller is told why (HTTP 409).
  returns: v.union(v.null(), v.object({ conflict: v.string() })),
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
      // Part of the Profile contract, not of the GitHub registration: every controller sends it,
      // and one that sends none (including one built before ADR 0017) unpins the Profile.
      workerLabels:
        args.workerLabels === undefined || args.workerLabels.length === 0
          ? undefined
          : args.workerLabels,
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
    const introduced = await introducedLabelConflicts(ctx, existing, value);
    if (introduced.added[0] !== undefined) return { conflict: introduced.added[0].reason };
    for (const kept of introduced.kept) {
      // Registered before the control plane refused conflicts. Refusing it now would refuse both
      // Profiles at their next controller restart, so it stays, logged here and raised by the
      // profile-label-conflict alert, the Profile list and `erainfra profiles list` until an
      // operator relabels one side.
      console.warn(
        `Profile ${value.name} registered with an existing label conflict: ${kept.reason}`,
      );
    }
    let profileId = existing?._id;
    if (profileId === undefined) {
      profileId = await ctx.db.insert("profiles", value);
    } else {
      await ctx.db.patch(profileId, value);
    }
    if (existing?.workerLabels?.join(",") !== value.workerLabels?.join(",")) {
      // A new or narrower pin leaves idle Runners on Workers that no longer qualify: retire them
      // so GitHub cannot hand them a job. A wider one can make a queued Attempt placeable.
      const stored = await ctx.db.get(profileId);
      if (stored !== null) await retireOffPinForProfile(ctx, stored);
      await ctx.scheduler.runAfter(0, internal.attemptScheduler.tryAssign, {});
    }
    return null;
  },
});

/**
 * Splits the label conflicts this registration would leave (scaleSetLabels.ts) into those it adds
 * and those that already existed: the stored row was active and conflicted with the same Profile.
 * A new Profile, a paused one coming back, or a label change that adds a conflict is refused; an
 * old conflict is kept so a controller restart does not take both Profiles down.
 */
async function introducedLabelConflicts(
  ctx: MutationCtx,
  existing: Doc<"profiles"> | null,
  value: ScaleSetProfile,
) {
  const others = (
    await ctx.db
      .query("profiles")
      .withIndex("by_state", (q) => q.eq("state", "active"))
      .collect()
  ).filter((other) => other.name !== value.name);
  const before = new Set(
    existing === null || existing.state !== "active"
      ? []
      : conflictsOf(existing, others).map((conflict) => conflict.other),
  );
  const now = conflictsOf(value, others);
  return {
    added: now.filter((conflict) => !before.has(conflict.other)),
    kept: now.filter((conflict) => before.has(conflict.other)),
  };
}

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
        // A retiring Attempt is on its way out: its Runner is being deleted, so it is not capacity
        // the controller can count on. If GitHub hands it a job first, it comes back as running.
        return attempts
          .filter((attempt) => !isRetiring(attempt))
          .map(({ runnerName, runnerId, createdAt }) => ({
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

/**
 * The Runners the controller must delete from GitHub: those of settled Attempts that ended without
 * a JobCompleted, and those of retiring Attempts (attemptRetirement.ts), which end only when the
 * delete is confirmed. One list, so a controller built before retirement existed deletes a retiring
 * Runner first and acknowledges it after, which is the order retirement needs.
 */
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
    // GitHub has confirmed the Runner is gone. A retiring Attempt ends now; its executor stops.
    if (isRetiring(attempt)) {
      await finishRetirement(ctx, attempt);
      await ctx.scheduler.runAfter(0, internal.attemptScheduler.tryAssign, {});
      return true;
    }
    await ctx.db.patch(attempt._id, { runnerCleanupPending: undefined, retirement: undefined });
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

/**
 * A scale-down. An unclaimed Attempt is cancelled at once. A `preparing` or `ready` one is retired:
 * it ends when the controller has deleted its Runner and acknowledged that (completeRunnerCleanup),
 * so a job GitHub handed it in the meantime is not lost. The controller of either generation calls
 * this, deletes the Runner, then acknowledges, so both get that order.
 */
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
    if ((await endIdleAttempt(ctx, attempt, args.reason)) === "cancelled") {
      await ctx.scheduler.runAfter(0, internal.attemptScheduler.tryAssign, {});
    }
    return null;
  },
});

/**
 * Records GitHub's JobStarted message on its Attempt. A controller sends it once as the message
 * arrives and, from this version on, once more with `headBranch` after it has read the workflow
 * run from GitHub. The two carry the same fields otherwise and either may land first: a field left
 * out is never cleared, so their order does not matter.
 */
export const markJobStarted = internalMutation({
  args: {
    profile: v.string(),
    runnerName: v.string(),
    runnerRequestId: v.optional(v.string()),
    repository: v.optional(v.string()),
    owner: v.optional(v.string()),
    jobId: v.optional(v.string()),
    workflowRef: v.optional(v.string()),
    headBranch: v.optional(v.string()),
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
    await settleScaleSetJob(ctx, args.runnerRequestId, "started");
    if (terminalStates.has(attempt.state)) {
      // A job that ran and settled before the controller's GitHub lookup came back may still
      // upload its test report, which reads the branch.
      if (
        args.headBranch !== undefined &&
        attempt.startedAt !== undefined &&
        attempt.headBranch === undefined
      ) {
        await ctx.db.patch(attempt._id, { headBranch: args.headBranch });
      }
      // An Attempt that ended without ever starting had its Runner deleted by GitHub, or its
      // executor exit, first. Neither can be running a job, so this message is late.
      if (attempt.startedAt === undefined) {
        console.warn(
          `JobStarted ${args.jobId ?? "?"} for Runner ${args.runnerName} of ${args.profile} ` +
            `after its Attempt ended (${attempt.state}) without a job; ignored`,
        );
      }
      return null;
    }
    await ctx.db.patch(attempt._id, {
      // A Runner that took a job while retiring keeps it. A running Attempt retired because its
      // Worker stopped reporting stays retiring: a redelivered JobStarted says nothing new.
      ...(attempt.state === "running" ? {} : keepForJob(attempt)),
      state: "running",
      // GitHub's runnerAssignTime is on the same clock as the FinishTime JobCompleted carries, so
      // a duration never mixes clocks. The receipt time is only a fallback: GitHub can deliver
      // JobStarted late, even in the same message as the job's JobCompleted, so it may land after
      // the job finished.
      startedAt: attempt.startedAt ?? args.runnerAssignedAt ?? Date.now(),
      ...(args.runnerRequestId === undefined ? {} : { runnerRequestId: args.runnerRequestId }),
      ...(args.repository === undefined ? {} : { repo: args.repository }),
      ...(args.owner === undefined ? {} : { owner: args.owner }),
      ...(args.jobId === undefined ? {} : { jobId: args.jobId }),
      ...(args.workflowRef === undefined ? {} : { workflowRef: args.workflowRef }),
      ...(args.headBranch === undefined ? {} : { headBranch: args.headBranch }),
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

// A JobCompleted for a job no Runner took: authorize the caller like any write. Only the acquired
// job it names, if any, is settled.
export const acknowledgeRunnerlessJobCompleted = internalMutation({
  args: { profile: v.string(), runnerRequestId: v.optional(v.string()), caller: callerArg },
  returns: v.null(),
  handler: async (ctx, args) => {
    await authorize(ctx, args.profile, args.caller);
    await settleScaleSetJob(ctx, args.runnerRequestId, "completed");
    return null;
  },
});

/** The jobs a controller acquired, kept for stranded job recovery (strandedJobs.ts). */
export const recordJobsAcquired = internalMutation({
  args: {
    profile: v.string(),
    jobs: v.array(
      v.object({
        runnerRequestId: v.string(),
        repository: v.optional(v.string()),
        owner: v.optional(v.string()),
        jobId: v.optional(v.string()),
        displayName: v.optional(v.string()),
        workflowRunId: v.optional(v.number()),
        queueTime: v.optional(v.number()),
      }),
    ),
    caller: callerArg,
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await authorize(ctx, args.profile, args.caller);
    await recordAcquiredJobs(ctx, args.profile, args.jobs, Date.now());
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
    await settleScaleSetJob(ctx, args.runnerRequestId, "completed");
    if (!terminalStates.has(attempt.state)) {
      await releaseAttemptSlot(ctx, attempt);
    }
    await deleteAttemptSecret(ctx, attempt._id);
    await ctx.db.patch(attempt._id, {
      // A start known only by when JobStarted reached the control plane can be later than
      // GitHub's own finish time. GitHub's time wins, so a job never ends before it starts.
      ...(attempt.startedAt !== undefined && attempt.startedAt > args.finishedAt
        ? { startedAt: args.finishedAt }
        : {}),
      state: "completed",
      runnerCleanupPending: undefined,
      retirement: undefined,
      ...(args.runnerRequestId === undefined ? {} : { runnerRequestId: args.runnerRequestId }),
      ...(args.jobId === undefined ? {} : { jobId: args.jobId }),
      ...(args.result === undefined ? {} : { result: args.result }),
      finishedAt: args.finishedAt,
    });
    await ctx.scheduler.runAfter(0, internal.attemptScheduler.tryAssign, {});
    return null;
  },
});
