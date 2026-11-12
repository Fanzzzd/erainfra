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
    name: "erainfra-4vcpu-ubuntu-2404",
    scaleSetName: "erainfra-4vcpu-ubuntu-2404",
    ...CONTRACT,
    minRunners: 0,
    maxRunners: 4,
  });
}

describe("Profile registration", () => {
  it("clears cache read permission when a current registration disables cache facts, but preserves legacy settings", async () => {
    const t = convexTest(schema, modules);
    const registration = {
      name: "erainfra-4vcpu-ubuntu-2404",
      scaleSetName: "erainfra-4vcpu-ubuntu-2404",
      ...CONTRACT,
      minRunners: 0,
      maxRunners: 4,
      githubConfigUrl: "https://github.com/acme/widgets",
    };
    await t.mutation(internal.controllerApi.registerProfile, {
      ...registration,
      githubCacheFacts: true,
      labels: ["custom"],
    });
    // A controller predating these fields must not erase them.
    await registerProfile(t);
    expect(await t.run((ctx) => ctx.db.query("profiles").unique())).toMatchObject({
      githubCacheFacts: true,
      labels: ["custom"],
    });
    // Go omits a false bool on the wire. A current registration therefore has
    // to clear the permission explicitly, not leave the previous true value.
    await t.mutation(internal.controllerApi.registerProfile, registration);
    const stored = await t.run((ctx) => ctx.db.query("profiles").unique());
    expect(stored?.githubCacheFacts).toBe(false);
    expect(stored?.labels).toBeUndefined();
  });
});

