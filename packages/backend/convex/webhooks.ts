import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import { internalMutation, internalQuery, query } from "./_generated/server";
import { requireDashboardAuth } from "./dashboardAuth";
import { applyWorkflowJob } from "./jobs";
import { decideRepository, parseRepositoryPolicy } from "./policy";
import {
  advanceWatermark,
  clampWatermark,
  decideRecovery,
  MAX_RECOVERY_ATTEMPTS,
  nextRunDelayMs,
  RECOVERY_SEED_MS,
} from "./recovery";

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
  runnerName: v.optional(v.string()),
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

// ---------------------------------------------------------------------------
// Recovering deliveries that never arrived
//
// Everything above deals with deliveries this deployment received. The rest of
// this module is the bookkeeping for the ones it did not: see recovery.ts for
// why GitHub's delivery GUID makes asking for a redelivery safe, and github.ts
// for the action that actually talks to GitHub.
// ---------------------------------------------------------------------------

/** How many recovery rows one reconcile or status query will look at. */
export const RECOVERY_SCAN_LIMIT = 100;

const recoveryCandidateValidator = v.object({
  guid: v.string(),
  githubDeliveryId: v.number(),
  event: v.string(),
  deliveredAt: v.number(),
  statusCode: v.number(),
});

/**
 * Which of these delivery GUIDs this deployment has no record of.
 *
 * Point lookups on `by_deliveryId`, bounded by the caller's candidate list. A
 * row in any state counts as received — a delivery the allowlist rejected was
 * still delivered, and asking GitHub to send it again would only reject it
 * again.
 */
export const missingGuids = internalQuery({
  args: { guids: v.array(v.string()) },
  returns: v.array(v.string()),
  handler: async (ctx, args) => {
    const missing: string[] = [];
    for (const guid of args.guids) {
      const existing = await ctx.db
        .query("webhookDeliveries")
        .withIndex("by_deliveryId", (q) => q.eq("deliveryId", guid))
        .unique();
      if (existing === null) {
        missing.push(guid);
      }
    }
    return missing;
  },
});

/**
 * Take out the right to ask GitHub to redeliver these GUIDs.
 *
 * The attempt cap and the per-GUID backoff live here rather than in the action,
 * so a listing that keeps returning the same failed delivery cannot turn into
 * an unbounded stream of redelivery requests. The attempt is counted before the
 * request is made: a request GitHub refuses still spends one, which is what
 * walks a permanently unacceptable delivery to "abandoned".
 */
export const claimRecovery = internalMutation({
  args: {
    now: v.number(),
    candidates: v.array(recoveryCandidateValidator),
  },
  returns: v.array(v.object({ guid: v.string(), githubDeliveryId: v.number() })),
  handler: async (ctx, args) => {
    const claimed: { guid: string; githubDeliveryId: number }[] = [];
    for (const candidate of args.candidates) {
      const existing = await ctx.db
        .query("webhookRecovery")
        .withIndex("by_guid", (q) => q.eq("guid", candidate.guid))
        .unique();
      const decision = decideRecovery(existing, args.now);

      if (decision.kind === "skip") {
        continue;
      }
      if (decision.kind === "abandon") {
        if (existing !== null) {
          await ctx.db.patch(existing._id, {
            state: "abandoned",
            lastError: decision.lastError,
          });
          console.warn(
            `Giving up on webhook delivery ${candidate.guid} after ${decision.attempts} redelivery requests`,
          );
        }
        continue;
      }

      if (existing === null) {
        await ctx.db.insert("webhookRecovery", {
          guid: candidate.guid,
          githubDeliveryId: candidate.githubDeliveryId,
          event: candidate.event,
          deliveredAt: candidate.deliveredAt,
          statusCode: candidate.statusCode,
          attempts: decision.attempts,
          firstRequestedAt: args.now,
          lastRequestedAt: args.now,
          nextAttemptAt: decision.nextAttemptAt,
          state: "requested",
        });
      } else {
        await ctx.db.patch(existing._id, {
          githubDeliveryId: candidate.githubDeliveryId,
          statusCode: candidate.statusCode,
          attempts: decision.attempts,
          lastRequestedAt: args.now,
          nextAttemptAt: decision.nextAttemptAt,
        });
      }
      claimed.push({ guid: candidate.guid, githubDeliveryId: candidate.githubDeliveryId });
    }
    return claimed;
  },
});

