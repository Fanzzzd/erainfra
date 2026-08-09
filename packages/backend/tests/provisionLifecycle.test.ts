import { convexTest, type TestConvex } from "convex-test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import schema from "../convex/schema";
import { githubMock } from "./support/githubMock.ts";
import { MAX_PROVISION_ATTEMPTS } from "../convex/retry";

// The real `github` module is swapped out: convex-test executes scheduled
// functions, so tryAssign/reconcile would otherwise drive Octokit at the
// network. See tests/support/githubMock.ts.
const modules = {
  ...import.meta.glob("../convex/**/*.ts"),
  "../convex/github.ts": githubMock,
};

// Carries the schema so ctx.db is fully typed inside t.run().
type Harness = TestConvex<typeof schema>;

const REPO = "acme/app";

beforeEach(() => {
  vi.stubEnv("ALLOWED_REPOS", REPO);
});

function addMachine(t: Harness, name: string, maxSlots = 1) {
  return t.run(async (ctx) =>
    ctx.db.insert("machines", {
      name,
      os: "linux" as const,
      labels: [],
      maxSlots,
      usedSlots: 0,
      lastSeen: Date.now(),
      token: `token-${name}`,
    }),
  );
}

function queueJob(t: Harness, ghJobId = 1) {
  return t.mutation(internal.jobs.handleWorkflowJob, {
    action: "queued",
    ghJobId,
    githubInstallationId: 42,
    repo: REPO,
    repoIsPublic: false,
    workflowName: "CI",
    labels: ["self-hosted", "rc-linux"],
  });
}

function job(t: Harness, ghJobId = 1) {
  return t.run(async (ctx) => {
    const found = await ctx.db
      .query("jobs")
      .withIndex("by_ghJobId", (q) => q.eq("ghJobId", ghJobId))
      .first();
    if (found === null) throw new Error(`job ${ghJobId} not found`);
    return found;
  });
}

function commands(t: Harness) {
  return t.run(async (ctx) => ctx.db.query("commands").collect());
}

function runnerDeletions(t: Harness) {
  return t.run(async (ctx) => ctx.db.query("runnerDeletions").collect());
}

/** Simulate the backoff window elapsing without touching the clock. */
function expireBackoff(t: Harness, jobId: Id<"jobs">) {
  return t.run(async (ctx) => ctx.db.patch(jobId, { nextAttemptAt: Date.now() - 1 }));
}

/** Take a job all the way to "a runner registration exists on GitHub". */
async function assignWithJit(t: Harness, ghJobId = 1, runnerId = 900) {
  const assigned = await t.mutation(internal.scheduler.tryAssign, {});
  const [command] = await commands(t);
  if (command === undefined) throw new Error("expected a command");
  await t.mutation(internal.scheduler.storeJitConfig, {
    commandId: command._id,
    jitConfig: "jit-blob",
    runnerId,
  });
  return { assigned, commandId: command._id, current: await job(t, ghJobId) };
}

