import { v } from "convex/values";

import { internal } from "./_generated/api";
import { internalAction, internalMutation, internalQuery } from "./_generated/server";
import {
  classifyResponse,
  DELIVERY_HEADER,
  DELIVERY_TIMEOUT_MS,
  deliveryBackoffMs,
  EVENT_HEADER,
  MAX_DELIVERY_ATTEMPTS,
  SIGNATURE_HEADER,
  signWebhook,
  type SendOutcome,
} from "./alertNotify";

// Sends one alertDeliveries row. The action does the network call and nothing else; the outcome
// is written by a mutation, which also schedules the next try. A delivery is therefore at least
// once: a receiver should dedupe on the X-EraInfra-Delivery header.

const ERROR_MAX_LENGTH = 300;

export const loadForSend = internalQuery({
  args: { deliveryId: v.id("alertDeliveries") },
  returns: v.union(
    v.object({ ready: v.literal(false), reason: v.optional(v.string()) }),
    v.object({
      ready: v.literal(true),
      kind: v.union(v.literal("webhook"), v.literal("slack")),
      url: v.string(),
      signingSecret: v.optional(v.string()),
      event: v.union(v.literal("firing"), v.literal("resolved"), v.literal("test")),
      body: v.string(),
    }),
  ),
  handler: async (ctx, args) => {
    const delivery = await ctx.db.get(args.deliveryId);
    // Already settled: a duplicate schedule, or the retention sweep got there first.
    if (delivery === null || delivery.status !== "pending") return { ready: false as const };
    const destination = await ctx.db.get(delivery.destinationId);
    if (destination === null) {
      return { ready: false as const, reason: "The destination was deleted" };
    }
    if (!destination.enabled) {
      return { ready: false as const, reason: "The destination is disabled" };
    }
    return {
      ready: true as const,
      kind: destination.kind,
      url: destination.url,
      ...(destination.signingSecret === undefined
        ? {}
        : { signingSecret: destination.signingSecret }),
      event: delivery.event,
      body: delivery.body,
    };
  },
});

const outcomeValidator = v.union(
  v.object({ kind: v.literal("delivered"), statusCode: v.number() }),
  v.object({
    kind: v.literal("retry"),
    statusCode: v.optional(v.number()),
    error: v.string(),
    retryAfterMs: v.optional(v.number()),
  }),
  v.object({ kind: v.literal("permanent"), statusCode: v.optional(v.number()), error: v.string() }),
);

export const recordOutcome = internalMutation({
  args: { deliveryId: v.id("alertDeliveries"), outcome: outcomeValidator },
  returns: v.null(),
  handler: async (ctx, args) => {
    const delivery = await ctx.db.get(args.deliveryId);
    if (delivery === null || delivery.status !== "pending") return null;
    const now = Date.now();
    const attempts = delivery.attempts + 1;
    const outcome = args.outcome;
    const statusCode =
      outcome.statusCode === undefined ? {} : { lastStatusCode: outcome.statusCode };
    if (outcome.kind === "delivered") {
      await ctx.db.patch(delivery._id, {
        status: "delivered",
        attempts,
        deliveredAt: now,
        nextAttemptAt: undefined,
        lastError: undefined,
        ...statusCode,
      });
      return null;
    }
    const error = outcome.error.slice(0, ERROR_MAX_LENGTH);
    if (outcome.kind === "permanent" || attempts >= MAX_DELIVERY_ATTEMPTS) {
      await ctx.db.patch(delivery._id, {
        status: "failed",
        attempts,
        nextAttemptAt: undefined,
        lastError:
          outcome.kind === "retry" ? `${error}; gave up after ${attempts} attempts` : error,
        ...statusCode,
      });
      return null;
    }
    const delay = deliveryBackoffMs(attempts, Math.random(), outcome.retryAfterMs);
    await ctx.db.patch(delivery._id, {
      attempts,
      nextAttemptAt: now + delay,
      lastError: error,
      ...statusCode,
    });
    await ctx.scheduler.runAfter(delay, internal.alertDelivery.deliver, {
      deliveryId: delivery._id,
    });
    return null;
  },
});

function describeFetchError(error: unknown) {
  if (error instanceof Error) {
    return error.name === "TimeoutError" || error.name === "AbortError"
      ? `No response within ${DELIVERY_TIMEOUT_MS / 1_000}s`
      : error.message;
  }
  return "Request failed";
}

export const deliver = internalAction({
  args: { deliveryId: v.id("alertDeliveries") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const job = await ctx.runQuery(internal.alertDelivery.loadForSend, args);
    if (!job.ready) {
      if (job.reason !== undefined) {
        await ctx.runMutation(internal.alertDelivery.recordOutcome, {
          deliveryId: args.deliveryId,
          outcome: { kind: "permanent", error: job.reason },
        });
      }
      return null;
    }

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "User-Agent": "EraInfra-Alerts/1",
    };
    if (job.kind === "webhook") {
      headers[EVENT_HEADER] = `alert.${job.event}`;
      headers[DELIVERY_HEADER] = args.deliveryId;
      if (job.signingSecret !== undefined) {
        headers[SIGNATURE_HEADER] = await signWebhook(
          job.signingSecret,
          Math.floor(Date.now() / 1_000),
          job.body,
        );
      }
    }

    let outcome: SendOutcome;
    try {
      const response = await fetch(job.url, {
        method: "POST",
        headers,
        body: job.body,
        // A redirect would resend the signed body to a host the operator never configured.
        redirect: "manual",
        signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
      });
      outcome = classifyResponse(response.status, response.headers.get("Retry-After"));
      // Release the connection; the response content is never stored.
      await response.body?.cancel().catch(() => undefined);
    } catch (error) {
      outcome = { kind: "retry", error: describeFetchError(error) };
    }
    await ctx.runMutation(internal.alertDelivery.recordOutcome, {
      deliveryId: args.deliveryId,
      outcome,
    });
    return null;
  },
});
