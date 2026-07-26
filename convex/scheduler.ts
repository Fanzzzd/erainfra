import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalMutation } from "./_generated/server";

export const tryAssign = internalMutation({
  args: {},
  returns: v.number(),
  handler: async (ctx): Promise<number> => {
    const now = Date.now();
    const [queuedJobs, machineDocs] = await Promise.all([
      ctx.db
        .query("jobs")
        .withIndex("by_status", (q) => q.eq("status", "queued"))
        .collect(),
      ctx.db.query("machines").collect(),
    ]);

    queuedJobs.sort((a, b) => a.queuedAt - b.queuedAt);
    const machines = machineDocs.map((machine) => ({
      doc: machine,
      usedSlots: machine.usedSlots,
    }));
    let assigned = 0;

    for (const job of queuedJobs) {
      const candidate = machines.find(({ doc, usedSlots }) => {
        if (usedSlots >= doc.maxSlots || now - doc.lastSeen >= 120_000) {
          return false;
        }
        const availableLabels = new Set(["self-hosted", ...doc.labels]);
        return job.labels.every((label) => availableLabels.has(label));
      });
      if (candidate === undefined) {
        continue;
      }

      // Unique per attempt: a retry of the same job must not collide with a
      // stale offline registration left by a previous dead runner.
      const attempt = Math.floor(Math.random() * 0xffff)
        .toString(16)
        .padStart(4, "0");
      const runnerName = `rc-${candidate.doc.name}-${job.ghJobId}-${attempt}`;
      candidate.usedSlots += 1;
      await ctx.db.patch(candidate.doc._id, {
        usedSlots: candidate.usedSlots,
      });
      await ctx.db.patch(job._id, {
        status: "assigned",
        machineId: candidate.doc._id,
        runnerName,
      });
      const commandId = await ctx.db.insert("commands", {
        machineId: candidate.doc._id,
        jobId: job._id,
        runnerName,
        status: "pending",
      });
      await ctx.scheduler.runAfter(0, internal.github.issueJit, {
        commandId,
        jobId: job._id,
        repo: job.repo,
        runnerName,
        labels: job.labels,
      });
      assigned += 1;
    }

    return assigned;
  },
});

export const storeJitConfig = internalMutation({
  args: {
    commandId: v.id("commands"),
    jitConfig: v.string(),
  },
  returns: v.boolean(),
  handler: async (ctx, args): Promise<boolean> => {
    const command = await ctx.db.get(args.commandId);
    if (command === null || command.status !== "pending") {
      return false;
    }
    await ctx.db.patch(command._id, { jitConfig: args.jitConfig });
    return true;
  },
});

export const revertAssignment = internalMutation({
  args: {
    commandId: v.id("commands"),
    jobId: v.id("jobs"),
  },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const [command, job] = await Promise.all([
      ctx.db.get(args.commandId),
      ctx.db.get(args.jobId),
    ]);
    if (
      command === null ||
      job === null ||
      command.status !== "pending" ||
      job.status !== "assigned"
    ) {
      return null;
    }

    const machine = await ctx.db.get(command.machineId);
    if (machine !== null) {
      await ctx.db.patch(machine._id, {
        usedSlots: Math.max(0, machine.usedSlots - 1),
      });
    }
    await ctx.db.patch(job._id, {
      status: "queued",
      machineId: undefined,
      runnerName: undefined,
    });
    await ctx.db.delete(command._id);
    return null;
  },
});
