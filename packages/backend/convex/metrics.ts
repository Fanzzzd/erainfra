import { getAuthUserId } from "@convex-dev/auth/server";
import { ConvexError, v } from "convex/values";
import { internalMutation, internalQuery, mutation, query } from "./_generated/server";
import { requireDashboardAuth } from "./dashboardAuth";
import { loadFleetObservation } from "./fleetObservation";
import { buildMetricFamilies, METRICS_RECENT_WINDOW_MS, renderExposition } from "./metricsFormat";

// Credentials for `GET /metrics`.
//
// Why dashboard-minted tokens and not a METRICS_TOKEN environment variable: an env var can only be
// changed by whoever holds deploy credentials, it allows exactly one live value (so rotating it
// means a scrape gap or a coordinated flip), and the deployment keeps it in plaintext. A minted
// token is random, shown once, stored only as its SHA-256, can overlap with its replacement, and
// is revoked with one click by any operator who sees it leak. This is the shape actuated uses
// for its per-customer metrics token and GitHub uses for personal access tokens.

const TOKEN_PREFIX = "eim_";
/** Characters of the token kept for display, including the prefix. */
const DISPLAY_PREFIX_LENGTH = TOKEN_PREFIX.length + 8;
/** `lastUsedAt` is refreshed at most this often, so a 15-second scrape is not a write each time. */
export const LAST_USED_RESOLUTION_MS = 5 * 60_000;
const LABEL_MAX_LENGTH = 100;

export async function sha256Hex(input: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function newMetricsToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return `${TOKEN_PREFIX}${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

/** The bearer token from an Authorization header, or null when there is none in that form. */
export function bearerToken(header: string | null) {
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header ?? "");
  return match?.[1] ?? null;
}

export const listTokens = query({
  args: {},
  returns: v.array(
    v.object({
      _id: v.id("metricsTokens"),
      label: v.string(),
      prefix: v.string(),
      createdAt: v.number(),
      lastUsedAt: v.optional(v.number()),
      revokedAt: v.optional(v.number()),
    }),
  ),
  handler: async (ctx) => {
    await requireDashboardAuth(ctx);
    const tokens = await ctx.db.query("metricsTokens").order("desc").take(100);
    return tokens.map((token) => ({
      _id: token._id,
      label: token.label,
      prefix: token.prefix,
      createdAt: token.createdAt,
      ...(token.lastUsedAt === undefined ? {} : { lastUsedAt: token.lastUsedAt }),
      ...(token.revokedAt === undefined ? {} : { revokedAt: token.revokedAt }),
    }));
  },
});

/** Mint a scrape token. The returned value is the only time the secret leaves the server. */
export const mintToken = mutation({
  args: { label: v.string() },
  returns: v.object({ id: v.id("metricsTokens"), token: v.string() }),
  handler: async (ctx, args) => {
    await requireDashboardAuth(ctx);
    const label = args.label.trim();
    if (label.length === 0 || label.length > LABEL_MAX_LENGTH) {
      throw new ConvexError(`Give the token a label of 1 to ${LABEL_MAX_LENGTH} characters`);
    }
    const token = newMetricsToken();
    const createdBy = await getAuthUserId(ctx);
    const id = await ctx.db.insert("metricsTokens", {
      label,
      tokenHash: await sha256Hex(token),
      prefix: token.slice(0, DISPLAY_PREFIX_LENGTH),
      createdAt: Date.now(),
      ...(createdBy === null ? {} : { createdBy }),
    });
    return { id, token };
  },
});

export const revokeToken = mutation({
  args: { id: v.id("metricsTokens") },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireDashboardAuth(ctx);
    const token = await ctx.db.get(args.id);
    if (token === null) throw new ConvexError("Token not found");
    if (token.revokedAt === undefined) {
      await ctx.db.patch(token._id, { revokedAt: Date.now() });
    }
    return null;
  },
});

/** The live token row a presented secret hashes to, or null. */
export const authorizeScrape = internalQuery({
  args: { tokenHash: v.string() },
  returns: v.union(
    v.null(),
    v.object({ id: v.id("metricsTokens"), lastUsedAt: v.optional(v.number()) }),
  ),
  handler: async (ctx, args) => {
    const token = await ctx.db
      .query("metricsTokens")
      .withIndex("by_tokenHash", (q) => q.eq("tokenHash", args.tokenHash))
      .unique();
    if (token === null || token.revokedAt !== undefined) return null;
    return {
      id: token._id,
      ...(token.lastUsedAt === undefined ? {} : { lastUsedAt: token.lastUsedAt }),
    };
  },
});

export const recordScrape = internalMutation({
  args: { id: v.id("metricsTokens"), at: v.number() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const token = await ctx.db.get(args.id);
    if (token === null || token.revokedAt !== undefined) return null;
    await ctx.db.patch(token._id, { lastUsedAt: args.at });
    return null;
  },
});

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
