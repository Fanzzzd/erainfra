import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { internal } from "../convex/_generated/api";
import { TERMINAL_WORK_RETENTION_MS } from "../convex/reconcile";
import schema from "../convex/schema";

const modules = import.meta.glob("../convex/**/*.ts");
const IMAGE = `ghcr.io/fanzzzd/runner@sha256:${"a".repeat(64)}`;

describe("Attempt and Experiment retention", () => {
  it("removes 30-day terminal history while preserving recent rows and cleanup tombstones", async () => {
    const t = convexTest(schema, modules);
    const now = Date.now();
    const staleAt = now - TERMINAL_WORK_RETENTION_MS - 1;
    const ids = await t.run(async (ctx) => {
      const attempt = {
        profile: "rc-linux-js",
        executor: "firecracker" as const,
        imageRelease: IMAGE,
        vcpus: 2,
        memoryMiB: 4096,
        runnerId: 1,
        state: "completed" as const,
        createdAt: staleAt,
      };
      const staleAttempt = await ctx.db.insert("attempts", {
        ...attempt,
        runnerName: "stale-attempt",
        finishedAt: staleAt,
      });
      await ctx.db.insert("attemptSecrets", {
        attemptId: staleAttempt,
        jitConfig: "legacy-secret",
        createdAt: staleAt,
      });
      const legacyAttempt = await ctx.db.insert("attempts", {
        ...attempt,
        runnerName: "legacy-attempt",
        runnerId: 2,
      });
      const recentAttempt = await ctx.db.insert("attempts", {
        ...attempt,
        runnerName: "recent-attempt",
        runnerId: 3,
        createdAt: now,
        finishedAt: now,
      });
      const cleanupAttempt = await ctx.db.insert("attempts", {
        ...attempt,
        runnerName: "cleanup-attempt",
        runnerId: 4,
        finishedAt: staleAt,
        runnerCleanupPending: true,
      });

      const experiment = {
        profile: "rc-linux-js",
        executor: "firecracker" as const,
        imageRelease: IMAGE,
        vcpus: 2,
        memoryMiB: 4096,
        command: ["true"],
        timeoutSeconds: 60,
        state: "completed" as const,
        createdBy: "operator",
        createdAt: staleAt,
      };
      const staleExperiment = await ctx.db.insert("experiments", {
        ...experiment,
        name: "stale-experiment",
        finishedAt: staleAt,
      });
      const legacyExperiment = await ctx.db.insert("experiments", {
        ...experiment,
        name: "legacy-experiment",
      });
      const recentExperiment = await ctx.db.insert("experiments", {
        ...experiment,
        name: "recent-experiment",
        createdAt: now,
        finishedAt: now,
      });
      return {
        staleAttempt,
        legacyAttempt,
        recentAttempt,
        cleanupAttempt,
        staleExperiment,
        legacyExperiment,
        recentExperiment,
      };
    });

    await t.mutation(internal.reconcile.run, {});

    const rows = await t.run(async (ctx) => ({
      staleAttempt: await ctx.db.get(ids.staleAttempt),
      legacyAttempt: await ctx.db.get(ids.legacyAttempt),
      recentAttempt: await ctx.db.get(ids.recentAttempt),
      cleanupAttempt: await ctx.db.get(ids.cleanupAttempt),
      staleExperiment: await ctx.db.get(ids.staleExperiment),
      legacyExperiment: await ctx.db.get(ids.legacyExperiment),
      recentExperiment: await ctx.db.get(ids.recentExperiment),
    }));
    expect(rows.staleAttempt).toBeNull();
    expect(rows.legacyAttempt).toBeNull();
    expect(rows.recentAttempt).not.toBeNull();
    expect(rows.cleanupAttempt).not.toBeNull();
    expect(rows.staleExperiment).toBeNull();
    expect(rows.legacyExperiment).toBeNull();
    expect(rows.recentExperiment).not.toBeNull();
    expect(await t.run((ctx) => ctx.db.query("attemptSecrets").take(10))).toEqual([]);
  });
});
