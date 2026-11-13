import { ConvexError, v, type Infer } from "convex/values";

import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import {
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
  query,
  type MutationCtx,
} from "./_generated/server";
import {
  destinationUrlError,
  slackBody,
  urlHint,
  webhookBody,
  type NotificationContent,
  type NotificationEvent,
} from "./alertNotify";
import {
  ALERT_HISTORY_WINDOW_MS,
  alertConditionValidator,
  conditionError,
  describeCondition,
  evaluateCondition,
  type AlertCondition,
} from "./alertRules";
import { requireDashboardAuth } from "./dashboardAuth";
import { loadFleetObservation } from "./fleetObservation";

// Alert rules, destinations and the incident lifecycle.
//
// Every dashboard account is an operator of the whole deployment (sign-up is invite-only and
// there is no narrower permission role), so configuration goes through requireDashboardAuth like
// every other operator mutation.
//
// Lifecycle, evaluated every minute by a cron (a query computes breaches, a mutation applies them):
//   condition holds, no open incident  -> insert pending (or firing when forMinutes is 0)
//   pending for forMinutes             -> firing
//   firing and not yet announced       -> announce unless muted or inside the cooldown
//   condition clears while pending     -> delete; it never fired
//   condition clears while firing      -> resolved; announce only if the firing was announced
// At most one pending or firing incident exists per rule and subject, which is the dedup key.
// Announcing only enqueues alertDeliveries rows and schedules the delivery action, so the
// receiver's latency or failure never reaches this mutation.

const MAX_RULES = 200;
const MAX_DESTINATIONS = 50;
const MAX_OPEN_INCIDENTS_PER_RULE = 1_000;
const NAME_MAX_LENGTH = 100;
export const INCIDENT_RETENTION_MS = 30 * 24 * 60 * 60_000;
export const DELIVERY_RETENTION_MS = 7 * 24 * 60 * 60_000;
const RETENTION_BATCH = 100;

const destinationKindValidator = v.union(v.literal("webhook"), v.literal("slack"));

