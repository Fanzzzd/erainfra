import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { internalMutation, query, type MutationCtx } from "./_generated/server";
import { requireDashboardAuth } from "./dashboardAuth";
import { enqueueRunnerDeletion } from "./runners";

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
  attempts: v.optional(v.number()),
  lastError: v.optional(v.string()),
  nextAttemptAt: v.optional(v.number()),
  lastFailedMachineId: v.optional(v.id("machines")),
});

export const list = query({
  args: {},
  returns: v.array(listedJobValidator),
  handler: async (ctx) => {
    await requireDashboardAuth(ctx);
    // ponytail: newest 200 jobs; paginate if history browsing ever matters
    const [jobs, machines] = await Promise.all([
      ctx.db.query("jobs").order("desc").take(200),
      ctx.db.query("machines").collect(),
    ]);
    const machineNames = new Map(machines.map((machine) => [machine._id, machine.name]));

    return jobs
      .toSorted((a, b) => b.queuedAt - a.queuedAt)
      .map((job) => ({
        ...job,
        machineName: job.machineId === undefined ? undefined : machineNames.get(job.machineId),
      }));
  },
});

export type WorkflowJobEvent = {
  action: "queued" | "in_progress" | "completed";
  ghJobId: number;
  githubInstallationId?: number;
  repo: string;
  repoIsPublic: boolean;
  workflowName: string;
  labels: string[];
  conclusion?: string;
};

function commandsForJob(ctx: MutationCtx, jobId: Id<"jobs">) {
  return ctx.db
    .query("commands")
    .withIndex("by_jobId", (q) => q.eq("jobId", jobId))
    .collect();
}

/**
 * Apply one workflow_job event to the control plane.
 *
 * Runs inside the caller's transaction (see webhooks.processDelivery) so the
 * delivery row and the state it produces commit together.
 *
 * GitHub does not guarantee delivery order. When "in_progress" or "completed"
 * arrives for a job we have never seen, we record the job in that terminal-ish
 * state anyway: a later "queued" then finds an existing row and does nothing,
 * instead of provisioning a runner for a job that has already moved on.
 */
export async function applyWorkflowJob(ctx: MutationCtx, args: WorkflowJobEvent) {
  const existing = await ctx.db
    .query("jobs")
    .withIndex("by_ghJobId", (q) => q.eq("ghJobId", args.ghJobId))
    .first();

  // Only self-hosted work concerns us — but once a job is ours we always settle
  // it, rather than trusting the label array on every later event.
  if (existing === null && !args.labels.includes("self-hosted")) {
    return;
  }

  const now = Date.now();

  if (args.action === "queued") {
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
      return;
    }
    await ctx.db.insert("jobs", {
      ghJobId: args.ghJobId,
      githubInstallationId: args.githubInstallationId,
      repo: args.repo,
      workflowName: args.workflowName,
      labels: args.labels,
      status: "queued",
      queuedAt: now,
      attempts: 0,
    });
    await ctx.scheduler.runAfter(0, internal.scheduler.tryAssign, {});
    return;
  }

  if (args.action === "in_progress") {
    if (existing === null) {
      // Out of order: the job started before we saw it queued.
      await ctx.db.insert("jobs", {
        ghJobId: args.ghJobId,
        githubInstallationId: args.githubInstallationId,
        repo: args.repo,
        workflowName: args.workflowName,
        labels: args.labels,
        status: "running",
        queuedAt: now,
        startedAt: now,
        attempts: 0,
      });
      return;
    }
    if (existing.status === "assigned" || existing.status === "queued") {
      await ctx.db.patch(existing._id, { status: "running", startedAt: now });
    }
    return;
  }

  const conclusion = args.conclusion ?? "unknown";
  const terminalStatus = conclusion === "success" ? ("done" as const) : ("failed" as const);

  if (existing === null) {
    // Out of order: the job finished (or was cancelled) before we saw it
    // queued. Record the outcome so a late "queued" cannot resurrect it.
    await ctx.db.insert("jobs", {
      ghJobId: args.ghJobId,
      githubInstallationId: args.githubInstallationId,
      repo: args.repo,
      workflowName: args.workflowName,
      labels: args.labels,
      status: terminalStatus,
      queuedAt: now,
      finishedAt: now,
      conclusion,
      attempts: 0,
    });
    return;
  }

  if (existing.status === "done" || existing.status === "failed") {
    return;
  }

  // "completed" can also arrive for a still-queued job (cancelled before
  // assignment); it must leave the queue or the scheduler keeps assigning it.
  const neverStarted = existing.status !== "running";
  await ctx.db.patch(existing._id, {
    status: terminalStatus,
    conclusion,
    finishedAt: now,
    nextAttemptAt: undefined,
  });

  if (existing.machineId !== undefined) {
    const machine = await ctx.db.get(existing.machineId);
    if (machine !== null) {
      await ctx.db.patch(machine._id, {
        usedSlots: Math.max(0, machine.usedSlots - 1),
      });
    }
  }

  for (const command of await commandsForJob(ctx, existing._id)) {
    if (command.status === "finished" || command.status === "cancelled") {
      continue;
    }
    // Cancelling rather than finishing is what the agent watches for: the
    // command drops out of its live set and it tears the provisioner down.
    await ctx.db.patch(command._id, { status: "cancelled", cancelledAt: now });
    if (neverStarted) {
      // The runner never picked up work, so its JIT registration is still
      // sitting on GitHub as an offline runner. Hand it back.
      await enqueueRunnerDeletion(ctx, command, existing);
    }
  }

  await ctx.scheduler.runAfter(0, internal.scheduler.tryAssign, {});
}

// Kept as an internal mutation so the flow can be driven directly in tests and
// from the Convex CLI without going through the HTTP layer.
export const handleWorkflowJob = internalMutation({
  args: {
    action: v.union(v.literal("queued"), v.literal("in_progress"), v.literal("completed")),
    ghJobId: v.number(),
    githubInstallationId: v.optional(v.number()),
    repo: v.string(),
    repoIsPublic: v.boolean(),
    workflowName: v.string(),
    labels: v.array(v.string()),
    conclusion: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    await applyWorkflowJob(ctx, args);
    return null;
  },
});
