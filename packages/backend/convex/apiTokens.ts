import { getAuthUserId } from "@convex-dev/auth/server";
import { ConvexError, v } from "convex/values";
import { internalMutation, internalQuery, mutation, query } from "./_generated/server";
import {
  API_TOKEN_HINT_LENGTH,
  hashApiToken,
  MAX_API_TOKEN_NAME_LENGTH,
  newApiToken,
  normalizeApiTokenName,
} from "./apiTokenPolicy";
import { requireDashboardAuth } from "./dashboardAuth";

export const scopeValidator = v.union(v.literal("read"), v.literal("admin"), v.literal("metrics"));

/** How many tokens the dashboard lists, newest first. */
const LIST_LIMIT = 200;

/**
 * Mint an API token for /api/v1 or /metrics. The token is returned once and
 * never readable again. Only a signed-in dashboard operator can mint one, and
 * no HTTP route mints or lists tokens: an admin token that could create more
 * tokens would let a leaked credential outlive its own revocation.
 *
 * A token rather than an environment variable such as METRICS_TOKEN: an env var
 * takes deploy credentials to change, allows one live value at a time (so
 * rotation means a gap), and sits in the deployment in plaintext. Several tokens
 * can be live at once, so a replacement overlaps the one it retires.
 */
export const create = mutation({
  args: { name: v.string(), scope: scopeValidator },
  returns: v.object({ _id: v.id("apiTokens"), token: v.string() }),
  handler: async (ctx, args) => {
    await requireDashboardAuth(ctx);
    const name = normalizeApiTokenName(args.name);
    if (name === null) {
      throw new ConvexError(`Name the token in 1 to ${MAX_API_TOKEN_NAME_LENGTH} characters`);
    }
    const token = newApiToken();
    const createdBy = await getAuthUserId(ctx);
    const _id = await ctx.db.insert("apiTokens", {
      name,
      scope: args.scope,
      tokenHash: await hashApiToken(token),
      hint: token.slice(0, API_TOKEN_HINT_LENGTH),
      ...(createdBy === null ? {} : { createdBy }),
      createdAt: Date.now(),
    });
    return { _id, token };
  },
});

export const list = query({
  args: {},
  returns: v.array(
    v.object({
      _id: v.id("apiTokens"),
      name: v.string(),
      scope: scopeValidator,
      hint: v.string(),
      createdByEmail: v.optional(v.string()),
      createdAt: v.number(),
      lastUsedAt: v.optional(v.number()),
      revokedAt: v.optional(v.number()),
    }),
  ),
  handler: async (ctx) => {
    await requireDashboardAuth(ctx);
    const tokens = await ctx.db.query("apiTokens").order("desc").take(LIST_LIMIT);
    return Promise.all(
      tokens.map(async (token) => {
        const creator = token.createdBy === undefined ? null : await ctx.db.get(token.createdBy);
        return {
          _id: token._id,
          name: token.name,
          scope: token.scope,
          hint: token.hint,
          createdByEmail: creator?.email ?? undefined,
          createdAt: token.createdAt,
          lastUsedAt: token.lastUsedAt,
          revokedAt: token.revokedAt,
        };
      }),
    );
  },
});

/** Revocation takes effect on the token's next request; there is no cache to expire. */
export const revoke = mutation({
  args: { tokenId: v.id("apiTokens") },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireDashboardAuth(ctx);
    const token = await ctx.db.get(args.tokenId);
    if (token === null) throw new ConvexError("Token not found");
    if (token.revokedAt === undefined) {
      await ctx.db.patch(token._id, { revokedAt: Date.now() });
    }
    return null;
  },
});

/**
 * The live token a presented digest belongs to, or null for an unknown or
 * revoked one. A query, so a request whose `lastUsedAt` is fresh writes nothing.
 */
export const lookup = internalQuery({
  args: { tokenHash: v.string() },
  returns: v.union(
    v.null(),
    v.object({
      tokenId: v.id("apiTokens"),
      name: v.string(),
      scope: scopeValidator,
      lastUsedAt: v.optional(v.number()),
    }),
  ),
  handler: async (ctx, args) => {
    const token = await ctx.db
      .query("apiTokens")
      .withIndex("by_tokenHash", (q) => q.eq("tokenHash", args.tokenHash))
      .unique();
    if (token === null || token.revokedAt !== undefined) return null;
    return {
      tokenId: token._id,
      name: token.name,
      scope: token.scope,
      ...(token.lastUsedAt === undefined ? {} : { lastUsedAt: token.lastUsedAt }),
    };
  },
});

export const recordUse = internalMutation({
  args: { tokenId: v.id("apiTokens"), at: v.number() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const token = await ctx.db.get(args.tokenId);
    if (token === null || token.revokedAt !== undefined) return null;
    await ctx.db.patch(token._id, { lastUsedAt: args.at });
    return null;
  },
});
