import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";

import { api } from "../convex/_generated/api";
import schema from "../convex/schema";
import {
  CONTRACT,
  insertMachine,
  insertProfile,
  insertReadiness,
  MINUTE,
  NOW,
} from "./support/fleetFixture";

/**
 * workerApi.readiness and GET /agents/readiness: what the installer reads before and after an
 * Action Runner Agent update to decide whether to keep the new Agent.
 */
const modules = import.meta.glob("../convex/**/*.ts");
const TOKEN = "0123456789abcdef0123456789abcdef";

async function workerWithReadyProfile() {
  const t = convexTest(schema, modules);
  await insertProfile(t);
  const machineId = await insertMachine(t, "ubuntu0", { token: TOKEN });
  await insertReadiness(t, machineId);
  return { t, machineId };
}

describe("workerApi.readiness", () => {
  it("reports a ready Profile as ready, with its checkedAt", async () => {
    const { t } = await workerWithReadyProfile();
    expect(await t.query(api.workerApi.readiness, { token: TOKEN })).toEqual([
      { profile: CONTRACT.profile, state: "ready", checkedAt: NOW - MINUTE, failedChecks: [] },
    ]);
  });

  it("names the failed checks of a degraded Profile", async () => {
    const t = convexTest(schema, modules);
    await insertProfile(t);
    const machineId = await insertMachine(t, "ubuntu0", { token: TOKEN });
    await t.run(async (ctx) => {
      await ctx.db.insert("workerReadiness", {
        machineId,
        ...CONTRACT,
        state: "degraded",
        checkedAt: NOW,
        preparedAt: NOW - MINUTE,
      });
      await ctx.db.insert("readinessEvidence", {
        machineId,
        ...CONTRACT,
        checkedAt: NOW,
        lastError: "warm pool owns 2 of 1 microVMs",
        checks: [
          { name: "kvm", passed: true },
          { name: "warm-pool", passed: false, detail: "warm pool owns 2 of 1 microVMs" },
        ],
      });
    });

    expect(await t.query(api.workerApi.readiness, { token: TOKEN })).toEqual([
      {
        profile: CONTRACT.profile,
        state: "degraded",
        checkedAt: NOW,
        failedChecks: ["warm-pool: warm pool owns 2 of 1 microVMs"],
        detail: "warm pool owns 2 of 1 microVMs",
      },
    ]);
  });

  it("reads a ready report whose evidence fails admission as degraded, the way the scheduler does", async () => {
    const t = convexTest(schema, modules);
    await insertProfile(t);
    const machineId = await insertMachine(t, "ubuntu0", { token: TOKEN });
    await insertReadiness(t, machineId);
    await t.run(async (ctx) => {
      const evidence = await ctx.db
        .query("readinessEvidence")
        .withIndex("by_machine_profile", (q) =>
          q.eq("machineId", machineId).eq("profile", CONTRACT.profile),
        )
        .unique();
      await ctx.db.patch(evidence!._id, { checks: [] });
    });

    const [row] = await t.query(api.workerApi.readiness, { token: TOKEN });
    expect(row?.state).toBe("degraded");
    expect(row?.detail).toMatch(/Firecracker readiness evidence is incomplete/);
  });

  it("lists a served Profile with no report for its current contract as unreported", async () => {
    const { t, machineId } = await workerWithReadyProfile();
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query("workerReadiness")
        .withIndex("by_machine_profile", (q) =>
          q.eq("machineId", machineId).eq("profile", CONTRACT.profile),
        )
        .unique();
      await ctx.db.patch(row!._id, {
        imageRelease: `ghcr.io/fanzzzd/runner@sha256:${"f".repeat(64)}`,
      });
    });

    expect(await t.query(api.workerApi.readiness, { token: TOKEN })).toEqual([
      { profile: CONTRACT.profile, state: "unreported", failedChecks: [] },
    ]);
  });

  it("leaves out a Profile the Worker no longer serves", async () => {
    const { t } = await workerWithReadyProfile();
    await t.run(async (ctx) => {
      const profile = await ctx.db
        .query("profiles")
        .withIndex("by_name", (q) => q.eq("name", CONTRACT.profile))
        .unique();
      await ctx.db.patch(profile!._id, { state: "paused" });
    });

    expect(await t.query(api.workerApi.readiness, { token: TOKEN })).toEqual([]);
  });

  it("refuses an unknown machine token", async () => {
    const { t } = await workerWithReadyProfile();
    await expect(t.query(api.workerApi.readiness, { token: "f".repeat(32) })).rejects.toThrow(
      /Invalid machine token/,
    );
  });
});

describe("GET /agents/readiness", () => {
  it("answers the Worker's readiness and the control plane's clock", async () => {
    const { t } = await workerWithReadyProfile();
    const before = Date.now();
    const response = await t.fetch("/agents/readiness", {
      method: "GET",
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { now: number; profiles: unknown[] };
    expect(body.now).toBeGreaterThanOrEqual(before);
    expect(body.profiles).toEqual([
      { profile: CONTRACT.profile, state: "ready", checkedAt: NOW - MINUTE, failedChecks: [] },
    ]);
  });

  it("answers 401 to a missing, malformed or unknown machine token", async () => {
    const { t } = await workerWithReadyProfile();
    for (const headers of [
      {} as Record<string, string>,
      { Authorization: "Bearer not-a-token" },
      { Authorization: `Bearer ${"f".repeat(32)}` },
    ]) {
      const response = await t.fetch("/agents/readiness", { method: "GET", headers });
      expect(response.status).toBe(401);
    }
  });
});