describe("assignment bookkeeping", () => {
  it("moves a claimed runner to the same-label job GitHub actually started", async () => {
    const t = convexTest(schema, modules);
    const machineId = await addMachine(t, "alpha");
    await queueJob(t, 1);
    await queueJob(t, 2);

    const { commandId, current } = await assignWithJit(t, 1);
    await t.mutation(api.agentApi.claim, { token: "token-alpha", commandId });
    await t.mutation(internal.jobs.handleWorkflowJob, {
      action: "in_progress",
      ghJobId: 2,
      githubInstallationId: 42,
      repo: REPO,
      repoIsPublic: false,
      workflowName: "CI",
      labels: ["self-hosted", "rc-linux"],
      runnerName: current.runnerName,
    });

    const actual = await job(t, 2);
    const displaced = await job(t, 1);
    const command = await t.run(async (ctx) => ctx.db.get(commandId));
    expect(actual.status).toBe("running");
    expect(actual.runnerName).toBe(current.runnerName);
    expect(actual.machineId).toBe(current.machineId);
    expect(displaced.status).toBe("queued");
    expect(displaced.runnerName).toBeUndefined();
    expect(displaced.machineId).toBeUndefined();
    expect(displaced.attempts).toBe(1);
    expect(command?.jobId).toBe(actual._id);

    await t.mutation(api.agentApi.report, {
      token: "token-alpha",
      commandId,
      exitCode: 0,
    });
    await t.mutation(internal.jobs.handleWorkflowJob, {
      action: "completed",
      ghJobId: 2,
      githubInstallationId: 42,
      repo: REPO,
      repoIsPublic: false,
      workflowName: "CI",
      labels: ["self-hosted", "rc-linux"],
      runnerName: current.runnerName,
      conclusion: "success",
    });

    expect((await job(t, 2)).status).toBe("done");
    expect((await t.run(async (ctx) => ctx.db.get(commandId)))?.status).toBe("finished");
    expect((await t.run(async (ctx) => ctx.db.get(machineId)))?.usedSlots).toBe(0);
  });

  it("swaps outstanding assignments when two same-label runners cross", async () => {
    const t = convexTest(schema, modules);
    await addMachine(t, "alpha", 2);
    await queueJob(t, 1);
    await queueJob(t, 2);

    expect(await t.mutation(internal.scheduler.tryAssign, {})).toBe(2);
    const firstBefore = await job(t, 1);
    const secondBefore = await job(t, 2);
    const [firstCommand, secondCommand] = await commands(t);
    if (firstCommand === undefined || secondCommand === undefined) {
      throw new Error("expected two commands");
    }
    await t.mutation(internal.jobs.handleWorkflowJob, {
      action: "in_progress",
      ghJobId: 2,
      githubInstallationId: 42,
      repo: REPO,
      repoIsPublic: false,
      workflowName: "CI",
      labels: ["self-hosted", "rc-linux"],
      runnerName: firstBefore.runnerName,
    });

    const firstAfter = await job(t, 1);
    const secondAfter = await job(t, 2);
    const firstCommandAfter = await t.run(async (ctx) => ctx.db.get(firstCommand._id));
    const secondCommandAfter = await t.run(async (ctx) => ctx.db.get(secondCommand._id));
    expect(secondAfter.status).toBe("running");
    expect(secondAfter.runnerName).toBe(firstBefore.runnerName);
    expect(firstCommandAfter?.jobId).toBe(secondAfter._id);
    expect(firstAfter.status).toBe("assigned");
    expect(firstAfter.runnerName).toBe(secondBefore.runnerName);
    expect(secondCommandAfter?.jobId).toBe(firstAfter._id);
  });

  it("charges a late JIT failure to a command's swapped job", async () => {
    const t = convexTest(schema, modules);
    await addMachine(t, "alpha", 2);
    await queueJob(t, 1);
    await queueJob(t, 2);
    await t.mutation(internal.scheduler.tryAssign, {});

    const firstBefore = await job(t, 1);
    const secondBefore = await job(t, 2);
    const [, secondCommand] = await commands(t);
    if (secondCommand === undefined) throw new Error("expected the second command");
    await t.mutation(internal.jobs.handleWorkflowJob, {
      action: "in_progress",
      ghJobId: 2,
      githubInstallationId: 42,
      repo: REPO,
      repoIsPublic: false,
      workflowName: "CI",
      labels: ["self-hosted", "rc-linux"],
      runnerName: firstBefore.runnerName,
    });

    // issueJit captured job 2 before its command was swapped to job 1.
    await t.mutation(internal.scheduler.failAttempt, {
      commandId: secondCommand._id,
      jobId: secondBefore._id,
      error: "late JIT failure",
    });

    const displaced = await job(t, 1);
    expect(displaced.status).toBe("queued");
    expect(displaced.lastError).toBe("late JIT failure");
  });

  it("settles the actual job when completed arrives without in-progress", async () => {
    const t = convexTest(schema, modules);
    const machineId = await addMachine(t, "alpha");
    await queueJob(t, 1);
    await queueJob(t, 2);

    const { commandId, current } = await assignWithJit(t, 1, 777);
    await t.mutation(api.agentApi.claim, { token: "token-alpha", commandId });
    await t.mutation(internal.jobs.handleWorkflowJob, {
      action: "completed",
      ghJobId: 2,
      githubInstallationId: 42,
      repo: REPO,
      repoIsPublic: false,
      workflowName: "CI",
      labels: ["self-hosted", "rc-linux"],
      runnerName: current.runnerName,
      conclusion: "success",
    });

    expect((await job(t, 2)).status).toBe("done");
    expect((await job(t, 2)).runnerName).toBe(current.runnerName);
    expect((await job(t, 1)).status).toBe("queued");
    expect((await t.run(async (ctx) => ctx.db.get(machineId)))?.usedSlots).toBe(0);
    expect((await t.run(async (ctx) => ctx.db.get(commandId)))?.jobId).toBe((await job(t, 2))._id);
    expect(await runnerDeletions(t)).toHaveLength(0);
  });

  it("adopts a runner even when the actual job's queued event was lost", async () => {
    const t = convexTest(schema, modules);
    await addMachine(t, "alpha");
    await queueJob(t, 1);

    const { commandId, current } = await assignWithJit(t, 1);
    await t.mutation(api.agentApi.claim, { token: "token-alpha", commandId });
    await t.mutation(internal.jobs.handleWorkflowJob, {
      action: "in_progress",
      ghJobId: 2,
      githubInstallationId: 42,
      repo: REPO,
      repoIsPublic: false,
      workflowName: "CI",
      labels: ["self-hosted", "rc-linux"],
      runnerName: current.runnerName,
    });

    expect((await job(t, 2)).status).toBe("running");
    expect((await job(t, 2)).runnerName).toBe(current.runnerName);
    expect((await job(t, 1)).status).toBe("queued");
    expect((await t.run(async (ctx) => ctx.db.get(commandId)))?.jobId).toBe((await job(t, 2))._id);
  });

  it("counts an attempt and names the runner after it", async () => {
    const t = convexTest(schema, modules);
    await addMachine(t, "alpha");
    await queueJob(t);

    expect(await t.mutation(internal.scheduler.tryAssign, {})).toBe(1);
    const assigned = await job(t);
    expect(assigned.status).toBe("assigned");
    expect(assigned.attempts).toBe(1);
    expect(assigned.runnerName).toBe("rc-alpha-1-1");
  });

  it("stores the GitHub runner id alongside the JIT config", async () => {
    const t = convexTest(schema, modules);
    await addMachine(t, "alpha");
    await queueJob(t);
    const { commandId } = await assignWithJit(t, 1, 777);

    const command = await t.run(async (ctx) => ctx.db.get(commandId));
    expect(command?.runnerId).toBe(777);
    expect(command?.jitConfig).toBe("jit-blob");
  });

  it("refuses to store a JIT config for a command that has gone away", async () => {
    const t = convexTest(schema, modules);
    await addMachine(t, "alpha");
    await queueJob(t);
    await t.mutation(internal.scheduler.tryAssign, {});
    const [command] = await commands(t);
    await t.run(async (ctx) => ctx.db.delete(command!._id));

    const stored = await t.mutation(internal.scheduler.storeJitConfig, {
      commandId: command!._id,
      jitConfig: "jit-blob",
      runnerId: 5,
    });
    expect(stored).toBe(false);
  });
});