describe("scale-set Attempt protocol", () => {
  it("creates an idempotent active Attempt without returning JIT", async () => {
    const t = convexTest(schema, modules);
    await registerProfile(t);
    const input = {
      ...CONTRACT,
      profile: "erainfra-4vcpu-ubuntu-2404",
      runnerName: "erainfra-4vcpu-ubuntu-2404-a",
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
        profile: "erainfra-4vcpu-ubuntu-2404",
      }),
    ).toEqual([
      expect.objectContaining({
        runnerName: input.runnerName,
        runnerId: input.runnerId,
        state: "pending",
      }),
    ]);
    const [stored, secrets] = await t.run(async (ctx) =>
      Promise.all([ctx.db.query("attempts").unique(), ctx.db.query("attemptSecrets").collect()]),
    );
    expect(stored?.jitConfig).toBeUndefined();
    expect(secrets).toHaveLength(1);
    expect(secrets[0]).toMatchObject({
      attemptId: stored?._id,
      jitConfig: "single-use-secret",
    });
  });

  it("rejects a runner name collision across registrations", async () => {
    const t = convexTest(schema, modules);
    await registerProfile(t);
    await t.mutation(internal.controllerApi.createAttempt, {
      ...CONTRACT,
      profile: "erainfra-4vcpu-ubuntu-2404",
      runnerName: "runner-a",
      runnerId: 1,
      encodedJITConfig: "first",
    });
    await expect(
      t.mutation(internal.controllerApi.createAttempt, {
        ...CONTRACT,
        profile: "erainfra-4vcpu-ubuntu-2404",
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
      profile: "erainfra-4vcpu-ubuntu-2404",
      runnerName: "runner-a",
      runnerId: 1,
      encodedJITConfig: "secret",
    });
    const started = {
      profile: "erainfra-4vcpu-ubuntu-2404",
      runnerName: "runner-a",
      runnerRequestId: "7",
      repository: "EraInfra",
      owner: "Fanzzzd",
      jobId: "job-1",
      workflowRef: "Fanzzzd/erainfra/.github/workflows/ci.yml@refs/heads/main",
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
      profile: "erainfra-4vcpu-ubuntu-2404",
      runnerName: "runner-a",
      runnerRequestId: "7",
      jobId: "job-1",
      result: "succeeded",
      finishedAt: 400,
    });
    await t.mutation(internal.controllerApi.markJobCompleted, {
      profile: "erainfra-4vcpu-ubuntu-2404",
      runnerName: "runner-a",
      runnerRequestId: "7",
      jobId: "job-1",
      result: "succeeded",
      finishedAt: 400,
    });

    const [stored] = await t.run(async (ctx) => ctx.db.query("attempts").collect());
    expect(stored).toMatchObject({
      state: "completed",
      repo: "EraInfra",
      jobId: "job-1",
      result: "succeeded",
      finishedAt: 400,
    });
    expect(stored?.jitConfig).toBeUndefined();
    expect(await t.run(async (ctx) => ctx.db.query("attemptSecrets").collect())).toEqual([]);
    expect(
      await t.query(internal.controllerApi.listActiveAttempts, {
        profile: "erainfra-4vcpu-ubuntu-2404",
      }),
    ).toEqual([]);
  });

  it("keeps the run's head branch from either JobStarted, in either order", async () => {
    const t = convexTest(schema, modules);
    await registerProfile(t);
    const started = {
      profile: "erainfra-4vcpu-ubuntu-2404",
      repository: "app",
      owner: "acme",
      workflowRef: "acme/shared/.github/workflows/test.yml@refs/heads/main",
      displayName: "test",
      workflowRunId: 99,
      eventName: "push",
      queueTime: 100,
      assignedAt: 200,
      runnerAssignedAt: 300,
    };
    const branchOf = async (runnerName: string) =>
      (
        await t.run(async (ctx) =>
          ctx.db
            .query("attempts")
            .withIndex("by_runnerName", (q) => q.eq("runnerName", runnerName))
            .unique(),
        )
      )?.headBranch;
    for (const [runnerId, runnerName] of [
      [1, "in-order"],
      [2, "branch-first"],
      [3, "settled"],
    ] as const) {
      await t.mutation(internal.controllerApi.createAttempt, {
        ...CONTRACT,
        profile: "erainfra-4vcpu-ubuntu-2404",
        runnerName,
        runnerId,
        encodedJITConfig: "secret",
      });
    }

    // The message as it arrives, then again once the controller has read the run from GitHub.
    await t.mutation(internal.controllerApi.markJobStarted, { ...started, runnerName: "in-order" });
    await t.mutation(internal.controllerApi.markJobStarted, {
      ...started,
      runnerName: "in-order",
      headBranch: "feature",
    });
    expect(await branchOf("in-order")).toBe("feature");

    // The lookup won the race: the plain message must not clear the branch.
    await t.mutation(internal.controllerApi.markJobStarted, {
      ...started,
      runnerName: "branch-first",
      headBranch: "feature",
    });
    await t.mutation(internal.controllerApi.markJobStarted, {
      ...started,
      runnerName: "branch-first",
    });
    expect(await branchOf("branch-first")).toBe("feature");

    // A job that settled before the lookup came back still gets its branch, once.
    await t.mutation(internal.controllerApi.markJobStarted, { ...started, runnerName: "settled" });
    await t.mutation(internal.controllerApi.markJobCompleted, {
      profile: "erainfra-4vcpu-ubuntu-2404",
      runnerName: "settled",
      result: "succeeded",
      finishedAt: 400,
    });
    await t.mutation(internal.controllerApi.markJobStarted, {
      ...started,
      runnerName: "settled",
      headBranch: "feature",
    });
    await t.mutation(internal.controllerApi.markJobStarted, {
      ...started,
      runnerName: "settled",
      headBranch: "other",
    });
    const [settled] = await t.run(async (ctx) =>
      ctx.db
        .query("attempts")
        .withIndex("by_runnerName", (q) => q.eq("runnerName", "settled"))
        .collect(),
    );
    expect(settled).toMatchObject({ state: "completed", headBranch: "feature" });
  });

  it("cancels only non-running Attempts and clears their JIT", async () => {
    const t = convexTest(schema, modules);
    await registerProfile(t);
    await t.mutation(internal.controllerApi.createAttempt, {
      ...CONTRACT,
      profile: "erainfra-4vcpu-ubuntu-2404",
      runnerName: "idle",
      runnerId: 1,
      encodedJITConfig: "idle-secret",
    });
    await t.mutation(internal.controllerApi.cancelAttempt, {
      profile: "erainfra-4vcpu-ubuntu-2404",
      runnerName: "idle",
      reason: "scale down",
    });
    const [cancelled] = await t.run(async (ctx) => ctx.db.query("attempts").collect());
    expect(cancelled).toMatchObject({ state: "cancelled", cancelReason: "scale down" });
    expect(cancelled?.jitConfig).toBeUndefined();
    expect(await t.run(async (ctx) => ctx.db.query("attemptSecrets").collect())).toEqual([]);

    await t.mutation(internal.controllerApi.createAttempt, {
      ...CONTRACT,
      profile: "erainfra-4vcpu-ubuntu-2404",
      runnerName: "running",
      runnerId: 2,
      encodedJITConfig: "running-secret",
    });
    await t.mutation(internal.controllerApi.markJobStarted, {
      profile: "erainfra-4vcpu-ubuntu-2404",
      runnerName: "running",
      runnerRequestId: "8",
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
        profile: "erainfra-4vcpu-ubuntu-2404",
        runnerName: "running",
        reason: "scale down",
      }),
    ).rejects.toThrow(/cannot be removed/);
  });

  it("deletes the secret when reconciliation times out an unassigned Attempt", async () => {
    const t = convexTest(schema, modules);
    await registerProfile(t);
    await t.mutation(internal.controllerApi.createAttempt, {
      ...CONTRACT,
      profile: "erainfra-4vcpu-ubuntu-2404",
      runnerName: "expired",
      runnerId: 99,
      encodedJITConfig: "expired-secret",
    });
    await t.run(async (ctx) => {
      const attempt = await ctx.db.query("attempts").unique();
      if (attempt === null) throw new Error("missing attempt");
      await ctx.db.patch(attempt._id, { createdAt: Date.now() - 25 * 60 * 60_000 });
    });

    await t.mutation(internal.reconcile.run, {});
    expect(await t.run(async (ctx) => ctx.db.query("attemptSecrets").collect())).toEqual([]);
    expect(await t.run(async (ctx) => ctx.db.query("attempts").unique())).toMatchObject({
      state: "cancelled",
      cancelReason: "No compatible Worker became ready within 24 hours",
    });
  });

  it("exposes and idempotently acknowledges runner cleanup tombstones", async () => {
    const t = convexTest(schema, modules);
    await registerProfile(t);
    await t.mutation(internal.controllerApi.createAttempt, {
      ...CONTRACT,
      profile: "erainfra-4vcpu-ubuntu-2404",
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
      await t.query(internal.controllerApi.listRunnerCleanups, {
        profile: "erainfra-4vcpu-ubuntu-2404",
      }),
    ).toEqual([{ runnerName: "orphan", runnerId: 73 }]);
    const cleanup = { profile: "erainfra-4vcpu-ubuntu-2404", runnerName: "orphan", runnerId: 73 };
    expect(await t.mutation(internal.controllerApi.completeRunnerCleanup, cleanup)).toBe(true);
    expect(await t.mutation(internal.controllerApi.completeRunnerCleanup, cleanup)).toBe(true);
    expect(
      await t.query(internal.controllerApi.listRunnerCleanups, {
        profile: "erainfra-4vcpu-ubuntu-2404",
      }),
    ).toEqual([]);
  });
});

