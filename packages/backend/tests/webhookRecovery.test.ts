import { convexTest, type TestConvex } from "convex-test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "../convex/_generated/api";
import { MAX_RECOVERY_ATTEMPTS, RECOVERY_SEED_MS, RECOVERY_WINDOW_MS } from "../convex/recovery";
import schema from "../convex/schema";
import { githubMock } from "./support/githubMock.ts";

// convex-test executes scheduled functions, so the real `github` module would
// otherwise drive Octokit at the network. See tests/support/githubMock.ts.
const modules = {
  ...import.meta.glob("../convex/**/*.ts"),
  "../convex/github.ts": githubMock,
};

// Carries the schema so ctx.db is fully typed inside t.run().
type Harness = TestConvex<typeof schema>;

const NOW = Date.parse("2026-08-09T12:00:00Z");
const OPERATOR = { subject: "operator", issuer: "test" };

beforeEach(() => {
  vi.stubEnv("ALLOWED_REPOS", "acme/app");
  vi.stubEnv("ALLOW_PUBLIC_REPOS", "");
});

function candidate(guid: string, overrides: Record<string, number | string> = {}) {
  return {
    guid,
    githubDeliveryId: 100,
    event: "workflow_job",
    deliveredAt: NOW - 60_000,
    statusCode: 500,
    ...overrides,
  };
}

function seedDelivery(t: Harness, deliveryId: string) {
  return t.run(async (ctx) =>
    ctx.db.insert("webhookDeliveries", {
      deliveryId,
      event: "workflow_job",
      receivedAt: NOW,
      status: "processed",
      attempts: 1,
    }),
  );
}

function readRecovery(t: Harness, guid: string) {
  return t.run(async (ctx) =>
    ctx.db
      .query("webhookRecovery")
      .withIndex("by_guid", (q) => q.eq("guid", guid))
      .unique(),
  );
}

function readState(t: Harness) {
  return t.run(async (ctx) => ctx.db.query("webhookRecoveryState").first());
}

/** Record a delivery and run its processor, exactly as the HTTP route does. */
async function deliver(
  t: Harness,
  deliveryId: string,
  workflowJob: {
    action: "queued" | "in_progress" | "completed";
    ghJobId: number;
    githubInstallationId?: number;
    repo: string;
    repoIsPublic: boolean;
    workflowName: string;
    labels: string[];
  },
) {
  const { duplicate } = await t.mutation(internal.webhooks.recordDelivery, {
    deliveryId,
    event: "workflow_job",
    workflowJob,
  });
  const delivery = await t.run(async (ctx) =>
    ctx.db
      .query("webhookDeliveries")
      .withIndex("by_deliveryId", (q) => q.eq("deliveryId", deliveryId))
      .unique(),
  );
  if (delivery !== null && delivery.status === "pending") {
    await t.mutation(internal.webhooks.processDelivery, { deliveryId: delivery._id });
  }
  return { duplicate };
}

describe("missingGuids", () => {
  it("reports only the GUIDs with no delivery row", async () => {
    const t = convexTest(schema, modules);
    await seedDelivery(t, "known");

    expect(
      await t.query(internal.webhooks.missingGuids, { guids: ["known", "lost", "also-lost"] }),
    ).toEqual(["lost", "also-lost"]);
  });

  // A delivery the allowlist refused still arrived; asking GitHub to send it
  // again would only refuse it again.
  it("counts a rejected or abandoned delivery as received", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await ctx.db.insert("webhookDeliveries", {
        deliveryId: "rejected",
        event: "workflow_job",
        receivedAt: NOW,
        status: "rejected",
        attempts: 1,
        lastError: "Repository evil/fork is not in ALLOWED_REPOS",
      });
      await ctx.db.insert("webhookDeliveries", {
        deliveryId: "gave-up",
        event: "workflow_job",
        receivedAt: NOW,
        status: "failed",
        attempts: 5,
      });
    });

    expect(
      await t.query(internal.webhooks.missingGuids, { guids: ["rejected", "gave-up"] }),
    ).toEqual([]);
  });
});

