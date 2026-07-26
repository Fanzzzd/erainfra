import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import { mutation, query, type QueryCtx } from "./_generated/server";

const osValidator = v.union(
  v.literal("linux"),
  v.literal("mac"),
  v.literal("win"),
);

async function machineForToken(ctx: QueryCtx, token: string) {
  const machine = await ctx.db
    .query("machines")
    .withIndex("by_token", (q) => q.eq("token", token))
    .unique();
  if (machine === null) {
    throw new ConvexError("Invalid machine token");
  }
  return machine;
}

export const pendingCommands = query({
  args: { token: v.string() },
  returns: v.object({
    os: osValidator,
    maxSlots: v.number(),
    commands: v.array(
      v.object({
        commandId: v.id("commands"),
        runnerName: v.string(),
      }),
    ),
  }),
  handler: async (ctx, args) => {
    const machine = await machineForToken(ctx, args.token);
    const commands = await ctx.db
      .query("commands")
      .withIndex("by_machine_status", (q) =>
        q.eq("machineId", machine._id).eq("status", "pending"),
      )
      .collect();

    return {
      os: machine.os,
      maxSlots: machine.maxSlots,
      commands: commands
        .filter((command) => command.jitConfig !== undefined)
        .map((command) => ({
          commandId: command._id,
          runnerName: command.runnerName,
        })),
    };
  },
});

export const claim = mutation({
  args: {
    token: v.string(),
    commandId: v.id("commands"),
  },
  returns: v.union(
    v.null(),
    v.object({
      jitConfig: v.string(),
      runnerName: v.string(),
      os: osValidator,
    }),
  ),
  handler: async (ctx, args) => {
    const machine = await ctx.db
      .query("machines")
      .withIndex("by_token", (q) => q.eq("token", args.token))
      .unique();
    if (machine === null) {
      throw new ConvexError("Invalid machine token");
    }

    const command = await ctx.db.get(args.commandId);
    if (
      command === null ||
      command.machineId !== machine._id ||
      command.status !== "pending" ||
      command.jitConfig === undefined
    ) {
      return null;
    }

    const jitConfig = command.jitConfig;
    await ctx.db.patch(command._id, {
      status: "claimed",
      jitConfig: undefined,
    });
    return {
      jitConfig,
      runnerName: command.runnerName,
      os: machine.os,
    };
  },
});

export const report = mutation({
  args: {
    token: v.string(),
    commandId: v.id("commands"),
    exitCode: v.number(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    if (!Number.isInteger(args.exitCode)) {
      throw new ConvexError("Exit code must be an integer");
    }
    const machine = await ctx.db
      .query("machines")
      .withIndex("by_token", (q) => q.eq("token", args.token))
      .unique();
    if (machine === null) {
      throw new ConvexError("Invalid machine token");
    }

    const command = await ctx.db.get(args.commandId);
    if (
      command === null ||
      command.machineId !== machine._id ||
      command.status === "pending"
    ) {
      return false;
    }
    await ctx.db.patch(command._id, {
      status: "finished",
      exitCode: args.exitCode,
    });

    // Runner exited without ever picking up the job (e.g. dead-on-arrival
    // runner): free the slot and requeue so a fresh JIT runner is issued.
    const job = await ctx.db.get(command.jobId);
    if (job !== null && job.status === "assigned") {
      await ctx.db.patch(machine._id, {
        usedSlots: Math.max(0, machine.usedSlots - 1),
      });
      await ctx.db.patch(job._id, {
        status: "queued",
        machineId: undefined,
        runnerName: undefined,
      });
      await ctx.scheduler.runAfter(0, internal.scheduler.tryAssign, {});
    }
    return true;
  },
});

export const heartbeat = mutation({
  args: { token: v.string() },
  returns: v.object({
    os: osValidator,
    maxSlots: v.number(),
  }),
  handler: async (ctx, args): Promise<{
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
    await ctx.db.patch(machine._id, { lastSeen: Date.now() });
    await ctx.scheduler.runAfter(0, internal.scheduler.tryAssign, {});
    return { os: machine.os, maxSlots: machine.maxSlots };
  },
});
