import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalMutation } from "./_generated/server";
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
