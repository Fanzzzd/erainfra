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

async function addWorker(t: Harness, name: string, maxSlots = 1, warmPool = 0) {
  await t.mutation(internal.controllerApi.registerProfile, {
    name: CONTRACT.profile,
    scaleSetName: CONTRACT.profile,
    executor: CONTRACT.executor,
    imageRelease: CONTRACT.imageRelease,
    vcpus: CONTRACT.vcpus,
    memoryMiB: CONTRACT.memoryMiB,
    warmPool,
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
    vcpus: CONTRACT.vcpus,
    memoryMiB: CONTRACT.memoryMiB,
    state: "ready",
    ...FIRECRACKER_FACTS,
    warmPool: { target: warmPool, parked: warmPool, claimed: 0 },
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

async function publishBenchmark(
  t: Harness,
  name: string,
  values: { cpu: number; network: number; disk?: number },
) {
  const measuredAt = Date.now();
  const result = await t.mutation(api.workerApi.reportBenchmark, {
    token: `token-${name}`,
    report: {
      version: 1,
      measuredAt,
      durationMs: 1_000,
      sampleSize: 1,
      cpuSha256MiBps: values.cpu,
      memoryCopyMiBps: 10_000,
      diskWriteMiBps: values.disk ?? 500,
      diskReadMiBps: values.disk ?? 500,
      diskFsyncLatencyMs: values.disk === 1 ? 100 : 5,
      packageLinkOpsPerSec: values.disk === 1 ? 1 : 5_000,
      network: [
        {
          target: "github",
          ttfbMs: values.network >= 50 ? 50 : 1_400,
          throughputMbps: values.network,
          bytes: 1_024,
        },
        {
          target: "ghcr",
          ttfbMs: values.network >= 50 ? 50 : 1_400,
          throughputMbps: values.network,
          bytes: 1_024,
        },
      ],
      errors: [],
    },
  });
  return { ...result, measuredAt };
}

describe("readiness-gated Attempt scheduling", () => {
  it("selects zero candidates after blank and partial ready reports are rejected", async () => {
    const t = convexTest(schema, modules);
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
    await t.run((ctx) =>
      ctx.db.insert("machines", {
        name: "incomplete",
        os: "linux",
        labels: [],
        maxSlots: 1,
        usedSlots: 0,
        lastSeen: Date.now(),
        token: "token-incomplete",
      }),
    );
    await t.mutation(internal.controllerApi.createAttempt, {
      ...CONTRACT,
      runnerName: "runner-incomplete",
      runnerId: 50,
      encodedJITConfig: "secret-incomplete",
    });

    for (const facts of [
      {},
      {
        ...FIRECRACKER_FACTS,
        checks: FIRECRACKER_FACTS.checks.filter((check) => check.name !== "job-network-policy"),
      },
    ]) {
      await expect(
        t.mutation(api.workerApi.reportReadiness, {
          token: "token-incomplete",
          ...CONTRACT,
          state: "ready",
          ...facts,
        }),
      ).rejects.toThrow(/Firecracker readiness evidence is incomplete/);
      expect(await t.mutation(internal.attemptScheduler.tryAssign, {})).toBe(0);
    }
  });

  it("treats an incomplete legacy ready row as not ready and surfaces the reason", async () => {
    const t = convexTest(schema, modules);
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
    const machineId = await t.run((ctx) =>
      ctx.db.insert("machines", {
        name: "legacy",
        os: "linux",
        labels: [],
        maxSlots: 1,
        usedSlots: 0,
        lastSeen: Date.now(),
        token: "token-legacy",
      }),
    );
    const checkedAt = Date.now();
    await t.run((ctx) =>
      ctx.db.insert("workerReadiness", {
        machineId,
        ...CONTRACT,
        state: "ready",
        checkedAt,
        preparedAt: checkedAt,
        boundary: "guest-kernel",
        checks: [{ name: "kvm-device", passed: true }],
      }),
    );
    await t.mutation(internal.controllerApi.createAttempt, {
      ...CONTRACT,
      runnerName: "runner-legacy",
      runnerId: 51,
      encodedJITConfig: "secret-legacy",
    });

    expect(await t.mutation(internal.attemptScheduler.tryAssign, {})).toBe(0);
    const [profile] = await t
      .withIdentity({ subject: "operator", issuer: "https://example.test" })
      .query(api.profiles.list, {});
    expect(profile?.readyWorkers).toBe(0);
    expect(profile?.workers[0]).toMatchObject({
      state: "degraded",
      lastError: expect.stringMatching(/hardware\.kvm.*storage\.snapshotter.*network\.policyHash/s),
    });

    await t.run(async (ctx) => {
      const readiness = await ctx.db.query("workerReadiness").unique();
      if (readiness === null) throw new Error("missing legacy readiness");
      await ctx.db.patch(readiness._id, {
        ...FIRECRACKER_FACTS,
        checks: FIRECRACKER_FACTS.checks.map((check) =>
          check.name === "job-network-policy" ? { ...check, passed: false } : check,
        ),
      });
    });
    expect(await t.mutation(internal.attemptScheduler.tryAssign, {})).toBe(0);
    const [contradictory] = await t
      .withIdentity({ subject: "operator", issuer: "https://example.test" })
      .query(api.profiles.list, {});
    expect(contradictory?.workers[0]?.lastError).toMatch(/checks must pass: job-network-policy/);
  });

  it("requires split evidence to match the current ready report exactly", async () => {
    const t = convexTest(schema, modules);
    const machineId = await addWorker(t, "current");
    await t.run(async (ctx) => {
      const readiness = await ctx.db
        .query("workerReadiness")
        .withIndex("by_machine_profile", (query) =>
          query.eq("machineId", machineId).eq("profile", CONTRACT.profile),
        )
        .unique();
      if (readiness === null) throw new Error("missing current readiness");
      await ctx.db.patch(readiness._id, { checkedAt: readiness.checkedAt + 1 });
    });

    await createAttempt(t, "runner-stale-evidence");
    const attempt = await t.run((ctx) =>
      ctx.db
        .query("attempts")
        .withIndex("by_runnerName", (query) => query.eq("runnerName", "runner-stale-evidence"))
        .unique(),
    );
    expect(attempt?.machineId).toBeUndefined();
    const [profile] = await t
      .withIdentity({ subject: "operator", issuer: "https://example.test" })
      .query(api.profiles.list, {});
    expect(profile?.workers[0]?.lastError).toMatch(/current readinessEvidence.*checkedAt/);
  });

  it("transfers parked capacity to matching Attempts without double-counting", async () => {
    const t = convexTest(schema, modules);
    const machineId = await addWorker(t, "warm", 2, 2);
    await createAttempt(t, "runner-a");
    await createAttempt(t, "runner-b");
    await createAttempt(t, "runner-c");

    const attempts = await t.run(async (ctx) => ctx.db.query("attempts").collect());
    expect(attempts.filter((attempt) => attempt.machineId === machineId)).toHaveLength(2);
    expect(attempts.filter((attempt) => attempt.machineId === undefined)).toHaveLength(1);
  });

  it("reserves parked slots against unrelated Profile work", async () => {
    const t = convexTest(schema, modules);
    const machineId = await addWorker(t, "warm", 2, 2);
    const other = { ...CONTRACT, profile: "rc-linux-other" };
    await t.mutation(internal.controllerApi.registerProfile, {
      name: other.profile,
      scaleSetName: other.profile,
      executor: other.executor,
      imageRelease: other.imageRelease,
      vcpus: other.vcpus,
      memoryMiB: other.memoryMiB,
      warmPool: 0,
      minRunners: 0,
      maxRunners: 4,
    });
    await t.mutation(api.workerApi.reportReadiness, {
      token: "token-warm",
      profile: other.profile,
      executor: other.executor,
      imageRelease: other.imageRelease,
      vcpus: other.vcpus,
      memoryMiB: other.memoryMiB,
      state: "ready",
      ...FIRECRACKER_FACTS,
      warmPool: { target: 0, parked: 0, claimed: 0 },
    });
    await t.mutation(internal.controllerApi.createAttempt, {
      ...other,
      runnerName: "runner-other",
      runnerId: 99,
      encodedJITConfig: "secret-other",
    });
    await t.mutation(internal.attemptScheduler.tryAssign, {});

    const attempt = await t.run(async (ctx) =>
      ctx.db
        .query("attempts")
        .withIndex("by_runnerName", (q) => q.eq("runnerName", "runner-other"))
        .unique(),
    );
    expect(attempt?.machineId).toBeUndefined();
    expect((await t.run(async (ctx) => ctx.db.get(machineId)))?.usedSlots).toBe(0);
  });
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

  it("migrates legacy machines without a slot policy to automatic capacity", async () => {
    const t = convexTest(schema, modules);
    const machineId = await t.run(async (ctx) =>
      ctx.db.insert("machines", {
        name: "legacy-mac",
        os: "mac",
        labels: [],
        maxSlots: 1,
        usedSlots: 0,
        lastSeen: Date.now(),
        token: "token-legacy-mac",
      }),
    );

    expect(
      await t.mutation(api.workerApi.reportHostFacts, {
        token: "token-legacy-mac",
        arch: "arm64",
        cpus: 16,
        memoryMiB: 48 * 1_024,
      }),
    ).toEqual({ maxSlots: 2, recommendedSlots: 2 });
    expect(await t.run(async (ctx) => ctx.db.get(machineId))).toMatchObject({
      slotPolicy: "auto",
      maxSlots: 2,
    });
  });

  it("keeps an explicit fixed capacity while still reporting its recommendation", async () => {
    const t = convexTest(schema, modules);
    const machineId = await t.run(async (ctx) =>
      ctx.db.insert("machines", {
        name: "fixed-linux",
        os: "linux",
        labels: [],
        slotPolicy: "fixed",
        maxSlots: 3,
        usedSlots: 0,
        lastSeen: Date.now(),
        token: "token-fixed-linux",
      }),
    );

    expect(
      await t.mutation(api.workerApi.reportHostFacts, {
        token: "token-fixed-linux",
        arch: "x64",
        cpus: 64,
        memoryMiB: 256 * 1_024,
      }),
    ).toEqual({ maxSlots: 3, recommendedSlots: 16 });
    expect(await t.run(async (ctx) => ctx.db.get(machineId))).toMatchObject({
      slotPolicy: "fixed",
      maxSlots: 3,
    });
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

  it("never schedules degraded capacity even when every hard contract still matches", async () => {
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
      await ctx.db.patch(readiness._id, {
        state: "degraded",
        lastError: "a recheck failed",
      });
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
    expect(await t.run(async (ctx) => ctx.db.query("attemptSecrets").collect())).toEqual([]);

    await t.mutation(api.workerApi.reportAttempt, {
      token: "token-alpha",
      attemptId: attempt._id,
      exitCode: 124,
    });
    expect((await t.run(async (ctx) => ctx.db.get(attempt._id)))?.state).toBe("failed");
    expect((await t.run(async (ctx) => ctx.db.get(machineId)))?.usedSlots).toBe(0);
  });

  it("claims one-cycle legacy inline JIT and erases it", async () => {
    const t = convexTest(schema, modules);
    await addWorker(t, "alpha");
    await createAttempt(t);
    const attempt = await t.run(async (ctx) => ctx.db.query("attempts").unique());
    const secret = await t.run(async (ctx) => ctx.db.query("attemptSecrets").unique());
    if (attempt === null || secret === null) throw new Error("missing attempt secret");
    await t.run(async (ctx) => {
      await ctx.db.delete(secret._id);
      await ctx.db.patch(attempt._id, { jitConfig: "legacy-inline-secret" });
    });

    expect(
      await t.mutation(api.workerApi.claimAttempt, {
        token: "token-alpha",
        attemptId: attempt._id,
      }),
    ).toMatchObject({ jitConfig: "legacy-inline-secret" });
    expect((await t.run(async (ctx) => ctx.db.get(attempt._id)))?.jitConfig).toBeUndefined();
  });

  it("deletes an unclaimed secret when the Worker terminally reports the Attempt", async () => {
    const t = convexTest(schema, modules);
    await addWorker(t, "alpha");
    await createAttempt(t);
    const attempt = await t.run(async (ctx) => ctx.db.query("attempts").unique());
    if (attempt === null) throw new Error("missing attempt");

    await t.mutation(api.workerApi.reportAttempt, {
      token: "token-alpha",
      attemptId: attempt._id,
      exitCode: 1,
    });
    expect(await t.run(async (ctx) => ctx.db.query("attemptSecrets").collect())).toEqual([]);
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
      runnerRequestId: "42",
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

  it("gives a completed runner time to drain before stopping its executor", async () => {
    const t = convexTest(schema, modules);
    await addWorker(t, "alpha");
    await createAttempt(t);
    const attempt = await t.run(async (ctx) => ctx.db.query("attempts").first());
    if (attempt === null) throw new Error("missing attempt");
    await t.mutation(api.workerApi.claimAttempt, {
      token: "token-alpha",
      attemptId: attempt._id,
    });
    await t.mutation(internal.controllerApi.markJobCompleted, {
      profile: CONTRACT.profile,
      runnerName: "runner-a",
      result: "succeeded",
      finishedAt: Date.now(),
    });

    expect(
      (await t.query(api.workerApi.pendingAttempts, { token: "token-alpha" })).liveAttemptIds,
    ).toContain(attempt._id);

    await t.run(async (ctx) =>
      ctx.db.patch(attempt._id, {
        finishedAt: Date.now() - 31_000,
      }),
    );
    expect(
      (await t.query(api.workerApi.pendingAttempts, { token: "token-alpha" })).liveAttemptIds,
    ).not.toContain(attempt._id);
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

  it("keeps the pre-index scheduler decision fixture byte-identical", async () => {
    const t = convexTest(schema, modules);
    const alpha = await addWorker(t, "alpha", 2);
    await addWorker(t, "beta", 2);
    await addWorker(t, "gamma", 2);
    await publishBenchmark(t, "alpha", { cpu: 100, network: 1 });
    await publishBenchmark(t, "beta", { cpu: 1_500, network: 100 });
    await t.run(async (ctx) => {
      await ctx.db.patch(alpha, { usedSlots: 1 });
      await ctx.db.insert("attempts", {
        ...CONTRACT,
        runnerName: "existing-alpha",
        runnerId: 90,
        state: "running",
        machineId: alpha,
        createdAt: Date.now() - 1_000,
      });
    });

    await createAttempt(t, "runner-a");
    await createAttempt(t, "runner-b");
    await createAttempt(t, "runner-c");

    const machines = await t.run(async (ctx) => ctx.db.query("machines").collect());
    const machineNames = new Map(machines.map((machine) => [machine._id, machine.name]));
    const decisions = (await t.run(async (ctx) => ctx.db.query("attempts").collect()))
      .filter((attempt) => attempt.runnerName.startsWith("runner-"))
      .toSorted((left, right) => left.runnerName.localeCompare(right.runnerName))
      .map((attempt) => ({
        runnerName: attempt.runnerName,
        machine: attempt.machineId === undefined ? undefined : machineNames.get(attempt.machineId),
        selectionReason: attempt.selectionReason,
      }));

    expect(decisions).toEqual([
      {
        runnerName: "runner-a",
        machine: "beta",
        selectionReason:
          "hard compatibility passed; pressure=0.000; balanced benchmark=74/100 (fresh); eligible=2",
      },
      {
        runnerName: "runner-b",
        machine: "gamma",
        selectionReason:
          "hard compatibility passed; pressure=0.000; balanced benchmark=50/100 (missing); eligible=1",
      },
      {
        runnerName: "runner-c",
        machine: "gamma",
        selectionReason:
          "hard compatibility passed; pressure=0.500; balanced benchmark=50/100 (missing); eligible=1",
      },
    ]);
  });

  it.each([
    { fitPolicy: "cpu" as const, expected: "beta" },
    { fitPolicy: "network" as const, expected: "alpha" },
  ])(
    "uses $fitPolicy score only as an equal-pressure tie-break",
    async ({ fitPolicy, expected }) => {
      const t = convexTest(schema, modules);
      const alpha = await addWorker(t, "alpha");
      const beta = await addWorker(t, "beta");
      const profile = await t.run(async (ctx) => ctx.db.query("profiles").unique());
      if (profile === null) throw new Error("missing profile");
      await t.run(async (ctx) => ctx.db.patch(profile._id, { fitPolicy }));
      await publishBenchmark(t, "alpha", { cpu: 100, network: 100 });
      await publishBenchmark(t, "beta", { cpu: 1_500, network: 1 });

      await createAttempt(t);

      const attempt = await t.run(async (ctx) => ctx.db.query("attempts").unique());
      expect(attempt?.machineId).toBe(expected === "alpha" ? alpha : beta);
      expect(attempt?.selectionReason).toContain(`${fitPolicy} benchmark=`);
      expect(attempt?.selectionReason).toContain("hard compatibility passed");
    },
  );

  it("keeps missing benchmark scores eligible with neutral, observable ranking", async () => {
    const t = convexTest(schema, modules);
    const machineId = await addWorker(t, "unmeasured");

    await createAttempt(t);

    const attempt = await t.run(async (ctx) => ctx.db.query("attempts").unique());
    expect(attempt?.machineId).toBe(machineId);
    expect(attempt?.selectionReason).toContain("benchmark=50/100 (missing)");
  });

  it("does not let a faster but busier Worker bypass resource-pressure spreading", async () => {
    const t = convexTest(schema, modules);
    const alpha = await addWorker(t, "alpha", 2);
    const beta = await addWorker(t, "beta", 2);
    await publishBenchmark(t, "alpha", { cpu: 1_500, network: 100 });
    await publishBenchmark(t, "beta", { cpu: 100, network: 1 });
    await t.run(async (ctx) => ctx.db.patch(alpha, { usedSlots: 1 }));

    await createAttempt(t);

    expect((await t.run(async (ctx) => ctx.db.query("attempts").unique()))?.machineId).toBe(beta);
  });

  it("reduces automatic capacity after a weak measured storage result", async () => {
    const t = convexTest(schema, modules);
    const machineId = await addWorker(t, "large", 16);
    await t.run(async (ctx) =>
      ctx.db.patch(machineId, {
        arch: "x64",
        cpus: 64,
        memoryMiB: 256 * 1_024,
        slotPolicy: "auto",
        resourceRecommendedSlots: 16,
        recommendedSlots: 16,
        usedSlots: 8,
      }),
    );

    const reported = await publishBenchmark(t, "large", {
      cpu: 1_500,
      network: 100,
      disk: 1,
    });
    expect(reported).toMatchObject({ maxSlots: 4, recommendedSlots: 4 });
    expect(await t.run(async (ctx) => ctx.db.get(machineId))).toMatchObject({
      resourceRecommendedSlots: 16,
      recommendedSlots: 4,
      maxSlots: 4,
      usedSlots: 8,
    });
    const [machine, evidence] = await t.run(async (ctx) =>
      Promise.all([ctx.db.get(machineId), ctx.db.query("benchmarkEvidence").unique()]),
    );
    if (evidence === null) throw new Error("missing benchmark evidence");
    expect(machine?.benchmark).toEqual({
      measuredAt: reported.measuredAt,
      scores: { cpu: 100, memory: 47, disk: 0, network: 100, balanced: 62 },
    });
    expect(evidence.benchmark).toMatchObject({
      diskWriteMiBps: 1,
      diskReadMiBps: 1,
      packageLinkOpsPerSec: 1,
    });
    await createAttempt(t);
    expect(
      (await t.run(async (ctx) => ctx.db.query("attempts").unique()))?.machineId,
    ).toBeUndefined();
  });

  it("uses a one-cycle legacy inline benchmark when host facts refresh", async () => {
    const t = convexTest(schema, modules);
    const machineId = await addWorker(t, "legacy-benchmark", 16);
    await publishBenchmark(t, "legacy-benchmark", { cpu: 1_500, network: 100, disk: 1 });
    const evidence = await t.run(async (ctx) => ctx.db.query("benchmarkEvidence").unique());
    if (evidence === null) throw new Error("missing benchmark evidence");
    await t.run(async (ctx) => {
      await ctx.db.patch(machineId, { benchmark: evidence.benchmark });
      await ctx.db.delete(evidence._id);
    });

    expect(
      await t.mutation(api.workerApi.reportHostFacts, {
        token: "token-legacy-benchmark",
        arch: "x64",
        cpus: 64,
        memoryMiB: 256 * 1_024,
      }),
    ).toEqual({ maxSlots: 4, recommendedSlots: 4 });
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
