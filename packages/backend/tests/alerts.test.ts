import { convexTest, type TestConvex } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { api, internal } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { MAX_DELIVERY_ATTEMPTS } from "../convex/alertNotify";
import type { AlertCondition } from "../convex/alertRules";
import schema from "../convex/schema";
import { setUpBefore } from "./support/clock.ts";
import { CONTRACT, MINUTE, NOW, operator, seedFleet } from "./support/fleetFixture.ts";

const modules = import.meta.glob("../convex/**/*.ts");
type Harness = TestConvex<typeof schema>;
type Operator = Awaited<ReturnType<typeof operator>>;

type SentRequest = { url: string; headers: Headers; body: string };
let sent: SentRequest[] = [];
let respond: (request: SentRequest) => Response | Promise<Response>;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  sent = [];
  respond = () => new Response(null, { status: 200 });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const request = {
        url: String(input),
        headers: new Headers(init?.headers),
        body: String(init?.body ?? ""),
      };
      sent.push(request);
      return respond(request);
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function setup() {
  return setUpBefore(NOW, async () => {
    const t = convexTest(schema, modules);
    await seedFleet(t);
    const ops = await operator(t);
    const webhook = await ops.mutation(api.alerts.createDestination, {
      name: "pager",
      kind: "webhook",
      url: "https://alerts.example.test/hook/s3cr3t-path",
    });
    return { t, ops, webhookId: webhook.id, signingSecret: webhook.signingSecret ?? "" };
  });
}

async function backlogRule(
  ops: Operator,
  destinationIds: Id<"alertDestinations">[],
  fields: { forMinutes?: number; cooldownMinutes?: number; minutes?: number } = {},
) {
  return ops.mutation(api.alerts.createRule, {
    name: "Queue backlog",
    condition: { kind: "queue-backlog", minutes: fields.minutes ?? 2 },
    profile: CONTRACT.profile,
    forMinutes: fields.forMinutes ?? 0,
    cooldownMinutes: fields.cooldownMinutes ?? 0,
    destinationIds,
  });
}

function evaluate(t: Harness) {
  return t.action(internal.alerts.evaluate, {});
}

function at(minutes: number) {
  vi.setSystemTime(NOW + minutes * MINUTE);
}

async function incidents(t: Harness) {
  return t.run((ctx) => ctx.db.query("alertIncidents").collect());
}

async function deliveries(t: Harness) {
  return t.run((ctx) => ctx.db.query("alertDeliveries").collect());
}

/** Empty the queue: every pending Attempt is cancelled. */
async function drainQueue(t: Harness) {
  await t.run(async (ctx) => {
    const pending = await ctx.db
      .query("attempts")
      .withIndex("by_state", (q) => q.eq("state", "pending"))
      .collect();
    for (const attempt of pending) {
      await ctx.db.patch(attempt._id, { state: "cancelled", finishedAt: Date.now() });
    }
  });
}

async function runDeliveries(t: Harness) {
  await t.finishAllScheduledFunctions(vi.runAllTimers);
}