describe("retiring a Profile", () => {
  it("pauses a registered Profile so Worker discovery stops seeing it, and a re-register revives it", async () => {
    const t = convexTest(schema, modules);
    await registerProfile(t);
    expect(
      await t.mutation(internal.controllerApi.pauseProfile, { name: "erainfra-4vcpu-ubuntu-2404" }),
    ).toBe(true);
    const paused = await t.run((ctx) =>
      ctx.db
        .query("profiles")
        .withIndex("by_name", (q) => q.eq("name", "erainfra-4vcpu-ubuntu-2404"))
        .unique(),
    );
    expect(paused?.state).toBe("paused");
    const active = await t.run((ctx) =>
      ctx.db
        .query("profiles")
        .withIndex("by_state", (q) => q.eq("state", "active"))
        .collect(),
    );
    expect(active).toHaveLength(0);

    await registerProfile(t);
    const revived = await t.run((ctx) =>
      ctx.db
        .query("profiles")
        .withIndex("by_name", (q) => q.eq("name", "erainfra-4vcpu-ubuntu-2404"))
        .unique(),
    );
    expect(revived?.state).toBe("active");
  });

  it("reports an unknown Profile instead of inventing one", async () => {
    const t = convexTest(schema, modules);
    expect(await t.mutation(internal.controllerApi.pauseProfile, { name: "nope" })).toBe(false);
  });
});

describe("POST /controller/profiles/pause", () => {
  const token = "controller-token-for-pause";

  it("pauses with the controller token, and refuses without it or for an unknown Profile", async () => {
    process.env.CONTROLLER_TOKEN = token;
    try {
      const t = convexTest(schema, modules);
      await registerProfile(t);
      const post = async (body: unknown, authorization?: string) => {
        const grant = await t.mutation(internal.controllerLease.acquire, {
          profile: (body as { name: string }).name,
          hostname: "retire-test",
          instance: "retire-test-instance",
          caller: { kind: "controllerToken", slot: "current" },
        });
        if (!grant.granted) throw new Error("retire test needs a lease");
        return t.fetch("/controller/profiles/pause", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-EraInfra-Lease-Epoch": String(grant.epoch),
            ...(authorization === undefined ? {} : { Authorization: authorization }),
          },
          body: JSON.stringify(body),
        });
      };

      expect((await post({ name: "erainfra-4vcpu-ubuntu-2404" })).status).toBe(401);
      expect((await post({ name: "erainfra-4vcpu-ubuntu-2404" }, "Bearer wrong")).status).toBe(401);
      expect((await post({ name: "../x" }, `Bearer ${token}`)).status).toBe(400);
      expect((await post({ name: "nope" }, `Bearer ${token}`)).status).toBe(404);
      expect((await post({ name: "erainfra-4vcpu-ubuntu-2404" }, `Bearer ${token}`)).status).toBe(
        204,
      );
      const row = await t.run((ctx) =>
        ctx.db
          .query("profiles")
          .withIndex("by_name", (q) => q.eq("name", "erainfra-4vcpu-ubuntu-2404"))
          .unique(),
      );
      expect(row?.state).toBe("paused");
    } finally {
      delete process.env.CONTROLLER_TOKEN;
    }
  });
});
