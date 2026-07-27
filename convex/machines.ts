import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import {
  action,
  internalMutation,
  internalQuery,
  query,
  type ActionCtx,
  type QueryCtx,
} from "./_generated/server";
import { selectImageForMachine } from "./catalog";

const osValidator = v.union(
  v.literal("linux"),
  v.literal("mac"),
  v.literal("win"),
);

const machineListItemValidator = v.object({
  _id: v.id("machines"),
  _creationTime: v.number(),
  name: v.string(),
  os: osValidator,
  labels: v.array(v.string()),
  maxSlots: v.number(),
  usedSlots: v.number(),
  lastSeen: v.number(),
  currentJobs: v.array(
    v.object({
      _id: v.id("jobs"),
      repo: v.string(),
      workflowName: v.string(),
      status: v.union(v.literal("assigned"), v.literal("running")),
    }),
  ),
});

async function requireDashboardAuth(ctx: QueryCtx | ActionCtx) {
  const identity = await ctx.auth.getUserIdentity();
  if (identity === null) {
    throw new ConvexError("Authentication required");
  }
  return identity;
}

export const list = query({
  args: {},
  returns: v.array(machineListItemValidator),
  handler: async (ctx) => {
    await requireDashboardAuth(ctx);
    const [machines, assignedJobs, runningJobs] = await Promise.all([
      ctx.db.query("machines").collect(),
      ctx.db
        .query("jobs")
        .withIndex("by_status", (q) => q.eq("status", "assigned"))
        .collect(),
      ctx.db
        .query("jobs")
        .withIndex("by_status", (q) => q.eq("status", "running"))
        .collect(),
    ]);

    const activeJobs = [...assignedJobs, ...runningJobs];
    return machines
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(({ token: _token, ...machine }) => ({
        ...machine,
        currentJobs: activeJobs
          .filter((job) => job.machineId === machine._id)
          .map((job) => ({
            _id: job._id,
            repo: job.repo,
            workflowName: job.workflowName,
            status: job.status as "assigned" | "running",
          })),
      }));
  },
});

export const create = action({
  args: {
    name: v.string(),
    os: osValidator,
    labels: v.array(v.string()),
    maxSlots: v.number(),
  },
  returns: v.object({
    machineId: v.id("machines"),
    token: v.string(),
  }),
  handler: async (ctx, args): Promise<{ machineId: Id<"machines">; token: string }> => {
    await requireDashboardAuth(ctx);

    const name = args.name.trim();
    if (!/^[A-Za-z0-9._-]+$/.test(name)) {
      throw new ConvexError(
        "Machine name must contain only letters, numbers, dots, underscores, and hyphens",
      );
    }
    if (!Number.isInteger(args.maxSlots) || args.maxSlots < 1) {
      throw new ConvexError("Max slots must be a positive integer");
    }

    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    const token = Array.from(bytes, (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");

    return await ctx.runMutation(internal.machines.createInternal, {
      name,
      os: args.os,
      labels: [...new Set(args.labels.map((label) => label.trim()).filter(Boolean))],
      maxSlots: args.maxSlots,
      token,
    });
  },
});

// Availability probe for the runs-on fallback endpoint: is any online
// machine with free slots able to satisfy these labels right now?
export const hasCapacity = internalQuery({
  args: { labels: v.array(v.string()) },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const now = Date.now();
    const machines = await ctx.db.query("machines").collect();
    return machines.some((machine) => {
      if (
        machine.usedSlots >= machine.maxSlots ||
        now - machine.lastSeen >= 120_000
      ) {
        return false;
      }
      return selectImageForMachine(args.labels, machine) !== undefined;
    });
  },
});

export const createInternal = internalMutation({
  args: {
    name: v.string(),
    os: osValidator,
    labels: v.array(v.string()),
    maxSlots: v.number(),
    token: v.string(),
  },
  returns: v.object({
    machineId: v.id("machines"),
    token: v.string(),
  }),
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("machines")
      .filter((q) => q.eq(q.field("name"), args.name))
      .first();
    if (existing !== null) {
      throw new ConvexError("A machine with this name already exists");
    }

    const machineId = await ctx.db.insert("machines", {
      name: args.name,
      os: args.os,
      labels: args.labels,
      maxSlots: args.maxSlots,
      usedSlots: 0,
      lastSeen: 0,
      token: args.token,
    });
    return { machineId, token: args.token };
  },
});