describe("bounded provisioning retries", () => {
  it("holds a failed job behind a backoff before retrying", async () => {
    const t = convexTest(schema, modules);
    await addMachine(t, "alpha");
    await queueJob(t);
    const { commandId } = await assignWithJit(t);

    await t.mutation(internal.scheduler.failAttempt, {
      commandId,
      jobId: (await job(t))._id,
      error: "docker: command not found",
    });

    const requeued = await job(t);
    expect(requeued.status).toBe("queued");
    expect(requeued.attempts).toBe(1);
    expect(requeued.lastError).toBe("docker: command not found");
    expect(requeued.nextAttemptAt).toBeGreaterThan(Date.now());
    // The slot is back and the dead command is gone.
    expect(await commands(t)).toHaveLength(0);
    const machine = await t.run(async (ctx) => ctx.db.query("machines").first());
    expect(machine?.usedSlots).toBe(0);

    // Still inside the backoff window: nothing is assigned.
    expect(await t.mutation(internal.scheduler.tryAssign, {})).toBe(0);

    await expireBackoff(t, requeued._id);
    expect(await t.mutation(internal.scheduler.tryAssign, {})).toBe(1);
    expect((await job(t)).attempts).toBe(2);
  });

  it("hands the abandoned runner registration back to GitHub", async () => {
    const t = convexTest(schema, modules);
    await addMachine(t, "alpha");
    await queueJob(t);
    const { commandId } = await assignWithJit(t, 1, 4242);

    await t.mutation(internal.scheduler.failAttempt, {
      commandId,
      jobId: (await job(t))._id,
      error: "boom",
    });

    const [deletion] = await runnerDeletions(t);
    expect(deletion?.runnerId).toBe(4242);
    expect(deletion?.repo).toBe(REPO);
    expect(deletion?.githubInstallationId).toBe(42);
    expect(deletion?.runnerName).toBe("rc-alpha-1-1");
  });

  it("prefers a different machine for the retry", async () => {
    const t = convexTest(schema, modules);
    await addMachine(t, "alpha");
    await addMachine(t, "beta");
    await queueJob(t);

    const { commandId } = await assignWithJit(t);
    expect((await job(t)).runnerName).toBe("rc-alpha-1-1");

    await t.mutation(internal.scheduler.failAttempt, {
      commandId,
      jobId: (await job(t))._id,
      error: "boom",
    });
    await expireBackoff(t, (await job(t))._id);
    await t.mutation(internal.scheduler.tryAssign, {});

    expect((await job(t)).runnerName).toBe("rc-beta-1-2");
  });

  it("falls back to the only machine when nothing else can serve the labels", async () => {
    const t = convexTest(schema, modules);
    await addMachine(t, "alpha");
    await queueJob(t);
    const { commandId } = await assignWithJit(t);

    await t.mutation(internal.scheduler.failAttempt, {
      commandId,
      jobId: (await job(t))._id,
      error: "boom",
    });
    await expireBackoff(t, (await job(t))._id);

    expect(await t.mutation(internal.scheduler.tryAssign, {})).toBe(1);
    expect((await job(t)).runnerName).toBe("rc-alpha-1-2");
  });

  it("gives up with a readable reason instead of looping forever", async () => {
    const t = convexTest(schema, modules);
    await addMachine(t, "alpha");
    await queueJob(t);

    for (let attempt = 1; attempt <= MAX_PROVISION_ATTEMPTS; attempt += 1) {
      const current = await job(t);
      if (current.status === "queued") {
        await expireBackoff(t, current._id);
        await t.mutation(internal.scheduler.tryAssign, {});
      }
      const [command] = await commands(t);
      await t.mutation(internal.scheduler.failAttempt, {
        commandId: command?._id,
        jobId: (await job(t))._id,
        error: `attempt ${attempt} failed`,
      });
    }

    const settled = await job(t);
    expect(settled.status).toBe("failed");
    expect(settled.conclusion).toBe("provision-failed");
    expect(settled.attempts).toBe(MAX_PROVISION_ATTEMPTS);
    expect(settled.lastError).toBe(`attempt ${MAX_PROVISION_ATTEMPTS} failed`);
    expect(settled.nextAttemptAt).toBeUndefined();

    // Terminal means terminal: no further assignment, no further registrations.
    expect(await t.mutation(internal.scheduler.tryAssign, {})).toBe(0);
    const machine = await t.run(async (ctx) => ctx.db.query("machines").first());
    expect(machine?.usedSlots).toBe(0);
  });
});

