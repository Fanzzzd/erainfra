import { ConvexError } from "convex/values";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { effectiveRole, isDashboardAdmin } from "./infra/policy";

/**
 * Every dashboard-facing query and mutation goes through this. Kept in one
 * place so a new operator-facing function cannot accidentally ship without the
 * check by forgetting to copy it.
 *
 * The CI functions behind it were written for accounts that may do anything.
 * Since accounts gained permission roles (infra/policy.ts), an `operator` or
 * `viewer` account, such as one the Hub importer brought over, is refused here
 * rather than handed those powers. Accounts with no role, which is every
 * account created before roles existed, read as owners and are unaffected.
 */
export async function requireDashboardAuth(ctx: QueryCtx | MutationCtx) {
  const identity = await ctx.auth.getUserIdentity();
  if (identity === null) {
    throw new ConvexError("Authentication required");
  }
  const userId = ctx.db.normalizeId("users", identity.subject.split("|")[0]);
  const user = userId === null ? null : await ctx.db.get(userId);
  if (user !== null && !isDashboardAdmin(effectiveRole(user.role))) {
    throw new ConvexError(`The ${effectiveRole(user.role)} role cannot use this`);
  }
  return identity;
}
