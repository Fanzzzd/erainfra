// Ending an Attempt whose Runner may be online: GitHub deletes the Runner first, and only then does
// the Attempt end and its executor stop (attemptRetirement.ts). A job GitHub handed the Runner in
// the meantime wins.
import { convexTest, type TestConvex } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { api, internal } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { RETIREMENT_UNCONFIRMED_MS, retirementBackstopDue } from "../convex/attemptRetirement";
import schema from "../convex/schema";
import {
  CONTRACT,
  MINUTE,
  NOW,
  insertAttempt,
  insertMachine,
  insertProfile,
} from "./support/fleetFixture";

const modules = import.meta.glob("../convex/**/*.ts");
type Harness = TestConvex<typeof schema>;
const PROFILE = CONTRACT.profile;

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
});
afterEach(() => {
  vi.useRealTimers();
});

/** A Worker that reported just now, holding one slot per Attempt placed on it. */
async function setup(t: Harness, held = 1) {
  await insertProfile(t);
  const machineId = await insertMachine(t, "w1", { lastSeen: NOW, usedSlots: held });
  return machineId;
}

/** The Attempt, with the fields retirement clears present even when absent, to match on. */
async function row(t: Harness, id: Id<"attempts">) {
  const attempt = await t.run(async (ctx) => ctx.db.get(id));
  if (attempt === null) return null;
  return {
    ...attempt,
    runnerCleanupPending: attempt.runnerCleanupPending,
    retirement: attempt.retirement,
  };
}

async function live(t: Harness) {
  return (await t.query(api.workerApi.pendingAttempts, { token: "token-w1" })).liveAttemptIds;
}

async function cleanups(t: Harness) {
  return (await t.query(internal.controllerApi.listRunnerCleanups, { profile: PROFILE })).map(
    (cleanup) => cleanup.runnerName,
  );
}

async function active(t: Harness) {
  return (await t.query(internal.controllerApi.listActiveAttempts, { profile: PROFILE })).map(
    (attempt) => attempt.runnerName,
  );
}

async function slots(t: Harness, machineId: Id<"machines">) {
  return (await t.run(async (ctx) => ctx.db.get(machineId)))?.usedSlots;
}

