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

const FIRECRACKER_FACTS = {
  isolation: "firecracker-microvm",
  boundary: "guest-kernel" as const,
  checks: [
    { name: "kvm-device", passed: true },
    { name: "job-network-policy", passed: true },
  ],
  cacheScope: "immutable-image",
  cacheSharedWritable: false,
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
      ...FIRECRACKER_FACTS,
      hardware: { arch: "amd64", cpus: 64, memoryMiB: 257_000, kvm: true, virtualization: "vmx" },
      storage: { snapshotter: "devmapper", poolTotalMiB: 51_200, poolFreeMiB: 40_960 },
      network: { policyName: "runner-center", subnet: "10.241.0.0/16", egressMode: "public" },
    });

    const row = await t.run(async (ctx) => ctx.db.query("workerReadiness").unique());
    expect(row?.boundary).toBe("guest-kernel");
    expect(row?.cacheSharedWritable).toBe(false);
    expect(row?.hardware?.kvm).toBe(true);
    expect(row?.network?.subnet).toBe("10.241.0.0/16");
    expect(row?.checks?.map((check) => check.name)).toContain("job-network-policy");
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
        ...FIRECRACKER_FACTS,
        storage: { snapshotter: "devmapper", poolTotalMiB: 51_200, poolFreeMiB },
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

  it("keeps accepting Workers from a deployment that reports no evidence yet", async () => {
    const t = convexTest(schema, modules);
    await worker(t, "token-c");
    await t.mutation(api.workerApi.reportReadiness, {
      token: "token-c",
      profile: "rc-linux-js",
      executor: "firecracker",
      imageRelease: IMAGE,
      state: "ready",
    });
    const row = await t.run(async (ctx) => ctx.db.query("workerReadiness").unique());
    expect(row?.state).toBe("ready");
    expect(row?.boundary).toBeUndefined();
  });
});