describe("agent reporting", () => {
  async function claimed(t: Harness) {
    await addMachine(t, "alpha");
    await queueJob(t);
    const { commandId } = await assignWithJit(t);
    const claim = await t.mutation(api.agentApi.claim, {
      token: "token-alpha",
      commandId,
    });
    return { commandId, claim };
  }

  it("records the claim time and hands the config over exactly once", async () => {
    const t = convexTest(schema, modules);
    const { commandId, claim } = await claimed(t);

    expect(claim?.jitConfig).toBe("jit-blob");
    const command = await t.run(async (ctx) => ctx.db.get(commandId));
    expect(command?.status).toBe("claimed");
    expect(command?.claimedAt).toBeGreaterThan(0);
    expect(command?.jitConfig).toBeUndefined();

    // A second claim finds nothing left to take.
    expect(await t.mutation(api.agentApi.claim, { token: "token-alpha", commandId })).toBeNull();
  });

  it("does not requeue a job when the provisioner exits cleanly", async () => {
    const t = convexTest(schema, modules);
    const { commandId } = await claimed(t);

    await t.mutation(api.agentApi.report, {
      token: "token-alpha",
      commandId,
      exitCode: 0,
    });

    const current = await job(t);
    expect(current.status).toBe("assigned");
    expect(current.attempts).toBe(1);
    // No second runner was minted for a job that already ran.
    expect(await t.mutation(internal.scheduler.tryAssign, {})).toBe(0);
    expect(await runnerDeletions(t)).toHaveLength(0);
    const command = await t.run(async (ctx) => ctx.db.get(commandId));
    expect(command?.status).toBe("finished");
    expect(command?.exitCode).toBe(0);
  });

  it("routes a failed provisioner through the bounded-retry path", async () => {
    const t = convexTest(schema, modules);
    const { commandId } = await claimed(t);

    await t.mutation(api.agentApi.report, {
      token: "token-alpha",
      commandId,
      exitCode: 127,
    });

    const current = await job(t);
    expect(current.status).toBe("queued");
    expect(current.lastError).toContain("127");
    expect(current.nextAttemptAt).toBeGreaterThan(Date.now());
    expect(await runnerDeletions(t)).toHaveLength(1);
  });

  it("does not retry when the agent reports a command the server cancelled", async () => {
    const t = convexTest(schema, modules);
    const { commandId } = await claimed(t);

    await t.mutation(internal.jobs.handleWorkflowJob, {
      action: "completed",
      ghJobId: 1,
      repo: REPO,
      repoIsPublic: false,
      workflowName: "CI",
      labels: ["self-hosted", "rc-linux"],
      conclusion: "cancelled",
    });
    // The agent kills the provisioner, which exits non-zero.
    await t.mutation(api.agentApi.report, {
      token: "token-alpha",
      commandId,
      exitCode: 143,
    });

    const current = await job(t);
    expect(current.status).toBe("failed");
    expect(current.conclusion).toBe("cancelled");
    expect(await t.mutation(internal.scheduler.tryAssign, {})).toBe(0);
  });
});

