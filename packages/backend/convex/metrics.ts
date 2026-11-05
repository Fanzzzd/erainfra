import { v } from "convex/values";
import { internalQuery } from "./_generated/server";
import { loadFleetObservation } from "./fleetObservation";
import { buildMetricFamilies, METRICS_RECENT_WINDOW_MS, renderExposition } from "./metricsFormat";

// The exposition behind `GET /metrics`. The route authenticates with an API token (apiTokens.ts),
// minted in the dashboard like every other token; a `metrics` token can scrape and do nothing else.

/** The full exposition text for one scrape. */
export const exposition = internalQuery({
  args: {},
  returns: v.string(),
  handler: async (ctx) => {
    const now = Date.now();
    const [observation, firing, rules] = await Promise.all([
      loadFleetObservation(ctx, now, { recentWindowMs: METRICS_RECENT_WINDOW_MS }),
      ctx.db
        .query("alertIncidents")
        .withIndex("by_status_resolvedAt", (q) => q.eq("status", "firing"))
        .take(1_000),
      ctx.db
        .query("alertRules")
        .withIndex("by_enabled", (q) => q.eq("enabled", true))
        .take(200),
    ]);
    const ruleNames = new Map(rules.map((rule) => [rule._id, rule.name]));
    const firingByRule = new Map<string, number>();
    for (const incident of firing) {
      const name = ruleNames.get(incident.ruleId);
      if (name === undefined) continue;
      firingByRule.set(name, (firingByRule.get(name) ?? 0) + 1);
    }
    // Every enabled rule gets a series, so "no incident" is an explicit 0 rather than absence.
    for (const rule of rules) {
      if (!firingByRule.has(rule.name)) firingByRule.set(rule.name, 0);
    }
    const incidents = [...firingByRule.entries()]
      .map(([rule, count]) => ({ rule, firing: count }))
      .toSorted((left, right) => left.rule.localeCompare(right.rule));
    return renderExposition(buildMetricFamilies(observation, incidents));
  },
});
