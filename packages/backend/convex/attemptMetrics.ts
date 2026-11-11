import { ConvexError, v } from "convex/values";

import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, query, type MutationCtx } from "./_generated/server";
import {
  assertValidSnapshot,
  MAX_SUMMARY_LOOKUP,
  METRICS_LATE_REPORT_MS,
  METRICS_RETENTION_MS,
  pointsValidator,
  summarizeMetrics,
  summaryValidator,
  type AttemptMetricsSummary,
  type MetricsSnapshot,
} from "./attemptMetricsModel";
import { requireDashboardAuth } from "./dashboardAuth";
import { runnerCause, runnerCauseValidator } from "./runnerCauses";

/** Stores, serves and expires per-Attempt resource metrics; see attemptMetricsModel.ts. */

const PURGE_BATCH = 100;
const MAX_LAST_ERROR = 200;

/**
 * Stores one upload. Returns false when the Attempt is not this Worker's to write, or no longer
 * accepts writes; true when the upload is stored or is already superseded.
 *
 * Every upload is a whole snapshot, so a lost one is healed by the next and a replay changes
 * nothing. `samples` only grows on the Worker, so it orders uploads: a snapshot with fewer
 * samples than the stored one is a late duplicate and is ignored, and nothing replaces a final
 * snapshot.
 */
export async function recordAttemptMetrics(
  ctx: MutationCtx,
  machineId: Id<"machines">,
  args: { attemptId: Id<"attempts">; final: boolean; snapshot: MetricsSnapshot },
  now = Date.now(),
): Promise<boolean> {
  const attempt = await ctx.db.get(args.attemptId);
  if (attempt === null || attempt.machineId !== machineId) return false;
  if (attempt.finishedAt !== undefined && now - attempt.finishedAt > METRICS_LATE_REPORT_MS) {
    return false;
  }
  assertValidSnapshot(args.snapshot, now);
  const existing = await ctx.db
    .query("attemptMetricSummaries")
    .withIndex("by_attempt", (q) => q.eq("attemptId", attempt._id))
    .unique();
  if (existing !== null) {
    if (existing.final) return true;
    if (args.snapshot.samples < existing.samples) return true;
    if (args.snapshot.samples === existing.samples && !args.final) return true;
  }
  const { version: _version, lastError, ...stored } = args.snapshot;
  const series = {
    ...stored,
    attemptId: attempt._id,
    lastError: lastError === undefined ? undefined : lastError.slice(0, MAX_LAST_ERROR),
  };
  const summary = summarizeMetrics(args.snapshot, attempt, args.final);
  if (existing === null) {
    const seriesId = await ctx.db.insert("attemptMetrics", series);
    await ctx.db.insert("attemptMetricSummaries", {
      attemptId: attempt._id,
      machineId,
      seriesId,
      updatedAt: now,
      ...summary,
    });
    return true;
  }
  await ctx.db.replace(existing.seriesId, series);
  await ctx.db.replace(existing._id, {
    attemptId: attempt._id,
    machineId,
    seriesId: existing.seriesId,
    updatedAt: now,
    ...summary,
  });
  return true;
}

function publicSummary(row: Doc<"attemptMetricSummaries">): AttemptMetricsSummary {
  const {
    _id: _rowId,
    _creationTime: _created,
    attemptId: _attempt,
    machineId: _machine,
    seriesId: _series,
    updatedAt: _updated,
    ...summary
  } = row;
  return summary;
}

/** The Runs page's resource column: one summary per listed Attempt that has one. */
export const summaries = query({
  args: { attemptIds: v.array(v.id("attempts")) },
  returns: v.array(v.object({ attemptId: v.id("attempts"), summary: summaryValidator })),
  handler: async (ctx, args) => {
    await requireDashboardAuth(ctx);
    if (args.attemptIds.length > MAX_SUMMARY_LOOKUP) {
      throw new ConvexError(`Ask for at most ${MAX_SUMMARY_LOOKUP} Attempts at once`);
    }
    const rows = await Promise.all(
      [...new Set(args.attemptIds)].map((attemptId) =>
        ctx.db
          .query("attemptMetricSummaries")
          .withIndex("by_attempt", (q) => q.eq("attemptId", attemptId))
          .unique(),
      ),
    );
    return rows
      .filter((row) => row !== null)
      .map((row) => ({ attemptId: row.attemptId, summary: publicSummary(row) }));
  },
});

