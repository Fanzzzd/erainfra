import { convexTest, type TestConvex } from "convex-test";
import { describe, expect, it } from "vitest";
import { api, internal } from "../convex/_generated/api";
import schema from "../convex/schema";

const modules = import.meta.glob("../convex/**/*.ts");
const OPERATOR = { subject: "operator", issuer: "https://example.test" };
const IMAGE = `ghcr.io/fanzzzd/runner@sha256:${"a".repeat(64)}`;

async function setup(t: TestConvex<typeof schema>, maxSlots = 2) {
  await t.mutation(internal.controllerApi.registerProfile, {
    name: "rc-linux-js",
    scaleSetName: "rc-linux-js",
    executor: "firecracker",
    imageRelease: IMAGE,
    vcpus: 2,
    memoryMiB: 4096,
    minRunners: 0,
    maxRunners: 8,
  });
  const machineId = await t.run(async (ctx) =>
    ctx.db.insert("machines", {
      name: "linux-a",
      os: "linux",
      labels: [],
      maxSlots,
      usedSlots: 0,
      lastSeen: Date.now(),
      token: "machine-token",
      cpus: 16,
      memoryMiB: 32_768,
    }),
  );
  await t.mutation(api.workerApi.reportReadiness, {
    token: "machine-token",
    profile: "rc-linux-js",
    executor: "firecracker",
    imageRelease: IMAGE,
    state: "ready",
  });
  return machineId;
}

describe("Experiment lifecycle", () => {
  it("copies the immutable Profile contract and shares Worker capacity", async () => {
    const t = convexTest(schema, modules);
    const machineId = await setup(t);
    const experimentId = await t.withIdentity(OPERATOR).mutation(api.experiments.create, {
      name: "node smoke",
      profile: "rc-linux-js",
      command: ["node", "--version"],
      timeoutSeconds: 120,
    });
    await t.mutation(internal.attemptScheduler.tryAssign, {});

    expect(await t.run(async (ctx) => ctx.db.get(experimentId))).toMatchObject({
      machineId,
      executor: "firecracker",
      imageRelease: IMAGE,
      vcpus: 2,
      memoryMiB: 4096,
      state: "queued",
    });
    expect((await t.run(async (ctx) => ctx.db.get(machineId)))?.usedSlots).toBe(1);
  });

  it("claims once, records execution and releases capacity", async () => {
    const t = convexTest(schema, modules);
    const machineId = await setup(t);
    const experimentId = await t.withIdentity(OPERATOR).mutation(api.experiments.create, {
      name: "failing smoke",
      profile: "rc-linux-js",
      command: ["sh", "-lc", "exit 17"],
      timeoutSeconds: 60,
    });
    await t.mutation(internal.attemptScheduler.tryAssign, {});

    expect(
      await t.mutation(api.workerApi.claimExperiment, {
        token: "machine-token",
        experimentId,
      }),
    ).toMatchObject({ command: ["sh", "-lc", "exit 17"], timeoutSeconds: 60 });
    expect(
      await t.mutation(api.workerApi.claimExperiment, {
        token: "machine-token",
        experimentId,
      }),
    ).toBeNull();
    expect(
      await t.mutation(api.workerApi.markExperimentRunning, {
        token: "machine-token",
        experimentId,
      }),
    ).toBe(true);
    await t.mutation(api.workerApi.reportExperiment, {
      token: "machine-token",
      experimentId,
      exitCode: 17,
    });

    expect(await t.run(async (ctx) => ctx.db.get(experimentId))).toMatchObject({
      state: "failed",
      exitCode: 17,
    });
    expect((await t.run(async (ctx) => ctx.db.get(machineId)))?.usedSlots).toBe(0);
  });

  it("cancels live execution idempotently and rejects unsafe inputs", async () => {
    const t = convexTest(schema, modules);
    const machineId = await setup(t);
    const authed = t.withIdentity(OPERATOR);
    const experimentId = await authed.mutation(api.experiments.create, {
      name: "cancel me",
      profile: "rc-linux-js",
      command: ["sleep", "300"],
      timeoutSeconds: 600,
    });
    await t.mutation(internal.attemptScheduler.tryAssign, {});
    expect(await authed.mutation(api.experiments.cancel, { experimentId })).toBe(true);
    expect(await authed.mutation(api.experiments.cancel, { experimentId })).toBe(true);
    expect((await t.run(async (ctx) => ctx.db.get(machineId)))?.usedSlots).toBe(0);

    await expect(
      authed.mutation(api.experiments.create, {
        name: "too long",
        profile: "rc-linux-js",
        command: ["echo", "x".repeat(16 * 1024)],
        timeoutSeconds: 1,
      }),
    ).rejects.toThrow(/16 KiB/);
  });

  it("requires dashboard authentication", async () => {
    const t = convexTest(schema, modules);
    await setup(t);
    await expect(
      t.mutation(api.experiments.create, {
        name: "unauthorized",
        profile: "rc-linux-js",
        command: ["true"],
        timeoutSeconds: 60,
      }),
    ).rejects.toThrow(/Authentication required/);
  });

  it("reconciliation preserves live slots and recovers an unclaimed offline assignment", async () => {
    const t = convexTest(schema, modules);
    const machineId = await setup(t);
    const experimentId = await t.withIdentity(OPERATOR).mutation(api.experiments.create, {
      name: "recover me",
      profile: "rc-linux-js",
      command: ["true"],
      timeoutSeconds: 60,
    });
    await t.mutation(internal.attemptScheduler.tryAssign, {});

    await t.mutation(internal.reconcile.run, {});
    expect((await t.run(async (ctx) => ctx.db.get(machineId)))?.usedSlots).toBe(1);

    await t.run(async (ctx) => ctx.db.patch(machineId, { lastSeen: Date.now() - 10 * 60_000 }));
    const result = await t.mutation(internal.reconcile.run, {});
    expect(result.requeued).toBe(1);
    const recovered = await t.run(async (ctx) => ctx.db.get(experimentId));
    expect(recovered?.state).toBe("queued");
    expect(recovered?.machineId).toBeUndefined();
    expect((await t.run(async (ctx) => ctx.db.get(machineId)))?.usedSlots).toBe(0);
  });
});