describe("a scale-down of an idle Runner", () => {
  it("keeps the executor until the controller confirms GitHub deleted the Runner", async () => {
    // The controller's order, in this release and the ones before it: cancel, delete the Runner
    // from GitHub, acknowledge.
    const t = convexTest(schema, modules);
    const machineId = await setup(t);
    const id = await insertAttempt(t, {
      machineId,
      state: "ready",
      runnerName: "idle",
      runnerId: 7,
    });

    await t.mutation(internal.controllerApi.cancelAttempt, {
      profile: PROFILE,
      runnerName: "idle",
      reason: "GitHub reduced the desired runner count",
    });
    expect((await row(t, id))?.state).toBe("ready");
    expect(await live(t), "the Agent stops an executor that leaves its live set").toContain(id);
    expect(await active(t), "a retiring Runner is not capacity").toEqual([]);
    expect(await cleanups(t)).toEqual(["idle"]);
    expect(await slots(t, machineId)).toBe(1);

    expect(
      await t.mutation(internal.controllerApi.completeRunnerCleanup, {
        profile: PROFILE,
        runnerName: "idle",
        runnerId: 7,
      }),
    ).toBe(true);
    expect(await row(t, id)).toMatchObject({
      state: "cancelled",
      cancelReason: "GitHub reduced the desired runner count",
      runnerCleanupPending: undefined,
      retirement: undefined,
    });
    expect(await live(t)).toEqual([]);
    expect(await cleanups(t)).toEqual([]);
    expect(await slots(t, machineId)).toBe(0);
  });

  it("lets a job GitHub handed the Runner first run to completion", async () => {
    const t = convexTest(schema, modules);
    const machineId = await setup(t);
    const id = await insertAttempt(t, {
      machineId,
      state: "ready",
      runnerName: "raced",
      runnerId: 8,
    });
    await t.mutation(internal.controllerApi.cancelAttempt, {
      profile: PROFILE,
      runnerName: "raced",
      reason: "GitHub reduced the desired runner count",
    });
    // GitHub refused the delete (JobStillRunning); the JobStarted arrives with the next message.
    await t.mutation(internal.controllerApi.markJobStarted, {
      profile: PROFILE,
      runnerName: "raced",
      jobId: "job-1",
    });
    expect(await row(t, id)).toMatchObject({
      state: "running",
      runnerCleanupPending: undefined,
      retirement: undefined,
    });
    expect(await live(t)).toContain(id);
    expect(await active(t)).toEqual(["raced"]);
    expect(await cleanups(t), "nothing is left for the controller to delete").toEqual([]);

    await t.mutation(internal.controllerApi.markJobCompleted, {
      profile: PROFILE,
      runnerName: "raced",
      jobId: "job-1",
      result: "succeeded",
      finishedAt: Date.now(),
    });
    expect(await row(t, id)).toMatchObject({ state: "completed", result: "succeeded" });
    expect(await slots(t, machineId)).toBe(0);
  });

  it("ends an unclaimed Attempt at once: no Runner is online to take a job", async () => {
    const t = convexTest(schema, modules);
    const machineId = await setup(t);
    const id = await insertAttempt(t, { machineId, state: "pending", runnerName: "unclaimed" });
    await t.mutation(internal.controllerApi.cancelAttempt, {
      profile: PROFILE,
      runnerName: "unclaimed",
      reason: "scale down",
    });
    expect(await row(t, id)).toMatchObject({ state: "cancelled", runnerCleanupPending: true });
    expect(await live(t)).toEqual([]);
    expect(await slots(t, machineId)).toBe(0);
  });

  it("is asked for once: a second cancel keeps the first reason", async () => {
    const t = convexTest(schema, modules);
    const machineId = await setup(t);
    const id = await insertAttempt(t, { machineId, state: "preparing", runnerName: "twice" });
    for (const reason of ["first", "second"]) {
      await t.mutation(internal.controllerApi.cancelAttempt, {
        profile: PROFILE,
        runnerName: "twice",
        reason,
      });
    }
    expect((await row(t, id))?.retirement).toMatchObject({ outcome: "cancelled", reason: "first" });
  });

  it("ends as cancelled, not failed, when the Runner exits on seeing GitHub delete it", async () => {
    // GitHub deleted the Runner; the runner process noticed and exited before the controller
    // acknowledged the delete. That is the scale-down working, not an Attempt failure.
    const t = convexTest(schema, modules);
    const machineId = await setup(t);
    const id = await insertAttempt(t, {
      machineId,
      state: "ready",
      runnerName: "exited",
      runnerId: 9,
    });
    await t.mutation(internal.controllerApi.cancelAttempt, {
      profile: PROFILE,
      runnerName: "exited",
      reason: "scale down",
    });
    await t.mutation(api.workerApi.reportAttempt, {
      token: "token-w1",
      attemptId: id,
      exitCode: 1,
    });
    expect(await row(t, id)).toMatchObject({
      state: "cancelled",
      cancelReason: "scale down",
      executorExitCode: 1,
      runnerCleanupPending: true,
      retirement: undefined,
    });
    expect(await slots(t, machineId)).toBe(0);
    // The controller's acknowledgement then settles the cleanup.
    expect(await cleanups(t)).toEqual(["exited"]);
    await t.mutation(internal.controllerApi.completeRunnerCleanup, {
      profile: PROFILE,
      runnerName: "exited",
      runnerId: 9,
    });
    expect(await row(t, id)).toMatchObject({ state: "cancelled", runnerCleanupPending: undefined });
  });
});

