import { ConvexError, v } from "convex/values";

import { internal } from "./_generated/api";
import { mutation } from "./_generated/server";
import { keepRunningAttemptsOfReturningWorker, workerReports } from "./attemptRetirement";
import { startBudgetValidator } from "./startBudgetModel";

const osValidator = v.union(v.literal("linux"), v.literal("mac"), v.literal("win"));

// The Action Runner Agent sends this every cycle; the rest of its calls go to workerApi.ts.
export const heartbeat = mutation({
  args: { token: v.string(), startBudget: v.optional(startBudgetValidator) },
  returns: v.object({
    os: osValidator,
    maxSlots: v.number(),
  }),
  handler: async (
    ctx,
    args,
  ): Promise<{
    os: "linux" | "mac" | "win";
    maxSlots: number;
  }> => {
    const machine = await ctx.db
      .query("machines")
      .withIndex("by_token", (q) => q.eq("token", args.token))
      .unique();
    if (machine === null) {
      throw new ConvexError("Invalid machine token");
    }
    const now = Date.now();
    // Back from a silence the reconciler may have retired its running Attempts for: their jobs
    // ran on, so the retirements are called off at once (attemptRetirement.ts).
    if (!workerReports(machine, now)) {
      await keepRunningAttemptsOfReturningWorker(ctx, machine._id);
    }
    await ctx.db.patch(machine._id, {
      lastSeen: now,
      ...(args.startBudget ? { startBudget: { ...args.startBudget, reportedAt: now } } : {}),
    });
    await ctx.scheduler.runAfter(0, internal.attemptScheduler.tryAssign, {});
    return { os: machine.os, maxSlots: machine.maxSlots };
  },
});
