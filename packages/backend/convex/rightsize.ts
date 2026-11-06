import { v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import { internalQuery, query, type QueryCtx } from "./_generated/server";
import { requireDashboardAuth } from "./dashboardAuth";
import {
  DEFAULT_WINDOW_MS,
  MAX_WINDOW_MS,
  recommendAll,
  type Recommendation,
  type RightsizeSample,
} from "./rightsizeModel";

/**
 * Reads the measured Attempts behind right-sizing and hands them to rightsizeModel.ts. Nothing is
 * stored: a recommendation is computed on read from `attemptMetricSummaries` (newest first, by its
 * `by_updatedAt` index) and the Attempt rows they belong to.
 *
 * MAX_SCANNED_SUMMARIES bounds one read at about four thousand small documents. A fleet that
 * finishes more measured Attempts than that inside the window gets recommendations from the newest
 * ones and `truncated: true`, which says to narrow the window or the repository.
 */
export const MAX_SCANNED_SUMMARIES = 2000;

export type RightsizeReport = {
  windowStart: number;
  windowEnd: number;
  scanned: number;
  truncated: boolean;
  recommendations: Recommendation[];
};

/** `owner/name` when JobStarted gave the two apart, as the Runs page and the API print it. */
export function fullRepositoryName(attempt: Pick<Doc<"attempts">, "repo" | "owner">) {
  if (attempt.repo === undefined) return undefined;
  if (attempt.repo.includes("/") || attempt.owner === undefined) return attempt.repo;
  return `${attempt.owner}/${attempt.repo}`;
}

function matchesRepo(full: string, wanted: string) {
  return wanted.includes("/")
    ? full.toLowerCase() === wanted.toLowerCase()
    : full.toLowerCase().split("/").at(-1) === wanted.toLowerCase();
}

/** Clamps a requested window start to the metrics retention: older series no longer exist. */
export function windowStartFor(since: number | undefined, now: number) {
  const requested = since ?? now - DEFAULT_WINDOW_MS;
  return Math.min(now, Math.max(requested, now - MAX_WINDOW_MS));
}

export async function rightsizeReport(
  ctx: QueryCtx,
  args: { since?: number; repo?: string },
  now = Date.now(),
): Promise<RightsizeReport> {
  const windowStart = windowStartFor(args.since, now);
  const rows = await ctx.db
    .query("attemptMetricSummaries")
    .withIndex("by_updatedAt", (q) => q.gte("updatedAt", windowStart))
    .order("desc")
    .take(MAX_SCANNED_SUMMARIES + 1);
  const truncated = rows.length > MAX_SCANNED_SUMMARIES;
  const summaries = rows.slice(0, MAX_SCANNED_SUMMARIES);

  const samples: RightsizeSample[] = [];
  for (const summary of summaries) {
    // A series still growing says nothing yet about the job's peak.
    if (!summary.final) continue;
    const attempt = await ctx.db.get(summary.attemptId);
    if (attempt === null) continue;
    const repo = fullRepositoryName(attempt);
    // An Attempt GitHub never bound to a job ran nothing worth sizing.
    if (repo === undefined || attempt.displayName === undefined) continue;
    if (args.repo !== undefined && !matchesRepo(repo, args.repo)) continue;
    samples.push({
      repo,
      job: attempt.displayName,
      profile: attempt.profile,
      executor: attempt.executor,
      vcpus: attempt.vcpus,
      memoryMiB: attempt.memoryMiB,
      finishedAt: attempt.finishedAt ?? summary.updatedAt,
      source: summary.source,
      final: summary.final,
      samples: summary.samples,
      errors: summary.errors,
      durationMs: summary.durationMs,
      cpuP95Vcpus: summary.cpuP95Vcpus,
      cpuMaxVcpus: summary.cpuMaxVcpus,
      memoryPeakBytes: summary.memoryPeakBytes,
      oomKills: summary.oomKills,
    });
  }

  const profiles = await ctx.db.query("profiles").collect();
  return {
    windowStart,
    windowEnd: now,
    scanned: summaries.length,
    truncated,
    recommendations: recommendAll(
      samples,
      profiles.map((profile) => ({
        name: profile.name,
        executor: profile.executor,
        imageRelease: profile.imageRelease,
        vcpus: profile.vcpus,
        memoryMiB: profile.memoryMiB,
        state: profile.state,
      })),
    ),
  };
}

const sizeValidator = v.object({ vcpus: v.number(), memoryMiB: v.number() });

export const recommendationValidator = v.object({
  repo: v.string(),
  job: v.string(),
  profile: v.string(),
  verdict: v.union(
    v.literal("upsize"),
    v.literal("downsize"),
    v.literal("keep"),
    v.literal("insufficient_data"),
  ),
  recommendedProfile: v.union(v.string(), v.null()),
  suggestedProfile: v.union(v.string(), v.null()),
  current: sizeValidator,
  target: v.union(sizeValidator, v.null()),
  attempts: v.number(),
  excludedAttempts: v.number(),
  lastSeenAt: v.number(),
  cpu: v.object({ p95Vcpus: v.number(), maxVcpus: v.number(), saturatedAttempts: v.number() }),
  memory: v.object({
    peakBytes: v.number(),
    measure: v.union(v.literal("working-set"), v.literal("host-resident")),
    oomAttempts: v.number(),
  }),
  explanation: v.string(),
});

const reportValidator = v.object({
  windowStart: v.number(),
  windowEnd: v.number(),
  scanned: v.number(),
  truncated: v.boolean(),
  recommendations: v.array(recommendationValidator),
});

/**
 * The dashboard's Rightsize page. It reads this once per visit (and on Refresh) rather than
 * subscribing: every live Attempt rewrites its summary every 30 seconds, and a subscription would
 * rerun the whole scan for each of those writes.
 */
export const report = query({
  args: { sinceDays: v.optional(v.number()), repo: v.optional(v.string()) },
  returns: reportValidator,
  handler: async (ctx, args) => {
    await requireDashboardAuth(ctx);
    const now = Date.now();
    const days = args.sinceDays;
    return await rightsizeReport(
      ctx,
      {
        since: days === undefined || !Number.isFinite(days) ? undefined : now - days * 86_400_000,
        repo: args.repo === undefined || args.repo.trim() === "" ? undefined : args.repo.trim(),
      },
      now,
    );
  },
});

/** The operator API's /api/v1/rightsize (operatorHttp.ts); authorization happens there. */
export const operatorReport = internalQuery({
  args: { since: v.optional(v.number()), repo: v.optional(v.string()) },
  returns: reportValidator,
  handler: async (ctx, args) => await rightsizeReport(ctx, args),
});
