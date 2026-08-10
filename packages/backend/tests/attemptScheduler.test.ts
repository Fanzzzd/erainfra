import { convexTest, type TestConvex } from "convex-test";
import { describe, expect, it } from "vitest";
import { api, internal } from "../convex/_generated/api";
import schema from "../convex/schema";

const modules = import.meta.glob("../convex/**/*.ts");
type Harness = TestConvex<typeof schema>;

const CONTRACT = {
  profile: "rc-linux-js",
  executor: "firecracker" as const,
  imageRelease:
    "ghcr.io/fanzzzd/runner@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  vcpus: 2,
  memoryMiB: 4096,
};

async function addWorker(t: Harness, name: string, maxSlots = 1) {
  await t.mutation(internal.controllerApi.registerProfile, {
    name: CONTRACT.profile,
    scaleSetName: CONTRACT.profile,
    executor: CONTRACT.executor,
    imageRelease: CONTRACT.imageRelease,
    vcpus: CONTRACT.vcpus,
    memoryMiB: CONTRACT.memoryMiB,
    minRunners: 0,
    maxRunners: 4,
  });
  const machineId = await t.run(async (ctx) =>
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
    state: "ready",
  });
  return machineId;
}

async function createAttempt(t: Harness, runnerName = "runner-a") {
  await t.mutation(internal.controllerApi.createAttempt, {
    ...CONTRACT,
    runnerName,
    runnerId: runnerName === "runner-a" ? 1 : 2,
    encodedJITConfig: `secret-${runnerName}`,
  });
  await t.mutation(internal.attemptScheduler.tryAssign, {});
}