/**
 * Record how one redelivery request went. `error` is status-code text from
 * `recovery.describeRecoveryFailure`, never a GitHub response body.
 *
 * A successful request only means GitHub accepted it; the row stays "requested"
 * until `reconcileRecovered` sees the delivery actually land.
 */
export const settleRecovery = internalMutation({
  args: {
    guid: v.string(),
    ok: v.boolean(),
    error: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("webhookRecovery")
      .withIndex("by_guid", (q) => q.eq("guid", args.guid))
      .unique();
    if (row === null) {
      return null;
    }
    await ctx.db.patch(row._id, { lastError: args.ok ? undefined : args.error });
    return null;
  },
});

/**
 * Close out recovery rows: mark the ones whose delivery arrived, and abandon
 * the ones that spent their attempts and never did.
 *
 * Deliberately not called from `recordDelivery`. That runs inside the HTTP
 * route, which has ten seconds before GitHub records the delivery as failed, so
 * it stays a signature check and one insert. Reconciling here instead costs a
 * bounded scan every five minutes and nothing at all on the hot path.
 */
export const reconcileRecovered = internalMutation({
  args: { now: v.number() },
  returns: v.object({ recovered: v.number(), abandoned: v.number() }),
  handler: async (ctx, args) => {
    const outstanding = await ctx.db
      .query("webhookRecovery")
      .withIndex("by_state", (q) => q.eq("state", "requested"))
      .take(RECOVERY_SCAN_LIMIT);

    let recovered = 0;
    let abandoned = 0;
    for (const row of outstanding) {
      const delivery = await ctx.db
        .query("webhookDeliveries")
        .withIndex("by_deliveryId", (q) => q.eq("deliveryId", row.guid))
        .unique();
      if (delivery !== null) {
        await ctx.db.patch(row._id, { state: "recovered", lastError: undefined });
        recovered += 1;
        continue;
      }
      // Every request was accepted and nothing ever arrived. Stop asking, and
      // leave the row behind so the dashboard can say so.
      if (row.attempts >= MAX_RECOVERY_ATTEMPTS && args.now >= row.nextAttemptAt) {
        await ctx.db.patch(row._id, {
          state: "abandoned",
          lastError:
            row.lastError ??
            `GitHub accepted ${row.attempts} redelivery requests but the delivery never arrived`,
        });
        console.error(
          `Webhook delivery ${row.guid} was never recovered after ${row.attempts} redelivery requests`,
        );
        abandoned += 1;
      }
    }
    return { recovered, abandoned };
  },
});

/**
 * Open a recovery run, or refuse it.
 *
 * Returns the watermark to scan from, seeded an hour back on a deployment that
 * has never run recovery so the first pass does not replay days of dead events.
 * When the circuit breaker is open this refuses before any credential is read
 * or any request is made.
 */
export const beginRecoveryRun = internalMutation({
  args: { now: v.number() },
  returns: v.union(
    v.object({ run: v.literal(false), reason: v.literal("backoff") }),
    v.object({ run: v.literal(true), scannedThrough: v.number() }),
  ),
  handler: async (ctx, args) => {
    const state = await ctx.db.query("webhookRecoveryState").first();
    if (state === null) {
      const scannedThrough = args.now - RECOVERY_SEED_MS;
      await ctx.db.insert("webhookRecoveryState", {
        scannedThrough,
        lastRunAt: args.now,
        nextRunAt: args.now,
        consecutiveFailures: 0,
        lastOutcome: "pending",
        listed: 0,
        missing: 0,
        requested: 0,
      });
      return { run: true as const, scannedThrough };
    }

    if (args.now < state.nextRunAt) {
      await ctx.db.patch(state._id, { lastRunAt: args.now, lastOutcome: "skipped-backoff" });
      return { run: false as const, reason: "backoff" as const };
    }

    await ctx.db.patch(state._id, { lastRunAt: args.now });
    return { run: true as const, scannedThrough: clampWatermark(state.scannedThrough, args.now) };
  },
});

