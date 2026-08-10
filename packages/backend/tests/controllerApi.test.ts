import { convexTest, type TestConvex } from "convex-test";
import { describe, expect, it } from "vitest";
import { internal } from "../convex/_generated/api";
import schema from "../convex/schema";

const modules = import.meta.glob("../convex/**/*.ts");
const CONTRACT = {
  executor: "firecracker" as const,
  imageRelease:
    "ghcr.io/fanzzzd/runner@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  vcpus: 2,
  memoryMiB: 4096,
};

async function registerProfile(t: TestConvex<typeof schema>) {
  await t.mutation(internal.controllerApi.registerProfile, {
    name: "rc-linux-js",
    scaleSetName: "rc-linux-js",
    ...CONTRACT,
    minRunners: 0,
    maxRunners: 4,
  });
}

describe("scale-set Attempt protocol", () => {
  it("creates an idempotent active Attempt without returning JIT", async () => {
    const t = convexTest(schema, modules);
    await registerProfile(t);
    const input = {
      ...CONTRACT,
      profile: "rc-linux-js",
      runnerName: "rc-linux-js-a",
      runnerId: 42,
      encodedJITConfig: "single-use-secret",
    };

    await t.mutation(internal.controllerApi.createAttempt, input);
    await t.mutation(internal.controllerApi.createAttempt, {
      ...input,
      encodedJITConfig: "a-replayed-value-is-ignored",
    });

    expect(
      await t.query(internal.controllerApi.listActiveAttempts, {
        profile: "rc-linux-js",
      }),
    ).toEqual([
      expect.objectContaining({
        runnerName: input.runnerName,
        runnerId: input.runnerId,
        state: "pending",
      }),
    ]);
    const [stored] = await t.run(async (ctx) => ctx.db.query("attempts").collect());
    expect(stored?.jitConfig).toBe("single-use-secret");
  });

  it("rejects a runner name collision across registrations", async () => {
    const t = convexTest(schema, modules);
    await registerProfile(t);
    await t.mutation(internal.controllerApi.createAttempt, {
      ...CONTRACT,
      profile: "rc-linux-js",
      runnerName: "runner-a",
      runnerId: 1,
      encodedJITConfig: "first",
    });
    await expect(
      t.mutation(internal.controllerApi.createAttempt, {
        ...CONTRACT,
        profile: "rc-linux-js",
        runnerName: "runner-a",
        runnerId: 2,
        encodedJITConfig: "second",
      }),
    ).rejects.toThrow(/already belongs/);
  });

  it("records lifecycle events idempotently and clears JIT at completion", async () => {
    const t = convexTest(schema, modules);
    await registerProfile(t);
    await t.mutation(internal.controllerApi.createAttempt, {
      ...CONTRACT,
      profile: "rc-linux-js",
      runnerName: "runner-a",
      runnerId: 1,
      encodedJITConfig: "secret",
    });
    const started = {
      profile: "rc-linux-js",
      runnerName: "runner-a",
      runnerRequestId: 7,
      repository: "runner-center",
      owner: "Fanzzzd",
      jobId: "job-1",
      workflowRef: "Fanzzzd/runner-center/.github/workflows/ci.yml@refs/heads/main",
      displayName: "check",
      workflowRunId: 99,
      eventName: "pull_request",
      queueTime: 100,
      assignedAt: 200,
      runnerAssignedAt: 300,
    };
    await t.mutation(internal.controllerApi.markJobStarted, started);
    await t.mutation(internal.controllerApi.markJobStarted, started);
    await t.mutation(internal.controllerApi.markJobCompleted, {
      profile: "rc-linux-js",
      runnerName: "runner-a",
      runnerRequestId: 7,
      jobId: "job-1",
      result: "succeeded",
      finishedAt: 400,
    });
    await t.mutation(internal.controllerApi.markJobCompleted, {
      profile: "rc-linux-js",
      runnerName: "runner-a",
      runnerRequestId: 7,
      jobId: "job-1",
      result: "succeeded",
      finishedAt: 400,
    });

    const [stored] = await t.run(async (ctx) => ctx.db.query("attempts").collect());
    expect(stored).toMatchObject({
      state: "completed",
      repo: "runner-center",
      jobId: "job-1",
      result: "succeeded",
      finishedAt: 400,
    });
    expect(stored?.jitConfig).toBeUndefined();
    expect(
      await t.query(internal.controllerApi.listActiveAttempts, {
        profile: "rc-linux-js",
      }),
    ).toEqual([]);
  });

  it("cancels only non-running Attempts and clears their JIT", async () => {
    const t = convexTest(schema, modules);
    await registerProfile(t);
    await t.mutation(internal.controllerApi.createAttempt, {
      ...CONTRACT,
      profile: "rc-linux-js",
      runnerName: "idle",
      runnerId: 1,
      encodedJITConfig: "idle-secret",
    });
    await t.mutation(internal.controllerApi.cancelAttempt, {
      profile: "rc-linux-js",
      runnerName: "idle",
      reason: "scale down",
    });
    const [cancelled] = await t.run(async (ctx) => ctx.db.query("attempts").collect());
    expect(cancelled).toMatchObject({ state: "cancelled", cancelReason: "scale down" });
    expect(cancelled?.jitConfig).toBeUndefined();

    await t.mutation(internal.controllerApi.createAttempt, {
      ...CONTRACT,
      profile: "rc-linux-js",
      runnerName: "running",
      runnerId: 2,
      encodedJITConfig: "running-secret",
    });
    await t.mutation(internal.controllerApi.markJobStarted, {
      profile: "rc-linux-js",
      runnerName: "running",
      runnerRequestId: 8,
      repository: "runner-center",
      owner: "Fanzzzd",
      jobId: "job-2",
      workflowRef: "",
      displayName: "test",
      workflowRunId: 100,
      eventName: "push",
    });
    await expect(
      t.mutation(internal.controllerApi.cancelAttempt, {
        profile: "rc-linux-js",
        runnerName: "running",
        reason: "scale down",
      }),
    ).rejects.toThrow(/cannot be removed/);
  });

  it("exposes and idempotently acknowledges runner cleanup tombstones", async () => {
    const t = convexTest(schema, modules);
    await registerProfile(t);
    await t.mutation(internal.controllerApi.createAttempt, {
      ...CONTRACT,
      profile: "rc-linux-js",
      runnerName: "orphan",
      runnerId: 73,
      encodedJITConfig: "secret",
    });
    await t.run(async (ctx) => {
      const attempt = await ctx.db.query("attempts").first();
      if (attempt === null) throw new Error("missing Attempt");
      await ctx.db.patch(attempt._id, { state: "failed", runnerCleanupPending: true });
    });

    expect(
      await t.query(internal.controllerApi.listRunnerCleanups, { profile: "rc-linux-js" }),
    ).toEqual([{ runnerName: "orphan", runnerId: 73 }]);
    const cleanup = { profile: "rc-linux-js", runnerName: "orphan", runnerId: 73 };
    expect(await t.mutation(internal.controllerApi.completeRunnerCleanup, cleanup)).toBe(true);
    expect(await t.mutation(internal.controllerApi.completeRunnerCleanup, cleanup)).toBe(true);
    expect(
      await t.query(internal.controllerApi.listRunnerCleanups, { profile: "rc-linux-js" }),
    ).toEqual([]);
  });
});
