import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import { internalMutation, query, type QueryCtx } from "./_generated/server";

const jobStatusValidator = v.union(
  v.literal("queued"),
  v.literal("assigned"),
  v.literal("running"),
  v.literal("done"),
  v.literal("failed"),
);

const listedJobValidator = v.object({
  _id: v.id("jobs"),
  _creationTime: v.number(),
  ghJobId: v.number(),
  githubInstallationId: v.optional(v.number()),
  repo: v.string(),
  workflowName: v.string(),
  labels: v.array(v.string()),
  status: jobStatusValidator,
  machineId: v.optional(v.id("machines")),
  machineName: v.optional(v.string()),
  runnerName: v.optional(v.string()),
  queuedAt: v.number(),
  startedAt: v.optional(v.number()),
  finishedAt: v.optional(v.number()),
  conclusion: v.optional(v.string()),
});

async function requireDashboardAuth(ctx: QueryCtx) {
  const identity = await ctx.auth.getUserIdentity();
  if (identity === null) {
    throw new ConvexError("Authentication required");
  }
}

export const list = query({
  args: {},
  returns: v.array(listedJobValidator),
  handler: async (ctx) => {
    await requireDashboardAuth(ctx);
    const [jobs, machines] = await Promise.all([
      ctx.db.query("jobs").collect(),
      ctx.db.query("machines").collect(),
    ]);
    const machineNames = new Map(
      machines.map((machine) => [machine._id, machine.name]),
    );

    return jobs
      .sort((a, b) => b.queuedAt - a.queuedAt)
      .map((job) => ({
        ...job,
        machineName:
          job.machineId === undefined
            ? undefined
            : machineNames.get(job.machineId),
      }));
  },
});

export const handleWorkflowJob = internalMutation({
  args: {
    action: v.union(
      v.literal("queued"),
      v.literal("in_progress"),
      v.literal("completed"),
    ),
    ghJobId: v.number(),
    githubInstallationId: v.optional(v.number()),
    repo: v.string(),
    workflowName: v.string(),
    labels: v.array(v.string()),
    conclusion: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const existing = await ctx.db
      .query("jobs")
      .withIndex("by_ghJobId", (q) => q.eq("ghJobId", args.ghJobId))
      .first();

    if (args.action === "queued") {
      if (!args.labels.includes("self-hosted")) {
        return null;
      }
      if (existing !== null) {
        if (
          existing.status === "queued" &&
          existing.githubInstallationId === undefined &&
          args.githubInstallationId !== undefined
        ) {
          await ctx.db.patch(existing._id, {
            githubInstallationId: args.githubInstallationId,
          });
        }
        return null;
      }
      await ctx.db.insert("jobs", {
        ghJobId: args.ghJobId,
        githubInstallationId: args.githubInstallationId,
        repo: args.repo,
        workflowName: args.workflowName,
        labels: args.labels,
        status: "queued",
        queuedAt: Date.now(),
      });
      await ctx.scheduler.runAfter(0, internal.scheduler.tryAssign, {});
      return null;
    }

    if (existing === null) {
      console.warn(`Ignoring ${args.action} for unknown job ${args.ghJobId}`);
      return null;
    }

    if (args.action === "in_progress") {
      if (existing.status === "assigned" || existing.status === "queued") {
        await ctx.db.patch(existing._id, {
          status: "running",
          startedAt: Date.now(),
        });
      }
      return null;
    }

    const wasActive =
      existing.status === "assigned" || existing.status === "running";
    if (!wasActive) {
      return null;
    }

    const conclusion = args.conclusion ?? "unknown";
    await ctx.db.patch(existing._id, {
      status: conclusion === "success" ? "done" : "failed",
      conclusion,
      finishedAt: Date.now(),
    });

    if (existing.machineId !== undefined) {
      const machine = await ctx.db.get(existing.machineId);
      if (machine !== null) {
        await ctx.db.patch(machine._id, {
          usedSlots: Math.max(0, machine.usedSlots - 1),
        });
      }
    }

    const command = await ctx.db
      .query("commands")
      .filter((q) => q.eq(q.field("jobId"), existing._id))
      .first();
    if (command !== null && command.status !== "finished") {
      await ctx.db.patch(command._id, { status: "finished" });
    }

    await ctx.scheduler.runAfter(0, internal.scheduler.tryAssign, {});
    return null;
  },
});
