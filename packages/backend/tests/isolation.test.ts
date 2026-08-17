import { convexTest, type TestConvex } from "convex-test";
import { describe, expect, it } from "vitest";
import { api, internal } from "../convex/_generated/api";
import {
  assertReadinessContract,
  EXECUTOR_BOUNDARY,
  hasSnapshotHeadroom,
  isTrustedOnly,
  SNAPSHOT_RESERVE_MIB,
} from "../convex/isolation.ts";
import schema from "../convex/schema";

const modules = import.meta.glob("../convex/**/*.ts");
type Harness = TestConvex<typeof schema>;

const IMAGE =
  "ghcr.io/fanzzzd/runner@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

const FIRECRACKER_CHECKS = [
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
].map((name) => ({ name, passed: true }));

const FIRECRACKER_FACTS = {
  isolation: "firecracker-microvm",
  boundary: "guest-kernel" as const,
  checks: FIRECRACKER_CHECKS,
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

describe("EXECUTOR_BOUNDARY", () => {
  it("never claims a guest kernel for a shared-kernel executor", () => {
    expect(EXECUTOR_BOUNDARY.docker).toBe("shared-kernel");
    expect(EXECUTOR_BOUNDARY.firecracker).toBe("guest-kernel");
    expect(EXECUTOR_BOUNDARY.tart).toBe("guest-kernel");
    expect(isTrustedOnly("docker")).toBe(true);
    expect(isTrustedOnly("firecracker")).toBe(false);
  });
});

describe("assertReadinessContract", () => {
  it("accepts a self-consistent ready report", () => {
    expect(() => assertReadinessContract("ready", "firecracker", FIRECRACKER_FACTS)).not.toThrow();
  });

  it("does not constrain a Worker that is not claiming readiness", () => {
    expect(() =>
      assertReadinessContract("failed", "firecracker", {
        ...FIRECRACKER_FACTS,
        checks: [{ name: "kvm-device", passed: false, detail: "no /dev/kvm" }],
      }),
    ).not.toThrow();
  });

  it("does not broaden Docker's ready-report requirements", () => {
    expect(() => assertReadinessContract("ready", "docker", {})).not.toThrow();
  });

  it("rejects readiness alongside a failing check", () => {
    expect(() =>
      assertReadinessContract("ready", "firecracker", {
        ...FIRECRACKER_FACTS,
        checks: [
          { name: "kvm-device", passed: true },
          { name: "job-network-policy", passed: false, detail: "east-west drop removed" },
        ],
      }),
    ).toThrow(/job-network-policy/);
  });

  it("rejects a boundary the executor cannot provide", () => {
    expect(() =>
      assertReadinessContract("ready", "docker", {
        ...FIRECRACKER_FACTS,
        isolation: "docker-container",
        boundary: "guest-kernel",
      }),
    ).toThrow(/shared-kernel/);
  });

  it("rejects a Worker that shares writable storage between Jobs", () => {
    expect(() =>
      assertReadinessContract("ready", "docker", {
        isolation: "docker-container",
        boundary: "shared-kernel",
        checks: [{ name: "docker-daemon", passed: true }],
        cacheScope: "profile-wide-pnpm-volume",
        cacheSharedWritable: true,
      }),
    ).toThrow(/cross-job/);
  });

  it("rejects an isolation claim with no evidence behind it", () => {
    expect(() =>
      assertReadinessContract("ready", "firecracker", {
        isolation: "firecracker-microvm",
        boundary: "guest-kernel",
        checks: [],
      }),
    ).toThrow(/report its checks/);
  });

  it("rejects blank or partial Firecracker readiness evidence", () => {
    expect(() => assertReadinessContract("ready", "firecracker", {})).toThrow(
      /guest-kernel.*hardware\.kvm.*devmapper.*network\.policyHash.*required checks/s,
    );
    expect(() =>
      assertReadinessContract("ready", "firecracker", {
        ...FIRECRACKER_FACTS,
        hardware: { kvm: false },
        network: { policyName: "runner-center", policyHash: "sha256:not-a-digest" },
      }),
    ).toThrow(/hardware\.kvm.*network\.policyHash/s);
  });
});

describe("hasSnapshotHeadroom", () => {
  it("admits an Attempt the thin-pool can still grow for", () => {
    expect(hasSnapshotHeadroom({ poolFreeMiB: SNAPSHOT_RESERVE_MIB * 3 }, 0)).toBe(true);
    expect(hasSnapshotHeadroom({ poolFreeMiB: SNAPSHOT_RESERVE_MIB * 3 }, 2)).toBe(true);
  });

  it("stops scheduling before the pool runs out mid-Job", () => {
    expect(hasSnapshotHeadroom({ poolFreeMiB: SNAPSHOT_RESERVE_MIB * 3 }, 3)).toBe(false);
    expect(hasSnapshotHeadroom({ poolFreeMiB: 512 }, 0)).toBe(false);
  });

  it("does not invent a constraint for a Worker with no thin-pool", () => {
    // Docker and Tart Profiles have no devmapper pool, and an older Agent
    // reports none at all. Neither may be locked out of scheduling.
    expect(hasSnapshotHeadroom(undefined, 8)).toBe(true);
    expect(hasSnapshotHeadroom({}, 8)).toBe(true);
  });
});

async function worker(t: Harness, token: string) {
  await t.mutation(internal.controllerApi.registerProfile, {
    name: "rc-linux-js",
    scaleSetName: "rc-linux-js",
    executor: "firecracker",
    imageRelease: IMAGE,
    vcpus: 2,
    memoryMiB: 4_096,
    minRunners: 0,
    maxRunners: 4,
  });
  await t.run(async (ctx) =>
    ctx.db.insert("machines", {
      name: "worker-a",
      os: "linux",
      labels: [],
      maxSlots: 1,
      usedSlots: 0,
      lastSeen: Date.now(),
      token,
    }),
  );
}

describe("workerApi.reportReadiness", () => {
  it("stores the isolation evidence a Worker proved", async () => {
    const t = convexTest(schema, modules);
    await worker(t, "token-a");
    await t.mutation(api.workerApi.reportReadiness, {
      token: "token-a",
      profile: "rc-linux-js",
      executor: "firecracker",
      imageRelease: IMAGE,
      state: "ready",
      vcpus: 2,
      memoryMiB: 4_096,
      ...FIRECRACKER_FACTS,
      hardware: { arch: "amd64", cpus: 64, memoryMiB: 257_000, kvm: true, virtualization: "vmx" },
    });

    const [row, evidence] = await t.run(async (ctx) =>
      Promise.all([
        ctx.db.query("workerReadiness").unique(),
        ctx.db.query("readinessEvidence").unique(),
      ]),
    );
    expect(row?.boundary).toBeUndefined();
    expect(row?.storage).toEqual({ poolTotalMiB: 51_200, poolFreeMiB: 40_960 });
    expect(evidence?.boundary).toBe("guest-kernel");
    expect(evidence?.cacheSharedWritable).toBe(false);
    expect(evidence?.hardware?.kvm).toBe(true);
    expect(evidence?.network?.subnet).toBe("10.241.0.0/16");
    expect(evidence?.network?.policyHash).toBe(`sha256:${"b".repeat(64)}`);
    expect(evidence?.checks?.map((check) => check.name)).toContain("job-network-policy");
  });

  it("refuses readiness whose own checks failed", async () => {
    const t = convexTest(schema, modules);
    await worker(t, "token-b");
    await expect(
      t.mutation(api.workerApi.reportReadiness, {
        token: "token-b",
        profile: "rc-linux-js",
        executor: "firecracker",
        imageRelease: IMAGE,
        state: "ready",
        vcpus: 2,
        memoryMiB: 4_096,
        ...FIRECRACKER_FACTS,
        checks: [{ name: "job-network-policy", passed: false, detail: "table missing" }],
      }),
    ).rejects.toThrow(/job-network-policy/);

    const row = await t.run(async (ctx) => ctx.db.query("workerReadiness").unique());
    expect(row).toBeNull();
  });

  it("stops scheduling onto a Worker whose thin-pool is nearly full", async () => {
    const t = convexTest(schema, modules);
    await worker(t, "token-d");
    await t.mutation(api.workerApi.reportHostFacts, {
      token: "token-d",
      arch: "amd64",
      cpus: 64,
      memoryMiB: 257_000,
    });

    async function assignWith(poolFreeMiB: number) {
      await t.mutation(api.workerApi.reportReadiness, {
        token: "token-d",
        profile: "rc-linux-js",
        executor: "firecracker",
        imageRelease: IMAGE,
        state: "ready",
        vcpus: 2,
        memoryMiB: 4_096,
        ...FIRECRACKER_FACTS,
        storage: { ...FIRECRACKER_FACTS.storage, poolFreeMiB },
      });
      return t.mutation(internal.attemptScheduler.tryAssign, {});
    }

    await t.mutation(internal.controllerApi.createAttempt, {
      profile: "rc-linux-js",
      executor: "firecracker",
      imageRelease: IMAGE,
      vcpus: 2,
      memoryMiB: 4_096,
      runnerName: "runner-full-pool",
      runnerId: 1,
      encodedJITConfig: "jit",
    });

    // A pool with less headroom than one Attempt can grow into is not capacity.
    expect(await assignWith(1_024)).toBe(0);
    expect(await assignWith(SNAPSHOT_RESERVE_MIB * 4)).toBe(1);
  });

  it("rejects a blank current Firecracker report at the write boundary", async () => {
    const t = convexTest(schema, modules);
    await worker(t, "token-c");
    await expect(
      t.mutation(api.workerApi.reportReadiness, {
        token: "token-c",
        profile: "rc-linux-js",
        executor: "firecracker",
        imageRelease: IMAGE,
        vcpus: 2,
        memoryMiB: 4_096,
        state: "ready",
      }),
    ).rejects.toThrow(/Firecracker readiness evidence is incomplete/);
    const row = await t.run(async (ctx) => ctx.db.query("workerReadiness").unique());
    expect(row).toBeNull();
  });

  it("serves one-cycle legacy evidence and compacts it on the next report", async () => {
    const t = convexTest(schema, modules);
    await worker(t, "token-legacy");
    const machine = await t.run(async (ctx) => ctx.db.query("machines").unique());
    if (machine === null) throw new Error("missing machine");
    const checkedAt = Date.now() - 1_000;
    await t.run(async (ctx) =>
      ctx.db.insert("workerReadiness", {
        machineId: machine._id,
        profile: "rc-linux-js",
        executor: "firecracker",
        imageRelease: IMAGE,
        state: "ready",
        checkedAt,
        preparedAt: checkedAt,
        statusDetail: "legacy detail",
        boundary: "guest-kernel",
        checks: [{ name: "kvm-device", passed: true }],
        storage: { snapshotter: "devmapper", poolFreeMiB: 32_768 },
      }),
    );

    const [legacyProfile] = await t
      .withIdentity({ subject: "operator" })
      .query(api.profiles.list, {});
    expect(legacyProfile?.workers[0]).toMatchObject({
      statusDetail: "legacy detail",
      boundary: "guest-kernel",
      storage: { snapshotter: "devmapper", poolFreeMiB: 32_768 },
    });

    await t.mutation(api.workerApi.reportReadiness, {
      token: "token-legacy",
      profile: "rc-linux-js",
      executor: "firecracker",
      imageRelease: IMAGE,
      state: "ready",
      vcpus: 2,
      memoryMiB: 4_096,
      statusDetail: "new evidence detail",
      ...FIRECRACKER_FACTS,
      storage: { ...FIRECRACKER_FACTS.storage, poolFreeMiB: 24_576 },
    });
    const [hot, evidence] = await t.run(async (ctx) =>
      Promise.all([
        ctx.db.query("workerReadiness").unique(),
        ctx.db.query("readinessEvidence").unique(),
      ]),
    );
    expect(hot).toMatchObject({ storage: { poolFreeMiB: 24_576 } });
    expect(hot?.statusDetail).toBeUndefined();
    expect(hot?.boundary).toBeUndefined();
    expect(evidence).toMatchObject({
      statusDetail: "new evidence detail",
      boundary: "guest-kernel",
      storage: { snapshotter: "devmapper", poolFreeMiB: 24_576 },
    });
  });

  it("distinguishes a first failure from a regression of previously ready capacity", async () => {
    const t = convexTest(schema, modules);
    await worker(t, "token-state");
    const contract = {
      token: "token-state",
      profile: "rc-linux-js",
      executor: "firecracker" as const,
      imageRelease: IMAGE,
    };

    expect(
      await t.mutation(api.workerApi.reportReadiness, {
        ...contract,
        state: "failed",
        error: "KVM is unavailable",
        checks: [{ name: "kvm-device", passed: false, detail: "no /dev/kvm" }],
      }),
    ).toEqual({ state: "failed" });
    let row = await t.run(async (ctx) => ctx.db.query("workerReadiness").unique());
    expect(row?.preparedAt).toBeUndefined();

    expect(
      await t.mutation(api.workerApi.reportReadiness, {
        ...contract,
        state: "ready",
        vcpus: 2,
        memoryMiB: 4_096,
        statusDetail: "all checks passed",
        ...FIRECRACKER_FACTS,
      }),
    ).toEqual({ state: "ready" });
    row = await t.run(async (ctx) => ctx.db.query("workerReadiness").unique());
    const preparedAt = row?.preparedAt;
    expect(preparedAt).toEqual(expect.any(Number));

    await t.mutation(api.workerApi.reportReadiness, {
      ...contract,
      state: "preparing",
      statusDetail: "rechecking the immutable image",
    });
    expect(
      await t.mutation(api.workerApi.reportReadiness, {
        ...contract,
        state: "failed",
        statusDetail: "retrying in five minutes",
        error: "network policy changed",
        checks: [{ name: "job-network-policy", passed: false, detail: "table changed" }],
      }),
    ).toEqual({ state: "degraded" });
    row = await t.run(async (ctx) => ctx.db.query("workerReadiness").unique());
    const evidence = await t.run(async (ctx) => ctx.db.query("readinessEvidence").unique());
    expect(row).toMatchObject({
      state: "degraded",
      preparedAt,
    });
    expect(evidence).toMatchObject({
      statusDetail: "retrying in five minutes",
      lastError: "network policy changed",
    });
  });

  it("recovers degraded capacity only after all checks pass again", async () => {
    const t = convexTest(schema, modules);
    await worker(t, "token-recovery");
    const contract = {
      token: "token-recovery",
      profile: "rc-linux-js",
      executor: "firecracker" as const,
      imageRelease: IMAGE,
    };
    await t.mutation(api.workerApi.reportReadiness, {
      ...contract,
      state: "ready",
      vcpus: 2,
      memoryMiB: 4_096,
      ...FIRECRACKER_FACTS,
    });
    await t.mutation(api.workerApi.reportReadiness, {
      ...contract,
      state: "failed",
      error: "thin-pool pressure",
      checks: [{ name: "snapshot-storage-headroom", passed: false }],
    });

    expect(
      await t.mutation(api.workerApi.reportReadiness, {
        ...contract,
        state: "ready",
        vcpus: 2,
        memoryMiB: 4_096,
        statusDetail: "capacity restored",
        ...FIRECRACKER_FACTS,
      }),
    ).toEqual({ state: "ready" });
    const [row, evidence] = await t.run(async (ctx) =>
      Promise.all([
        ctx.db.query("workerReadiness").unique(),
        ctx.db.query("readinessEvidence").unique(),
      ]),
    );
    expect(row).toMatchObject({ state: "ready" });
    expect(evidence).toMatchObject({ statusDetail: "capacity restored" });
    expect(evidence?.lastError).toBeUndefined();
  });
});