async function hmacHex(secret: string, message: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return Array.from(new Uint8Array(mac), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

describe("alert lifecycle", () => {
  it("fires at once with no pending time, announces once, and keeps one incident", async () => {
    const { t, ops, webhookId } = await setup();
    await backlogRule(ops, [webhookId]);

    await evaluate(t);
    let rows = await incidents(t);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      subject: CONTRACT.profile,
      status: "firing",
      firedAt: NOW,
      firingNotifiedAt: NOW,
    });
    expect(rows[0]?.summary).toBe(
      "2 Attempts queued on Profile erainfra-4vcpu-ubuntu-2404; the oldest has waited 5m.",
    );
    expect(await deliveries(t)).toEqual([
      expect.objectContaining({ event: "firing", status: "pending", attempts: 0 }),
    ]);

    at(1);
    await evaluate(t);
    at(2);
    await evaluate(t);
    rows = await incidents(t);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.summary).toContain("the oldest has waited 7m");
    expect(await deliveries(t)).toHaveLength(1);
  });

  it("holds an incident pending for forMinutes and drops it silently if the condition clears", async () => {
    const { t, ops, webhookId } = await setup();
    await backlogRule(ops, [webhookId], { forMinutes: 5 });

    await evaluate(t);
    at(4);
    await evaluate(t);
    expect(await incidents(t)).toEqual([
      expect.objectContaining({ status: "pending", since: NOW }),
    ]);
    expect(await deliveries(t)).toEqual([]);

    await drainQueue(t);
    at(5);
    await evaluate(t);
    expect(await incidents(t)).toEqual([]);
    expect(await deliveries(t)).toEqual([]);
  });

  it("fires once the condition has held for forMinutes", async () => {
    const { t, ops, webhookId } = await setup();
    await backlogRule(ops, [webhookId], { forMinutes: 5 });
    await evaluate(t);
    at(5);
    await evaluate(t);
    expect(await incidents(t)).toEqual([
      expect.objectContaining({ status: "firing", since: NOW, firedAt: NOW + 5 * MINUTE }),
    ]);
    expect(await deliveries(t)).toEqual([expect.objectContaining({ event: "firing" })]);
  });

  it("resolves when the condition clears and announces the resolve", async () => {
    const { t, ops, webhookId } = await setup();
    await backlogRule(ops, [webhookId]);
    await evaluate(t);
    await drainQueue(t);
    at(3);
    await evaluate(t);

    expect(await incidents(t)).toEqual([
      expect.objectContaining({ status: "resolved", resolvedAt: NOW + 3 * MINUTE }),
    ]);
    const events = (await deliveries(t)).map((delivery) => delivery.event);
    expect(events).toEqual(["firing", "resolved"]);
    const resolved = (await deliveries(t))[1];
    expect(JSON.parse(resolved?.body ?? "{}")).toMatchObject({
      event: "alert.resolved",
      incident: { status: "resolved", resolvedAt: "2026-11-05T12:03:00.000Z" },
    });
  });

  it("opens a new incident on a re-fire but stays quiet inside the cooldown", async () => {
    const { t, ops, webhookId } = await setup();
    await backlogRule(ops, [webhookId], { cooldownMinutes: 30 });
    await evaluate(t);
    await drainQueue(t);
    at(2);
    await evaluate(t);
    expect((await deliveries(t)).map((delivery) => delivery.event)).toEqual(["firing", "resolved"]);

    // The queue backs up again ten minutes after the first notice.
    await t.run(async (ctx) => {
      const [attempt] = await ctx.db
        .query("attempts")
        .withIndex("by_state", (q) => q.eq("state", "cancelled"))
        .collect();
      if (attempt === undefined) throw new Error("fixture changed");
      await ctx.db.patch(attempt._id, { state: "pending", createdAt: NOW + 5 * MINUTE });
    });
    at(10);
    await evaluate(t);
    let open = (await incidents(t)).filter((incident) => incident.status === "firing");
    expect(open).toHaveLength(1);
    expect(open[0]?.firingNotifiedAt).toBeUndefined();
    expect(await deliveries(t)).toHaveLength(2);

    // Still firing when the cooldown ends: announced then.
    at(30);
    await evaluate(t);
    open = (await incidents(t)).filter((incident) => incident.status === "firing");
    expect(open[0]?.firingNotifiedAt).toBe(NOW + 30 * MINUTE);
    expect((await deliveries(t)).map((delivery) => delivery.event)).toEqual([
      "firing",
      "resolved",
      "firing",
    ]);
  });

  it("stays silent while muted and announces a still-firing incident after the mute", async () => {
    const { t, ops, webhookId } = await setup();
    const ruleId = await backlogRule(ops, [webhookId]);
    await ops.mutation(api.alerts.muteRule, { id: ruleId, until: NOW + 60 * MINUTE });

    await evaluate(t);
    const [incident] = await incidents(t);
    expect(incident?.status).toBe("firing");
    expect(incident?.firingNotifiedAt).toBeUndefined();
    expect(await deliveries(t)).toEqual([]);

    at(61);
    await evaluate(t);
    expect(await deliveries(t)).toEqual([expect.objectContaining({ event: "firing" })]);
  });

  it("lifts a mute early with null", async () => {
    const { t, ops, webhookId } = await setup();
    const ruleId = await backlogRule(ops, [webhookId]);
    await ops.mutation(api.alerts.muteRule, { id: ruleId, until: NOW + 60 * MINUTE });
    await evaluate(t);
    await ops.mutation(api.alerts.muteRule, { id: ruleId, until: null });
    at(1);
    await evaluate(t);
    expect(await deliveries(t)).toHaveLength(1);
  });

  it("closes a disabled rule's incidents without a notification", async () => {
    const { t, ops, webhookId } = await setup();
    const ruleId = await backlogRule(ops, [webhookId]);
    await evaluate(t);
    await ops.mutation(api.alerts.setRuleEnabled, { id: ruleId, enabled: false });
    expect(await incidents(t)).toEqual([expect.objectContaining({ status: "resolved" })]);
    at(1);
    await evaluate(t);
    expect((await deliveries(t)).map((delivery) => delivery.event)).toEqual(["firing"]);
  });

  it("skips a disabled destination", async () => {
    const { t, ops, webhookId } = await setup();
    const slack = await ops.mutation(api.alerts.createDestination, {
      name: "slack",
      kind: "slack",
      url: "https://hooks.slack.com/services/T0/B0/xyz",
    });
    await ops.mutation(api.alerts.updateDestination, { id: webhookId, enabled: false });
    await backlogRule(ops, [webhookId, slack.id]);
    await evaluate(t);
    expect((await deliveries(t)).map((delivery) => delivery.destinationId)).toEqual([slack.id]);
  });

  it("evaluates nothing when no rule is enabled", async () => {
    const t = convexTest(schema, modules);
    await seedFleet(t);
    expect(await evaluate(t)).toEqual({ rules: 0, breaches: 0 });
    expect(await incidents(t)).toEqual([]);
  });

  it("skips a rule edited between reading the fleet and applying the result", async () => {
    const { t, ops, webhookId } = await setup();
    const ruleId = await backlogRule(ops, [webhookId]);
    const evaluated = await t.query(internal.alerts.computeBreaches, {});
    vi.setSystemTime(NOW + 1_000);
    await ops.mutation(api.alerts.updateRule, {
      id: ruleId,
      name: "Queue backlog",
      condition: { kind: "queue-backlog", minutes: 60 },
      forMinutes: 0,
      cooldownMinutes: 0,
      destinationIds: [webhookId],
    });
    await t.mutation(internal.alerts.applyBreaches, evaluated);
    expect(await incidents(t)).toEqual([]);
    expect(await deliveries(t)).toEqual([]);
  });

  it("evaluates each fleet-health rule kind against the seeded fleet", async () => {
    const { t, ops } = await setup();
    const rule = (name: string, condition: AlertCondition) =>
      ops.mutation(api.alerts.createRule, {
        name,
        condition,
        forMinutes: 0,
        cooldownMinutes: 0,
        destinationIds: [],
      });
    await rule("offline", { kind: "worker-offline", minutes: 10 });
    await rule("degraded", { kind: "profile-readiness-degraded" });
    await rule("no-ready", { kind: "profile-no-ready-worker" });
    await rule("failures", { kind: "consecutive-failures", count: 2 });
    await rule("rate", { kind: "failure-rate", percent: 50, windowMinutes: 60, minAttempts: 3 });
    await rule("slow", { kind: "attempt-duration", minutes: 1 });
    await evaluate(t);
    const overview = await ops.query(api.alerts.overview, {});
    const firing = overview.incidents
      .filter((incident) => incident.status === "firing")
      .map((incident) => `${incident.ruleName}:${incident.subject}`)
      .toSorted();
    // The fixture's newest finished Attempts are a control-plane failure then a GitHub failure;
    // 2 of 4 decided Attempts in the hour failed. ubuntu0 is ready, so no-ready stays quiet.
    expect(firing).toEqual([
      "degraded:erainfra-4vcpu-ubuntu-2404/mac-mini",
      "failures:erainfra-4vcpu-ubuntu-2404",
      "offline:gone-box",
      "rate:erainfra-4vcpu-ubuntu-2404",
      "slow:erainfra-4vcpu-ubuntu-2404",
    ]);
  });
});

