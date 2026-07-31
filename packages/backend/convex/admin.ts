import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalMutation } from "./_generated/server";

// Operator cleanup: remove a machine and any commands pointing at it.
export const deleteMachine = internalMutation({
  args: { machineId: v.id("machines") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const commands = await ctx.db
      .query("commands")
      .filter((q) => q.eq(q.field("machineId"), args.machineId))
      .collect();
    for (const command of commands) {
      await ctx.db.delete(command._id);
    }
    await ctx.db.delete(args.machineId);
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

    const commands = await ctx.db
      .query("commands")
      .filter((q) => q.eq(q.field("jobId"), job._id))
      .collect();
    for (const command of commands) {
      await ctx.db.delete(command._id);
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
    return null;
  },
});

// Operator cleanup: force a stuck assigned job back to the queue.
export const requeueJob = internalMutation({
  args: { jobId: v.id("jobs") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId);
    if (job === null || job.status !== "assigned") return null;

    const commands = await ctx.db
      .query("commands")
      .filter((q) => q.eq(q.field("jobId"), job._id))
      .collect();
    for (const command of commands) {
      await ctx.db.delete(command._id);
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
    });
    await ctx.scheduler.runAfter(0, internal.scheduler.tryAssign, {});
    return null;
  },
});
