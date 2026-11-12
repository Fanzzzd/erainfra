import { ConvexError, v, type Infer } from "convex/values";

import type { Doc, Id } from "../_generated/dataModel";
import { mutation, type MutationCtx, type QueryCtx } from "../_generated/server";
import { appendAudit } from "./auditLog";
import {
  can,
  effectiveRole,
  mayAssignRole,
  type Permission,
  type PermissionRole,
  type Principal,
} from "./policy";
import { permissionRoleValidator } from "./tables";

/**
 * The signed-in user's row, or null. Convex Auth puts `<userId>|<sessionId>` in the token's
 * subject; a subject that is not a users id (as in tests that fake an identity) has no row.
 */
export async function currentUser(ctx: QueryCtx) {
  const identity = await ctx.auth.getUserIdentity();
  if (identity === null) return null;
  const userId = ctx.db.normalizeId("users", identity.subject.split("|")[0]);
  return userId === null ? null : await ctx.db.get(userId);
}

/**
 * Every infrastructure function a person calls goes through this. Unlike `requireDashboardAuth`,
 * an identity alone is not enough: the caller must have a users row whose role grants
 * `permission`.
 */
export async function requirePermission(ctx: QueryCtx, permission: Permission) {
  const user = await currentUser(ctx);
  if (user === null) throw new ConvexError("Authentication required");
  const principal: Principal & { kind: "user" } = {
    kind: "user",
    userId: user._id,
    role: effectiveRole(user.role),
  };
  if (!can(principal, permission)) {
    throw new ConvexError(`The ${principal.role} role does not allow ${permission}`);
  }
  return { user, principal, actor: user._id as string };
}

/**
 * The operator API's caller: an API token the HTTP layer already authenticated (operatorHttp.ts).
 * Internal functions behind /api/v1 take it as an argument and check it against the same
 * permission table a signed-in person is checked against, so the route's scope check and the
 * policy cannot drift apart.
 */
export const apiCallerValidator = v.object({
  tokenId: v.id("apiTokens"),
  name: v.string(),
  scope: v.union(v.literal("read"), v.literal("admin"), v.literal("metrics")),
});
export type ApiCaller = Infer<typeof apiCallerValidator>;

/** The audit actor for an API token, `token:<name>`, as the deployment routes record it. */
export function requireTokenPermission(caller: ApiCaller, permission: Permission) {
  if (!can({ kind: "token", tokenId: caller.tokenId, scope: caller.scope }, permission)) {
    throw new ConvexError(`A ${caller.scope} token does not allow ${permission}`);
  }
  return { actor: `token:${caller.name}` };
}

export function normalizeEmail(email: string) {
  return email.trim().toLowerCase();
}

/** Why `insertUser` would refuse a normalized email, or null. */
export function emailRefusal(email: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? null : "Not a valid email address";
}

/**
 * The only way a users row is created, by sign-up or by the Hub importer, so both of the Hub's
 * account rules hold for every account:
 *
 * - emails are unique, compared case-insensitively as the Hub compared them;
 * - the first account is the owner, whatever role was asked for.
 *
 * Both checks read the users table in the inserting transaction, so two concurrent sign-ups cannot
 * both see an empty table or both miss the other's email.
 */
export async function insertUser(
  ctx: MutationCtx,
  input: {
    email: string;
    role: PermissionRole;
    name?: string;
    createdAt?: number;
    legacyHubId?: string;
  },
) {
  const email = normalizeEmail(input.email);
  const refusal = emailRefusal(email);
  if (refusal !== null) throw new ConvexError(refusal);
  const existing = await ctx.db
    .query("users")
    .withIndex("email", (q) => q.eq("email", email))
    .first();
  if (existing !== null) throw new ConvexError("An account with this email already exists");
  const first = (await ctx.db.query("users").first()) === null;
  return await ctx.db.insert("users", {
    email,
    emailVerificationTime: undefined,
    role: first ? "owner" : input.role,
    ...(input.name === undefined ? {} : { name: input.name }),
    ...(input.createdAt === undefined ? {} : { createdAt: input.createdAt }),
    ...(input.legacyHubId === undefined ? {} : { legacyHubId: input.legacyHubId }),
  });
}

/**
 * Whether an owner other than `target` exists. Owners are rows with role `owner` or with no role
 * (accounts from before roles existed); two indexed reads of at most two rows each answer it.
 */
async function anotherOwnerExists(ctx: QueryCtx, target: Doc<"users">) {
  for (const role of ["owner", undefined] as const) {
    const owners = await ctx.db
      .query("users")
      .withIndex("by_role", (q) => q.eq("role", role))
      .take(2);
    if (owners.some((owner) => owner._id !== target._id)) return true;
  }
  return false;
}

/** Refuses any change that would leave the instance without an owner. */
async function assertNotLastOwner(ctx: QueryCtx, target: Doc<"users">, verb: string) {
  if (effectiveRole(target.role) === "owner" && !(await anotherOwnerExists(ctx, target))) {
    throw new ConvexError(`Cannot ${verb} the last owner account`);
  }
}

export const setUserRole = mutation({
  args: { userId: v.id("users"), role: permissionRoleValidator },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { principal, actor } = await requirePermission(ctx, "account.admin");
    const target = await ctx.db.get(args.userId);
    if (target === null) throw new ConvexError("No such user");
    const from = effectiveRole(target.role);
    if (!mayAssignRole(principal.role, from, args.role)) {
      throw new ConvexError(`The ${principal.role} role cannot change ${from} to ${args.role}`);
    }
    if (from === "owner" && args.role !== "owner") await assertNotLastOwner(ctx, target, "demote");
    await ctx.db.patch(target._id, { role: args.role });
    await appendAudit(ctx, {
      actor,
      action: "account.users.setRole",
      target: target._id,
      outcome: "success",
      meta: { from, to: args.role },
    });
    return null;
  },
});

/** Removes the account and everything that lets it sign in: accounts, sessions, refresh tokens. */
export const removeUser = mutation({
  args: { userId: v.id("users") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { principal, actor } = await requirePermission(ctx, "account.admin");
    if (args.userId === principal.userId) throw new ConvexError("Cannot remove yourself");
    const target = await ctx.db.get(args.userId);
    if (target === null) throw new ConvexError("No such user");
    const role = effectiveRole(target.role);
    if (!mayAssignRole(principal.role, role, role)) {
      throw new ConvexError(`The ${principal.role} role cannot remove an ${role}`);
    }
    await assertNotLastOwner(ctx, target, "remove");
    await deleteUserCredentials(ctx, target._id);
    await ctx.db.delete(target._id);
    await appendAudit(ctx, {
      actor,
      action: "account.users.remove",
      target: target._id,
      outcome: "success",
    });
    return null;
  },
});

async function deleteUserCredentials(ctx: MutationCtx, userId: Id<"users">) {
  const accounts = await ctx.db
    .query("authAccounts")
    .withIndex("userIdAndProvider", (q) => q.eq("userId", userId))
    .collect();
  for (const account of accounts) await ctx.db.delete(account._id);
  const sessions = await ctx.db
    .query("authSessions")
    .withIndex("userId", (q) => q.eq("userId", userId))
    .collect();
  for (const session of sessions) {
    const refreshTokens = await ctx.db
      .query("authRefreshTokens")
      .withIndex("sessionId", (q) => q.eq("sessionId", session._id))
      .collect();
    for (const token of refreshTokens) await ctx.db.delete(token._id);
    await ctx.db.delete(session._id);
  }
}
