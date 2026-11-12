import { convexTest, type TestConvex } from "convex-test";
import { describe, expect, it } from "vitest";

import { api, internal } from "../convex/_generated/api";
import { FIRECRACKER_REQUIRED_CHECKS } from "../convex/isolation";
import schema from "../convex/schema";

const modules = import.meta.glob("../convex/**/*.ts");
type Harness = TestConvex<typeof schema>;

const CONTRACT = {
  profile: "erainfra-4vcpu-ubuntu-2404",
  executor: "firecracker" as const,
  imageRelease: `ghcr.io/fanzzzd/runner@sha256:${"a".repeat(64)}`,
  vcpus: 2,
  memoryMiB: 4096,
};

const FIRECRACKER_FACTS = {
  isolation: "firecracker-microvm",
  boundary: "guest-kernel" as const,
  checks: [...FIRECRACKER_REQUIRED_CHECKS].map((name) => ({ name, passed: true })),
  cacheScope: "immutable-image",
  cacheSharedWritable: false,
  hardware: { kvm: true },
  storage: {
    snapshotter: "devmapper",
    poolName: "runner-center-thinpool",
    poolTotalMiB: 51_200,
    poolFreeMiB: 40_960,
  },
  network: {
    policyName: "runner-center",
    policyHash: `sha256:${"b".repeat(64)}`,
    subnet: "10.241.0.0/16",
    egressMode: "public",
  },
};

async function registerProfile(t: Harness, maxRunners = 4, minRunners = 0) {
  await t.mutation(internal.controllerApi.registerProfile, {
    name: CONTRACT.profile,
    scaleSetName: CONTRACT.profile,
    executor: CONTRACT.executor,
    imageRelease: CONTRACT.imageRelease,
    vcpus: CONTRACT.vcpus,
    memoryMiB: CONTRACT.memoryMiB,
    warmPool: 0,
    minRunners,
    maxRunners,
  });
  await holdLease(t);
}

/** A controller listening for the Profile: it holds the lease until `expiresAt`. */
async function holdLease(t: Harness, expiresAt = Date.now() + 30_000) {
  await t.run(async (ctx) => {
    const existing = await ctx.db
      .query("controllerLeases")
      .withIndex("by_profile", (query) => query.eq("profile", CONTRACT.profile))
      .first();
    if (existing !== null) await ctx.db.delete(existing._id);
    await ctx.db.insert("controllerLeases", {
      profile: CONTRACT.profile,
      epoch: 1,
      holder: {
        credential: "controllerToken",
        hostname: "controller-host",
        instance: "instance-1",
      },
      acquiredAt: Date.now() - 60_000,
      renewedAt: Date.now(),
      expiresAt,
    });
  });
}

async function addReadyWorker(t: Harness, name: string, maxSlots = 1) {
  const machineId = await t.run((ctx) =>
    ctx.db.insert("machines", {
      name,
      os: "linux",
      labels: [],
      maxSlots,
      usedSlots: 0,
      lastSeen: Date.now(),
      token: `token-${name}`,
    }),
  );
  await t.mutation(api.workerApi.reportReadiness, {
    token: `token-${name}`,
    profile: CONTRACT.profile,
    executor: CONTRACT.executor,
    imageRelease: CONTRACT.imageRelease,
    vcpus: CONTRACT.vcpus,
    memoryMiB: CONTRACT.memoryMiB,
    state: "ready",
    ...FIRECRACKER_FACTS,
    warmPool: { target: 0, parked: 0, claimed: 0 },
  });
  return machineId;
}

let runnerSequence = 0;
async function createAttempt(t: Harness) {
  runnerSequence += 1;
  const runnerName = `runner-${runnerSequence}`;
  await t.mutation(internal.controllerApi.createAttempt, {
    ...CONTRACT,
    runnerName,
    runnerId: runnerSequence,
    encodedJITConfig: `secret-${runnerName}`,
  });
  await t.mutation(internal.attemptScheduler.tryAssign, {});
  const attempt = await t.run((ctx) =>
    ctx.db
      .query("attempts")
      .withIndex("by_runnerName", (query) => query.eq("runnerName", runnerName))
      .unique(),
  );
  if (attempt === null) throw new Error(`Attempt ${runnerName} was not created`);
  return attempt;
}

