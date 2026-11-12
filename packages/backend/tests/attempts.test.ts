import { convexTest, type TestConvex } from "convex-test";
import { describe, expect, it } from "vitest";

import { api, internal } from "../convex/_generated/api";
import { ATTEMPT_LIST_LIMIT, queueWaitMs, workflowRunUrl } from "../convex/attempts";
import schema from "../convex/schema";

const modules = import.meta.glob("../convex/**/*.ts");
const OPERATOR = { subject: "operator", issuer: "https://example.test" };
type Harness = TestConvex<typeof schema>;

const CONTRACT = {
  profile: "erainfra-4vcpu-ubuntu-2404",
  executor: "firecracker" as const,
  imageRelease: `ghcr.io/fanzzzd/runner@sha256:${"a".repeat(64)}`,
  vcpus: 2,
  memoryMiB: 4096,
};

async function registerProfile(t: Harness) {
  await t.mutation(internal.controllerApi.registerProfile, {
    name: CONTRACT.profile,
    scaleSetName: CONTRACT.profile,
    executor: CONTRACT.executor,
    imageRelease: CONTRACT.imageRelease,
    vcpus: CONTRACT.vcpus,
    memoryMiB: CONTRACT.memoryMiB,
    warmPool: 0,
    minRunners: 0,
    maxRunners: 4,
  });
}

async function createAttempt(t: Harness, runnerName: string, runnerId: number) {
  await t.mutation(internal.controllerApi.createAttempt, {
    ...CONTRACT,
    runnerName,
    runnerId,
    encodedJITConfig: `secret-${runnerName}`,
  });
}

describe("attempts.list", () => {
  it("requires a dashboard session", async () => {
    const t = convexTest(schema, modules);
    await expect(t.query(api.attempts.list, {})).rejects.toThrow();
  });

  it("returns the newest Attempts first, capped at the page limit", async () => {
    const t = convexTest(schema, modules);
    await registerProfile(t);
    const total = ATTEMPT_LIST_LIMIT + 3;
    await t.run(async (ctx) => {
      for (let index = 0; index < total; index += 1) {
        await ctx.db.insert("attempts", {
          ...CONTRACT,
          runnerName: `runner-${index}`,
          runnerId: index + 1,
          state: "completed",
          createdAt: 1_000 + index,
        });
      }
    });

    const rows = await t.withIdentity(OPERATOR).query(api.attempts.list, {});
    expect(rows).toHaveLength(ATTEMPT_LIST_LIMIT);
    expect(rows[0]?.runnerName).toBe(`runner-${total - 1}`);
    expect(rows.at(-1)?.runnerName).toBe(`runner-${total - ATTEMPT_LIST_LIMIT}`);
    const created = rows.map((row) => row.createdAt);
    expect(created).toEqual(created.toSorted((left, right) => right - left));
  });

  it("reports the Worker, the GitHub run link and the queue wait GitHub reported at job start", async () => {
    const t = convexTest(schema, modules);
    await registerProfile(t);
    const machineId = await t.run((ctx) =>
      ctx.db.insert("machines", {
        name: "worker-a",
        os: "linux",
        labels: [],
        maxSlots: 1,
        usedSlots: 0,
        lastSeen: Date.now(),
        token: "token-a",
      }),
    );
    await createAttempt(t, "runner-started", 1);
    await createAttempt(t, "runner-waiting", 2);
    await t.run(async (ctx) => {
      const started = await ctx.db
        .query("attempts")
        .withIndex("by_runnerName", (query) => query.eq("runnerName", "runner-started"))
        .unique();
      if (started !== null) await ctx.db.patch(started._id, { machineId });
    });
    const queueTime = Date.UTC(2026, 10, 5, 12, 0, 0);
    await t.mutation(internal.controllerApi.markJobStarted, {
      profile: CONTRACT.profile,
      runnerName: "runner-started",
      repository: "octo-repo",
      owner: "octo-org",
      displayName: "test / unit",
      workflowRunId: 19_876_543_210,
      queueTime,
      assignedAt: queueTime + 2_000,
      runnerAssignedAt: queueTime + 47_000,
    });

    const rows = await t.withIdentity(OPERATOR).query(api.attempts.list, {});
    const started = rows.find((row) => row.runnerName === "runner-started");
    expect(started).toMatchObject({
      profile: CONTRACT.profile,
      executor: "firecracker",
      state: "running",
      machineName: "worker-a",
      repo: "octo-repo",
      owner: "octo-org",
      displayName: "test / unit",
      workflowRunId: 19_876_543_210,
      workflowRunUrl: "https://github.com/octo-org/octo-repo/actions/runs/19876543210",
      queueTime,
      queueWaitMs: 47_000,
    });
    expect(started?.startedAt).toBeTypeOf("number");
    // Credentials never leave the control plane through the dashboard.
    expect(Object.keys(started ?? {})).not.toContain("jitConfig");

    const waiting = rows.find((row) => row.runnerName === "runner-waiting");
    expect(waiting).toMatchObject({ state: "pending", queueWaitMs: null });
    expect(waiting?.workflowRunUrl).toBeUndefined();
    expect(waiting?.machineName).toBeUndefined();
  });
});

describe("queueWaitMs", () => {
  it("is null until GitHub has said when the job was queued or handed to the scale set", () => {
    expect(queueWaitMs({})).toBeNull();
    expect(queueWaitMs({ runnerAssignedAt: 5_000, startedAt: 6_000 })).toBeNull();
    expect(queueWaitMs({ queueTime: 1_000 })).toBeNull();
    expect(queueWaitMs({ assignedAt: 1_000 })).toBeNull();
  });

  it("measures queue to Runner assignment on GitHub's clock when it can", () => {
    expect(
      queueWaitMs({
        queueTime: 1_000,
        assignedAt: 2_000,
        runnerAssignedAt: 4_000,
        startedAt: 9_000,
      }),
    ).toBe(3_000);
  });

  // GitHub's scale-set JobStarted carries queueTime as zero, which the controller drops, but
  // scaleSetAssignTime and runnerAssignTime set.
  it("starts at the scale-set assignment when GitHub sent no queue time", () => {
    expect(queueWaitMs({ assignedAt: 2_000, runnerAssignedAt: 4_000, startedAt: 9_000 })).toBe(
      2_000,
    );
  });

  it("falls back to the control plane's start time and never reports a negative wait", () => {
    expect(queueWaitMs({ queueTime: 1_000, startedAt: 2_500 })).toBe(1_500);
    expect(queueWaitMs({ queueTime: 5_000, startedAt: 4_000 })).toBe(0);
  });
});

describe("workflowRunUrl", () => {
  it("needs the owner, the repository and the run id", () => {
    expect(workflowRunUrl({ owner: "o", repo: "r", workflowRunId: 7 })).toBe(
      "https://github.com/o/r/actions/runs/7",
    );
    expect(workflowRunUrl({ repo: "o/r", workflowRunId: 7 })).toBe(
      "https://github.com/o/r/actions/runs/7",
    );
    expect(workflowRunUrl({ repo: "r", workflowRunId: 7 })).toBeUndefined();
    expect(workflowRunUrl({ owner: "o", repo: "r" })).toBeUndefined();
    expect(workflowRunUrl({ owner: "o", repo: "a/b/c", workflowRunId: 7 })).toBeUndefined();
  });
});
