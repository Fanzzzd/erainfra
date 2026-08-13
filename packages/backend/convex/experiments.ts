import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import { mutation, query } from "./_generated/server";
import { releaseMachineSlot } from "./attemptScheduler";
import { requireDashboardAuth } from "./dashboardAuth";

const stateValidator = v.union(
  v.literal("queued"),
  v.literal("preparing"),
  v.literal("running"),
  v.literal("completed"),
  v.literal("cancelled"),
  v.literal("failed"),
);

const terminalStates = new Set(["completed", "cancelled", "failed"]);

function validateCommand(command: string[]) {
  const bytes = command.reduce((total, value) => total + new TextEncoder().encode(value).length, 0);
  if (command.length < 1 || command.length > 32 || bytes > 16 * 1024) {
    throw new ConvexError("Experiment command must contain 1-32 arguments and fit within 16 KiB");
  }
  if (command.some((value) => value.length === 0 || value.includes("\0"))) {
    throw new ConvexError(
      "Experiment command arguments must be non-empty and contain no NUL bytes",
    );
  }
}

export const create = mutation({
  args: {
    name: v.string(),
    profile: v.string(),
    command: v.array(v.string()),
    timeoutSeconds: v.number(),
  },
  returns: v.id("experiments"),
  handler: async (ctx, args) => {
    const identity = await requireDashboardAuth(ctx);
    const name = args.name.trim();
    if (name.length < 1 || name.length > 80) {
      throw new ConvexError("Experiment name must contain 1-80 characters");
    }
    validateCommand(args.command);
    if (
      !Number.isInteger(args.timeoutSeconds) ||
      args.timeoutSeconds < 1 ||
      args.timeoutSeconds > 21_600
    ) {
      throw new ConvexError("Experiment timeout must be between 1 and 21600 seconds");
    }
    const profile = await ctx.db
      .query("profiles")
      .withIndex("by_name", (q) => q.eq("name", args.profile))
      .unique();
    if (profile === null || profile.state !== "active") {
      throw new ConvexError("Experiment Profile is not active");
    }
    if (profile.executor !== "firecracker") {
      throw new ConvexError("Experiments currently require a Linux Firecracker Profile");
    }
    const experimentId = await ctx.db.insert("experiments", {
      name,
      profile: profile.name,
      executor: "firecracker",
      imageRelease: profile.imageRelease,
      vcpus: profile.vcpus,
      memoryMiB: profile.memoryMiB,
      command: args.command,
      timeoutSeconds: args.timeoutSeconds,
      state: "queued",
      createdBy: identity.subject,
      createdAt: Date.now(),
    });
    await ctx.scheduler.runAfter(0, internal.attemptScheduler.tryAssign, {});
    return experimentId;
  },
});

export const cancel = mutation({
  args: { experimentId: v.id("experiments") },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    await requireDashboardAuth(ctx);
    const experiment = await ctx.db.get(args.experimentId);
    if (experiment === null) return false;
    if (terminalStates.has(experiment.state)) return true;
    await releaseMachineSlot(ctx, experiment.machineId);
    await ctx.db.patch(experiment._id, {
      state: "cancelled",
      finishedAt: Date.now(),
      lastError: "Cancelled by operator",
    });
    await ctx.scheduler.runAfter(0, internal.attemptScheduler.tryAssign, {});
    return true;
  },
});

export const list = query({
  args: {},
  returns: v.array(
    v.object({
      _id: v.id("experiments"),
      name: v.string(),
      profile: v.string(),
      imageRelease: v.string(),
      command: v.array(v.string()),
      timeoutSeconds: v.number(),
      state: stateValidator,
      machineName: v.optional(v.string()),
      selectionReason: v.optional(v.string()),
      createdAt: v.number(),
      startedAt: v.optional(v.number()),
      finishedAt: v.optional(v.number()),
      exitCode: v.optional(v.number()),
      lastError: v.optional(v.string()),
    }),
  ),
  handler: async (ctx) => {
    await requireDashboardAuth(ctx);
    const [experiments, machines] = await Promise.all([
      ctx.db.query("experiments").order("desc").take(100),
      ctx.db.query("machines").collect(),
    ]);
    const machineNames = new Map(machines.map((machine) => [machine._id, machine.name]));
    return experiments.map((experiment) => ({
      _id: experiment._id,
      name: experiment.name,
      profile: experiment.profile,
      imageRelease: experiment.imageRelease,
      command: experiment.command,
      timeoutSeconds: experiment.timeoutSeconds,
      state: experiment.state,
      machineName:
        experiment.machineId === undefined ? undefined : machineNames.get(experiment.machineId),
      selectionReason: experiment.selectionReason,
      createdAt: experiment.createdAt,
      startedAt: experiment.startedAt,
      finishedAt: experiment.finishedAt,
      exitCode: experiment.exitCode,
      lastError: experiment.lastError,
    }));
  },
});