function route(t: Harness, profile = CONTRACT.profile) {
  return t.query(internal.routing.profileRoute, { profile });
}

async function runsOn(t: Harness, query: string) {
  const response = await t.fetch(`/runs-on?${query}`, { method: "GET" });
  return { status: response.status, response, body: (await response.json()) as unknown };
}

describe("routing.profileRoute", () => {
  it("routes to a Profile whose ready Worker has a free slot", async () => {
    const t = convexTest(schema, modules);
    await registerProfile(t);
    await addReadyWorker(t, "worker-a");

    expect(await route(t)).toEqual({ route: "profile", executor: "firecracker" });
  });

  it("falls back when no controller holds the Profile's lease, however ready the Workers", async () => {
    // 2026-11-12: erainfra-4vcpu-ubuntu-2404's controller was disabled while ubuntu0 still reported the Profile
    // ready. The router kept answering erainfra-4vcpu-ubuntu-2404, and payable's jobs queued with no listener.
    const t = convexTest(schema, modules);
    await registerProfile(t);
    await addReadyWorker(t, "worker-a");
    await t.run(async (ctx) => {
      const lease = await ctx.db.query("controllerLeases").first();
      if (lease !== null) await ctx.db.delete(lease._id);
    });

    expect(await route(t)).toMatchObject({ route: "fallback", reason: "no-controller" });
    expect((await runsOn(t, `profile=${CONTRACT.profile}&fallback=ubuntu-24.04`)).body).toEqual({
      "runs-on": "ubuntu-24.04",
    });
  });

  it("falls back when the controller's lease expired or was released", async () => {
    const t = convexTest(schema, modules);
    await registerProfile(t);
    await addReadyWorker(t, "worker-a");

    await holdLease(t, Date.now() - 1);
    expect(await route(t)).toMatchObject({ route: "fallback", reason: "no-controller" });

    await t.run(async (ctx) => {
      const lease = await ctx.db.query("controllerLeases").first();
      if (lease !== null) await ctx.db.patch(lease._id, { holder: undefined });
    });
    expect(await route(t)).toMatchObject({ route: "fallback", reason: "no-controller" });

    await holdLease(t);
    expect(await route(t)).toEqual({ route: "profile", executor: "firecracker" });
  });

  it("falls back when no Worker has proved readiness for the Profile", async () => {
    const t = convexTest(schema, modules);
    await registerProfile(t);

    expect(await route(t)).toMatchObject({ route: "fallback", reason: "no-ready-worker" });
  });

  it("falls back when the only ready Worker stopped heartbeating", async () => {
    const t = convexTest(schema, modules);
    await registerProfile(t);
    const machineId = await addReadyWorker(t, "worker-a");
    await t.run((ctx) => ctx.db.patch(machineId, { lastSeen: Date.now() - 10 * 60_000 }));

    expect(await route(t)).toMatchObject({ route: "fallback", reason: "no-ready-worker" });
  });

  it("falls back when a ready row's evidence no longer proves the isolation contract", async () => {
    const t = convexTest(schema, modules);
    await registerProfile(t);
    await addReadyWorker(t, "worker-a");
    // The scheduler refuses a row whose split evidence no longer matches it; so must routing.
    await t.run(async (ctx) => {
      const evidence = await ctx.db.query("readinessEvidence").first();
      if (evidence !== null) await ctx.db.patch(evidence._id, { checkedAt: 1 });
    });

    expect(await route(t)).toMatchObject({ route: "fallback", reason: "no-ready-worker" });
  });

  it("falls back when every slot is taken by a running job", async () => {
    const t = convexTest(schema, modules);
    await registerProfile(t);
    await addReadyWorker(t, "worker-a", 1);
    const attempt = await createAttempt(t);
    expect(attempt.machineId).toBeDefined();
    await t.run((ctx) => ctx.db.patch(attempt._id, { state: "running" }));

    expect(await route(t)).toMatchObject({ route: "fallback", reason: "saturated" });
  });

  it("counts Attempts already waiting ahead of the new job", async () => {
    const t = convexTest(schema, modules);
    await registerProfile(t);
    // Two slots: one runs a job, one is spoken for by an Attempt that a
    // queued job is waiting on but the Worker has not claimed yet.
    await addReadyWorker(t, "worker-a", 2);
    const running = await createAttempt(t);
    await t.run((ctx) => ctx.db.patch(running._id, { state: "running" }));
    expect(await route(t)).toEqual({ route: "profile", executor: "firecracker" });

    const waiting = await createAttempt(t);
    expect(waiting.state).toBe("pending");
    expect(await route(t)).toMatchObject({ route: "fallback", reason: "saturated" });
  });

  it("falls back once the controller is at the Profile's maxRunners", async () => {
    const t = convexTest(schema, modules);
    await registerProfile(t, 1);
    await addReadyWorker(t, "worker-a", 4);
    const attempt = await createAttempt(t);
    await t.run((ctx) => ctx.db.patch(attempt._id, { state: "running" }));

    expect(await route(t)).toMatchObject({ route: "fallback", reason: "saturated" });
  });

  it("routes to the Profile while a warm Runner is idle, even with every slot taken", async () => {
    const t = convexTest(schema, modules);
    // minRunners=1: the controller keeps one Runner online with no job.
    await registerProfile(t, 2, 1);
    await addReadyWorker(t, "worker-a", 1);
    const attempt = await createAttempt(t);
    await t.run((ctx) => ctx.db.patch(attempt._id, { state: "ready" }));

    expect(await route(t)).toEqual({ route: "profile", executor: "firecracker" });
  });

  it("does not count a ready Runner that a queued job is already waiting for", async () => {
    const t = convexTest(schema, modules);
    // minRunners=0: a Runner exists only because a job was assigned, so it is that job's.
    await registerProfile(t, 2, 0);
    await addReadyWorker(t, "worker-a", 1);
    const attempt = await createAttempt(t);
    await t.run((ctx) => ctx.db.patch(attempt._id, { state: "ready" }));

    expect(await route(t)).toMatchObject({ route: "fallback", reason: "saturated" });
  });

  it("does not trust an idle-looking Runner once the controller is at maxRunners", async () => {
    const t = convexTest(schema, modules);
    await registerProfile(t, 1, 1);
    await addReadyWorker(t, "worker-a", 4);
    const attempt = await createAttempt(t);
    await t.run((ctx) => ctx.db.patch(attempt._id, { state: "ready" }));

    expect(await route(t)).toMatchObject({ route: "fallback", reason: "saturated" });
  });

  it("falls back for an unknown Profile", async () => {
    const t = convexTest(schema, modules);
    await registerProfile(t);
    await addReadyWorker(t, "worker-a");

    expect(await route(t, "rc-linux-typo")).toEqual({
      route: "fallback",
      reason: "unknown-profile",
    });
  });

  it("falls back for a paused Profile even with a ready Worker", async () => {
    const t = convexTest(schema, modules);
    await registerProfile(t);
    await addReadyWorker(t, "worker-a");
    await t.run(async (ctx) => {
      const profile = await ctx.db.query("profiles").first();
      if (profile !== null) await ctx.db.patch(profile._id, { state: "paused" });
    });

    expect(await route(t)).toMatchObject({ route: "fallback", reason: "paused" });
  });
});

