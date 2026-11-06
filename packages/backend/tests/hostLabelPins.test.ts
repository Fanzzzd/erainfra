// What happens to work already placed when a Worker loses a host label or a Profile gains a pin,
// and to label conflicts stored before the control plane refused them (ADR 0017).
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { convexTest, type TestConvex } from "convex-test";
import { describe, expect, it, vi } from "vitest";
import { api, internal } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { evaluateCondition } from "../convex/alertRules";
import { loadFleetObservation } from "../convex/fleetObservation";
import schema from "../convex/schema";
import { exitCode, parseRows, report } from "../scripts/profile-label-conflicts";

const modules = import.meta.glob("../convex/**/*.ts");
type Harness = TestConvex<typeof schema>;

const PINNED = "erainfra-4vcpu-ubuntu-2404-gpu";
const CONTRACT = {
  executor: "firecracker" as const,
  imageRelease:
    "ghcr.io/fanzzzd/runner@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  vcpus: 2,
  memoryMiB: 4096,
};
const FACTS = {
  isolation: "firecracker-microvm",
  boundary: "guest-kernel" as const,
  checks: [
    "firecracker-binary",
    "guest-kernel-image",
    "guest-kernel-arguments",
    "kvm-device",
    "cni-plugins",
    "cni-network-configuration",
    "job-network-policy",
    "containerd-snapshotter",
    "cni-address-reservations",
    "snapshot-storage-headroom",
    "cache-isolation",
    "image-release",
    "warm-pool",
  ].map((name) => ({ name, passed: true })),
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

async function registerProfile(t: Harness, name: string, workerLabels?: string[]) {
  return await t.mutation(internal.controllerApi.registerProfile, {
    name,
    scaleSetName: name,
    ...CONTRACT,
    minRunners: 1,
    maxRunners: 4,
    ...(workerLabels === undefined ? {} : { workerLabels }),
  });
}

async function addMachine(t: Harness, name: string, labels: string[], maxSlots = 4) {
  return await t.run(async (ctx) =>
    ctx.db.insert("machines", {
      name,
      os: "linux",
      labels,
      maxSlots,
      usedSlots: 0,
      lastSeen: Date.now(),
      token: `token-${name}`,
    }),
  );
}

async function reportReady(t: Harness, machine: string, profile: string) {
  await t.mutation(api.workerApi.reportReadiness, {
    token: `token-${machine}`,
    profile,
    ...CONTRACT,
    state: "ready",
    ...FACTS,
    warmPool: { target: 0, parked: 0, claimed: 0 },
  });
}

/** Creates an Attempt, places it, and drives it on its Worker to `until`. */
async function attempt(
  t: Harness,
  profile: string,
  runnerId: number,
  until: "pending" | "preparing" | "ready" | "running",
) {
  const runnerName = `runner-${runnerId}`;
  await t.mutation(internal.controllerApi.createAttempt, {
    profile,
    ...CONTRACT,
    runnerName,
    runnerId,
    encodedJITConfig: `secret-${runnerId}`,
  });
  await t.mutation(internal.attemptScheduler.tryAssign, {});
  const row = await t.run(async (ctx) =>
    ctx.db
      .query("attempts")
      .withIndex("by_runnerName", (q) => q.eq("runnerName", runnerName))
      .unique(),
  );
  if (row?.machineId === undefined) throw new Error(`${runnerName} was not placed`);
  const machine = await t.run(async (ctx) => ctx.db.get(row.machineId as Id<"machines">));
  const token = machine!.token;
  if (until !== "pending")
    await t.mutation(api.workerApi.claimAttempt, { token, attemptId: row._id });
  if (until === "ready" || until === "running") {
    await t.mutation(api.workerApi.markReady, { token, attemptId: row._id });
  }
  if (until === "running") {
    await t.mutation(internal.controllerApi.markJobStarted, { profile, runnerName, jobId: "j" });
  }
  return row._id;
}

async function state(t: Harness, attemptId: Id<"attempts">) {
  return await t.run(async (ctx) => {
    const row = await ctx.db.get(attemptId);
    const machine = row?.machineId === undefined ? null : await ctx.db.get(row.machineId);
    return {
      state: row?.state,
      worker: machine?.name,
      cleanup: row?.runnerCleanupPending === true,
      reason: row?.cancelReason,
    };
  });
}

async function usedSlots(t: Harness, name: string) {
  return await t.run(
    async (ctx) =>
      (
        await ctx.db
          .query("machines")
          .withIndex("by_name", (q) => q.eq("name", name))
          .unique()
      )?.usedSlots,
  );
}

describe("a Worker that loses a pinned Profile's label", () => {
  it("retires its idle Runners and requeues its unclaimed Attempts; a running job finishes", async () => {
    const t = convexTest(schema, modules);
    await registerProfile(t, PINNED, ["gpu"]);
    await addMachine(t, "gpu-1", ["gpu"]);
    await reportReady(t, "gpu-1", PINNED);
    const ready = await attempt(t, PINNED, 1, "ready");
    const preparing = await attempt(t, PINNED, 2, "preparing");
    const placed = await attempt(t, PINNED, 3, "pending");
    const running = await attempt(t, PINNED, 4, "running");
    expect(await usedSlots(t, "gpu-1")).toBe(4);

    const result = await t.mutation(internal.machines.setLabels, { name: "gpu-1", labels: [] });
    expect(result).toEqual({
      ok: true,
      name: "gpu-1",
      labels: [],
      retiredRunners: 2,
      requeuedAttempts: 1,
    });

    // Retiring: the controller deletes the Runners first, and their executors keep running until
    // GitHub has confirmed, so a job GitHub handed one in the meantime is not lost.
    const lacks = "Worker gpu-1: this Worker lacks the host label gpu the Profile is pinned to";
    expect(await state(t, ready)).toEqual({
      state: "ready",
      worker: "gpu-1",
      cleanup: true,
      reason: undefined,
    });
    expect((await state(t, preparing)).state).toBe("preparing");
    // Back in the queue, waiting for a Worker with the label rather than spilling elsewhere.
    expect(await state(t, placed)).toEqual({
      state: "pending",
      worker: undefined,
      cleanup: false,
      reason: undefined,
    });
    expect(await state(t, running)).toEqual({
      state: "running",
      worker: "gpu-1",
      cleanup: false,
      reason: undefined,
    });
    expect(await usedSlots(t, "gpu-1")).toBe(3);
    const liveIds = async () =>
      (await t.query(api.workerApi.pendingAttempts, { token: "token-gpu-1" })).liveAttemptIds;
    expect(new Set(await liveIds())).toEqual(new Set([ready, preparing, running]));
    // The controller no longer counts them, so it creates their replacements.
    expect(
      (await t.query(internal.controllerApi.listActiveAttempts, { profile: PINNED })).map(
        (listed) => listed.runnerName,
      ),
    ).toEqual(expect.arrayContaining(["runner-3", "runner-4"]));
    expect(
      (await t.query(internal.controllerApi.listActiveAttempts, { profile: PINNED })).length,
    ).toBe(2);
    // The controller deletes their GitHub Runners, then acknowledges each delete.
    expect(
      (await t.query(internal.controllerApi.listRunnerCleanups, { profile: PINNED })).map(
        (runner) => runner.runnerName,
      ),
    ).toEqual(["runner-1", "runner-2"]);
    for (const runnerId of [1, 2]) {
      await t.mutation(internal.controllerApi.completeRunnerCleanup, {
        profile: PINNED,
        runnerName: `runner-${runnerId}`,
        runnerId,
      });
    }
    expect(await state(t, ready)).toEqual({
      state: "cancelled",
      worker: "gpu-1",
      cleanup: false,
      reason: `Retired before it took a job. ${lacks}`,
    });
    expect((await state(t, preparing)).state).toBe("cancelled");
    expect(await usedSlots(t, "gpu-1")).toBe(1);
    // Only now does the Worker stop their executors: they left its live set.
    expect(await liveIds()).toEqual([running]);
    // A late JobStarted for a Runner GitHub has deleted changes nothing.
    await t.mutation(internal.controllerApi.markJobStarted, {
      profile: PINNED,
      runnerName: "runner-1",
      jobId: "job-later",
    });
    expect((await state(t, ready)).state).toBe("cancelled");

    // A Worker that carries the label takes the requeued Attempt.
    await addMachine(t, "gpu-2", ["gpu"]);
    await reportReady(t, "gpu-2", PINNED);
    await t.mutation(internal.attemptScheduler.tryAssign, {});
    expect((await state(t, placed)).worker).toBe("gpu-2");
  });

  it("keeps a ready Runner's executor alive until GitHub has confirmed the Runner is gone", async () => {
    // GitHub hands an idle Runner a job before the controller's JobStarted reaches Convex. If the
    // Attempt left the Worker's live set at setLabels time, the Agent would kill a VM already
    // running the user's job, and GitHub would then refuse to delete that Runner (JobStillRunning).
    const t = convexTest(schema, modules);
    await registerProfile(t, PINNED, ["gpu"]);
    await addMachine(t, "gpu-1", ["gpu"]);
    await reportReady(t, "gpu-1", PINNED);
    const ready = await attempt(t, PINNED, 1, "ready");
    await t.mutation(internal.machines.setLabels, { name: "gpu-1", labels: [] });
    // JobStarted for the job GitHub assigned a moment before the labels changed.
    await t.mutation(internal.controllerApi.markJobStarted, {
      profile: PINNED,
      runnerName: "runner-1",
      jobId: "job-assigned-in-the-race",
    });
    const live = (await t.query(api.workerApi.pendingAttempts, { token: "token-gpu-1" }))
      .liveAttemptIds;
    expect(live, "the Agent stops the executor of a Runner GitHub already gave a job").toContain(
      ready,
    );
    expect(await state(t, ready)).toMatchObject({ state: "running", cleanup: false });
    expect(await t.query(internal.controllerApi.listRunnerCleanups, { profile: PINNED })).toEqual(
      [],
    );
  });

  it("leaves work alone when the Worker keeps every label the Profile needs", async () => {
    const t = convexTest(schema, modules);
    await registerProfile(t, PINNED, ["gpu"]);
    await addMachine(t, "gpu-1", ["gpu", "nvme"]);
    await reportReady(t, "gpu-1", PINNED);
    const ready = await attempt(t, PINNED, 1, "ready");
    const result = await t.mutation(internal.machines.setLabels, {
      name: "gpu-1",
      labels: ["gpu"],
    });
    expect(result).toMatchObject({ ok: true, retiredRunners: 0, requeuedAttempts: 0 });
    expect((await state(t, ready)).state).toBe("ready");
  });
});

describe("a pin added to a Profile that already has Runners", () => {
  it("retires the Runners on Workers without the label", async () => {
    const t = convexTest(schema, modules);
    await registerProfile(t, PINNED);
    await addMachine(t, "plain-1", [], 1);
    await addMachine(t, "gpu-1", ["gpu"], 1);
    await reportReady(t, "plain-1", PINNED);
    await reportReady(t, "gpu-1", PINNED);
    const first = await attempt(t, PINNED, 1, "ready");
    const second = await attempt(t, PINNED, 2, "ready");
    const onPlain = (await state(t, first)).worker === "plain-1" ? first : second;
    const onGpu = onPlain === first ? second : first;

    expect(await registerProfile(t, PINNED, ["gpu"])).toBeNull();
    // Retiring: its Runner is listed for the controller to delete, and it ends once that is done.
    expect(await state(t, onPlain)).toMatchObject({ state: "ready", cleanup: true });
    expect(
      (await t.query(internal.controllerApi.listRunnerCleanups, { profile: PINNED })).length,
    ).toBe(1);
    expect(await state(t, onGpu)).toMatchObject({ state: "ready", worker: "gpu-1" });

    // Re-registering the same pin, as every controller restart does, retires nothing more.
    expect(await registerProfile(t, PINNED, ["gpu"])).toBeNull();
    expect((await state(t, onGpu)).state).toBe("ready");
  });
});

describe("a scale-set label conflict stored before the control plane refused them", () => {
  const stored = async (t: Harness, rows: Array<[string, string[]]>) => {
    await t.run(async (ctx) => {
      for (const [name, labels] of rows) {
        await ctx.db.insert("profiles", {
          name,
          scaleSetName: name,
          ...CONTRACT,
          minRunners: 0,
          maxRunners: 4,
          labels,
          githubConfigUrl: "https://github.com/o/r",
          fitPolicy: "balanced",
          warmPool: 0,
          state: "active",
          updatedAt: 0,
        });
      }
    });
  };
  const register = (t: Harness, name: string, labels: string[]) =>
    t.mutation(internal.controllerApi.registerProfile, {
      name,
      scaleSetName: name,
      ...CONTRACT,
      minRunners: 0,
      maxRunners: 4,
      githubConfigUrl: "https://github.com/o/r",
      labels,
    });

  it("lets both controllers register again, and raises it instead", async () => {
    const t = convexTest(schema, modules);
    await stored(t, [
      ["plain", ["plain"]],
      ["gpu", ["gpu", "plain"]],
    ]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await register(t, "plain", ["plain"])).toBeNull();
    expect(await register(t, "gpu", ["gpu", "plain"])).toBeNull();
    expect(warn.mock.calls.map(([line]) => line)).toEqual([
      "Profile plain registered with an existing label conflict: Profile gpu's scale set also answers to plain; this Profile's jobs could run there instead (ADR 0017)",
      "Profile gpu registered with an existing label conflict: scale-set label plain is Profile plain's name; its jobs could run on this Profile instead (ADR 0017)",
    ]);
    warn.mockRestore();
    const rows = await t.run(async (ctx) =>
      (await ctx.db.query("profiles").collect()).map((p) => `${p.name}:${p.state}`),
    );
    expect(rows).toEqual(["plain:active", "gpu:active"]);

    // Visible to an operator: the Profile list, the alert, and /metrics read it.
    const listed = await t.query(internal.operatorApi.profiles, {});
    expect(listed.map((p) => [p.name, p.labelConflicts.length])).toEqual([
      ["gpu", 1],
      ["plain", 1],
    ]);
    const observation = await t.run((ctx) =>
      loadFleetObservation(ctx, Date.now(), { recentWindowMs: 60 * 60_000 }),
    );
    expect(
      evaluateCondition({ kind: "profile-label-conflict" }, undefined, observation).map(
        (breach) => breach.subject,
      ),
    ).toEqual(["gpu", "plain"]);
  });

  it("still refuses a registration that adds a conflict", async () => {
    const t = convexTest(schema, modules);
    await stored(t, [
      ["plain", ["plain"]],
      ["gpu", ["gpu", "plain"]],
    ]);
    // A new Profile answering to plain's name.
    expect(await register(t, "arm", ["arm", "plain"])).toHaveProperty("conflict");
    // An existing Profile widening its labels onto another's name.
    await stored(t, [["nvme", ["nvme"]]]);
    expect(await register(t, "nvme", ["nvme", "gpu"])).toHaveProperty("conflict");
    // A paused Profile coming back with a conflict it had while paused.
    await t.mutation(internal.controllerApi.pauseProfile, { name: "gpu" });
    expect(await register(t, "gpu", ["gpu", "plain"])).toHaveProperty("conflict");
  });

  it("is listed by the pre-deploy check from exported rows", () => {
    const rows = parseRows(
      [
        { name: "plain", scaleSetName: "plain", labels: ["plain"], state: "active" },
        { name: "gpu", scaleSetName: "gpu", labels: ["gpu", "plain"], state: "active" },
        { name: "old", scaleSetName: "old", labels: ["plain"], state: "paused" },
      ]
        .map((row) => JSON.stringify(row))
        .join("\n"),
    );
    const result = report(rows);
    expect(result.conflicts.map((c) => `${c.profile}/${c.other}`)).toEqual(["gpu/plain"]);
    expect(result.lines[0]).toBe("1 conflicting pair(s) among 2 active Profiles:");
    expect(exitCode(result)).toBe(1);
    expect(() => parseRows('{"name":"x"}')).toThrow("row 1 is not a Profile");
  });

  // `npx convex data … | script` with no pipefail hands the script nothing when the export fails.
  it.each(["", "\n", "[]"])(
    "refuses an export with no rows (%j) rather than passing it",
    (text) => {
      expect(() => parseRows(text)).toThrow("read no Profile rows");
    },
  );

  it("names the Profiles whose labels the export does not show, and does not call them safe", () => {
    // What a backend that never stored labels exports: their controllers' RC_LABELS are unknown.
    const result = report(
      parseRows(
        [
          { name: "rc-linux-js", scaleSetName: "rc-linux-js", state: "active" },
          { name: "rc-e2e", scaleSetName: "rc-e2e", labels: [], state: "active" },
          { name: "labelled", scaleSetName: "labelled", labels: ["labelled"], state: "active" },
          { name: "gone", scaleSetName: "gone", state: "paused" },
        ]
          .map((row) => JSON.stringify(row))
          .join("\n"),
      ),
    );
    expect(result.conflicts).toEqual([]);
    expect(result.unlabeled).toEqual(["rc-e2e", "rc-linux-js"]);
    expect(result.warnings[0]).toBe(
      "2 active Profile(s) carry no labels in this export: rc-e2e, rc-linux-js.",
    );
    expect(exitCode(result)).toBe(3);
    const labelled = report(
      parseRows('[{"name":"a","scaleSetName":"a","labels":["a"],"state":"active"}]'),
    );
    expect(labelled.warnings).toEqual([]);
    expect(exitCode(labelled)).toBe(0);
  });

  it("exits 2 on an empty pipe and 3 on unlabelled rows when run as the runbook runs it", () => {
    const script = fileURLToPath(new URL("../scripts/profile-label-conflicts.ts", import.meta.url));
    const run = (input: string) =>
      spawnSync(process.execPath, ["--experimental-strip-types", script], {
        input,
        encoding: "utf8",
      });
    const empty = run("");
    expect(empty.status, empty.stderr).toBe(2);
    expect(empty.stderr).toContain("read no Profile rows");
    const unlabeled = run('{"name":"rc-e2e","scaleSetName":"rc-e2e","state":"active"}\n');
    expect(unlabeled.status, unlabeled.stderr).toBe(3);
    expect(unlabeled.stdout).toContain("No conflicts among 1 active Profiles.");
    expect(unlabeled.stderr).toContain("carry no labels in this export: rc-e2e.");
  });
});

describe("labels a Worker registers with", () => {
  it("are normalized like an admin's, and a bad one is refused before the token is spent", async () => {
    const t = convexTest(schema, modules);
    const issue = () =>
      t.run(async (ctx) => {
        const token = `rcreg_${Math.random().toString(16).slice(2)}`;
        await ctx.db.insert("registrationTokens", { token, createdAt: Date.now() });
        return token;
      });
    const register = (registrationToken: string, labels: string[]) =>
      t.mutation(internal.machines.registerAgent, {
        registrationToken,
        name: "gpu-1",
        os: "linux",
        arch: "x64",
        cpus: 8,
        labels,
      });
    const token = await issue();
    expect(await register(token, ["has space"])).toMatchObject({ ok: false, status: 400 });
    expect(await register(token, [" GPU", "nvme", "gpu"])).toMatchObject({ ok: true });
    const labels = await t.run(async (ctx) => (await ctx.db.query("machines").first())?.labels);
    expect(labels).toEqual(["gpu", "nvme"]);
  });
});
