import { convexTest, type TestConvex } from "convex-test";
import { describe, expect, it } from "vitest";
import { api, internal } from "../convex/_generated/api";
import schema from "../convex/schema";

const modules = import.meta.glob("../convex/**/*.ts");
type Harness = TestConvex<typeof schema>;

const CONTRACT = {
  profile: "rc-linux-js",
  executor: "firecracker" as const,
  imageRelease: `ghcr.io/fanzzzd/runner@sha256:${"a".repeat(64)}`,
  vcpus: 2,
  memoryMiB: 4096,
};

const FIRECRACKER_FACTS = {
  isolation: "firecracker-microvm",
  boundary: "guest-kernel" as const,
  checks: [
    "firecracker-binary",
    "guest-kernel-image",
    "guest-kernel-arguments",
    "kvm-device",
    "cni-plugins",
    "cni-network-configuration",
    "job-network-policy",
    "containerd-snapshotter",
    "cni-address-reservations",
    "snapshot-storage-headroom",
    "cache-isolation",
    "image-release",
    "warm-pool",
  ].map((name) => ({ name, passed: true })),
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

    const { status, response, body } = await runsOn(t, "profile=rc-linux-js&fallback=ubuntu-24.04");
    expect(status).toBe(200);
    expect(body).toEqual({ "runs-on": "rc-linux-js" });
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("answers the caller's fallback label when the Profile has no ready Worker", async () => {
    const t = convexTest(schema, modules);
    await registerProfile(t);

    const { status, body } = await runsOn(t, "profile=rc-linux-js&fallback=ubuntu-24.04");
    expect(status).toBe(200);
    expect(body).toEqual({ "runs-on": "ubuntu-24.04" });
  });

  it("answers the fallback when the Profile is saturated", async () => {
    const t = convexTest(schema, modules);
    await registerProfile(t);
    await addReadyWorker(t, "worker-a", 1);
    const attempt = await createAttempt(t);
    await t.run((ctx) => ctx.db.patch(attempt._id, { state: "running" }));

    const { body } = await runsOn(t, "profile=rc-linux-js&fallback=ubuntu-24.04");
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

    expect((await runsOn(t, "profile=rc-linux-js&fallback=%3Cscript%3E")).status).toBe(400);
    expect((await runsOn(t, `profile=${"x".repeat(101)}`)).status).toBe(400);
    expect((await runsOn(t, "profile=rc-linux-js&labels=rc-linux")).status).toBe(400);
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
