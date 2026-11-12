import { v, type Infer, type ObjectType } from "convex/values";

import { internal } from "./_generated/api";
import { type ActionCtx, internalMutation, internalQuery } from "./_generated/server";
import {
  fallbackReasonValidator,
  ROUTER_DECISION_RETENTION_MS,
  routerDecisionFields,
  routerRouteValidator,
} from "./routerDecisionsModel";

/**
 * Stores one row per `/runs-on` answer, so a billing reconciliation can count per day and
 * repository how often the router sent jobs to a Profile and how often to the GitHub-hosted
 * fallback, and why. Rows are kept 90 days.
 */

const PURGE_BATCH = 500;
// A Convex query reads at most 32,000 documents; the counts stop well short and say so.
const MAX_COUNTED = 16_000;
const DAY_MS = 24 * 60 * 60_000;

const { createdAt: _createdAt, ...recordArgs } = routerDecisionFields;

export const record = internalMutation({
  args: recordArgs,
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.insert("routerDecisions", { ...args, createdAt: Date.now() });
    return null;
  },
});

/**
 * Stores one decision after the router has its answer. A failed write is logged and swallowed: the
 * caller's answer never depends on the record.
 */
export async function recordRouterDecision(
  ctx: ActionCtx,
  decision: ObjectType<typeof recordArgs>,
): Promise<void> {
  try {
    await ctx.runMutation(internal.routerDecisions.record, decision);
  } catch (error) {
    console.error(`/runs-on: decision not stored: ${String(error)}`);
  }
}

const countRowValidator = v.object({
  day: v.string(),
  route: routerRouteValidator,
  reason: v.optional(fallbackReasonValidator),
  count: v.number(),
});

/**
 * Decisions in [from, to), counted per UTC day (YYYY-MM-DD), route and reason. With `repo` it
 * reads only that repository's rows; without it, every row. `truncated` is true when the range
 * held more rows than one query may read; ask again for a narrower range.
 */
export const counts = internalQuery({
  args: { repo: v.optional(v.string()), from: v.number(), to: v.number() },
  returns: v.object({ rows: v.array(countRowValidator), truncated: v.boolean() }),
  handler: async (ctx, { repo, from, to }) => {
    const decisions =
      repo === undefined
        ? await ctx.db
            .query("routerDecisions")
            .withIndex("by_createdAt", (q) => q.gte("createdAt", from).lt("createdAt", to))
            .take(MAX_COUNTED + 1)
        : await ctx.db
            .query("routerDecisions")
            .withIndex("by_repo_createdAt", (q) =>
              q.eq("repo", repo).gte("createdAt", from).lt("createdAt", to),
            )
            .take(MAX_COUNTED + 1);
    const tally = new Map<string, Infer<typeof countRowValidator>>();
    for (const decision of decisions.slice(0, MAX_COUNTED)) {
      const day = new Date(Math.floor(decision.createdAt / DAY_MS) * DAY_MS)
        .toISOString()
        .slice(0, 10);
      const key = `${day}|${decision.route}|${decision.reason ?? ""}`;
      const entry = tally.get(key);
      if (entry === undefined) {
        tally.set(key, { day, route: decision.route, reason: decision.reason, count: 1 });
      } else {
        entry.count += 1;
      }
    }
    // Rows come in createdAt order, so the tally is already in day order.
    return { rows: [...tally.values()], truncated: decisions.length > MAX_COUNTED };
  },
});

/**
 * Deletes decisions older than the retention window, a bounded batch per transaction, and
 * schedules itself again while a full batch was found.
 */
export const purgeExpired = internalMutation({
  args: {},
  returns: v.number(),
  handler: async (ctx) => {
    const cutoff = Date.now() - ROUTER_DECISION_RETENTION_MS;
    const expired = await ctx.db
      .query("routerDecisions")
      .withIndex("by_createdAt", (q) => q.lt("createdAt", cutoff))
      .take(PURGE_BATCH);
    for (const row of expired) await ctx.db.delete(row._id);
    if (expired.length === PURGE_BATCH) {
      await ctx.scheduler.runAfter(0, internal.routerDecisions.purgeExpired, {});
    }
    return expired.length;
  },
});