describe("readiness-gated Attempt scheduling", () => {
  it("derives bounded automatic capacity from live host resources", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) =>
      ctx.db.insert("machines", {
        name: "large",
        os: "linux",
        labels: [],
        slotPolicy: "auto",
        maxSlots: 1,
        usedSlots: 0,
        lastSeen: Date.now(),
        token: "token-large",
      }),
    );
    expect(
      await t.mutation(api.workerApi.reportHostFacts, {
        token: "token-large",
        arch: "x64",
        cpus: 64,
        memoryMiB: 256 * 1024,
      }),
    ).toEqual({ maxSlots: 16, recommendedSlots: 16 });
  });

  it("assigns only an online Worker ready for the exact Image Release", async () => {
    const t = convexTest(schema, modules);
    const machineId = await addWorker(t, "alpha");
    await createAttempt(t);

    const [attempt] = await t.run(async (ctx) => ctx.db.query("attempts").collect());
    expect(attempt).toMatchObject({ machineId, state: "pending" });
    expect((await t.run(async (ctx) => ctx.db.get(machineId)))?.usedSlots).toBe(1);
  });

  it("does not use a merely online Worker with a different image", async () => {
    const t = convexTest(schema, modules);
    const machineId = await addWorker(t, "alpha");
    await t.run(async (ctx) => {
      const readiness = await ctx.db
        .query("workerReadiness")
        .withIndex("by_machine_profile", (query) =>
          query.eq("machineId", machineId).eq("profile", CONTRACT.profile),
        )
        .unique();
      if (readiness === null) throw new Error("missing readiness");
      await ctx.db.patch(readiness._id, { imageRelease: "different@sha256:" + "b".repeat(64) });
    });
    await createAttempt(t);

    const [attempt] = await t.run(async (ctx) => ctx.db.query("attempts").collect());
    expect(attempt?.machineId).toBeUndefined();
    expect((await t.run(async (ctx) => ctx.db.get(machineId)))?.usedSlots).toBe(0);
  });

  it("claims JIT once and frees capacity after executor failure", async () => {
    const t = convexTest(schema, modules);
    const machineId = await addWorker(t, "alpha");
    await createAttempt(t);
    const [attempt] = await t.run(async (ctx) => ctx.db.query("attempts").collect());
    if (attempt === undefined) throw new Error("missing attempt");

    const claimed = await t.mutation(api.workerApi.claimAttempt, {
      token: "token-alpha",
      attemptId: attempt._id,
    });
    expect(claimed).toMatchObject({
      profile: CONTRACT.profile,
      executor: CONTRACT.executor,
      jitConfig: "secret-runner-a",
    });
    expect(
      await t.mutation(api.workerApi.claimAttempt, {
        token: "token-alpha",
        attemptId: attempt._id,
      }),
    ).toBeNull();
    expect((await t.run(async (ctx) => ctx.db.get(attempt._id)))?.jitConfig).toBeUndefined();

    await t.mutation(api.workerApi.reportAttempt, {
      token: "token-alpha",
      attemptId: attempt._id,
      exitCode: 124,
    });
    expect((await t.run(async (ctx) => ctx.db.get(attempt._id)))?.state).toBe("failed");
    expect((await t.run(async (ctx) => ctx.db.get(machineId)))?.usedSlots).toBe(0);
  });

  it("settles a clean executor exit even if GitHub's completion message is lost", async () => {
    const t = convexTest(schema, modules);
    const machineId = await addWorker(t, "alpha");
    await createAttempt(t);
    const attempt = await t.run(async (ctx) => ctx.db.query("attempts").first());
    if (attempt === null) throw new Error("missing attempt");
    await t.mutation(api.workerApi.claimAttempt, {
      token: "token-alpha",
      attemptId: attempt._id,
    });

    await t.mutation(api.workerApi.reportAttempt, {
      token: "token-alpha",
      attemptId: attempt._id,
      exitCode: 0,
    });

    expect(await t.run(async (ctx) => ctx.db.get(attempt._id))).toMatchObject({
      state: "completed",
      executorExitCode: 0,
    });
    expect((await t.run(async (ctx) => ctx.db.get(machineId)))?.usedSlots).toBe(0);
  });

  it("lets a later GitHub completion enrich an executor-settled Attempt", async () => {
    const t = convexTest(schema, modules);
    await addWorker(t, "alpha");
    await createAttempt(t);
    const attempt = await t.run(async (ctx) => ctx.db.query("attempts").first());
    if (attempt === null) throw new Error("missing attempt");
    await t.mutation(api.workerApi.claimAttempt, {
      token: "token-alpha",
      attemptId: attempt._id,
    });
    await t.mutation(api.workerApi.reportAttempt, {
      token: "token-alpha",
      attemptId: attempt._id,
      exitCode: 0,
    });

    await t.mutation(internal.controllerApi.markJobCompleted, {
      profile: CONTRACT.profile,
      runnerName: "runner-a",
      runnerRequestId: 42,
      jobId: "job-42",
      result: "Succeeded",
      finishedAt: Date.now(),
    });

    expect(await t.run(async (ctx) => ctx.db.get(attempt._id))).toMatchObject({
      state: "completed",
      executorExitCode: 0,
      result: "Succeeded",
      jobId: "job-42",
    });
  });

  it("spreads simultaneous Attempts before filling a Worker", async () => {
    const t = convexTest(schema, modules);
    const alpha = await addWorker(t, "alpha", 2);
    const beta = await addWorker(t, "beta", 2);
    await createAttempt(t, "runner-a");
    await createAttempt(t, "runner-b");

    const attempts = await t.run(async (ctx) => ctx.db.query("attempts").collect());
    expect(new Set(attempts.map((attempt) => attempt.machineId))).toEqual(new Set([alpha, beta]));
  });

  it("does not overcommit the host resource envelope even when slots remain", async () => {
    const t = convexTest(schema, modules);
    const machineId = await addWorker(t, "small", 4);
    await t.run(async (ctx) =>
      ctx.db.patch(machineId, {
        cpus: 2,
        memoryMiB: 4096,
      }),
    );
    await createAttempt(t, "runner-a");
    await createAttempt(t, "runner-b");

    const attempts = await t.run(async (ctx) => ctx.db.query("attempts").collect());
    expect(attempts.filter((attempt) => attempt.machineId === machineId)).toHaveLength(1);
    expect(attempts.filter((attempt) => attempt.machineId === undefined)).toHaveLength(1);
  });

  it("keeps scale-set capacity reserved across the minute reconciliation", async () => {
    const t = convexTest(schema, modules);
    const machineId = await addWorker(t, "alpha");
    await createAttempt(t);

    await t.mutation(internal.reconcile.run, {});

    expect((await t.run(async (ctx) => ctx.db.get(machineId)))?.usedSlots).toBe(1);
    expect((await t.run(async (ctx) => ctx.db.query("attempts").first()))?.machineId).toBe(
      machineId,
    );
  });

  it("does not assign from paused Profiles or stale readiness", async () => {
    const t = convexTest(schema, modules);
    const machineId = await addWorker(t, "alpha");
    const profile = await t.run(async (ctx) => ctx.db.query("profiles").first());
    if (profile === null) throw new Error("missing Profile");
    await t.run(async (ctx) => ctx.db.patch(profile._id, { state: "paused" }));
    await t.run(async (ctx) =>
      ctx.db.insert("attempts", {
        ...CONTRACT,
        runnerName: "runner-paused",
        runnerId: 90,
        state: "pending",
        jitConfig: "secret",
        createdAt: Date.now(),
      }),
    );
    await t.mutation(internal.attemptScheduler.tryAssign, {});
    let [attempt] = await t.run(async (ctx) => ctx.db.query("attempts").collect());
    expect(attempt?.machineId).toBeUndefined();

    await t.run(async (ctx) => ctx.db.patch(profile._id, { state: "active" }));
    const readiness = await t.run(async (ctx) =>
      ctx.db
        .query("workerReadiness")
        .withIndex("by_machine_profile", (query) =>
          query.eq("machineId", machineId).eq("profile", CONTRACT.profile),
        )
        .unique(),
    );
    if (readiness === null) throw new Error("missing readiness");
    await t.run(async (ctx) =>
      ctx.db.patch(readiness._id, { checkedAt: Date.now() - 13 * 60 * 60_000 }),
    );
    await t.mutation(internal.attemptScheduler.tryAssign, {});
    [attempt] = await t.run(async (ctx) => ctx.db.query("attempts").collect());
    expect(attempt?.machineId).toBeUndefined();
  });
});