describe("cancellation is observable to the agent", () => {
  it("cancels a live command and reclaims its runner registration", async () => {
    const t = convexTest(schema, modules);
    await addMachine(t, "alpha");
    await queueJob(t);
    const { commandId } = await assignWithJit(t, 1, 555);

    let live = await t.query(api.agentApi.pendingCommands, { token: "token-alpha" });
    expect(live.liveCommandIds).toContain(commandId);

    await t.mutation(internal.jobs.handleWorkflowJob, {
      action: "completed",
      ghJobId: 1,
      repo: REPO,
      repoIsPublic: false,
      workflowName: "CI",
      labels: ["self-hosted", "rc-linux"],
      conclusion: "cancelled",
    });

    const command = await t.run(async (ctx) => ctx.db.get(commandId));
    expect(command?.status).toBe("cancelled");
    expect(command?.cancelledAt).toBeGreaterThan(0);

    live = await t.query(api.agentApi.pendingCommands, { token: "token-alpha" });
    expect(live.liveCommandIds).not.toContain(commandId);
    expect(live.commands.map((entry) => entry.commandId)).not.toContain(commandId);

    const [deletion] = await runnerDeletions(t);
    expect(deletion?.runnerId).toBe(555);

    const machine = await t.run(async (ctx) => ctx.db.query("machines").first());
    expect(machine?.usedSlots).toBe(0);
  });

  it("leaves the registration alone when the runner actually ran the job", async () => {
    const t = convexTest(schema, modules);
    await addMachine(t, "alpha");
    await queueJob(t);
    await assignWithJit(t, 1, 555);

    await t.mutation(internal.jobs.handleWorkflowJob, {
      action: "in_progress",
      ghJobId: 1,
      repo: REPO,
      repoIsPublic: false,
      workflowName: "CI",
      labels: ["self-hosted", "rc-linux"],
    });
    await t.mutation(internal.jobs.handleWorkflowJob, {
      action: "completed",
      ghJobId: 1,
      repo: REPO,
      repoIsPublic: false,
      workflowName: "CI",
      labels: ["self-hosted", "rc-linux"],
      conclusion: "success",
    });

    // An ephemeral runner deregisters itself after finishing its job.
    expect(await runnerDeletions(t)).toHaveLength(0);
    expect((await job(t)).status).toBe("done");
  });

  it("refuses to claim a command after it was cancelled", async () => {
    const t = convexTest(schema, modules);
    await addMachine(t, "alpha");
    await queueJob(t);
    const { commandId } = await assignWithJit(t);
    await t.run(async (ctx) =>
      ctx.db.patch(commandId, { status: "cancelled", cancelledAt: Date.now() }),
    );

    expect(await t.mutation(api.agentApi.claim, { token: "token-alpha", commandId })).toBeNull();
  });
});

