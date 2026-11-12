import { convexTest, type TestConvex } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { api, internal } from "../convex/_generated/api";
import schema from "../convex/schema";
import { setUpBefore } from "./support/clock.ts";
import {
  CONTRACT,
  MINUTE,
  NOW,
  insertProfile,
  operator,
  seedFleet,
} from "./support/fleetFixture.ts";

// The controller heartbeat end to end: the HTTP route and its two tokens, the stored row, and the
// two readers that turn it into an outage signal, /metrics and the controller-silent alert.

const modules = import.meta.glob("../convex/**/*.ts");
type Harness = TestConvex<typeof schema>;

const CURRENT = "controller-token-current";
const NEXT = "controller-token-next";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  vi.stubEnv("CONTROLLER_TOKEN", CURRENT);
  vi.stubEnv("CONTROLLER_TOKEN_NEXT", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

function at(minutes: number) {
  vi.setSystemTime(NOW + minutes * MINUTE);
}

type Report = {
  profile?: string;
  hostname?: string;
  version?: string;
  scaleSetId?: number;
  sessionState?: string;
  lastMessageAt?: number;
  startedAt?: number;
  assignedJobs?: number;
  runningJobs?: number;
  lastError?: string;
};

function report(fields: Report = {}): Report {
  return {
    profile: CONTRACT.profile,
    hostname: "oracle-singapore-1",
    version: "0.2.0-rc.11",
    scaleSetId: 7,
    sessionState: "listening",
    lastMessageAt: Date.now() - 1_000,
    startedAt: NOW - 60 * MINUTE,
    assignedJobs: 2,
    runningJobs: 1,
    ...fields,
  };
}

async function send(t: Harness, body: unknown, token: string | null = CURRENT) {
  const grant = await t.mutation(internal.controllerLease.acquire, {
    profile: CONTRACT.profile,
    hostname: "heartbeat-test",
    instance: "heartbeat-test-instance",
    activate: true,
    caller: { kind: "controllerToken", slot: "current" },
  });
  if (!grant.granted) throw new Error("test heartbeat needs a lease");
  return t.fetch("/controller/heartbeat", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token === null ? {} : { Authorization: `Bearer ${token}` }),
      "X-EraInfra-Lease-Epoch": String(grant.epoch),
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

async function rows(t: Harness) {
  return t.run((ctx) => ctx.db.query("controllerHeartbeats").collect());
}

describe("POST /controller/heartbeat", () => {
  it("refuses a request without the controller token, and fails closed when none is configured", async () => {
    const t = convexTest(schema, modules);
    expect((await send(t, report(), null)).status).toBe(401);
    expect((await send(t, report(), "wrong-token")).status).toBe(401);
    // A metrics or Worker token is not a controller token.
    expect((await send(t, report(), `${CURRENT}x`)).status).toBe(401);

    vi.stubEnv("CONTROLLER_TOKEN", "");
    expect((await send(t, report(), CURRENT)).status).toBe(503);
    expect(await rows(t)).toEqual([]);
  });

  it("accepts either token while a rotation is in progress, and records which one was used", async () => {
    const t = convexTest(schema, modules);
    vi.stubEnv("CONTROLLER_TOKEN_NEXT", NEXT);
    expect((await send(t, report({ hostname: "old-token-host" }), CURRENT)).status).toBe(204);
    expect((await send(t, report({ hostname: "new-token-host" }), NEXT)).status).toBe(204);
    const slots = Object.fromEntries((await rows(t)).map((row) => [row.hostname, row.tokenSlot]));
    expect(slots).toEqual({ "old-token-host": "current", "new-token-host": "next" });

    // The last step: NEXT is promoted, the old token is withdrawn, and the moved host keeps working.
    vi.stubEnv("CONTROLLER_TOKEN", NEXT);
    vi.stubEnv("CONTROLLER_TOKEN_NEXT", "");
    expect((await send(t, report({ hostname: "new-token-host" }), NEXT)).status).toBe(204);
    expect((await send(t, report({ hostname: "old-token-host" }), CURRENT)).status).toBe(401);
  });

  it("works with only CONTROLLER_TOKEN_NEXT set", async () => {
    const t = convexTest(schema, modules);
    vi.stubEnv("CONTROLLER_TOKEN", "");
    vi.stubEnv("CONTROLLER_TOKEN_NEXT", NEXT);
    expect((await send(t, report(), NEXT)).status).toBe(204);
  });

  it("refuses a malformed report", async () => {
    const t = convexTest(schema, modules);
    const bad: unknown[] = [
      "not json",
      [],
      report({ profile: "" }),
      report({ profile: "has spaces" }),
      report({ hostname: "" }),
      report({ hostname: "host\nname" }),
      report({ version: "x".repeat(65) }),
      report({ sessionState: "sleeping" }),
      report({ assignedJobs: -1 }),
      report({ runningJobs: 1.5 }),
      report({ scaleSetId: 0 }),
      report({ lastMessageAt: -5 }),
      report({ lastError: "e".repeat(1_001) }),
    ];
    for (const body of bad) {
      expect((await send(t, body)).status, JSON.stringify(body)).toBe(400);
    }
    expect(await rows(t)).toEqual([]);
  });

  it("keeps one row per Profile and host, judged by the control plane's clock", async () => {
    const t = convexTest(schema, modules);
    // The controller's clock is a day off; receivedAt is still this deployment's.
    expect((await send(t, report({ startedAt: NOW - 24 * 60 * MINUTE }))).status).toBe(204);
    at(1);
    expect(
      (
        await send(
          t,
          report({ sessionState: "conflict", lastError: "409 Conflict", lastMessageAt: undefined }),
        )
      ).status,
    ).toBe(204);
    at(2);
    expect((await send(t, report({ hostname: "ubuntu0", sessionState: "starting" }))).status).toBe(
      204,
    );

    const stored = (await rows(t)).toSorted((a, b) => a.hostname.localeCompare(b.hostname));
    expect(stored).toHaveLength(2);
    expect(stored[0]).toMatchObject({
      hostname: "oracle-singapore-1",
      sessionState: "conflict",
      lastError: "409 Conflict",
      firstSeenAt: NOW,
      receivedAt: NOW + MINUTE,
      // The last report in which it held the session.
      lastListeningAt: NOW,
    });
    // A report that no longer carries a field clears it rather than keeping a stale value.
    expect(stored[0]?.lastMessageAt).toBeUndefined();
    expect(stored[1]).toMatchObject({ hostname: "ubuntu0", sessionState: "starting" });
    expect(stored[1]?.lastListeningAt).toBeUndefined();
  });
});

async function scrape(t: Harness) {
  const { token } = await (
    await operator(t)
  ).mutation(api.apiTokens.create, {
    name: "prometheus",
    scope: "metrics",
  });
  const response = await t.fetch("/metrics", {
    method: "GET",
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(response.status).toBe(200);
  return response.text();
}

function sample(text: string, name: string, profile: string) {
  const line = text
    .split("\n")
    .find((candidate) => candidate.startsWith(`${name}{profile="${profile}"} `));
  return line === undefined ? undefined : Number(line.split(" ").at(-1));
}

describe("controller liveness in /metrics", () => {
  it("has no series for a Profile no controller has reported for, so an old controller is never down", async () => {
    const t = convexTest(schema, modules);
    await seedFleet(t);
    const text = await scrape(t);
    expect(text).toContain("# TYPE erainfra_controller_up gauge");
    expect(text).toContain("# TYPE erainfra_controller_last_heartbeat_age_seconds gauge");
    expect(sample(text, "erainfra_controller_up", CONTRACT.profile)).toBeUndefined();
    expect(
      sample(text, "erainfra_controller_last_heartbeat_age_seconds", CONTRACT.profile),
    ).toBeUndefined();
  });

  it("reports up while a controller listens, and down with its age once it falls silent", async () => {
    const t = convexTest(schema, modules);
    await seedFleet(t);
    expect((await send(t, report())).status).toBe(204);

    at(0.5);
    let text = await scrape(t);
    expect(sample(text, "erainfra_controller_up", CONTRACT.profile)).toBe(1);
    expect(sample(text, "erainfra_controller_last_heartbeat_age_seconds", CONTRACT.profile)).toBe(
      30,
    );

    at(2);
    text = await scrape(t);
    expect(sample(text, "erainfra_controller_up", CONTRACT.profile)).toBe(0);
    expect(sample(text, "erainfra_controller_last_heartbeat_age_seconds", CONTRACT.profile)).toBe(
      120,
    );
  });

  it("reports down while the only controller is waiting out a session conflict", async () => {
    const t = convexTest(schema, modules);
    await seedFleet(t);
    expect((await send(t, report({ sessionState: "conflict" }))).status).toBe(204);
    const text = await scrape(t);
    expect(sample(text, "erainfra_controller_up", CONTRACT.profile)).toBe(0);
    expect(sample(text, "erainfra_controller_last_heartbeat_age_seconds", CONTRACT.profile)).toBe(
      0,
    );
  });
});

async function silentRule(t: Harness) {
  const ops = await operator(t);
  await ops.mutation(api.alerts.createRule, {
    name: "Controller silent",
    condition: { kind: "controller-silent", minutes: 3 },
    forMinutes: 0,
    cooldownMinutes: 0,
    destinationIds: [],
  });
}

async function incidents(t: Harness) {
  return t.run((ctx) => ctx.db.query("alertIncidents").collect());
}

async function evaluate(t: Harness) {
  await t.action(internal.alerts.evaluate, {});
}

describe("the controller-silent alert", () => {
  it("fires when the controller has been silent for the threshold, and resolves when it listens again", async () => {
    const t = await setUpBefore(NOW, async () => {
      const harness = convexTest(schema, modules);
      await insertProfile(harness);
      await silentRule(harness);
      return harness;
    });
    expect((await send(t, report())).status).toBe(204);

    at(2);
    await evaluate(t);
    expect(await incidents(t)).toEqual([]);

    at(4);
    await evaluate(t);
    let open = await incidents(t);
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ subject: CONTRACT.profile, status: "firing" });
    expect(open[0]?.summary).toBe(
      "Profile erainfra-4vcpu-ubuntu-2404 has had no listening controller for 4m; the last report came from oracle-singapore-1 (0.2.0-rc.11) 4m ago.",
    );

    at(5);
    expect((await send(t, report())).status).toBe(204);
    // A later evaluation, so it does not share the report's instant.
    at(6);
    await evaluate(t);
    open = await incidents(t);
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ status: "resolved", resolvedAt: NOW + 6 * MINUTE });
  });

  it("never fires for a Profile whose controller predates the heartbeat", async () => {
    const t = convexTest(schema, modules);
    await insertProfile(t);
    await silentRule(t);
    at(60);
    await evaluate(t);
    expect(await incidents(t)).toEqual([]);
  });
});
