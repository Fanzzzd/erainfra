import { v } from "convex/values";
import { requireDashboardAuth } from "./dashboardAuth";
import { query } from "./_generated/server";

const stateValidator = v.union(
  v.literal("pending"),
  v.literal("preparing"),
  v.literal("ready"),
  v.literal("running"),
  v.literal("completed"),
  v.literal("cancelled"),
  v.literal("failed"),
);

export const list = query({
  args: {},
  returns: v.array(
    v.object({
      _id: v.id("attempts"),
      profile: v.string(),
      executor: v.union(
        v.literal("docker"),
        v.literal("firecracker"),
        v.literal("tart"),
        v.literal("hyperv"),
      ),
      imageRelease: v.string(),
      runnerName: v.string(),
      state: stateValidator,
      machineName: v.optional(v.string()),
      repo: v.optional(v.string()),
      displayName: v.optional(v.string()),
      workflowRunId: v.optional(v.number()),
      result: v.optional(v.string()),
      lastError: v.optional(v.string()),
      cancelReason: v.optional(v.string()),
      createdAt: v.number(),
      startedAt: v.optional(v.number()),
      finishedAt: v.optional(v.number()),
    }),
  ),
  handler: async (ctx) => {
    await requireDashboardAuth(ctx);
    const [attempts, machines] = await Promise.all([
      ctx.db.query("attempts").order("desc").take(200),
      ctx.db.query("machines").collect(),
    ]);
    const machineNames = new Map(machines.map((machine) => [machine._id, machine.name]));
    return attempts.map((attempt) => ({
      _id: attempt._id,
      profile: attempt.profile,
      executor: attempt.executor,
      imageRelease: attempt.imageRelease,
      runnerName: attempt.runnerName,
      state: attempt.state,
      machineName:
        attempt.machineId === undefined ? undefined : machineNames.get(attempt.machineId),
      repo: attempt.repo,
      displayName: attempt.displayName,
      workflowRunId: attempt.workflowRunId,
      result: attempt.result,
      lastError: attempt.lastError,
      cancelReason: attempt.cancelReason,
      createdAt: attempt.createdAt,
      startedAt: attempt.startedAt,
      finishedAt: attempt.finishedAt,
    }));
  },
});
