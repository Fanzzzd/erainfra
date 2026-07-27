import { ConvexError, v } from "convex/values";
import { selectImageForMachine } from "./catalog";
import {
  internalMutation,
  internalQuery,
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";

const REGISTRATION_TOKEN_TTL_MS = 15 * 60 * 1_000;

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

async function requireDashboardAuth(ctx: QueryCtx | MutationCtx) {
  const identity = await ctx.auth.getUserIdentity();
  if (identity === null) {
    throw new ConvexError("Authentication required");
  }
  return identity;
}

function randomHex(length: number) {
  let value = "";
  for (let index = 0; index < length; index += 1) {
    value += Math.floor(Math.random() * 16).toString(16);
  }
  return value;
}

function sanitizeMachineName(hostname: string) {
  const sanitized = hostname
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return sanitized.length > 0 ? sanitized : "runner";
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

export const createRegistrationToken = mutation({
  args: {},
  returns: v.object({
    token: v.string(),
    expiresAt: v.number(),
  }),
  handler: async (ctx) => {
    await requireDashboardAuth(ctx);

    let token = "";
    do {
      token = `rcreg_${randomHex(24)}`;
    } while (
      (await ctx.db
        .query("registrationTokens")
        .withIndex("by_token", (q) => q.eq("token", token))
        .unique()) !== null
    );

    const createdAt = Date.now();
    await ctx.db.insert("registrationTokens", { token, createdAt });
    return { token, expiresAt: createdAt + REGISTRATION_TOKEN_TTL_MS };
  },
});

export const registerAgent = internalMutation({
  args: {
    registrationToken: v.string(),
    name: v.string(),
    os: osValidator,
    arch: v.string(),
    cpus: v.number(),
    labels: v.optional(v.array(v.string())),
    maxSlots: v.optional(v.number()),
  },
  returns: v.union(
    v.object({
      ok: v.literal(true),
      machineToken: v.string(),
    }),
    v.object({
      ok: v.literal(false),
      status: v.number(),
      error: v.string(),
    }),
  ),
  handler: async (ctx, args) => {
    const registration = await ctx.db
      .query("registrationTokens")
      .withIndex("by_token", (q) => q.eq("token", args.registrationToken))
      .unique();
    if (registration === null) {
      return { ok: false as const, status: 401, error: "Invalid registration token" };
    }
    if (registration.usedAt !== undefined) {
      return {
        ok: false as const,
        status: 409,
        error: "Registration token has already been used",
      };
    }

    const now = Date.now();
    if (now - registration.createdAt >= REGISTRATION_TOKEN_TTL_MS) {
      return { ok: false as const, status: 410, error: "Registration token has expired" };
    }

    const existingNames = new Set(
      (await ctx.db.query("machines").collect()).map((machine) => machine.name),
    );
    const baseName = sanitizeMachineName(args.name);
    let name = baseName;
    let suffix = 2;
    while (existingNames.has(name)) {
      name = `${baseName}-${suffix}`;
      suffix += 1;
    }

    const defaultSlots =
      args.os === "linux"
        ? Math.min(2, Math.max(1, Math.floor(args.cpus / 4)))
        : 1;
    const maxSlots = args.maxSlots ?? defaultSlots;
    const labels = [
      ...new Set((args.labels ?? []).map((label) => label.trim()).filter(Boolean)),
    ];

    let machineToken = "";
    do {
      machineToken = randomHex(32);
    } while (
      (await ctx.db
        .query("machines")
        .withIndex("by_token", (q) => q.eq("token", machineToken))
        .unique()) !== null
    );

    await ctx.db.patch(registration._id, { usedAt: now });
    await ctx.db.insert("machines", {
      name,
      os: args.os,
      labels,
      maxSlots,
      usedSlots: 0,
      lastSeen: 0,
      token: machineToken,
    });
    return { ok: true as const, machineToken };
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
