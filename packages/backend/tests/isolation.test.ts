import { readFileSync } from "node:fs";

import { convexTest, type TestConvex } from "convex-test";
import { describe, expect, it } from "vitest";

import { api, internal } from "../convex/_generated/api";
import { PUBLIC_EGRESS } from "../convex/egress.ts";
import {
  assertReadinessContract,
  EXECUTOR_BOUNDARY,
  FIRECRACKER_REQUIRED_CHECKS,
  hasSnapshotHeadroomForGuests,
  isTrustedOnly,
  LEGACY_POOL_RESERVE_MIB,
  PLACEMENT_STORAGE_FIELDS,
} from "../convex/isolation.ts";
import schema from "../convex/schema";

const modules = import.meta.glob("../convex/**/*.ts");
type Harness = TestConvex<typeof schema>;

const IMAGE =
  "ghcr.io/fanzzzd/runner@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

const FIRECRACKER_CHECKS = [...FIRECRACKER_REQUIRED_CHECKS].map((name) => ({ name, passed: true }));

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

function assertPublicContract(
  ...args: [
    Parameters<typeof assertReadinessContract>[0],
    Parameters<typeof assertReadinessContract>[1],
    Parameters<typeof assertReadinessContract>[2],
  ]
) {
  assertReadinessContract(...args, PUBLIC_EGRESS);
}

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
    expect(() => assertPublicContract("ready", "firecracker", FIRECRACKER_FACTS)).not.toThrow();
  });

  it("does not constrain a Worker that is not claiming readiness", () => {
    expect(() =>
      assertPublicContract("failed", "firecracker", {
        ...FIRECRACKER_FACTS,
        checks: [{ name: "kvm-device", passed: false, detail: "no /dev/kvm" }],
      }),
    ).not.toThrow();
  });

  it("does not broaden Docker's ready-report requirements", () => {
    expect(() => assertPublicContract("ready", "docker", {})).not.toThrow();
  });

  it("rejects readiness alongside a failing check", () => {
    expect(() =>
      assertPublicContract("ready", "firecracker", {
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
      assertPublicContract("ready", "docker", {
        ...FIRECRACKER_FACTS,
        isolation: "docker-container",
        boundary: "guest-kernel",
      }),
    ).toThrow(/shared-kernel/);
  });

  it("rejects a Worker that shares writable storage between Jobs", () => {
    expect(() =>
      assertPublicContract("ready", "docker", {
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
      assertPublicContract("ready", "firecracker", {
        isolation: "firecracker-microvm",
        boundary: "guest-kernel",
        checks: [],
      }),
    ).toThrow(/report its checks/);
  });

  it("rejects blank or partial Firecracker readiness evidence", () => {
    expect(() => assertPublicContract("ready", "firecracker", {})).toThrow(
      /guest-kernel.*hardware\.kvm.*devmapper.*network\.policyHash.*required checks/s,
    );
    expect(() =>
      assertPublicContract("ready", "firecracker", {
        ...FIRECRACKER_FACTS,
        hardware: { kvm: false },
        network: { policyName: "runner-center", policyHash: "sha256:not-a-digest" },
      }),
    ).toThrow(/hardware\.kvm.*network\.policyHash/s);
  });
});

describe("hasSnapshotHeadroomForGuests", () => {
  it("admits guests the thin-pool can still grow for", () => {
    expect(hasSnapshotHeadroomForGuests({ poolFreeMiB: LEGACY_POOL_RESERVE_MIB * 3 }, 1)).toBe(
      true,
    );
    expect(hasSnapshotHeadroomForGuests({ poolFreeMiB: LEGACY_POOL_RESERVE_MIB * 3 }, 3)).toBe(
      true,
    );
  });

  it("stops scheduling before the pool runs out mid-Job", () => {
    expect(hasSnapshotHeadroomForGuests({ poolFreeMiB: LEGACY_POOL_RESERVE_MIB * 3 }, 4)).toBe(
      false,
    );
    expect(hasSnapshotHeadroomForGuests({ poolFreeMiB: 512 }, 1)).toBe(false);
  });

  it("reserves what the Worker reports it enforces", () => {
    // RC_MIN_POOL_FREE_MIB on the Worker is the only setting: placement follows it both ways.
    expect(hasSnapshotHeadroomForGuests({ poolFreeMiB: 4_096, poolReserveMiB: 2_048 }, 2)).toBe(
      true,
    );
    expect(hasSnapshotHeadroomForGuests({ poolFreeMiB: 40_960, poolReserveMiB: 16_384 }, 3)).toBe(
      false,
    );
    expect(hasSnapshotHeadroomForGuests({ poolFreeMiB: 1, poolReserveMiB: 0 }, 8)).toBe(true);
  });

  it("does not invent a constraint for a Worker with no thin-pool", () => {
    // Docker and Tart Profiles have no devmapper pool, and an older Action Runner Agent
    // reports none at all. Neither may be locked out of scheduling.
    expect(hasSnapshotHeadroomForGuests(undefined, 8)).toBe(true);
    expect(hasSnapshotHeadroomForGuests({}, 8)).toBe(true);
  });

  it("does not charge a guest twice for the reserve it already wrote", () => {
    // poolFreeMiB already lacks what guests had written when the Worker measured it. Those
    // guests spent that part of their reserve, so only the rest is still owed.
    const reserve = 8_192;
    const storage = { poolFreeMiB: reserve * 2, poolReserveMiB: reserve };
    expect(hasSnapshotHeadroomForGuests({ ...storage, poolReserveUsedMiB: reserve }, 3)).toBe(true);
    expect(hasSnapshotHeadroomForGuests({ ...storage, poolReserveUsedMiB: reserve }, 4)).toBe(
      false,
    );
  });

  it("still owes a guest live at the sample the reserve it has not written", () => {
    // A guest that had written nothing yet can still grow by a full reserve. Counting only
    // guests started after the sample would admit a second guest here and fill the pool.
    const reserve = 8_192;
    const storage = { poolFreeMiB: reserve * 1.5, poolReserveMiB: reserve, poolReserveUsedMiB: 0 };
    expect(hasSnapshotHeadroomForGuests(storage, 2)).toBe(false);
  });

  it("reads only the storage facts the hot readiness row carries", () => {
    const read = new Set<string>();
    const evidence = new Proxy(
      { ...FIRECRACKER_FACTS.storage, poolReserveMiB: 8_192, poolReserveUsedMiB: 0 },
      {
        get(target, key, receiver) {
          if (typeof key === "string") read.add(key);
          return Reflect.get(target, key, receiver);
        },
      },
    );
    hasSnapshotHeadroomForGuests(evidence, 2);
    expect(read.size).toBeGreaterThan(0);
    // A fact placement needs belongs in PLACEMENT_STORAGE_FIELDS, which reportReadiness copies
    // onto the hot row. Read from anywhere else, it is undefined on that row and silently ignored.
    expect([...read].filter((key) => !(key in PLACEMENT_STORAGE_FIELDS))).toEqual([]);
  });
});

async function worker(t: Harness, token: string) {
  await t.mutation(internal.controllerApi.registerProfile, {
    name: "erainfra-4vcpu-ubuntu-2404",
    scaleSetName: "erainfra-4vcpu-ubuntu-2404",
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
      profile: "erainfra-4vcpu-ubuntu-2404",
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
    expect(row).not.toHaveProperty("boundary");
    expect(row?.storage).toEqual({ poolTotalMiB: 51_200, poolFreeMiB: 40_960 });
    expect(evidence?.boundary).toBe("guest-kernel");
    expect(evidence?.cacheSharedWritable).toBe(false);
    expect(evidence?.hardware?.kvm).toBe(true);
    expect(evidence?.network?.subnet).toBe("10.241.0.0/16");
    expect(evidence?.network?.policyHash).toBe(`sha256:${"b".repeat(64)}`);
    expect(evidence?.checks?.map((check) => check.name)).toContain("job-network-policy");
  });

  it("copies every storage fact placement reads onto the hot row", async () => {
    const t = convexTest(schema, modules);
    await worker(t, "token-p");
    // Every placement field gets a distinct value, so a field left out of the copy or swapped
    // with another fails here.
    const placement = Object.fromEntries(
      Object.keys(PLACEMENT_STORAGE_FIELDS).map((key, index) => [key, 1_024 * (index + 1)]),
    );
    const storage = { ...FIRECRACKER_FACTS.storage, ...placement, poolTotalMiB: 409_600 };
    await t.mutation(api.workerApi.reportReadiness, {
      token: "token-p",
      profile: "erainfra-4vcpu-ubuntu-2404",
      executor: "firecracker",
      imageRelease: IMAGE,
      state: "ready",
      vcpus: 2,
      memoryMiB: 4_096,
      ...FIRECRACKER_FACTS,
      storage,
    });

    const row = await t.run(async (ctx) => ctx.db.query("workerReadiness").unique());
    expect(row?.storage).toEqual({ ...placement, poolTotalMiB: 409_600 });
  });

  it("refuses readiness whose own checks failed", async () => {
    const t = convexTest(schema, modules);
    await worker(t, "token-b");
    await expect(
      t.mutation(api.workerApi.reportReadiness, {
        token: "token-b",
        profile: "erainfra-4vcpu-ubuntu-2404",
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
        profile: "erainfra-4vcpu-ubuntu-2404",
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
      profile: "erainfra-4vcpu-ubuntu-2404",
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
    expect(await assignWith(LEGACY_POOL_RESERVE_MIB * 4)).toBe(1);
  });

  it("places against the pool reserve the runtime reports", async () => {
    // The storage a default Worker reports, written by the runtime's own test
    // (apps/runtime/internal/firecracker/storage_test.go).
    const reported = JSON.parse(
      readFileSync(
        new URL(
          "../../../apps/runtime/internal/firecracker/testdata/storage.golden.json",
          import.meta.url,
        ),
        "utf8",
      ),
    ) as typeof FIRECRACKER_FACTS.storage & { poolReserveMiB: number; poolReserveUsedMiB: number };
    const t = convexTest(schema, modules);
    await worker(t, "token-r");
    await t.mutation(api.workerApi.reportHostFacts, {
      token: "token-r",
      arch: "amd64",
      cpus: 64,
      memoryMiB: 257_000,
    });

    async function assignWith(poolReserveMiB: number) {
      await t.mutation(api.workerApi.reportReadiness, {
        token: "token-r",
        profile: "erainfra-4vcpu-ubuntu-2404",
        executor: "firecracker",
        imageRelease: IMAGE,
        state: "ready",
        vcpus: 2,
        memoryMiB: 4_096,
        ...FIRECRACKER_FACTS,
        storage: { ...reported, poolReserveMiB },
      });
      return t.mutation(internal.attemptScheduler.tryAssign, {});
    }

    await t.mutation(internal.controllerApi.createAttempt, {
      profile: "erainfra-4vcpu-ubuntu-2404",
      executor: "firecracker",
      imageRelease: IMAGE,
      vcpus: 2,
      memoryMiB: 4_096,
      runnerName: "runner-reserve",
      runnerId: 1,
      encodedJITConfig: "jit",
    });

    // An operator who raises RC_MIN_POOL_FREE_MIB past the free space stops placement too. The
    // guests live at the sample have since ended, so what they wrote is free again.
    const room = reported.poolFreeMiB + reported.poolReserveUsedMiB;
    expect(reported.poolReserveUsedMiB).toBeGreaterThan(0);
    expect(await assignWith(room + 1)).toBe(0);
    expect(await assignWith(room)).toBe(1);
  });

  it("rejects a blank current Firecracker report at the write boundary", async () => {
    const t = convexTest(schema, modules);
    await worker(t, "token-c");
    await expect(
      t.mutation(api.workerApi.reportReadiness, {
        token: "token-c",
        profile: "erainfra-4vcpu-ubuntu-2404",
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

  it("distinguishes a first failure from a regression of previously ready capacity", async () => {
    const t = convexTest(schema, modules);
    await worker(t, "token-state");
    const contract = {
      token: "token-state",
      profile: "erainfra-4vcpu-ubuntu-2404",
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
      profile: "erainfra-4vcpu-ubuntu-2404",
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