describe("claimRecovery", () => {
  it("claims an unseen delivery once and then holds it for the backoff", async () => {
    const t = convexTest(schema, modules);

    expect(
      await t.mutation(internal.webhooks.claimRecovery, {
        now: NOW,
        candidates: [candidate("lost", { githubDeliveryId: 7 })],
      }),
    ).toEqual([{ guid: "lost", githubDeliveryId: 7 }]);

    const first = await readRecovery(t, "lost");
    expect(first).toMatchObject({ attempts: 1, state: "requested", githubDeliveryId: 7 });

    // Same run, same listing: the row must not inflate.
    expect(
      await t.mutation(internal.webhooks.claimRecovery, {
        now: NOW + 1_000,
        candidates: [candidate("lost")],
      }),
    ).toEqual([]);
    expect((await readRecovery(t, "lost"))?.attempts).toBe(1);
  });

  it("gives up once the attempt budget is spent", async () => {
    const t = convexTest(schema, modules);

    let now = NOW;
    for (let attempt = 1; attempt <= MAX_RECOVERY_ATTEMPTS; attempt += 1) {
      const claimed = await t.mutation(internal.webhooks.claimRecovery, {
        now,
        candidates: [candidate("never-lands")],
      });
      expect(claimed).toHaveLength(1);
      now = (await readRecovery(t, "never-lands"))?.nextAttemptAt ?? now;
    }

    const beyond = await t.mutation(internal.webhooks.claimRecovery, {
      now,
      candidates: [candidate("never-lands")],
    });
    expect(beyond).toEqual([]);

    const row = await readRecovery(t, "never-lands");
    expect(row).toMatchObject({ state: "abandoned", attempts: MAX_RECOVERY_ATTEMPTS });
    expect(row?.lastError).toContain(String(MAX_RECOVERY_ATTEMPTS));
  });

  it("never reopens a settled row", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.webhooks.claimRecovery, {
      now: NOW,
      candidates: [candidate("done")],
    });
    const row = await readRecovery(t, "done");
    await t.run(async (ctx) => {
      if (row !== null) await ctx.db.patch(row._id, { state: "recovered" });
    });

    expect(
      await t.mutation(internal.webhooks.claimRecovery, {
        now: NOW + RECOVERY_WINDOW_MS,
        candidates: [candidate("done")],
      }),
    ).toEqual([]);
  });
});

describe("settleRecovery", () => {
  it("records a refusal without touching the attempt already spent", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.webhooks.claimRecovery, {
      now: NOW,
      candidates: [candidate("refused")],
    });

    await t.mutation(internal.webhooks.settleRecovery, {
      guid: "refused",
      ok: false,
      error: "GitHub responded 404 while requesting a redelivery",
    });

    const row = await readRecovery(t, "refused");
    expect(row).toMatchObject({ attempts: 1, state: "requested" });
    expect(row?.lastError).toBe("GitHub responded 404 while requesting a redelivery");

    // A later success clears the stale note.
    await t.mutation(internal.webhooks.settleRecovery, { guid: "refused", ok: true });
    expect((await readRecovery(t, "refused"))?.lastError).toBeUndefined();
  });
});

describe("reconcileRecovered", () => {
  it("closes a row once its delivery lands, and leaves the others waiting", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.webhooks.claimRecovery, {
      now: NOW,
      candidates: [candidate("landed"), candidate("still-waiting")],
    });
    await seedDelivery(t, "landed");

    expect(await t.mutation(internal.webhooks.reconcileRecovered, { now: NOW })).toEqual({
      recovered: 1,
      abandoned: 0,
    });
    expect((await readRecovery(t, "landed"))?.state).toBe("recovered");
    expect((await readRecovery(t, "still-waiting"))?.state).toBe("requested");
  });

  it("abandons a row whose requests were all accepted and never arrived", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.webhooks.claimRecovery, {
      now: NOW,
      candidates: [candidate("vanished")],
    });
    const row = await readRecovery(t, "vanished");
    await t.run(async (ctx) => {
      if (row !== null) await ctx.db.patch(row._id, { attempts: MAX_RECOVERY_ATTEMPTS });
    });

    // Still inside the backoff: nothing has actually run out yet.
    expect(await t.mutation(internal.webhooks.reconcileRecovered, { now: NOW })).toEqual({
      recovered: 0,
      abandoned: 0,
    });

    const after = (row?.nextAttemptAt ?? NOW) + 1;
    expect(await t.mutation(internal.webhooks.reconcileRecovered, { now: after })).toEqual({
      recovered: 0,
      abandoned: 1,
    });
    expect((await readRecovery(t, "vanished"))?.state).toBe("abandoned");
  });
});

