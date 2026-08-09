import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import { internalMutation, query } from "./_generated/server";
import { requireDashboardAuth } from "./dashboardAuth";
import { applyWorkflowJob } from "./jobs";
import { decideRepository, parseRepositoryPolicy } from "./policy";

export const MAX_DELIVERY_ATTEMPTS = 5;
/** How long a delivery may sit in "pending" before reconcile retries it. */
export const DELIVERY_RETRY_AFTER_MS = 60_000;

const workflowJobValidator = v.object({
  action: v.union(v.literal("queued"), v.literal("in_progress"), v.literal("completed")),
  ghJobId: v.number(),
  githubInstallationId: v.optional(v.number()),
  repo: v.string(),
  repoIsPublic: v.boolean(),
  workflowName: v.string(),
  labels: v.array(v.string()),
  conclusion: v.optional(v.string()),
});

export const RECENT_FAILURE_LIMIT = 50;

const failedDeliveryValidator = v.object({
  _id: v.id("webhookDeliveries"),
  deliveryId: v.string(),
  event: v.string(),
  repo: v.optional(v.string()),
  status: v.union(v.literal("rejected"), v.literal("failed")),
  receivedAt: v.number(),
  settledAt: v.optional(v.number()),
  attempts: v.number(),
  lastError: v.optional(v.string()),
});

/**
 * Project a delivery down to what an operator needs to diagnose it.
 *
 * Built field by field rather than by spreading the document: `workflowJob`
 * carries the whole narrowed event and must not reach a browser, so only the
 * repository name is lifted out of it. Adding a field to the table therefore
 * cannot silently widen what this returns.
 */
export function toFailedDeliveryView(
  delivery: Doc<"webhookDeliveries">,
  status: "rejected" | "failed",
) {
  return {
    _id: delivery._id,
    deliveryId: delivery.deliveryId,
    event: delivery.event,
    repo: delivery.workflowJob?.repo,
    status,
    receivedAt: delivery.receivedAt,
    settledAt: delivery.settledAt,
    attempts: delivery.attempts,
    lastError: delivery.lastError,
  };
}

/**
 * Deliveries that arrived, verified, and were then refused or gave up.
 *
 * This is the only place an allowlist rejection is visible: intake fails
 * closed and creates no job row, so without this the symptom is an empty Jobs
 * table and no explanation anywhere.
 */
export const recentFailures = query({
  args: {},
  returns: v.array(failedDeliveryValidator),
  handler: async (ctx) => {
    await requireDashboardAuth(ctx);
    const [rejected, failed] = await Promise.all([
      ctx.db
        .query("webhookDeliveries")
        .withIndex("by_status", (q) => q.eq("status", "rejected"))
        .order("desc")
        .take(RECENT_FAILURE_LIMIT),
      ctx.db
        .query("webhookDeliveries")
        .withIndex("by_status", (q) => q.eq("status", "failed"))
        .order("desc")
        .take(RECENT_FAILURE_LIMIT),
    ]);

    return [
      ...rejected.map((delivery) => toFailedDeliveryView(delivery, "rejected")),
      ...failed.map((delivery) => toFailedDeliveryView(delivery, "failed")),
    ]
      .toSorted((a, b) => b.receivedAt - a.receivedAt)
      .slice(0, RECENT_FAILURE_LIMIT);
  },
});

/**
 * Record a verified delivery and hand it to a scheduled processor. Keyed by
 * X-GitHub-Delivery, so a redelivery of the same event is a no-op rather than a
 * second job.
 */
export const recordDelivery = internalMutation({
  args: {
    deliveryId: v.string(),
    event: v.string(),
    workflowJob: v.optional(workflowJobValidator),
  },
  returns: v.object({ duplicate: v.boolean() }),
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("webhookDeliveries")
      .withIndex("by_deliveryId", (q) => q.eq("deliveryId", args.deliveryId))
      .unique();
    if (existing !== null) {
      return { duplicate: true };
    }

    const deliveryId = await ctx.db.insert("webhookDeliveries", {
      deliveryId: args.deliveryId,
      event: args.event,
      receivedAt: Date.now(),
      status: "pending",
      workflowJob: args.workflowJob,
      attempts: 0,
    });
    await ctx.scheduler.runAfter(0, internal.webhooks.processDelivery, {
      deliveryId,
    });
    return { duplicate: false };
  },
});

/**
 * Apply one recorded delivery. Runs as its own transaction: on an unexpected
 * error everything rolls back and the row stays "pending", which reconcile
 * retries. GitHub never redelivers a failed webhook on its own, so this row is
 * the only thing between a transient failure and a permanently lost job.
 */
export const processDelivery = internalMutation({
  args: { deliveryId: v.id("webhookDeliveries") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const delivery = await ctx.db.get(args.deliveryId);
    if (delivery === null || delivery.status !== "pending") {
      return null;
    }

    const event = delivery.workflowJob;
    if (event === undefined) {
      await ctx.db.patch(delivery._id, {
        status: "rejected",
        lastError: "Delivery carried no workflow_job payload",
        settledAt: Date.now(),
      });
      return null;
    }

    // The allowlist is enforced here, before any job row can exist.
    const decision = decideRepository(
      event.repo,
      event.repoIsPublic,
      parseRepositoryPolicy(process.env),
    );
    if (!decision.allowed) {
      console.warn(`Rejected workflow_job from ${event.repo}: ${decision.reason}`);
      await ctx.db.patch(delivery._id, {
        status: "rejected",
        lastError: decision.reason,
        settledAt: Date.now(),
      });
      return null;
    }

    await applyWorkflowJob(ctx, event);
    await ctx.db.patch(delivery._id, {
      status: "processed",
      attempts: delivery.attempts + 1,
      settledAt: Date.now(),
    });
    return null;
  },
});

/**
 * Retry deliveries that never settled. Called from reconcile so the attempt
 * accounting commits even when the processor itself keeps rolling back.
 */
export const retryStalledDeliveries = internalMutation({
  args: { now: v.number() },
  returns: v.object({ retried: v.number(), abandoned: v.number() }),
  handler: async (ctx, args) => {
    const pending = await ctx.db
      .query("webhookDeliveries")
      .withIndex("by_status", (q) => q.eq("status", "pending"))
      .take(50);

    let retried = 0;
    let abandoned = 0;
    for (const delivery of pending) {
      if (args.now - delivery.receivedAt < DELIVERY_RETRY_AFTER_MS) {
        continue;
      }
      const attempts = delivery.attempts + 1;
      if (attempts >= MAX_DELIVERY_ATTEMPTS) {
        await ctx.db.patch(delivery._id, {
          status: "failed",
          attempts,
          lastError: `Gave up after ${attempts} attempts`,
          settledAt: args.now,
        });
        console.error(
          `Webhook delivery ${delivery.deliveryId} failed permanently after ${attempts} attempts`,
        );
        abandoned += 1;
        continue;
      }
      await ctx.db.patch(delivery._id, { attempts });
      await ctx.scheduler.runAfter(0, internal.webhooks.processDelivery, {
        deliveryId: delivery._id,
      });
      retried += 1;
    }
    return { retried, abandoned };
  },
});