describe("alert configuration", () => {
  it("requires a dashboard login", async () => {
    const t = convexTest(schema, modules);
    await expect(t.query(api.alerts.overview, {})).rejects.toThrow(/Authentication required/);
    await expect(
      t.mutation(api.alerts.createDestination, {
        name: "x",
        kind: "slack",
        url: "https://hooks.slack.com/services/x",
      }),
    ).rejects.toThrow(/Authentication required/);
    await expect(
      t.mutation(api.alerts.createRule, {
        name: "x",
        condition: { kind: "profile-no-ready-worker" },
        forMinutes: 0,
        cooldownMinutes: 0,
        destinationIds: [],
      }),
    ).rejects.toThrow(/Authentication required/);
  });

  it("never returns a destination's URL or signing secret after creation", async () => {
    const { ops, signingSecret } = await setup();
    expect(signingSecret).toMatch(/^whsec_[0-9a-f]{64}$/);
    const overview = await ops.query(api.alerts.overview, {});
    const text = JSON.stringify(overview);
    expect(text).not.toContain("s3cr3t-path");
    expect(text).not.toContain(signingSecret);
    expect(overview.destinations).toEqual([
      expect.objectContaining({
        name: "pager",
        kind: "webhook",
        urlHint: "https://alerts.example.test/…path",
        signed: true,
      }),
    ]);
  });

  it("refuses bad thresholds, plain http, and duplicate rule names", async () => {
    const { ops, webhookId } = await setup();
    await expect(
      ops.mutation(api.alerts.createDestination, {
        name: "x",
        kind: "webhook",
        url: "http://alerts.example.test/hook",
      }),
    ).rejects.toThrow(/https/);
    await expect(
      ops.mutation(api.alerts.createRule, {
        name: "fast",
        condition: { kind: "worker-offline", minutes: 1 },
        forMinutes: 0,
        cooldownMinutes: 0,
        destinationIds: [],
      }),
    ).rejects.toThrow(/2 to 10080/);
    await backlogRule(ops, [webhookId]);
    await expect(backlogRule(ops, [webhookId])).rejects.toThrow(/already exists/);
  });

  it("rotates a webhook's signing secret", async () => {
    const { t, ops, webhookId, signingSecret } = await setup();
    const { signingSecret: next } = await ops.mutation(api.alerts.rotateSigningSecret, {
      id: webhookId,
    });
    expect(next).not.toBe(signingSecret);
    const row = await t.run((ctx) => ctx.db.get(webhookId));
    expect(row?.signingSecret).toBe(next);
  });

  it("removes a deleted destination from its rules", async () => {
    const { t, ops, webhookId } = await setup();
    const ruleId = await backlogRule(ops, [webhookId]);
    await ops.mutation(api.alerts.deleteDestination, { id: webhookId });
    const rule = await t.run((ctx) => ctx.db.get(ruleId));
    expect(rule?.destinationIds).toEqual([]);
  });
});