describe("the reconciler ending an Attempt whose Worker stopped reporting", () => {
  it("retires a ready one and fails it once GitHub has deleted its Runner", async () => {
    const t = convexTest(schema, modules);
    const machineId = await setup(t);
    await t.run(async (ctx) => ctx.db.patch(machineId, { lastSeen: NOW - 5 * MINUTE }));
    const id = await insertAttempt(t, {
      machineId,
      state: "ready",
      runnerName: "offline-idle",
      runnerId: 11,
      claimedAt: NOW - 6 * MINUTE,
    });

    expect((await t.mutation(internal.reconcile.run, {})).abandoned).toBe(1);
    expect((await row(t, id))?.state).toBe("ready");
    expect(await live(t), "a Worker that only lost its link keeps the executor").toContain(id);
    expect(await cleanups(t)).toEqual(["offline-idle"]);
    // The next pass leaves it waiting for the controller.
    expect((await t.mutation(internal.reconcile.run, {})).abandoned).toBe(0);

    await t.mutation(internal.controllerApi.completeRunnerCleanup, {
      profile: PROFILE,
      runnerName: "offline-idle",
      runnerId: 11,
    });
    expect(await row(t, id)).toMatchObject({
      state: "failed",
      lastError: "Worker stopped reporting while preparing the runner",
      runnerCleanupPending: undefined,
    });
  });

  it("keeps a running one until GitHub settles the job", async () => {
    const t = convexTest(schema, modules);
    const machineId = await setup(t);
    await t.run(async (ctx) => ctx.db.patch(machineId, { lastSeen: NOW - 15 * MINUTE }));
    const id = await insertAttempt(t, {
      machineId,
      state: "running",
      runnerName: "offline-busy",
      runnerId: 12,
      startedAt: NOW - 20 * MINUTE,
    });

    await t.mutation(internal.reconcile.run, {});
    expect((await row(t, id))?.state).toBe("running");
    expect(await live(t)).toContain(id);
    // The controller tries to delete it each pass; GitHub answers JobStillRunning until the job
    // ends. A redelivered JobStarted does not call the retirement off.
    expect(await cleanups(t)).toEqual(["offline-busy"]);
    await t.mutation(internal.controllerApi.markJobStarted, {
      profile: PROFILE,
      runnerName: "offline-busy",
      jobId: "job-2",
    });
    expect(await cleanups(t)).toEqual(["offline-busy"]);

    await t.mutation(internal.controllerApi.markJobCompleted, {
      profile: PROFILE,
      runnerName: "offline-busy",
      jobId: "job-2",
      result: "succeeded",
      finishedAt: Date.now(),
    });
    expect(await row(t, id)).toMatchObject({
      state: "completed",
      runnerCleanupPending: undefined,
      retirement: undefined,
    });
    expect(await cleanups(t)).toEqual([]);
  });

  it("ends a retirement no controller confirms, and keeps the Runner owed a delete", async () => {
    const t = convexTest(schema, modules);
    const machineId = await setup(t);
    const id = await insertAttempt(t, { machineId, state: "ready", runnerName: "unserved" });
    await t.mutation(internal.controllerApi.cancelAttempt, {
      profile: PROFILE,
      runnerName: "unserved",
      reason: "scale down",
    });
    vi.setSystemTime(NOW + RETIREMENT_UNCONFIRMED_MS - MINUTE);
    await t.run(async (ctx) => ctx.db.patch(machineId, { lastSeen: Date.now() }));
    await t.mutation(internal.reconcile.run, {});
    expect((await row(t, id))?.state).toBe("ready");

    vi.setSystemTime(NOW + RETIREMENT_UNCONFIRMED_MS + MINUTE);
    await t.run(async (ctx) => ctx.db.patch(machineId, { lastSeen: Date.now() }));
    await t.mutation(internal.reconcile.run, {});
    const ended = await row(t, id);
    expect(ended).toMatchObject({ state: "cancelled", runnerCleanupPending: true });
    expect(ended?.cancelReason).toMatch(/no controller confirmed/);
    expect(await live(t)).toEqual([]);
    expect(await cleanups(t)).toEqual(["unserved"]);
    expect(await slots(t, machineId)).toBe(0);
  });
});

/** A controller for the Profile reporting now, as its heartbeat does every 30 seconds. */
async function controllerReports(
  t: Harness,
  sessionState: "listening" | "standby" | "stopped" = "listening",
) {
  await t.mutation(internal.controllerApi.recordHeartbeat, {
    profile: PROFILE,
    hostname: "controller-1",
    version: "test",
    sessionState,
    assignedJobs: 0,
    runningJobs: 1,
    tokenSlot: "current",
  });
}

/** Moves the clock and has the Worker heartbeat through its own mutation, as the Agent does. */
async function workerHeartbeatAt(t: Harness, at: number) {
  vi.setSystemTime(at);
  await t.mutation(api.agentApi.heartbeat, { token: "token-w1" });
}

