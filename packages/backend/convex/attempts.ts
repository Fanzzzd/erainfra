import { v } from "convex/values";

import type { Doc } from "./_generated/dataModel";
import { query } from "./_generated/server";
import { requireDashboardAuth } from "./dashboardAuth";
import { egressRecordValidator } from "./egress";
import { runnerCause, runnerCauseValidator } from "./runnerCauses";

/** How many Attempts the Runs page shows, newest first. */
export const ATTEMPT_LIST_LIMIT = 200;

const stateValidator = v.union(
  v.literal("pending"),
  v.literal("preparing"),
  v.literal("ready"),
  v.literal("running"),
  v.literal("completed"),
  v.literal("cancelled"),
  v.literal("failed"),
);

/**
 * How long GitHub held the job before a Runner of ours picked it up, or null when the controller
 * reported neither when the job was queued nor when GitHub assigned it to the scale set.
 *
 * Both ends come from GitHub's JobStarted message, so the difference is measured on one clock. The
 * wait starts at queueTime. GitHub's scale-set messages have so far carried it as zero, which the
 * controller drops, so the wait then starts at scaleSetAssignTime (`assignedAt`): when GitHub
 * handed the job to this Profile's scale set. That leaves out only the time before the scale set
 * acquired the job, which is short while its controller listens. The wait ends at
 * runnerAssignTime. Only when GitHub omitted that does it fall back to `startedAt`, which may be
 * the control plane's receipt of JobStarted and skewed against GitHub's clock; a negative result
 * from that skew reads as zero, not as a wait.
 */
export function queueWaitMs(
  attempt: Pick<Doc<"attempts">, "queueTime" | "assignedAt" | "runnerAssignedAt" | "startedAt">,
): number | null {
  const queued = attempt.queueTime ?? attempt.assignedAt;
  if (queued === undefined) return null;
  const start = attempt.runnerAssignedAt ?? attempt.startedAt;
  if (start === undefined) return null;
  return Math.max(0, start - queued);
}

/**
 * The GitHub Actions run this Attempt served. GitHub's JobStarted carries the repository name and
 * its owner separately, and both plus the run id must be known. That message has no numeric job
 * id, which a `/job/<id>` link would need, so the link stops at the run.
 */
export function workflowRunUrl(
  attempt: Pick<Doc<"attempts">, "owner" | "repo" | "workflowRunId">,
): string | undefined {
  if (attempt.repo === undefined || attempt.workflowRunId === undefined) return undefined;
  const fullName = attempt.repo.includes("/")
    ? attempt.repo
    : attempt.owner === undefined
      ? undefined
      : `${attempt.owner}/${attempt.repo}`;
  const [owner, name, extra] = fullName?.split("/") ?? [];
  if (!owner || !name || extra !== undefined) return undefined;
  return `https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/actions/runs/${attempt.workflowRunId}`;
}

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
      selectionReason: v.optional(v.string()),
      repo: v.optional(v.string()),
      owner: v.optional(v.string()),
      displayName: v.optional(v.string()),
      workflowRunId: v.optional(v.number()),
      workflowRunUrl: v.optional(v.string()),
      result: v.optional(v.string()),
      lastError: v.optional(v.string()),
      cancelReason: v.optional(v.string()),
      cause: v.optional(runnerCauseValidator),
      createdAt: v.number(),
      queueTime: v.optional(v.number()),
      queueWaitMs: v.union(v.number(), v.null()),
      startedAt: v.optional(v.number()),
      finishedAt: v.optional(v.number()),
    }),
  ),
  handler: async (ctx) => {
    await requireDashboardAuth(ctx);
    const [attempts, machines] = await Promise.all([
      ctx.db.query("attempts").order("desc").take(ATTEMPT_LIST_LIMIT),
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
      selectionReason: attempt.selectionReason,
      repo: attempt.repo,
      owner: attempt.owner,
      displayName: attempt.displayName,
      workflowRunId: attempt.workflowRunId,
      workflowRunUrl: workflowRunUrl(attempt),
      result: attempt.result,
      lastError: attempt.lastError,
      cancelReason: attempt.cancelReason,
      cause: runnerCause(attempt) ?? undefined,
      createdAt: attempt.createdAt,
      queueTime: attempt.queueTime,
      queueWaitMs: queueWaitMs(attempt),
      startedAt: attempt.startedAt,
      finishedAt: attempt.finishedAt,
    }));
  },
});

/**
 * What one Attempt's guest talked to, for an audit or allowlist Profile, or
 * null when the Worker recorded nothing: a public Profile, an Agent that
 * predates egress records, or an Attempt that never ran.
 */
export const egress = query({
  args: { attemptId: v.id("attempts") },
  returns: v.union(
    v.null(),
    v.object({ profile: v.string(), recordedAt: v.number(), record: egressRecordValidator }),
  ),
  handler: async (ctx, args) => {
    await requireDashboardAuth(ctx);
    const row = await ctx.db
      .query("attemptEgress")
      .withIndex("by_attempt", (q) => q.eq("attemptId", args.attemptId))
      .unique();
    if (row === null) return null;
    return { profile: row.profile, recordedAt: row.recordedAt, record: row.record };
  },
});