const seriesValidator = v.object({
  source: v.string(),
  startedAt: v.number(),
  sampleSeconds: v.number(),
  bucketSeconds: v.number(),
  samples: v.number(),
  errors: v.number(),
  lastError: v.optional(v.string()),
  memoryPeakBytes: v.number(),
  oomKills: v.union(v.number(), v.null()),
  points: pointsValidator,
});

/** The Attempt page: the Attempt, its summary and its whole bounded series. */
export const get = query({
  args: { attemptId: v.id("attempts") },
  returns: v.union(
    v.null(),
    v.object({
      attempt: v.object({
        _id: v.id("attempts"),
        profile: v.string(),
        executor: v.union(
          v.literal("docker"),
          v.literal("firecracker"),
          v.literal("tart"),
          v.literal("hyperv"),
        ),
        runnerName: v.string(),
        state: v.string(),
        vcpus: v.number(),
        memoryMiB: v.number(),
        machineName: v.optional(v.string()),
        repo: v.optional(v.string()),
        owner: v.optional(v.string()),
        displayName: v.optional(v.string()),
        workflowRunId: v.optional(v.number()),
        result: v.optional(v.string()),
        lastError: v.optional(v.string()),
        cause: v.optional(runnerCauseValidator),
        createdAt: v.number(),
        startedAt: v.optional(v.number()),
        finishedAt: v.optional(v.number()),
      }),
      summary: v.union(v.null(), summaryValidator),
      series: v.union(v.null(), seriesValidator),
    }),
  ),
  handler: async (ctx, args) => {
    await requireDashboardAuth(ctx);
    const attempt = await ctx.db.get(args.attemptId);
    if (attempt === null) return null;
    const [machine, summaryRow] = await Promise.all([
      attempt.machineId === undefined ? null : ctx.db.get(attempt.machineId),
      ctx.db
        .query("attemptMetricSummaries")
        .withIndex("by_attempt", (q) => q.eq("attemptId", attempt._id))
        .unique(),
    ]);
    const seriesRow = summaryRow === null ? null : await ctx.db.get(summaryRow.seriesId);
    let series = null;
    if (seriesRow !== null) {
      const { _id: _seriesId, _creationTime: _created, attemptId: _attempt, ...rest } = seriesRow;
      series = rest;
    }
    return {
      attempt: {
        _id: attempt._id,
        profile: attempt.profile,
        executor: attempt.executor,
        runnerName: attempt.runnerName,
        state: attempt.state,
        vcpus: attempt.vcpus,
        memoryMiB: attempt.memoryMiB,
        machineName: machine?.name,
        repo: attempt.repo,
        owner: attempt.owner,
        displayName: attempt.displayName,
        workflowRunId: attempt.workflowRunId,
        result: attempt.result,
        lastError: attempt.lastError,
        cause: runnerCause(attempt) ?? undefined,
        createdAt: attempt.createdAt,
        startedAt: attempt.startedAt,
        finishedAt: attempt.finishedAt,
      },
      summary: summaryRow === null ? null : publicSummary(summaryRow),
      series,
    };
  },
});

/**
 * Deletes series whose last upload is older than the retention window, a bounded batch per
 * transaction, and schedules itself again while a full batch was found.
 */
export const purgeExpired = internalMutation({
  args: {},
  returns: v.number(),
  handler: async (ctx) => {
    const cutoff = Date.now() - METRICS_RETENTION_MS;
    const expired = await ctx.db
      .query("attemptMetricSummaries")
      .withIndex("by_updatedAt", (q) => q.lt("updatedAt", cutoff))
      .take(PURGE_BATCH);
    for (const row of expired) {
      if ((await ctx.db.get(row.seriesId)) !== null) await ctx.db.delete(row.seriesId);
      await ctx.db.delete(row._id);
    }
    if (expired.length === PURGE_BATCH) {
      await ctx.scheduler.runAfter(0, internal.attemptMetrics.purgeExpired, {});
    }
    return expired.length;
  },
});