/**
 * Close a recovery run.
 *
 * A failure widens the gap before the next one (1m → 5m → 15m → 1h), so a
 * revoked App or a wrong private key costs a couple of dozen requests a day
 * instead of nearly three hundred. A success resets that and moves the
 * watermark — but only when `newestDeliveredAt` is present, which the action
 * omits whenever the page cap cut its scan short.
 */
export const finishRecoveryRun = internalMutation({
  args: {
    now: v.number(),
    outcome: v.union(v.literal("ok"), v.literal("skipped-no-app"), v.literal("error")),
    newestDeliveredAt: v.optional(v.number()),
    listed: v.number(),
    missing: v.number(),
    requested: v.number(),
    error: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const state = await ctx.db.query("webhookRecoveryState").first();
    if (state === null) {
      return null;
    }

    if (args.outcome === "error") {
      const consecutiveFailures = state.consecutiveFailures + 1;
      await ctx.db.patch(state._id, {
        lastOutcome: "error",
        lastError: args.error,
        consecutiveFailures,
        nextRunAt: args.now + nextRunDelayMs(consecutiveFailures),
        scannedThrough: clampWatermark(state.scannedThrough, args.now),
      });
      return null;
    }

    await ctx.db.patch(state._id, {
      lastOutcome: args.outcome,
      lastError: undefined,
      // A deployment with no App is not failing; it simply cannot do this.
      lastSuccessAt: args.outcome === "ok" ? args.now : state.lastSuccessAt,
      consecutiveFailures: 0,
      nextRunAt: args.now,
      scannedThrough:
        args.newestDeliveredAt === undefined
          ? clampWatermark(state.scannedThrough, args.now)
          : advanceWatermark(state.scannedThrough, args.newestDeliveredAt, args.now),
      listed: args.listed,
      missing: args.missing,
      requested: args.requested,
    });
    return null;
  },
});

const recoveryStatusValidator = v.object({
  lastRunAt: v.number(),
  lastSuccessAt: v.optional(v.number()),
  nextRunAt: v.number(),
  lastOutcome: v.union(
    v.literal("pending"),
    v.literal("ok"),
    v.literal("skipped-no-app"),
    v.literal("skipped-backoff"),
    v.literal("error"),
  ),
  lastError: v.optional(v.string()),
  consecutiveFailures: v.number(),
  listed: v.number(),
  missing: v.number(),
  requested: v.number(),
  outstanding: v.number(),
  recovered: v.number(),
  abandoned: v.number(),
});

/**
 * Whether deliveries that never arrived are being recovered, and how it is
 * going. Null until the cron has opened its first run.
 *
 * Built field by field rather than by spreading the document, matching
 * `toFailedDeliveryView`: the counts and the run record are operator
 * diagnostics, and nothing here should widen just because a column was added.
 * The per-delivery counts are capped at RECOVERY_SCAN_LIMIT.
 */
export const recoveryStatus = query({
  args: {},
  returns: v.union(v.null(), recoveryStatusValidator),
  handler: async (ctx) => {
    await requireDashboardAuth(ctx);
    const state = await ctx.db.query("webhookRecoveryState").first();
    if (state === null) {
      return null;
    }

    const [outstanding, recovered, abandoned] = await Promise.all(
      (["requested", "recovered", "abandoned"] as const).map((recoveryState) =>
        ctx.db
          .query("webhookRecovery")
          .withIndex("by_state", (q) => q.eq("state", recoveryState))
          .take(RECOVERY_SCAN_LIMIT),
      ),
    );

    return {
      lastRunAt: state.lastRunAt,
      lastSuccessAt: state.lastSuccessAt,
      nextRunAt: state.nextRunAt,
      lastOutcome: state.lastOutcome,
      lastError: state.lastError,
      consecutiveFailures: state.consecutiveFailures,
      listed: state.listed,
      missing: state.missing,
      requested: state.requested,
      outstanding: outstanding.length,
      recovered: recovered.length,
      abandoned: abandoned.length,
    };
  },
});