describe("beginRecoveryRun / finishRecoveryRun", () => {
  it("seeds a short lookback on a deployment that has never run", async () => {
    const t = convexTest(schema, modules);

    expect(await t.mutation(internal.webhooks.beginRecoveryRun, { now: NOW })).toEqual({
      run: true,
      scannedThrough: NOW - RECOVERY_SEED_MS,
    });
    expect(await readState(t)).toMatchObject({ lastOutcome: "pending", consecutiveFailures: 0 });
  });

  it("advances the watermark on a complete scan and holds it on a truncated one", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.webhooks.beginRecoveryRun, { now: NOW });

    await t.mutation(internal.webhooks.finishRecoveryRun, {
      now: NOW,
      outcome: "ok",
      newestDeliveredAt: NOW - 60_000,
      listed: 4,
      missing: 1,
      requested: 1,
    });
    const advanced = await readState(t);
    expect(advanced).toMatchObject({ lastOutcome: "ok", listed: 4, missing: 1, requested: 1 });
    expect(advanced?.scannedThrough).toBeGreaterThan(NOW - RECOVERY_SEED_MS);

    const held = advanced?.scannedThrough ?? 0;
    await t.mutation(internal.webhooks.finishRecoveryRun, {
      now: NOW + 60_000,
      outcome: "ok",
      listed: 300,
      missing: 0,
      requested: 0,
    });
    expect((await readState(t))?.scannedThrough).toBe(held);
  });

  it("opens the circuit breaker on failure and closes it on the next success", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.webhooks.beginRecoveryRun, { now: NOW });
    await t.mutation(internal.webhooks.finishRecoveryRun, {
      now: NOW,
      outcome: "error",
      listed: 0,
      missing: 0,
      requested: 0,
      error: "GitHub responded 401 while scanning webhook deliveries",
    });

    const broken = await readState(t);
    expect(broken).toMatchObject({ lastOutcome: "error", consecutiveFailures: 1 });
    expect(broken?.nextRunAt).toBe(NOW + 60_000);

    // The very next tick is refused without reading a credential.
    expect(await t.mutation(internal.webhooks.beginRecoveryRun, { now: NOW + 1_000 })).toEqual({
      run: false,
      reason: "backoff",
    });
    expect((await readState(t))?.lastOutcome).toBe("skipped-backoff");

    const reopened = NOW + 60_001;
    expect(await t.mutation(internal.webhooks.beginRecoveryRun, { now: reopened })).toMatchObject({
      run: true,
    });
    await t.mutation(internal.webhooks.finishRecoveryRun, {
      now: reopened,
      outcome: "ok",
      listed: 0,
      missing: 0,
      requested: 0,
    });
    const healthy = await readState(t);
    expect(healthy).toMatchObject({ consecutiveFailures: 0, lastSuccessAt: reopened });
    expect(healthy?.lastError).toBeUndefined();
  });

  it("does not count a missing GitHub App as a failure", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.webhooks.beginRecoveryRun, { now: NOW });
    await t.mutation(internal.webhooks.finishRecoveryRun, {
      now: NOW,
      outcome: "skipped-no-app",
      listed: 0,
      missing: 0,
      requested: 0,
    });

    const state = await readState(t);
    expect(state).toMatchObject({
      lastOutcome: "skipped-no-app",
      consecutiveFailures: 0,
      nextRunAt: NOW,
    });
    // Nothing was scanned, so nothing succeeded either.
    expect(state?.lastSuccessAt).toBeUndefined();
  });

  it("pulls a stale watermark back inside the window GitHub can redeliver from", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.webhooks.beginRecoveryRun, { now: NOW });

    const muchLater = NOW + 30 * 24 * 60 * 60_000;
    expect(await t.mutation(internal.webhooks.beginRecoveryRun, { now: muchLater })).toEqual({
      run: true,
      scannedThrough: muchLater - RECOVERY_WINDOW_MS,
    });
  });
});