describe("alert delivery", () => {
  it("signs a webhook delivery and retries a 5xx until it lands", async () => {
    const { t, ops, webhookId, signingSecret } = await setup();
    await backlogRule(ops, [webhookId]);
    let calls = 0;
    respond = () => new Response("busy", { status: calls++ === 0 ? 503 : 202 });

    await evaluate(t);
    await runDeliveries(t);

    expect(sent).toHaveLength(2);
    const [delivery] = await deliveries(t);
    expect(delivery).toMatchObject({ status: "delivered", attempts: 2, lastStatusCode: 202 });
    for (const request of sent) {
      expect(request.url).toBe("https://alerts.example.test/hook/s3cr3t-path");
      expect(request.body).toBe(delivery?.body);
      expect(request.headers.get("Content-Type")).toBe("application/json");
      expect(request.headers.get("X-EraInfra-Event")).toBe("alert.firing");
      expect(request.headers.get("X-EraInfra-Delivery")).toBe(delivery?._id);
      const signature = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(
        request.headers.get("X-EraInfra-Signature") ?? "",
      );
      expect(signature).not.toBeNull();
      expect(signature?.[2]).toBe(
        await hmacHex(signingSecret, `${signature?.[1]}.${request.body}`),
      );
    }
    // The retry went out after the first backoff step, 30 to 36 seconds later.
    const [first, second] = sent.map((request) =>
      Number(/t=(\d+)/.exec(request.headers.get("X-EraInfra-Signature") ?? "")?.[1]),
    );
    expect((second ?? 0) - (first ?? 0)).toBeGreaterThanOrEqual(30);
    expect((second ?? 0) - (first ?? 0)).toBeLessThanOrEqual(36);
  });

  it("gives up at once on a 4xx other than 408 and 429", async () => {
    const { t, ops, webhookId } = await setup();
    await backlogRule(ops, [webhookId]);
    respond = () => new Response(null, { status: 410 });
    await evaluate(t);
    await runDeliveries(t);
    expect(sent).toHaveLength(1);
    expect(await deliveries(t)).toEqual([
      expect.objectContaining({ status: "failed", attempts: 1, lastError: "HTTP 410" }),
    ]);
  });

  it("stops after the attempt budget when the receiver never answers", async () => {
    const { t, ops, webhookId } = await setup();
    await backlogRule(ops, [webhookId]);
    respond = () => {
      throw new TypeError("fetch failed");
    };
    await evaluate(t);
    await runDeliveries(t);
    expect(sent).toHaveLength(MAX_DELIVERY_ATTEMPTS);
    expect(await deliveries(t)).toEqual([
      expect.objectContaining({
        status: "failed",
        attempts: MAX_DELIVERY_ATTEMPTS,
        lastError: `fetch failed; gave up after ${MAX_DELIVERY_ATTEMPTS} attempts`,
      }),
    ]);
  });

  it("posts Slack's message format with no signature", async () => {
    const { t, ops } = await setup();
    const slack = await ops.mutation(api.alerts.createDestination, {
      name: "slack",
      kind: "slack",
      url: "https://hooks.slack.com/services/T0/B0/xyz",
    });
    expect(slack.signingSecret).toBeUndefined();
    await backlogRule(ops, [slack.id]);
    await evaluate(t);
    await runDeliveries(t);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.headers.get("X-EraInfra-Signature")).toBeNull();
    const body = JSON.parse(sent[0]?.body ?? "{}") as { text: string; blocks: unknown[] };
    expect(body.text).toBe(
      ":rotating_light: Firing: Queue backlog: 2 Attempts queued on Profile erainfra-4vcpu-ubuntu-2404; the oldest has waited 5m.",
    );
    expect(body.blocks).toHaveLength(1);
  });

  it("settles a delivery whose destination was deleted before it was sent", async () => {
    const { t, ops, webhookId } = await setup();
    await backlogRule(ops, [webhookId]);
    await evaluate(t);
    await ops.mutation(api.alerts.deleteDestination, { id: webhookId });
    await runDeliveries(t);
    expect(sent).toEqual([]);
    expect(await deliveries(t)).toEqual([
      expect.objectContaining({ status: "failed", lastError: "The destination was deleted" }),
    ]);
  });

  it("sends a test notification on request", async () => {
    const { t, ops, webhookId } = await setup();
    await ops.mutation(api.alerts.sendTest, { id: webhookId });
    await runDeliveries(t);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.headers.get("X-EraInfra-Event")).toBe("alert.test");
    const overview = await ops.query(api.alerts.overview, {});
    expect(overview.destinations[0]?.lastDelivery).toMatchObject({
      event: "test",
      status: "delivered",
    });
  });
});
