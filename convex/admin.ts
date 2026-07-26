import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalMutation } from "./_generated/server";

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
