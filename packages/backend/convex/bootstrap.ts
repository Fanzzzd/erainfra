import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { mutation, type MutationCtx } from "./_generated/server";
import { requireDashboardAuth } from "./dashboardAuth";
import {
  constantTimeEqual,
  GRANT_TTL_MS,
  grantValidity,
  nextThrottleAfterFailure,
  readBootstrapSecret,
  throttleState,
} from "./bootstrapPolicy";

/**
 * One message for every reason a sign-up can be refused. An unauthenticated
 * caller must not be able to tell "no grant" from "expired grant" from "this
 * instance already has an admin" -- otherwise the sign-up endpoint becomes a
 * probe for whether the instance is still up for grabs.
 */
export const SIGNUP_REFUSED = "Sign-up requires a valid invitation.";

async function sha256Hex(input: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function sha256Bytes(input: string) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input)));
}

/** 256 bits of grant token, rendered hex. Returned once and never stored raw. */
function newGrantToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function issueGrant(
  ctx: MutationCtx,
  kind: "bootstrap" | "invite",
  invitedBy?: Awaited<ReturnType<typeof getAuthUserId>>,
) {
  const token = newGrantToken();
  const now = Date.now();
  const expiresAt = now + GRANT_TTL_MS;
  await ctx.db.insert("signupGrants", {
    kind,
    tokenHash: await sha256Hex(token),
    createdAt: now,
    expiresAt,
    ...(invitedBy === undefined || invitedBy === null ? {} : { invitedBy }),
  });
  return { grantToken: token, expiresAt };
}

const claimResult = v.union(
  v.object({
    ok: v.literal(true),
    grantToken: v.string(),
    expiresAt: v.number(),
  }),
  v.object({
    ok: v.literal(false),
    reason: v.union(
      v.literal("rejected"),
      v.literal("locked"),
      v.literal("unavailable"),
      v.literal("already-bootstrapped"),
    ),
    retryAfterMs: v.optional(v.number()),
    detail: v.optional(v.string()),
  }),
);

/**
 * Exchange BOOTSTRAP_SECRET for a one-shot grant that lets the caller create
 * the first dashboard admin.
 *
 * Deliberately *returns* failures instead of throwing: a throw would roll the
 * transaction back and take the throttle increment with it, so a wrong secret
 * would cost the attacker nothing.
 */
export const claim = mutation({
  args: { secret: v.string() },
  returns: claimResult,
  handler: async (ctx, args) => {
    const now = Date.now();
    const throttle = await ctx.db.query("bootstrapThrottle").first();
    const state = throttleState(throttle, now);
    if (state.locked) {
      return { ok: false as const, reason: "locked" as const, retryAfterMs: state.retryAfterMs };
    }

    // Fail closed on a missing or weak secret. Saying so is safe: an instance
    // with no bootstrap secret cannot be bootstrapped by anyone, so there is
    // nothing for the answer to give away.
    const configured = readBootstrapSecret(process.env);
    if (!configured.configured) {
      return { ok: false as const, reason: "unavailable" as const, detail: configured.reason };
    }

    const [presented, expected] = await Promise.all([
      sha256Bytes(args.secret),
      sha256Bytes(configured.secret),
    ]);
    if (!constantTimeEqual(presented, expected)) {
      const next = nextThrottleAfterFailure(throttle, now);
      if (throttle === null) {
        await ctx.db.insert("bootstrapThrottle", { ...next, updatedAt: now });
      } else {
        await ctx.db.patch(throttle._id, { ...next, updatedAt: now });
      }
      return { ok: false as const, reason: "rejected" as const };
    }

    // The secret was correct, so the caller is the operator and telling them
    // the instance is already set up costs nothing and saves confusion.
    if (throttle !== null) {
      await ctx.db.patch(throttle._id, { failures: 0, lockedUntil: 0, updatedAt: now });
    }
    const anyUser = await ctx.db.query("users").first();
    if (anyUser !== null) {
      return { ok: false as const, reason: "already-bootstrapped" as const };
    }

    return { ok: true as const, ...(await issueGrant(ctx, "bootstrap")) };
  },
});

/**
 * The only way to open sign-up once the instance has an admin. The returned
 * token is shown to the inviting admin once; it is never readable again.
 */
export const invite = mutation({
  args: {},
  returns: v.object({ grantToken: v.string(), expiresAt: v.number() }),
  handler: async (ctx) => {
    await requireDashboardAuth(ctx);
    return await issueGrant(ctx, "invite", await getAuthUserId(ctx));
  },
});

/**
 * Redeem a grant on behalf of a sign-up. Called from the auth callback inside
 * the same transaction that creates the user, so the check, the consumption of
 * the grant and the insert either all happen or none do.
 *
 * Every rejection throws the same message on purpose -- see SIGNUP_REFUSED.
 */
export async function consumeSignupGrant(ctx: MutationCtx, presentedToken: unknown) {
  if (typeof presentedToken !== "string" || presentedToken.length === 0) {
    throw new Error(SIGNUP_REFUSED);
  }

  const tokenHash = await sha256Hex(presentedToken);
  const grant = await ctx.db
    .query("signupGrants")
    .withIndex("by_tokenHash", (q) => q.eq("tokenHash", tokenHash))
    .unique();
  if (grant === null || grantValidity(grant, Date.now()) !== "valid") {
    throw new Error(SIGNUP_REFUSED);
  }

  // One-winner semantics. A bootstrap grant only ever creates the *first*
  // account: once any user exists it is inert, whatever its expiry says.
  // Convex mutations are serializable, so two concurrent redemptions cannot
  // both read an empty users table and both commit.
  //
  // Nothing is written on this path deliberately. The throw aborts the
  // transaction, so marking the grant used here would be rolled back with it;
  // the losing grant simply stays unusable until it expires.
  if (grant.kind === "bootstrap") {
    const anyUser = await ctx.db.query("users").first();
    if (anyUser !== null) {
      throw new Error(SIGNUP_REFUSED);
    }
  }

  await ctx.db.patch(grant._id, { usedAt: Date.now() });
  return grant;
}