function newSigningSecret() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return `whsec_${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function countByRule(incidents: Doc<"alertIncidents">[]) {
  const counts = new Map<Id<"alertRules">, number>();
  for (const incident of incidents) {
    counts.set(incident.ruleId, (counts.get(incident.ruleId) ?? 0) + 1);
  }
  return counts;
}

function cleanName(name: string, what: string) {
  const trimmed = name.trim();
  if (trimmed.length === 0 || trimmed.length > NAME_MAX_LENGTH) {
    throw new ConvexError(`Give the ${what} a name of 1 to ${NAME_MAX_LENGTH} characters`);
  }
  return trimmed;
}

// ---------------------------------------------------------------------------------------------
// Dashboard reads

export const overview = query({
  args: {},
  returns: v.object({
    rules: v.array(
      v.object({
        _id: v.id("alertRules"),
        name: v.string(),
        condition: alertConditionValidator,
        description: v.string(),
        profile: v.optional(v.string()),
        forMinutes: v.number(),
        cooldownMinutes: v.number(),
        mutedUntil: v.optional(v.number()),
        destinationIds: v.array(v.id("alertDestinations")),
        enabled: v.boolean(),
        firing: v.number(),
        pending: v.number(),
      }),
    ),
    destinations: v.array(
      v.object({
        _id: v.id("alertDestinations"),
        name: v.string(),
        kind: destinationKindValidator,
        urlHint: v.string(),
        enabled: v.boolean(),
        signed: v.boolean(),
        lastDelivery: v.optional(
          v.object({
            event: v.union(v.literal("firing"), v.literal("resolved"), v.literal("test")),
            status: v.union(v.literal("pending"), v.literal("delivered"), v.literal("failed")),
            attempts: v.number(),
            createdAt: v.number(),
            lastStatusCode: v.optional(v.number()),
            lastError: v.optional(v.string()),
          }),
        ),
      }),
    ),
    incidents: v.array(
      v.object({
        _id: v.id("alertIncidents"),
        ruleName: v.string(),
        subject: v.string(),
        status: v.union(v.literal("pending"), v.literal("firing"), v.literal("resolved")),
        summary: v.string(),
        since: v.number(),
        firedAt: v.optional(v.number()),
        resolvedAt: v.optional(v.number()),
        notified: v.boolean(),
      }),
    ),
  }),
  handler: async (ctx) => {
    await requireDashboardAuth(ctx);
    const [rules, destinations, firing, pending, resolved] = await Promise.all([
      ctx.db.query("alertRules").order("desc").take(MAX_RULES),
      ctx.db.query("alertDestinations").order("desc").take(MAX_DESTINATIONS),
      ctx.db
        .query("alertIncidents")
        .withIndex("by_status_resolvedAt", (q) => q.eq("status", "firing"))
        .take(200),
      ctx.db
        .query("alertIncidents")
        .withIndex("by_status_resolvedAt", (q) => q.eq("status", "pending"))
        .take(200),
      ctx.db
        .query("alertIncidents")
        .withIndex("by_status_resolvedAt", (q) => q.eq("status", "resolved"))
        .order("desc")
        .take(20),
    ]);
    const ruleName = new Map(rules.map((rule) => [rule._id, rule.name]));
    const firingByRule = countByRule(firing);
    const pendingByRule = countByRule(pending);
    const lastDeliveries = await Promise.all(
      destinations.map((destination) =>
        ctx.db
          .query("alertDeliveries")
          .withIndex("by_destination", (q) => q.eq("destinationId", destination._id))
          .order("desc")
          .first(),
      ),
    );
    return {
      rules: rules.map((rule) => ({
        _id: rule._id,
        name: rule.name,
        condition: rule.condition,
        description: describeCondition(rule.condition),
        ...(rule.profile === undefined ? {} : { profile: rule.profile }),
        forMinutes: rule.forMinutes,
        cooldownMinutes: rule.cooldownMinutes,
        ...(rule.mutedUntil === undefined ? {} : { mutedUntil: rule.mutedUntil }),
        destinationIds: rule.destinationIds,
        enabled: rule.enabled,
        firing: firingByRule.get(rule._id) ?? 0,
        pending: pendingByRule.get(rule._id) ?? 0,
      })),
      destinations: destinations.map((destination, index) => {
        const last = lastDeliveries[index];
        return {
          _id: destination._id,
          name: destination.name,
          kind: destination.kind,
          urlHint: destination.urlHint,
          enabled: destination.enabled,
          signed: destination.signingSecret !== undefined,
          ...(last === null || last === undefined
            ? {}
            : {
                lastDelivery: {
                  event: last.event,
                  status: last.status,
                  attempts: last.attempts,
                  createdAt: last.createdAt,
                  ...(last.lastStatusCode === undefined
                    ? {}
                    : { lastStatusCode: last.lastStatusCode }),
                  ...(last.lastError === undefined ? {} : { lastError: last.lastError }),
                },
              }),
        };
      }),
      incidents: [...firing, ...pending, ...resolved]
        .filter((incident) => ruleName.has(incident.ruleId))
        .map((incident) => ({
          _id: incident._id,
          ruleName: ruleName.get(incident.ruleId) ?? "",
          subject: incident.subject,
          status: incident.status,
          summary: incident.summary,
          since: incident.since,
          ...(incident.firedAt === undefined ? {} : { firedAt: incident.firedAt }),
          ...(incident.resolvedAt === undefined ? {} : { resolvedAt: incident.resolvedAt }),
          notified: incident.firingNotifiedAt !== undefined,
        })),
    };
  },
});

// ---------------------------------------------------------------------------------------------
// Destinations

export const createDestination = mutation({
  args: { name: v.string(), kind: destinationKindValidator, url: v.string() },
  returns: v.object({ id: v.id("alertDestinations"), signingSecret: v.optional(v.string()) }),
  handler: async (ctx, args) => {
    await requireDashboardAuth(ctx);
    const name = cleanName(args.name, "destination");
    const url = args.url.trim();
    const urlError = destinationUrlError(url);
    if (urlError !== undefined) throw new ConvexError(urlError);
    const existing = await ctx.db.query("alertDestinations").take(MAX_DESTINATIONS);
    if (existing.length >= MAX_DESTINATIONS) {
      throw new ConvexError(`A deployment can have at most ${MAX_DESTINATIONS} destinations`);
    }
    // Slack verifies nothing, so only a generic webhook gets a key. The receiver needs it to
    // check that a request came from this deployment.
    const signingSecret = args.kind === "webhook" ? newSigningSecret() : undefined;
    const now = Date.now();
    const id = await ctx.db.insert("alertDestinations", {
      name,
      kind: args.kind,
      url,
      urlHint: urlHint(url),
      ...(signingSecret === undefined ? {} : { signingSecret }),
      enabled: true,
      createdAt: now,
      updatedAt: now,
    });
    return { id, ...(signingSecret === undefined ? {} : { signingSecret }) };
  },
});

/** Change a destination. `url` replaces the stored one; it can be written, never read back. */
export const updateDestination = mutation({
  args: {
    id: v.id("alertDestinations"),
    name: v.optional(v.string()),
    url: v.optional(v.string()),
    enabled: v.optional(v.boolean()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireDashboardAuth(ctx);
    const destination = await ctx.db.get(args.id);
    if (destination === null) throw new ConvexError("Destination not found");
    const patch: Partial<Doc<"alertDestinations">> = { updatedAt: Date.now() };
    if (args.name !== undefined) patch.name = cleanName(args.name, "destination");
    if (args.url !== undefined) {
      const url = args.url.trim();
      const urlError = destinationUrlError(url);
      if (urlError !== undefined) throw new ConvexError(urlError);
      patch.url = url;
      patch.urlHint = urlHint(url);
    }
    if (args.enabled !== undefined) patch.enabled = args.enabled;
    await ctx.db.patch(destination._id, patch);
    return null;
  },
});

/** Replace a webhook's signing secret. The old one stops working at once. */
export const rotateSigningSecret = mutation({
  args: { id: v.id("alertDestinations") },
  returns: v.object({ signingSecret: v.string() }),
  handler: async (ctx, args) => {
    await requireDashboardAuth(ctx);
    const destination = await ctx.db.get(args.id);
    if (destination === null) throw new ConvexError("Destination not found");
    if (destination.kind !== "webhook") {
      throw new ConvexError("Only generic webhooks are signed");
    }
    const signingSecret = newSigningSecret();
    await ctx.db.patch(destination._id, { signingSecret, updatedAt: Date.now() });
    return { signingSecret };
  },
});

export const deleteDestination = mutation({
  args: { id: v.id("alertDestinations") },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireDashboardAuth(ctx);
    const destination = await ctx.db.get(args.id);
    if (destination === null) return null;
    for (const rule of await ctx.db.query("alertRules").take(MAX_RULES)) {
      if (rule.destinationIds.includes(destination._id)) {
        await ctx.db.patch(rule._id, {
          destinationIds: rule.destinationIds.filter((id) => id !== destination._id),
          updatedAt: Date.now(),
        });
      }
    }
    // Deliveries still queued for it find the destination gone and settle as failed.
    await ctx.db.delete(destination._id);
    return null;
  },
});

/** Queue a sample notification, so an operator can see the receiver accept one. */
export const sendTest = mutation({
  args: { id: v.id("alertDestinations") },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireDashboardAuth(ctx);
    const destination = await ctx.db.get(args.id);
    if (destination === null) throw new ConvexError("Destination not found");
    const now = Date.now();
    await enqueueDelivery(ctx, destination, undefined, {
      event: "test",
      rule: {
        id: "test",
        name: "Test notification",
        kind: "test",
        condition: "Sent from the dashboard",
        profile: null,
      },
      incident: {
        id: "test",
        subject: destination.name,
        summary: "This is a test notification from EraInfra. No action is needed.",
        since: now,
        firedAt: null,
        resolvedAt: null,
      },
      sentAt: now,
    });
    return null;
  },
});

// ---------------------------------------------------------------------------------------------
// Rules

const ruleFields = {
  name: v.string(),
  condition: alertConditionValidator,
  profile: v.optional(v.string()),
  forMinutes: v.number(),
  cooldownMinutes: v.number(),
  destinationIds: v.array(v.id("alertDestinations")),
};

async function validateRule(
  ctx: MutationCtx,
  args: {
    name: string;
    condition: AlertCondition;
    profile?: string;
    forMinutes: number;
    cooldownMinutes: number;
    destinationIds: Id<"alertDestinations">[];
  },
  existingId?: Id<"alertRules">,
) {
  const name = cleanName(args.name, "rule");
  const error = conditionError(args.condition);
  if (error !== undefined) throw new ConvexError(error);
  if (!Number.isInteger(args.forMinutes) || args.forMinutes < 0 || args.forMinutes > 24 * 60) {
    throw new ConvexError("Pending minutes must be a whole number from 0 to 1440");
  }
  if (
    !Number.isInteger(args.cooldownMinutes) ||
    args.cooldownMinutes < 0 ||
    args.cooldownMinutes > 7 * 24 * 60
  ) {
    throw new ConvexError("Cooldown minutes must be a whole number from 0 to 10080");
  }
  const destinationIds = [...new Set(args.destinationIds)];
  for (const id of destinationIds) {
    if ((await ctx.db.get(id)) === null) throw new ConvexError("A destination no longer exists");
  }
  const rules = await ctx.db.query("alertRules").take(MAX_RULES);
  if (existingId === undefined && rules.length >= MAX_RULES) {
    throw new ConvexError(`A deployment can have at most ${MAX_RULES} rules`);
  }
  // The rule name is the `rule` label on erainfra_alerts_firing and the headline of every
  // notification, so two rules must not share it.
  if (rules.some((rule) => rule.name === name && rule._id !== existingId)) {
    throw new ConvexError(`A rule named "${name}" already exists`);
  }
  const profile = args.profile?.trim();
  return {
    name,
    condition: args.condition,
    profile: profile === undefined || profile.length === 0 ? undefined : profile,
    forMinutes: args.forMinutes,
    cooldownMinutes: args.cooldownMinutes,
    destinationIds,
  };
}

export const createRule = mutation({
  args: ruleFields,
  returns: v.id("alertRules"),
  handler: async (ctx, args) => {
    await requireDashboardAuth(ctx);
    const rule = await validateRule(ctx, args);
    const now = Date.now();
    return ctx.db.insert("alertRules", {
      ...rule,
      enabled: true,
      createdAt: now,
      updatedAt: now,
    });
  },
});

export const updateRule = mutation({
  args: { id: v.id("alertRules"), ...ruleFields },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireDashboardAuth(ctx);
    const existing = await ctx.db.get(args.id);
    if (existing === null) throw new ConvexError("Rule not found");
    const { id, ...fields } = args;
    const rule = await validateRule(ctx, fields, id);
    // Open incidents stay; the next evaluation resolves any the new condition no longer holds.
    await ctx.db.patch(id, { ...rule, updatedAt: Date.now() });
    return null;
  },
});

async function openIncidents(ctx: MutationCtx, ruleId: Id<"alertRules">) {
  const [pending, firing] = await Promise.all(
    (["pending", "firing"] as const).map((status) =>
      ctx.db
        .query("alertIncidents")
        .withIndex("by_rule_status", (q) => q.eq("ruleId", ruleId).eq("status", status))
        .take(MAX_OPEN_INCIDENTS_PER_RULE),
    ),
  );
  return [...(pending ?? []), ...(firing ?? [])];
}

/**
 * Turning a rule off closes its open incidents without a notification: the operator chose to stop
 * watching, which is not the same as the problem going away.
 */
export const setRuleEnabled = mutation({
  args: { id: v.id("alertRules"), enabled: v.boolean() },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireDashboardAuth(ctx);
    const rule = await ctx.db.get(args.id);
    if (rule === null) throw new ConvexError("Rule not found");
    const now = Date.now();
    if (!args.enabled) {
      for (const incident of await openIncidents(ctx, rule._id)) {
        if (incident.status === "pending") {
          await ctx.db.delete(incident._id);
        } else {
          await ctx.db.patch(incident._id, { status: "resolved", resolvedAt: now });
        }
      }
    }
    await ctx.db.patch(rule._id, { enabled: args.enabled, updatedAt: now });
    return null;
  },
});

/** Silence a rule's notifications until a time, or lift the mute with `until: null`. */
export const muteRule = mutation({
  args: { id: v.id("alertRules"), until: v.union(v.number(), v.null()) },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireDashboardAuth(ctx);
    const rule = await ctx.db.get(args.id);
    if (rule === null) throw new ConvexError("Rule not found");
    const now = Date.now();
    if (args.until !== null && (args.until <= now || args.until > now + 30 * 24 * 60 * 60_000)) {
      throw new ConvexError("Mute for between a minute and 30 days");
    }
    await ctx.db.patch(rule._id, {
      mutedUntil: args.until === null ? undefined : args.until,
      updatedAt: now,
    });
    return null;
  },
});

export const deleteRule = mutation({
  args: { id: v.id("alertRules") },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireDashboardAuth(ctx);
    const rule = await ctx.db.get(args.id);
    if (rule === null) return null;
    const incidents = await ctx.db
      .query("alertIncidents")
      .withIndex("by_rule_subject", (q) => q.eq("ruleId", rule._id))
      .take(5_000);
    for (const incident of incidents) await ctx.db.delete(incident._id);
    await ctx.db.delete(rule._id);
    return null;
  },
});

// ---------------------------------------------------------------------------------------------
// Evaluation

function notificationContent(
  rule: Doc<"alertRules">,
  incident: Doc<"alertIncidents">,
  event: NotificationEvent,
  now: number,
): NotificationContent {
  return {
    event,
    rule: {
      id: rule._id,
      name: rule.name,
      kind: rule.condition.kind,
      condition: describeCondition(rule.condition),
      profile: rule.profile ?? null,
    },
    incident: {
      id: incident._id,
      subject: incident.subject,
      summary: incident.summary,
      since: incident.since,
      firedAt: incident.firedAt ?? null,
      resolvedAt: incident.resolvedAt ?? null,
    },
    sentAt: now,
  };
}

async function enqueueDelivery(
  ctx: MutationCtx,
  destination: Doc<"alertDestinations">,
  incidentId: Id<"alertIncidents"> | undefined,
  content: NotificationContent,
) {
  const deliveryId = await ctx.db.insert("alertDeliveries", {
    destinationId: destination._id,
    ...(incidentId === undefined ? {} : { incidentId }),
    event: content.event,
    body: destination.kind === "slack" ? slackBody(content) : webhookBody(content),
    status: "pending",
    attempts: 0,
    createdAt: content.sentAt,
    nextAttemptAt: content.sentAt,
  });
  await ctx.scheduler.runAfter(0, internal.alertDelivery.deliver, { deliveryId });
}

async function announce(
  ctx: MutationCtx,
  rule: Doc<"alertRules">,
  incident: Doc<"alertIncidents">,
  event: "firing" | "resolved",
  now: number,
) {
  const content = notificationContent(rule, incident, event, now);
  for (const destinationId of rule.destinationIds) {
    const destination = await ctx.db.get(destinationId);
    if (destination === null || !destination.enabled) continue;
    await enqueueDelivery(ctx, destination, incident._id, content);
  }
}

/** When this rule last announced a firing for the subject, before the given incident. */
async function lastFiringNotice(
  ctx: MutationCtx,
  ruleId: Id<"alertRules">,
  subject: string,
  except: Id<"alertIncidents">,
) {
  const recent = await ctx.db
    .query("alertIncidents")
    .withIndex("by_rule_subject", (q) => q.eq("ruleId", ruleId).eq("subject", subject))
    .order("desc")
    .take(10);
  let latest: number | undefined;
  for (const incident of recent) {
    if (incident._id === except || incident.firingNotifiedAt === undefined) continue;
    latest = Math.max(latest ?? 0, incident.firingNotifiedAt);
  }
  return latest;
}

async function evaluateRule(
  ctx: MutationCtx,
  rule: Doc<"alertRules">,
  breaches: Map<string, string>,
  now: number,
) {
  const muted = rule.mutedUntil !== undefined && rule.mutedUntil > now;
  const forMs = rule.forMinutes * 60_000;
  const cooldownMs = rule.cooldownMinutes * 60_000;
  const open = new Map((await openIncidents(ctx, rule._id)).map((row) => [row.subject, row]));

  for (const [subject, summary] of breaches) {
    let incident = open.get(subject);
    if (incident === undefined) {
      const firesNow = forMs === 0;
      const id = await ctx.db.insert("alertIncidents", {
        ruleId: rule._id,
        subject,
        status: firesNow ? "firing" : "pending",
        summary,
        since: now,
        ...(firesNow ? { firedAt: now } : {}),
        lastEvaluatedAt: now,
      });
      incident = (await ctx.db.get(id)) ?? undefined;
      if (incident === undefined) continue;
    } else {
      const fires = incident.status === "pending" && now - incident.since >= forMs;
      await ctx.db.patch(incident._id, {
        summary,
        lastEvaluatedAt: now,
        ...(fires ? { status: "firing" as const, firedAt: now } : {}),
      });
      incident = {
        ...incident,
        summary,
        ...(fires ? { status: "firing" as const, firedAt: now } : {}),
      };
    }

    if (incident.status !== "firing" || incident.firingNotifiedAt !== undefined || muted) continue;
    const last = await lastFiringNotice(ctx, rule._id, subject, incident._id);
    if (last !== undefined && now - last < cooldownMs) continue;
    await ctx.db.patch(incident._id, { firingNotifiedAt: now });
    await announce(ctx, rule, incident, "firing", now);
  }

  for (const incident of open.values()) {
    if (breaches.has(incident.subject)) continue;
    if (incident.status === "pending") {
      await ctx.db.delete(incident._id);
      continue;
    }
    await ctx.db.patch(incident._id, { status: "resolved", resolvedAt: now, lastEvaluatedAt: now });
    if (incident.firingNotifiedAt !== undefined && !muted) {
      await announce(
        ctx,
        rule,
        { ...incident, status: "resolved", resolvedAt: now },
        "resolved",
        now,
      );
    }
  }
}

async function sweepRetention(ctx: MutationCtx, now: number) {
  const oldIncidents = await ctx.db
    .query("alertIncidents")
    .withIndex("by_status_resolvedAt", (q) =>
      q.eq("status", "resolved").lt("resolvedAt", now - INCIDENT_RETENTION_MS),
    )
    .take(RETENTION_BATCH);
  for (const incident of oldIncidents) await ctx.db.delete(incident._id);
  for (const status of ["delivered", "failed"] as const) {
    const oldDeliveries = await ctx.db
      .query("alertDeliveries")
      .withIndex("by_status_createdAt", (q) =>
        q.eq("status", status).lt("createdAt", now - DELIVERY_RETENTION_MS),
      )
      .take(RETENTION_BATCH);
    for (const delivery of oldDeliveries) await ctx.db.delete(delivery._id);
  }
}

const breachesValidator = v.object({
  now: v.number(),
  rules: v.array(
    v.object({
      ruleId: v.id("alertRules"),
      // The rule as evaluated. A rule edited since is skipped until the next run.
      updatedAt: v.number(),
      breaches: v.array(v.object({ subject: v.string(), summary: v.string() })),
    }),
  ),
});

/**
 * Which subjects breach each enabled rule. A query, so the wide read of fleet state (Profiles,
 * readiness, live and recent Attempts) never sits in a mutation's read set, where every Attempt
 * write by the scheduler or a Worker would force a retry.
 */
export const computeBreaches = internalQuery({
  args: {},
  returns: breachesValidator,
  handler: async (ctx) => {
    const now = Date.now();
    const rules = await ctx.db
      .query("alertRules")
      .withIndex("by_enabled", (q) => q.eq("enabled", true))
      .take(MAX_RULES);
    if (rules.length === 0) return { now, rules: [] };
    const observation = await loadFleetObservation(ctx, now, {
      recentWindowMs: ALERT_HISTORY_WINDOW_MS,
    });
    return {
      now,
      rules: rules.map((rule) => ({
        ruleId: rule._id,
        updatedAt: rule.updatedAt,
        breaches: evaluateCondition(rule.condition, rule.profile, observation),
      })),
    };
  },
});

/** Advance every evaluated rule's incidents. Reads and writes only the alert tables. */
export const applyBreaches = internalMutation({
  args: breachesValidator,
  returns: v.null(),
  handler: async (ctx, args) => {
    await sweepRetention(ctx, args.now);
    for (const evaluated of args.rules) {
      const rule = await ctx.db.get(evaluated.ruleId);
      if (rule === null || !rule.enabled || rule.updatedAt !== evaluated.updatedAt) continue;
      const breaches = new Map(
        evaluated.breaches.map((breach) => [breach.subject, breach.summary]),
      );
      await evaluateRule(ctx, rule, breaches, args.now);
    }
    return null;
  },
});

/** The alert cron: read in a query, then apply in a mutation. */
export const evaluate = internalAction({
  args: {},
  returns: v.object({ rules: v.number(), breaches: v.number() }),
  // Annotated: the action calls its own module through `internal`, which TypeScript cannot infer
  // through without the explicit types.
  handler: async (ctx): Promise<{ rules: number; breaches: number }> => {
    const evaluated: Infer<typeof breachesValidator> = await ctx.runQuery(
      internal.alerts.computeBreaches,
      {},
    );
    await ctx.runMutation(internal.alerts.applyBreaches, evaluated);
    return {
      rules: evaluated.rules.length,
      breaches: evaluated.rules.reduce((total, rule) => total + rule.breaches.length, 0),
    };
  },
});
