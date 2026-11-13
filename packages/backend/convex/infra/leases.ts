// Per-App operation leases for deploy and failover, following ADR 0014's controller pattern:
//
// - one row per App with a holder, an expiry and an epoch;
// - a free or expired lease goes to whoever asks, and every change of holder raises the epoch;
// - fenced Convex writes carry the epoch, so a holder that stalled past its expiry cannot commit
//   them after another took over, even before it notices.
//
// This does not stop an old holder's in-flight runtime request or make external side effects
// exactly once. The runtime command path must also reject stale fencing epochs and deduplicate
// stable operation/step idempotency keys, which the deploy pipeline does (pipeline.ts).
import { ConvexError, v } from "convex/values";

import { internalMutation, type MutationCtx, type QueryCtx } from "../_generated/server";
import { APP_LEASE_TTL_MS, decideLease, leaseAdmits } from "./policy";

export type LeaseOperation = "deploy" | "failover";

async function leaseRow(ctx: QueryCtx, app: string) {
  return ctx.db
    .query("appLeases")
    .withIndex("by_app", (q) => q.eq("app", app))
    .unique();
}

export async function acquireAppLease(
  ctx: MutationCtx,
  input: { app: string; holder: string; operation: LeaseOperation; now: number; ttlMs?: number },
) {
  const row = await leaseRow(ctx, input.app);
  const decision = decideLease(row, input.holder, input.now);
  if (!decision.grant) return decision;
  const fields = {
    holder: input.holder,
    operation: input.operation,
    epoch: decision.epoch,
    expiresAt: input.now + (input.ttlMs ?? APP_LEASE_TTL_MS),
  };
  if (row === null) {
    await ctx.db.insert("appLeases", { app: input.app, acquiredAt: input.now, ...fields });
  } else {
    await ctx.db.patch(row._id, decision.renewed ? fields : { ...fields, acquiredAt: input.now });
  }
  return decision;
}

/** Throws unless `epoch` is the App's live lease. Call before every fenced write. */
export async function assertAppLease(ctx: QueryCtx, app: string, epoch: number, now: number) {
  const row = await leaseRow(ctx, app);
  if (!leaseAdmits(row, epoch, now)) {
    throw new ConvexError(
      `Stale lease for ${app}: epoch ${epoch} is not the live lease (now epoch ${row?.epoch ?? 0})`,
    );
  }
  return row!;
}

/** Extends a live lease. A lapsed one is not revived: its holder must acquire again. */
export async function renewAppLease(
  ctx: MutationCtx,
  input: { app: string; epoch: number; now: number; ttlMs?: number },
) {
  const row = await assertAppLease(ctx, input.app, input.epoch, input.now);
  await ctx.db.patch(row._id, { expiresAt: input.now + (input.ttlMs ?? APP_LEASE_TTL_MS) });
}

/** Gives the lease up. The epoch stays, so the next holder's is higher. */
export async function releaseAppLease(ctx: MutationCtx, app: string, epoch: number) {
  const row = await leaseRow(ctx, app);
  if (row !== null && row.epoch === epoch && row.holder !== undefined) {
    await ctx.db.patch(row._id, { holder: undefined, operation: undefined });
  }
}

const operationValidator = v.union(v.literal("deploy"), v.literal("failover"));

const decisionValidator = v.union(
  v.object({ grant: v.literal(true), epoch: v.number(), renewed: v.boolean() }),
  v.object({ grant: v.literal(false), heldBy: v.string(), expiresAt: v.number() }),
);

/** Internal entry points to the lease rules; the pipeline calls the helpers above directly. */
export const acquire = internalMutation({
  args: { app: v.string(), holder: v.string(), operation: operationValidator },
  returns: decisionValidator,
  handler: async (ctx, args) => acquireAppLease(ctx, { ...args, now: Date.now() }),
});

export const renew = internalMutation({
  args: { app: v.string(), epoch: v.number() },
  returns: v.null(),
  handler: async (ctx, args) => {
    await renewAppLease(ctx, { ...args, now: Date.now() });
    return null;
  },
});

export const release = internalMutation({
  args: { app: v.string(), epoch: v.number() },
  returns: v.null(),
  handler: async (ctx, args) => {
    await releaseAppLease(ctx, args.app, args.epoch);
    return null;
  },
});
