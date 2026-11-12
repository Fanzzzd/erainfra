import type { TestConvex } from "convex-test";

import type { Doc, Id } from "../../convex/_generated/dataModel";
import { FIRECRACKER_REQUIRED_CHECKS } from "../../convex/isolation";
import type schema from "../../convex/schema";

// A fleet with something to report: an active Firecracker Profile with a ready Worker and a
// degraded one, a paused Docker Profile, a Worker that went silent, one that never connected, and
// Attempts in every state. Shared by the /metrics and alert suites so both read the same facts.
//
// Every row is written directly. workerApi.reportReadiness and the controller mutations schedule
// the scheduler, and a tryAssign racing the fixture would move the pending Attempts the tests
// count.

type Harness = TestConvex<typeof schema>;

export const NOW = Date.UTC(2026, 10, 5, 12, 0, 0);
export const MINUTE = 60_000;

export const CONTRACT = {
  profile: "erainfra-4vcpu-ubuntu-2404",
  executor: "firecracker" as const,
  imageRelease: `ghcr.io/fanzzzd/runner@sha256:${"a".repeat(64)}`,
  vcpus: 2,
  memoryMiB: 4096,
};

export const FIRECRACKER_FACTS = {
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

/** A signed-in dashboard operator backed by a real users row. */
export async function operator(t: Harness) {
  const userId = await t.run((ctx) => ctx.db.insert("users", { email: "ops@example.com" }));
  return t.withIdentity({ subject: userId as Id<"users"> });
}

export async function insertProfile(t: Harness, fields: Partial<Doc<"profiles">> = {}) {
  return t.run((ctx) =>
    ctx.db.insert("profiles", {
      name: CONTRACT.profile,
      scaleSetName: CONTRACT.profile,
      executor: CONTRACT.executor,
      imageRelease: CONTRACT.imageRelease,
      vcpus: CONTRACT.vcpus,
      memoryMiB: CONTRACT.memoryMiB,
      warmPool: 0,
      minRunners: 1,
      maxRunners: 6,
      state: "active",
      updatedAt: NOW,
      ...fields,
    }),
  );
}

export async function insertMachine(
  t: Harness,
  name: string,
  fields: Partial<Doc<"machines">> = {},
) {
  return t.run((ctx) =>
    ctx.db.insert("machines", {
      name,
      os: "linux",
      arch: "x86_64",
      labels: [],
      slotPolicy: "auto",
      recommendedSlots: 4,
      maxSlots: 4,
      usedSlots: 1,
      lastSeen: NOW - 10_000,
      token: `token-${name}`,
      ...fields,
    }),
  );
}

/**
 * Readiness for CONTRACT: the hot row the scheduler reads and the readinessEvidence row that proves
 * it, both with the same checkedAt.
 */
export async function insertReadiness(
  t: Harness,
  machineId: Id<"machines">,
  fields: Partial<Doc<"workerReadiness">> = {},
) {
  return t.run(async (ctx) => {
    const readiness = {
      machineId,
      ...CONTRACT,
      state: "ready" as const,
      checkedAt: NOW - MINUTE,
      preparedAt: NOW - 2 * MINUTE,
      warmPool: { target: 0, parked: 0, claimed: 0 },
      storage: {
        poolTotalMiB: FIRECRACKER_FACTS.storage.poolTotalMiB,
        poolFreeMiB: FIRECRACKER_FACTS.storage.poolFreeMiB,
      },
      ...fields,
    };
    await ctx.db.insert("readinessEvidence", {
      machineId,
      profile: readiness.profile,
      executor: readiness.executor,
      imageRelease: readiness.imageRelease,
      vcpus: readiness.vcpus,
      memoryMiB: readiness.memoryMiB,
      checkedAt: readiness.checkedAt,
      ...FIRECRACKER_FACTS,
    });
    return ctx.db.insert("workerReadiness", readiness);
  });
}

let attemptSequence = 0;
export async function insertAttempt(t: Harness, fields: Partial<Doc<"attempts">> = {}) {
  attemptSequence += 1;
  const sequence = attemptSequence;
  return t.run((ctx) =>
    ctx.db.insert("attempts", {
      ...CONTRACT,
      runnerName: `runner-${sequence}`,
      runnerId: sequence,
      state: "pending",
      createdAt: NOW,
      repo: "acme/secret-repo",
      ...fields,
    }),
  );
}

export async function seedFleet(t: Harness) {
  await insertProfile(t);
  await insertProfile(t, {
    name: "rc-docker",
    scaleSetName: "rc-docker",
    executor: "docker",
    imageRelease: `ghcr.io/fanzzzd/runner@sha256:${"c".repeat(64)}`,
    minRunners: 0,
    maxRunners: 2,
    state: "paused",
  });

  const ready = await insertMachine(t, "ubuntu0", {
    benchmark: {
      measuredAt: NOW - 60 * MINUTE,
      scores: { cpu: 80, memory: 70, disk: 60, network: 55.5, balanced: 66 },
    },
  });
  const degraded = await insertMachine(t, "mac-mini", {
    slotPolicy: "fixed",
    configuredSlots: 2,
    maxSlots: 2,
    usedSlots: 0,
  });
  await insertMachine(t, "gone-box", { lastSeen: NOW - 30 * MINUTE, usedSlots: 0 });
  await insertMachine(t, "never-seen", { lastSeen: 0, usedSlots: 0 });

  await insertReadiness(t, ready);
  await t.run(async (ctx) => {
    await ctx.db.insert("workerReadiness", {
      machineId: degraded,
      ...CONTRACT,
      state: "degraded",
      checkedAt: NOW - MINUTE,
    });
    await ctx.db.insert("readinessEvidence", {
      machineId: degraded,
      ...CONTRACT,
      checkedAt: NOW - MINUTE,
      lastError: 'thin pool "runner" is 97% full',
    });
  });

  // Two queued Attempts; the older has waited five minutes.
  await insertAttempt(t, { state: "pending", createdAt: NOW - 5 * MINUTE });
  await insertAttempt(t, { state: "pending", createdAt: NOW - MINUTE });
  await insertAttempt(t, {
    state: "running",
    createdAt: NOW - 3 * MINUTE,
    startedAt: NOW - 2 * MINUTE,
  });
  // Finished in the last hour: queue waits 10 s, 20 s, 30 s; run times 60 s, 120 s, 180 s.
  for (const [index, result] of ["succeeded", "Succeeded", "failed"].entries()) {
    const startedAt = NOW - 30 * MINUTE;
    await insertAttempt(t, {
      state: "completed",
      result,
      createdAt: startedAt - MINUTE,
      queueTime: startedAt - (index + 1) * 10_000,
      runnerAssignedAt: startedAt,
      startedAt,
      finishedAt: startedAt + (index + 1) * 60_000,
    });
  }
  await insertAttempt(t, {
    state: "failed",
    createdAt: NOW - 20 * MINUTE,
    finishedAt: NOW - 19 * MINUTE,
  });
  await insertAttempt(t, {
    state: "cancelled",
    createdAt: NOW - 10 * MINUTE,
    finishedAt: NOW - 9 * MINUTE,
  });
  // Outside the one-hour window.
  await insertAttempt(t, {
    state: "completed",
    result: "succeeded",
    createdAt: NOW - 5 * 60 * MINUTE,
    startedAt: NOW - 5 * 60 * MINUTE,
    finishedAt: NOW - 4 * 60 * MINUTE,
  });
}
