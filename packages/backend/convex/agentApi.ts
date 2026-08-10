import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import { mutation, query, type QueryCtx } from "./_generated/server";

const osValidator = v.union(v.literal("linux"), v.literal("mac"), v.literal("win"));

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
    // Every command this machine should still be working on. Anything the agent
    // is running that is missing from this list has been cancelled or settled
    // server-side and must be torn down.
    liveCommandIds: v.array(v.id("commands")),
  }),
  handler: async (ctx, args) => {
    const machine = await machineForToken(ctx, args.token);
    const [pending, claimed] = await Promise.all([
      ctx.db
        .query("commands")
        .withIndex("by_machine_status", (q) =>
          q.eq("machineId", machine._id).eq("status", "pending"),
        )
        .collect(),
      ctx.db
        .query("commands")
        .withIndex("by_machine_status", (q) =>
          q.eq("machineId", machine._id).eq("status", "claimed"),
        )
        .collect(),
    ]);

    return {
      os: machine.os,
      maxSlots: machine.maxSlots,
      commands: pending
        .filter((command) => command.jitConfig !== undefined)
        .map((command) => ({
          commandId: command._id,
          runnerName: command.runnerName,
        })),
      liveCommandIds: [...pending, ...claimed].map((command) => command._id),
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
      image: v.optional(v.string()),
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
      claimedAt: Date.now(),
      jitConfig: undefined,
    });
    return {
      jitConfig,
      image: command.image,
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
  handler: async (ctx, args): Promise<boolean> => {
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
    if (command === null || command.machineId !== machine._id || command.status === "pending") {
      return false;
    }

    const job = await ctx.db.get(command.jobId);
    const wasCancelled = command.status === "cancelled";

    if (!wasCancelled && job !== null && job.status === "assigned" && args.exitCode !== 0) {
      // The provisioner failed before the job ever started. Route through the
      // bounded-retry path so this cannot loop forever on the same machine.
      await ctx.runMutation(internal.scheduler.failAttempt, {
        commandId: command._id,
        jobId: job._id,
        error: `Provisioner exited with code ${args.exitCode}`,
      });
      return true;
    }

    await ctx.db.patch(command._id, {
      status: "finished",
      exitCode: args.exitCode,
    });

    // A clean exit means the runner did its work; GitHub's "completed" webhook
    // settles the job and frees the slot. Requeueing here would provision a
    // second runner for a job that has already run.
    return true;
  },
});

export const heartbeat = mutation({
  args: { token: v.string() },
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
    await ctx.db.patch(machine._id, { lastSeen: Date.now() });
    await ctx.scheduler.runAfter(0, internal.scheduler.tryAssign, {});
    await ctx.scheduler.runAfter(0, internal.attemptScheduler.tryAssign, {});
    return { os: machine.os, maxSlots: machine.maxSlots };
  },
});
