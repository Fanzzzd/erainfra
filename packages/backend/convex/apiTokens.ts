import { getAuthUserId } from "@convex-dev/auth/server";
import { ConvexError, v } from "convex/values";
import { internalMutation, mutation, query } from "./_generated/server";
import {
  API_TOKEN_HINT_LENGTH,
  hashApiToken,
  MAX_API_TOKEN_NAME_LENGTH,
  newApiToken,
  normalizeApiTokenName,
  shouldTouchLastUsed,
} from "./apiTokenPolicy";
import { requireDashboardAuth } from "./dashboardAuth";

const scopeValidator = v.union(v.literal("read"), v.literal("admin"));

/**
 * Mint an operator API token. The token is returned once and never readable
 * again. Only a signed-in dashboard operator can mint one, and the API itself
 * has no route that mints or lists tokens: an admin token that could create
 * more tokens would let a leaked credential outlive its own revocation.
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
    const tokens = await ctx.db.query("apiTokens").order("desc").collect();
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
 * Resolve a presented token's digest to its scope, or null for an unknown or
 * revoked token. A mutation rather than a query so it can record `lastUsedAt`,
 * which it writes at most once per LAST_USED_RESOLUTION_MS.
 */
export const authenticate = internalMutation({
  args: { tokenHash: v.string() },
  returns: v.union(
    v.null(),
    v.object({ tokenId: v.id("apiTokens"), name: v.string(), scope: scopeValidator }),
  ),
  handler: async (ctx, args) => {
    const token = await ctx.db
      .query("apiTokens")
      .withIndex("by_tokenHash", (q) => q.eq("tokenHash", args.tokenHash))
      .unique();
    if (token === null || token.revokedAt !== undefined) return null;
    const now = Date.now();
    if (shouldTouchLastUsed(token.lastUsedAt, now)) {
      await ctx.db.patch(token._id, { lastUsedAt: now });
    }
    return { tokenId: token._id, name: token.name, scope: token.scope };
  },
});