describe("a running Attempt whose Worker went silent and came back", () => {
  async function retiredMidJob(t: Harness) {
    await insertProfile(t);
    const machineId = await insertMachine(t, "w1", { lastSeen: NOW - 15 * MINUTE, usedSlots: 1 });
    const id = await insertAttempt(t, {
      machineId,
      state: "running",
      runnerName: "long-build",
      runnerId: 21,
      startedAt: NOW - 20 * MINUTE,
    });
    await t.mutation(internal.reconcile.run, {});
    expect((await row(t, id))?.retirement, "the silence retired it").toBeDefined();
    expect(await cleanups(t)).toEqual(["long-build"]);
    expect(await active(t)).toEqual([]);
    return { machineId, id };
  }

  it("is no longer retiring after the Worker's first heartbeat", async () => {
    const t = convexTest(schema, modules);
    const { id } = await retiredMidJob(t);

    await workerHeartbeatAt(t, NOW + MINUTE);
    expect(await row(t, id)).toMatchObject({
      state: "running",
      retirement: undefined,
      runnerCleanupPending: undefined,
    });
    expect(await cleanups(t), "the controller stops trying to delete a busy Runner").toEqual([]);
    expect(await active(t), "the controller counts it again").toEqual(["long-build"]);
  });

  it("keeps its job past the backstop while a controller gets JobStillRunning", async () => {
    const t = convexTest(schema, modules);
    const { machineId, id } = await retiredMidJob(t);

    // The Worker is back; only the reconciler sees it (no heartbeat mutation ran).
    for (let hour = 1; hour <= 7; hour++) {
      vi.setSystemTime(NOW + hour * 60 * MINUTE);
      await t.run(async (ctx) => ctx.db.patch(machineId, { lastSeen: Date.now() }));
      await controllerReports(t);
      await t.mutation(internal.reconcile.run, {});
    }
    expect(Date.now() - NOW).toBeGreaterThan(RETIREMENT_UNCONFIRMED_MS);
    expect(await row(t, id)).toMatchObject({ state: "running", retirement: undefined });
    expect(await live(t), "the Agent keeps the VM").toContain(id);
    expect(await slots(t, machineId)).toBe(1);

    await t.mutation(internal.controllerApi.markJobCompleted, {
      profile: PROFILE,
      runnerName: "long-build",
      result: "succeeded",
      finishedAt: Date.now(),
    });
    expect((await row(t, id))?.state).toBe("completed");
  });

  it("is retired again if the Worker goes silent again", async () => {
    const t = convexTest(schema, modules);
    const { id } = await retiredMidJob(t);
    await workerHeartbeatAt(t, NOW + MINUTE);
    expect((await row(t, id))?.retirement).toBeUndefined();

    vi.setSystemTime(NOW + 15 * MINUTE);
    await t.mutation(internal.reconcile.run, {});
    expect((await row(t, id))?.retirement?.reason).toBe(
      "Worker stopped reporting during the GitHub job",
    );
  });
});

describe("the retirement backstop", () => {
  it("never ends a running Attempt whose Worker reports, even with no controller", async () => {
    const t = convexTest(schema, modules);
    const machineId = await setup(t);
    const id = await insertAttempt(t, {
      machineId,
      state: "running",
      runnerName: "busy",
      startedAt: NOW,
      runnerCleanupPending: true,
      retirement: { outcome: "failed", reason: "test", requestedAt: NOW },
    });
    const later = NOW + RETIREMENT_UNCONFIRMED_MS + MINUTE;
    const due = await t.run(async (ctx) => {
      const attempt = await ctx.db.get(id);
      const machine = await ctx.db.get(machineId);
      if (attempt === null || machine === null) throw new Error("fixture rows missing");
      return retirementBackstopDue(ctx, attempt, { ...machine, lastSeen: later }, later);
    });
    expect(due).toBe(false);
  });

  it("waits for a live controller to settle an idle Runner, and ends it once none reports", async () => {
    const t = convexTest(schema, modules);
    const machineId = await setup(t);
    const id = await insertAttempt(t, { machineId, state: "ready", runnerName: "idle" });
    await t.mutation(internal.controllerApi.cancelAttempt, {
      profile: PROFILE,
      runnerName: "idle",
      reason: "scale down",
    });

    vi.setSystemTime(NOW + RETIREMENT_UNCONFIRMED_MS + MINUTE);
    await t.run(async (ctx) => ctx.db.patch(machineId, { lastSeen: Date.now() }));
    await controllerReports(t, "standby");
    await t.mutation(internal.reconcile.run, {});
    expect(
      (await row(t, id))?.state,
      "a controller waiting for the lease can still settle it",
    ).toBe("ready");

    await controllerReports(t, "stopped");
    await t.mutation(internal.reconcile.run, {});
    expect(await row(t, id)).toMatchObject({ state: "cancelled", runnerCleanupPending: true });
    expect(await live(t)).toEqual([]);
  });

  it("ends a running Attempt whose Worker stays silent once no controller reports", async () => {
    const t = convexTest(schema, modules);
    await insertProfile(t);
    const machineId = await insertMachine(t, "w1", { lastSeen: NOW - 15 * MINUTE, usedSlots: 1 });
    const id = await insertAttempt(t, {
      machineId,
      state: "running",
      runnerName: "gone",
      startedAt: NOW - 20 * MINUTE,
    });
    await controllerReports(t);
    await t.mutation(internal.reconcile.run, {});

    vi.setSystemTime(NOW + RETIREMENT_UNCONFIRMED_MS + MINUTE);
    await controllerReports(t);
    await t.mutation(internal.reconcile.run, {});
    expect((await row(t, id))?.state, "the listening controller still settles it").toBe("running");

    vi.setSystemTime(Date.now() + 5 * MINUTE);
    await t.mutation(internal.reconcile.run, {});
    const ended = await row(t, id);
    expect(ended).toMatchObject({ state: "failed", runnerCleanupPending: true });
    expect(ended?.lastError).toMatch(/Worker stopped reporting during the GitHub job/);
    expect(await slots(t, machineId)).toBe(0);
  });
});
