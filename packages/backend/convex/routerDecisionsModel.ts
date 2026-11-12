import { v } from "convex/values";

/** Why the `/runs-on` router answered the fallback for a Profile (routing.profileRoute). */
export const fallbackReasonValidator = v.union(
  v.literal("unknown-profile"),
  v.literal("paused"),
  v.literal("no-controller"),
  v.literal("no-ready-worker"),
  v.literal("saturated"),
  // Every schedulable Worker is over its start budget, so a job sent there would wait for its
  // start (startBudget.ts).
  v.literal("over-start-budget"),
);

export const routerRouteValidator = v.union(v.literal("profile"), v.literal("fallback"));

/** Stored decisions are kept 90 days (routerDecisions.purgeExpired). */
export const ROUTER_DECISION_RETENTION_MS = 90 * 24 * 60 * 60_000;

/** One `/runs-on` answer (routerDecisions.ts). */
export const routerDecisionFields = {
  // The Profile asked about, or the labels of the legacy `labels=` form.
  profile: v.optional(v.string()),
  labels: v.optional(v.array(v.string())),
  // The `runs-on` value the router returned.
  answer: v.union(v.string(), v.array(v.string())),
  route: routerRouteValidator,
  // Why a Profile request fell back. The labels form has no reason.
  reason: v.optional(fallbackReasonValidator),
  // OWNER/NAME as the caller sent it in `repo=`; absent when the caller sent none.
  repo: v.optional(v.string()),
  createdAt: v.number(),
};
