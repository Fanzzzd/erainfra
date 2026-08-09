import { ConvexError } from "convex/values";
import type { MutationCtx, QueryCtx } from "./_generated/server";

/**
 * Every dashboard-facing query and mutation goes through this. Kept in one
 * place so a new operator-facing function cannot accidentally ship without the
 * check by forgetting to copy it.
 */
export async function requireDashboardAuth(ctx: QueryCtx | MutationCtx) {
  const identity = await ctx.auth.getUserIdentity();
  if (identity === null) {
    throw new ConvexError("Authentication required");
  }
  return identity;
}