// The guarantee the whole design rests on: the GUID is constant across
// redeliveries, so a redelivery that races a late original cannot double-queue.
describe("a redelivery arriving", () => {
  it("creates one job, is idempotent, and closes out its recovery row", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.webhooks.claimRecovery, {
      now: NOW,
      candidates: [candidate("delivery-guid")],
    });

    const event = {
      action: "queued" as const,
      ghJobId: 4242,
      githubInstallationId: 42,
      repo: "acme/app",
      repoIsPublic: false,
      workflowName: "CI",
      labels: ["self-hosted", "rc-linux"],
    };
    const first = await deliver(t, "delivery-guid", event);
    const second = await deliver(t, "delivery-guid", event);

    expect(first).toEqual({ duplicate: false });
    expect(second).toEqual({ duplicate: true });
    expect(await t.run(async (ctx) => ctx.db.query("jobs").collect())).toHaveLength(1);

    expect(await t.mutation(internal.webhooks.reconcileRecovered, { now: NOW })).toEqual({
      recovered: 1,
      abandoned: 0,
    });
    expect((await readRecovery(t, "delivery-guid"))?.state).toBe("recovered");
  });
});

describe("recoveryStatus", () => {
  it("requires dashboard authentication", async () => {
    const t = convexTest(schema, modules);
    await expect(t.query(api.webhooks.recoveryStatus, {})).rejects.toThrow(
      /Authentication required/,
    );
  });

  it("is null until the cron has opened its first run", async () => {
    const t = convexTest(schema, modules).withIdentity(OPERATOR);
    expect(await t.query(api.webhooks.recoveryStatus, {})).toBeNull();
  });

  // Projected field by field, so adding a column to either table cannot widen
  // what reaches a browser. A delivery GUID is not part of this shape.
  it("returns exactly the run record and the counts", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.webhooks.beginRecoveryRun, { now: NOW });
    await t.mutation(internal.webhooks.finishRecoveryRun, {
      now: NOW,
      outcome: "ok",
      newestDeliveredAt: NOW - 60_000,
      listed: 12,
      missing: 2,
      requested: 2,
    });
    // A later failure keeps the counters of the last completed scan and adds a
    // status-code-only reason, so both optional fields are populated here.
    await t.mutation(internal.webhooks.beginRecoveryRun, { now: NOW + 1 });
    await t.mutation(internal.webhooks.finishRecoveryRun, {
      now: NOW + 1,
      outcome: "error",
      listed: 0,
      missing: 0,
      requested: 0,
      error: "GitHub responded 401 while scanning webhook deliveries",
    });
    await t.mutation(internal.webhooks.claimRecovery, {
      now: NOW,
      candidates: [candidate("outstanding")],
    });

    const status = await t.withIdentity(OPERATOR).query(api.webhooks.recoveryStatus, {});
    expect(Object.keys(status ?? {}).toSorted()).toEqual([
      "abandoned",
      "consecutiveFailures",
      "lastError",
      "lastOutcome",
      "lastRunAt",
      "lastSuccessAt",
      "listed",
      "missing",
      "nextRunAt",
      "outstanding",
      "recovered",
      "requested",
    ]);
    expect(status).toMatchObject({
      lastOutcome: "error",
      consecutiveFailures: 1,
      listed: 12,
      missing: 2,
      requested: 2,
      outstanding: 1,
      recovered: 0,
      abandoned: 0,
    });
    expect(JSON.stringify(status)).not.toContain("outstanding-guid");
  });
});
