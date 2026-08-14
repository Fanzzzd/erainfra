import { convexTest, type TestConvex } from "convex-test";
import { describe, expect, it } from "vitest";
import { api, internal } from "../convex/_generated/api";
import schema from "../convex/schema";

const modules = import.meta.glob("../convex/**/*.ts");
const OPERATOR = { subject: "operator", issuer: "https://example.test" };
const IMAGE = `ghcr.io/fanzzzd/runner@sha256:${"a".repeat(64)}`;
type Harness = TestConvex<typeof schema>;

function seedMachine(t: Harness, name: string, token: string, lastSeen = Date.now()) {
  return t.run((ctx) =>
    ctx.db.insert("machines", {
      name,
      os: "linux",
      labels: [],
      cpus: 16,
      memoryMiB: 32_768,
      maxSlots: 4,
      usedSlots: 0,
      lastSeen,
      token,
    }),
  );
}

describe("machines.list", () => {
  it("joins only active Attempt and Experiment state ranges", async () => {
    const t = convexTest(schema, modules);
    const machineId = await seedMachine(t, "worker-a", "token-a");
    const baseAttempt = {
      profile: "rc-linux-js",
      executor: "firecracker" as const,
      imageRelease: IMAGE,
      vcpus: 2,
      memoryMiB: 4096,
      runnerId: 1,
      machineId,
      createdAt: Date.now(),
    };
    const baseExperiment = {
      name: "smoke",
      profile: "rc-linux-js",
      executor: "firecracker" as const,
      imageRelease: IMAGE,
      vcpus: 2,
      memoryMiB: 4096,
      command: ["true"],
      timeoutSeconds: 60,
      machineId,
      createdBy: "operator",
      createdAt: Date.now(),
    };
    await t.run(async (ctx) => {
      await ctx.db.insert("attempts", {
        ...baseAttempt,
        runnerName: "active-attempt",
        state: "ready",
      });
      await ctx.db.insert("attempts", {
        ...baseAttempt,
        runnerName: "finished-attempt",
        runnerId: 2,
        state: "completed",
        finishedAt: Date.now(),
      });
      await ctx.db.insert("experiments", { ...baseExperiment, state: "running" });
      await ctx.db.insert("experiments", {
        ...baseExperiment,
        name: "finished-smoke",
        state: "failed",
        finishedAt: Date.now(),
      });
    });

    const [machine] = await t.withIdentity(OPERATOR).query(api.machines.list, {});
    expect(machine?.currentAttempts).toEqual([
      expect.objectContaining({ profile: "rc-linux-js", state: "ready" }),
    ]);
    expect(machine?.currentExperiments).toEqual([
      expect.objectContaining({ name: "smoke", state: "running" }),
    ]);
  });
});

describe("machine indexed policies", () => {
  it("allocates duplicate names and legacy no-memory slots without scanning the fleet", async () => {
    const t = convexTest(schema, modules).withIdentity(OPERATOR);
    const firstToken = await t.mutation(api.machines.createRegistrationToken, {});
    const secondToken = await t.mutation(api.machines.createRegistrationToken, {});

    for (const registrationToken of [firstToken.token, secondToken.token]) {
      expect(
        await t.mutation(internal.machines.registerAgent, {
          registrationToken,
          name: "worker",
          os: "linux",
          arch: "x64",
          cpus: 32,
        }),
      ).toMatchObject({ ok: true });
    }

    const machines = await t.run((ctx) => ctx.db.query("machines").order("asc").take(10));
    expect(machines.map(({ name, maxSlots }) => ({ name, maxSlots }))).toEqual([
      { name: "worker", maxSlots: 8 },
      { name: "worker-2", maxSlots: 8 },
    ]);
  });

  it("considers only Workers inside the shared heartbeat window for capacity", async () => {
    const t = convexTest(schema, modules);
    const online = await seedMachine(t, "online", "online-token");
    const offline = await seedMachine(t, "offline", "offline-token", Date.now() - 10 * 60_000);

    expect(
      await t.query(internal.machines.hasCapacity, { labels: ["self-hosted", "rc-linux"] }),
    ).toBe(true);
    await t.run(async (ctx) => {
      await ctx.db.patch(online, { lastSeen: Date.now() - 10 * 60_000 });
      await ctx.db.patch(offline, { lastSeen: Date.now() });
    });
    expect(
      await t.query(internal.machines.hasCapacity, { labels: ["self-hosted", "rc-linux"] }),
    ).toBe(true);
    await t.run((ctx) => ctx.db.patch(offline, { lastSeen: Date.now() - 10 * 60_000 }));
    expect(
      await t.query(internal.machines.hasCapacity, { labels: ["self-hosted", "rc-linux"] }),
    ).toBe(false);
  });
});
