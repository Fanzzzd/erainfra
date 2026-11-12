import { v } from "convex/values";

import { internal } from "./_generated/api";
import { internalMutation } from "./_generated/server";

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
    await ctx.scheduler.runAfter(0, internal.attemptScheduler.tryAssign, {});
    return null;
  },
});

// Operator cleanup: remove a machine.
export const deleteMachine = internalMutation({
  args: { machineId: v.id("machines") },
  returns: v.null(),
  handler: async (ctx, args) => {
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