describe("GET /runs-on?profile=", () => {
  it("answers the Profile name when it has room, and nothing else", async () => {
    const t = convexTest(schema, modules);
    await registerProfile(t);
    await addReadyWorker(t, "worker-a");

    const { status, response, body } = await runsOn(
      t,
      "profile=erainfra-4vcpu-ubuntu-2404&fallback=ubuntu-24.04",
    );
    expect(status).toBe(200);
    expect(body).toEqual({ "runs-on": "erainfra-4vcpu-ubuntu-2404" });
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("answers the caller's fallback label when the Profile has no ready Worker", async () => {
    const t = convexTest(schema, modules);
    await registerProfile(t);

    const { status, body } = await runsOn(
      t,
      "profile=erainfra-4vcpu-ubuntu-2404&fallback=ubuntu-24.04",
    );
    expect(status).toBe(200);
    expect(body).toEqual({ "runs-on": "ubuntu-24.04" });
  });

  it("answers the fallback when the Profile is saturated", async () => {
    const t = convexTest(schema, modules);
    await registerProfile(t);
    await addReadyWorker(t, "worker-a", 1);
    const attempt = await createAttempt(t);
    await t.run((ctx) => ctx.db.patch(attempt._id, { state: "running" }));

    const { body } = await runsOn(t, "profile=erainfra-4vcpu-ubuntu-2404&fallback=ubuntu-24.04");
    expect(body).toEqual({ "runs-on": "ubuntu-24.04" });
  });

  it("defaults the fallback to the latest hosted runner, including for an unknown Profile", async () => {
    const t = convexTest(schema, modules);

    const { status, body } = await runsOn(t, "profile=rc-nothing");
    expect(status).toBe(200);
    expect(body).toEqual({ "runs-on": "ubuntu-latest" });
  });

  it("refuses labels it would otherwise echo back", async () => {
    const t = convexTest(schema, modules);

    expect(
      (await runsOn(t, "profile=erainfra-4vcpu-ubuntu-2404&fallback=%3Cscript%3E")).status,
    ).toBe(400);
    expect((await runsOn(t, `profile=${"x".repeat(101)}`)).status).toBe(400);
    expect((await runsOn(t, "profile=erainfra-4vcpu-ubuntu-2404&labels=rc-linux")).status).toBe(
      400,
    );
    expect((await runsOn(t, "")).status).toBe(400);
  });

  it("keeps answering the legacy labels form from the pre-Profile machines path", async () => {
    const t = convexTest(schema, modules);
    await t.run((ctx) =>
      ctx.db.insert("machines", {
        name: "legacy",
        os: "linux",
        labels: [],
        cpus: 16,
        memoryMiB: 32_768,
        maxSlots: 4,
        usedSlots: 0,
        lastSeen: Date.now(),
        token: "legacy-token",
      }),
    );

    expect((await runsOn(t, "labels=rc-linux")).body).toEqual({
      "runs-on": ["self-hosted", "rc-linux"],
    });
  });
});

describe("router decisions", () => {
  const DAY_MS = 24 * 60 * 60_000;

  function decisions(t: Harness) {
    return t.run((ctx) => ctx.db.query("routerDecisions").collect());
  }

  it("stores each answer with its route, reason and repository", async () => {
    const t = convexTest(schema, modules);
    await registerProfile(t);
    await addReadyWorker(t, "worker-a");

    const routed = await runsOn(
      t,
      "profile=erainfra-4vcpu-ubuntu-2404&fallback=ubuntu-24.04&repo=acme/web",
    );
    expect(routed.body).toEqual({ "runs-on": "erainfra-4vcpu-ubuntu-2404" });
    const fellBack = await runsOn(t, "profile=rc-nothing&repo=acme/web");
    expect(fellBack.body).toEqual({ "runs-on": "ubuntu-latest" });
    await runsOn(t, "profile=erainfra-4vcpu-ubuntu-2404");

    const rows = (await decisions(t)).map((row) => ({
      profile: row.profile,
      answer: row.answer,
      route: row.route,
      reason: row.reason,
      repo: row.repo,
    }));
    expect(rows).toEqual([
      {
        profile: "erainfra-4vcpu-ubuntu-2404",
        answer: "erainfra-4vcpu-ubuntu-2404",
        route: "profile",
        reason: undefined,
        repo: "acme/web",
      },
      {
        profile: "rc-nothing",
        answer: "ubuntu-latest",
        route: "fallback",
        reason: "unknown-profile",
        repo: "acme/web",
      },
      {
        profile: "erainfra-4vcpu-ubuntu-2404",
        answer: "erainfra-4vcpu-ubuntu-2404",
        route: "profile",
        reason: undefined,
        repo: undefined,
      },
    ]);
  });

  it("stores the legacy labels answer", async () => {
    const t = convexTest(schema, modules);

    const { body } = await runsOn(t, "labels=rc-linux&fallback=ubuntu-24.04&repo=acme/web");
    expect(body).toEqual({ "runs-on": "ubuntu-24.04" });
    expect(await decisions(t)).toMatchObject([
      {
        labels: ["self-hosted", "rc-linux"],
        answer: "ubuntu-24.04",
        route: "fallback",
        repo: "acme/web",
      },
    ]);
  });

  it("refuses a repo that is not OWNER/NAME and stores nothing", async () => {
    const t = convexTest(schema, modules);

    for (const repo of [
      "acme",
      "acme/web/x",
      "%3Cscript%3E/web",
      "-acme/web",
      `acme/${"x".repeat(101)}`,
    ]) {
      expect((await runsOn(t, `profile=erainfra-4vcpu-ubuntu-2404&repo=${repo}`)).status).toBe(400);
    }
    expect(await decisions(t)).toEqual([]);
  });

  it("counts decisions per day, route and reason for one repository", async () => {
    const t = convexTest(schema, modules);
    const day = Date.UTC(2026, 10, 1);
    const hour = 60 * 60_000;
    await t.run(async (ctx) => {
      const rows = [
        { repo: "acme/web", createdAt: day + hour, route: "profile" as const },
        { repo: "acme/web", createdAt: day + 2 * hour, route: "profile" as const },
        {
          repo: "acme/web",
          createdAt: day + 3 * hour,
          route: "fallback" as const,
          reason: "saturated" as const,
        },
        {
          repo: "acme/web",
          createdAt: day + 25 * hour,
          route: "fallback" as const,
          reason: "paused" as const,
        },
        { repo: "acme/api", createdAt: day + hour, route: "profile" as const },
        { repo: "acme/web", createdAt: day + 49 * hour, route: "profile" as const },
      ];
      for (const row of rows) {
        await ctx.db.insert("routerDecisions", {
          profile: "erainfra-4vcpu-ubuntu-2404",
          answer: "x",
          ...row,
        });
      }
    });

    expect(
      await t.query(internal.routerDecisions.counts, {
        repo: "acme/web",
        from: day,
        to: day + 48 * hour,
      }),
    ).toEqual({
      truncated: false,
      rows: [
        { day: "2026-11-01", route: "profile", count: 2 },
        { day: "2026-11-01", route: "fallback", reason: "saturated", count: 1 },
        { day: "2026-11-02", route: "fallback", reason: "paused", count: 1 },
      ],
    });
    const all = await t.query(internal.routerDecisions.counts, { from: day, to: day + hour + 1 });
    expect(all.rows).toEqual([{ day: "2026-11-01", route: "profile", count: 2 }]);
  });

  it("purges decisions older than 90 days", async () => {
    const t = convexTest(schema, modules);
    const now = Date.now();
    await t.run(async (ctx) => {
      for (const age of [91, 89]) {
        await ctx.db.insert("routerDecisions", {
          profile: "erainfra-4vcpu-ubuntu-2404",
          answer: "erainfra-4vcpu-ubuntu-2404",
          route: "profile",
          createdAt: now - age * DAY_MS,
        });
      }
    });

    expect(await t.mutation(internal.routerDecisions.purgeExpired, {})).toBe(1);
    expect((await decisions(t)).map((row) => row.createdAt)).toEqual([now - 89 * DAY_MS]);
  });
});