describe("reconcile", () => {
  it("leaves a freshly claimed command alone", async () => {
    const t = convexTest(schema, modules);
    await addMachine(t, "alpha");
    await queueJob(t);
    const { commandId } = await assignWithJit(t);
    await t.mutation(api.agentApi.claim, { token: "token-alpha", commandId });

    const result = await t.mutation(internal.reconcile.run, {});
    expect(result.requeued).toBe(0);
    expect((await job(t)).status).toBe("assigned");
  });

  it("requeues through the bounded path when the agent goes away", async () => {
    const t = convexTest(schema, modules);
    const machineId = await addMachine(t, "alpha");
    await queueJob(t);
    const { commandId } = await assignWithJit(t, 1, 31337);
    await t.mutation(api.agentApi.claim, { token: "token-alpha", commandId });
    await t.run(async (ctx) => ctx.db.patch(machineId, { lastSeen: Date.now() - 10 * 60_000 }));

    const result = await t.mutation(internal.reconcile.run, {});
    expect(result.requeued).toBe(1);

    const current = await job(t);
    expect(current.status).toBe("queued");
    expect(current.lastError).toContain("stopped reporting");
    expect(current.lastFailedMachineId).toBe(machineId);
    // The orphaned registration is queued for deletion rather than leaked.
    expect((await runnerDeletions(t))[0]?.runnerId).toBe(31337);
  });

  it("stops requeueing an unreachable agent once the budget is spent", async () => {
    const t = convexTest(schema, modules);
    const machineId = await addMachine(t, "alpha");
    await queueJob(t);
    await t.run(async (ctx) =>
      ctx.db.patch((await ctx.db.query("jobs").first())!._id, {
        status: "assigned",
        machineId,
        runnerName: "rc-alpha-1-3",
        attempts: MAX_PROVISION_ATTEMPTS,
      }),
    );
    await t.run(async (ctx) => ctx.db.patch(machineId, { lastSeen: 0 }));

    const result = await t.mutation(internal.reconcile.run, {});
    expect(result.requeued).toBe(0);
    expect((await job(t)).status).toBe("failed");
    expect((await job(t)).conclusion).toBe("provision-failed");
  });
});
