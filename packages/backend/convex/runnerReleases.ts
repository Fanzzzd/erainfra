// The stored actions/runner release list (one row) that the runner-release-expiring alert reads.
// github.ts refreshRunnerReleases fetches it; runnerReleaseModel.ts holds the rules.

import { v } from "convex/values";
import { internalMutation, internalQuery, type QueryCtx } from "./_generated/server";
import {
  RUNNER_RELEASE_PAGE,
  RUNNER_RELEASE_REFRESH_MS,
  runnerReleaseValidator,
  type RunnerRelease,
} from "./runnerReleaseModel";

/** The stored list, or undefined before the first successful fetch. */
export async function loadRunnerReleases(
  ctx: QueryCtx,
): Promise<{ releases: RunnerRelease[]; fetchedAt: number } | undefined> {
  const row = await ctx.db.query("runnerReleases").first();
  if (row === null || row.fetchedAt === undefined) return undefined;
  return { releases: row.releases, fetchedAt: row.fetchedAt };
}

/** Whether the refresh should ask GitHub now: never fetched, or the list is six hours old. */
export const refreshDue = internalQuery({
  args: { now: v.number() },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const row = await ctx.db.query("runnerReleases").first();
    return row?.fetchedAt === undefined || args.now - row.fetchedAt >= RUNNER_RELEASE_REFRESH_MS;
  },
});

/**
 * Records a fetch. A failed one keeps the last good list and only notes the error, so a GitHub
 * outage or a rate limit never blanks the alert's input.
 */
export const record = internalMutation({
  args: {
    attemptedAt: v.number(),
    releases: v.optional(v.array(runnerReleaseValidator)),
    error: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await ctx.db.query("runnerReleases").first();
    const patch =
      args.releases === undefined
        ? { lastAttemptAt: args.attemptedAt, lastError: args.error?.slice(0, 500) }
        : {
            lastAttemptAt: args.attemptedAt,
            lastError: undefined,
            fetchedAt: args.attemptedAt,
            releases: args.releases.slice(-RUNNER_RELEASE_PAGE),
          };
    if (row === null) {
      await ctx.db.insert("runnerReleases", { releases: [], ...patch });
    } else {
      await ctx.db.patch(row._id, patch);
    }
    return null;
  },
});
