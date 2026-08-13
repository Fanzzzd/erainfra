import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalMutation, type MutationCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { discardCommand } from "./runners";

function commandsForJob(ctx: MutationCtx, jobId: Id<"jobs">) {
  return ctx.db
    .query("commands")
    .withIndex("by_jobId", (q) => q.eq("jobId", jobId))
    .collect();
}

// Operator control: change how many concurrent jobs a machine may claim.
export const setMachineMaxSlots = internalMutation({
  args: {
    machineId: v.id("machines"),
    maxSlots: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    if (!Number.isInteger(args.maxSlots) || args.maxSlots < 1 || args.maxSlots > 128) {
      throw new Error("maxSlots must be an integer between 1 and 128");
    }
    const machine = await ctx.db.get(args.machineId);
    if (machine === null) {
      throw new Error("Machine not found");
    }
    if (args.maxSlots < machine.usedSlots) {
      throw new Error(
        `maxSlots cannot be lower than the machine's ${machine.usedSlots} active slot(s)`,
      );
    }
    await ctx.db.patch(machine._id, {
      slotPolicy: "fixed",
      configuredSlots: args.maxSlots,
      maxSlots: args.maxSlots,
    });
    await ctx.scheduler.runAfter(0, internal.scheduler.tryAssign, {});
    return null;
  },
});

// Operator cleanup: remove a machine and any commands pointing at it.
export const deleteMachine = internalMutation({
  args: { machineId: v.id("machines") },
  returns: v.null(),
  handler: async (ctx, args) => {
    for (const status of ["pending", "claimed", "cancelled", "finished"] as const) {
      const commands = await ctx.db
        .query("commands")
        .withIndex("by_machine_status", (q) =>
          q.eq("machineId", args.machineId).eq("status", status),
        )
        .collect();
      for (const command of commands) {
        await discardCommand(ctx, command, await ctx.db.get(command.jobId));
      }
    }
    await ctx.db.delete(args.machineId);
    await ctx.scheduler.runAfter(0, internal.github.drainRunnerDeletions, {});
    return null;
  },
});

// Operator cleanup: remove a dashboard user and all their auth records.
export const deleteUser = internalMutation({
  args: { userId: v.id("users") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const accounts = await ctx.db
      .query("authAccounts")
      .withIndex("userIdAndProvider", (q) => q.eq("userId", args.userId))
      .collect();
    for (const account of accounts) {
      await ctx.db.delete(account._id);
    }
    const sessions = await ctx.db
      .query("authSessions")
      .withIndex("userId", (q) => q.eq("userId", args.userId))
      .collect();
    for (const session of sessions) {
      const tokens = await ctx.db
        .query("authRefreshTokens")
        .withIndex("sessionId", (q) => q.eq("sessionId", session._id))
        .collect();
      for (const token of tokens) {
        await ctx.db.delete(token._id);
      }
      await ctx.db.delete(session._id);
    }
    await ctx.db.delete(args.userId);
    return null;
  },
});

// Operator cleanup: drop a job (any state) with its commands, release the
// machine slot it held, and re-run the scheduler.
export const dropJob = internalMutation({
  args: { jobId: v.id("jobs") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId);
    if (job === null) return null;

    for (const command of await commandsForJob(ctx, job._id)) {
      await discardCommand(ctx, command, job);
    }
    if (job.machineId !== undefined) {
      const machine = await ctx.db.get(job.machineId);
      if (machine !== null && (job.status === "assigned" || job.status === "running")) {
        await ctx.db.patch(machine._id, {
          usedSlots: Math.max(0, machine.usedSlots - 1),
        });
      }
    }
    await ctx.db.delete(job._id);
    await ctx.scheduler.runAfter(0, internal.scheduler.tryAssign, {});
    await ctx.scheduler.runAfter(0, internal.github.drainRunnerDeletions, {});
    return null;
  },
});

// Operator cleanup: force a stuck assigned job back to the queue. Resets the
// attempt budget, because this is a deliberate operator decision rather than
// another automatic retry.
export const requeueJob = internalMutation({
  args: { jobId: v.id("jobs") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId);
    if (job === null || job.status !== "assigned") return null;

    for (const command of await commandsForJob(ctx, job._id)) {
      await discardCommand(ctx, command, job);
    }
    if (job.machineId !== undefined) {
      const machine = await ctx.db.get(job.machineId);
      if (machine !== null) {
        await ctx.db.patch(machine._id, {
          usedSlots: Math.max(0, machine.usedSlots - 1),
        });
      }
    }
    await ctx.db.patch(job._id, {
      status: "queued",
      machineId: undefined,
      runnerName: undefined,
      attempts: 0,
      nextAttemptAt: undefined,
      lastFailedMachineId: undefined,
    });
    await ctx.scheduler.runAfter(0, internal.scheduler.tryAssign, {});
    await ctx.scheduler.runAfter(0, internal.github.drainRunnerDeletions, {});
    return null;
  },
});
