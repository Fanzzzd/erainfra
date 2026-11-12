import { convexTest, type TestConvex } from "convex-test";
import { describe, expect, it } from "vitest";

import { api, internal } from "../convex/_generated/api";
import { evaluateCondition } from "../convex/alertRules";
import {
  loadFleetObservation,
  oldestRunnerVersion,
  type ObservedProfile,
} from "../convex/fleetObservation";
import { buildMetricFamilies } from "../convex/metricsFormat";
import {
  parseRunnerReleases,
  runnerReleaseStanding,
  runnerVersionFromImageRelease,
  type RunnerRelease,
} from "../convex/runnerReleaseModel";
import schema from "../convex/schema";

const modules = import.meta.glob("../convex/**/*.ts");
type Harness = TestConvex<typeof schema>;

const DAY = 24 * 60 * 60_000;
const NOW = Date.UTC(2026, 10, 7, 12, 0, 0);
const IMAGE =
  "ghcr.io/fanzzzd/runner@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

// The incident's shape: the image pinned 2.336.0, GitHub shipped 2.337.0 and then 2.338.x.
const RELEASES: RunnerRelease[] = [
  { version: "2.335.1", publishedAt: NOW - 70 * DAY },
  { version: "2.336.0", publishedAt: NOW - 60 * DAY },
  { version: "2.337.0", publishedAt: NOW - 33 * DAY },
  { version: "2.338.2", publishedAt: NOW - 12 * DAY },
];

describe("parseRunnerReleases", () => {
  it("keeps published x.y.z releases, oldest version first, as pinbump does", () => {
    expect(
      parseRunnerReleases([
        { tag_name: "v2.338.2", published_at: "2026-10-26T12:00:00Z" },
        { tag_name: "v2.339.0", published_at: "2026-11-06T12:00:00Z", prerelease: true },
        { tag_name: "v2.340.0", published_at: null, draft: true },
        { tag_name: "v2.337.0", published_at: "2026-10-05T12:00:00Z" },
        { tag_name: "nightly", published_at: "2026-11-01T00:00:00Z" },
        { tag_name: "v2.336.1", published_at: "not a date" },
        "not a release",
      ]),
    ).toEqual([
      { version: "2.337.0", publishedAt: Date.UTC(2026, 9, 5, 12) },
      { version: "2.338.2", publishedAt: Date.UTC(2026, 9, 26, 12) },
    ]);
    expect(() => parseRunnerReleases({ message: "API rate limit exceeded" })).toThrow(/array/);
  });
});

describe("runnerReleaseStanding", () => {
  it("counts from the successor's release, not the newest", () => {
    // 2.337.0 shipped 33 days ago, so 2.336.0 is past the cutoff even though the newest release,
    // 2.338.2, is only 12 days old. Counting from the newest would say 18 days were left.
    expect(runnerReleaseStanding("2.336.0", RELEASES, NOW)).toMatchObject({
      state: "expired",
      successor: { version: "2.337.0" },
      newest: { version: "2.338.2" },
      deadline: NOW - 3 * DAY,
    });
  });

  it("warns from 25 days after the successor, and not before", () => {
    const releases = [
      { version: "2.337.0", publishedAt: NOW - 40 * DAY },
      { version: "2.338.2", publishedAt: NOW - 25 * DAY },
    ];
    expect(runnerReleaseStanding("2.337.0", releases, NOW)).toMatchObject({
      state: "expiring",
      deadline: NOW + 5 * DAY,
    });
    expect(runnerReleaseStanding("2.337.0", releases, NOW - 1)).toMatchObject({
      state: "supported",
    });
    expect(runnerReleaseStanding("2.337.0", releases, NOW + 5 * DAY)).toMatchObject({
      state: "expired",
    });
  });

  it("is current at the newest release, or past a list fetched before a newer one", () => {
    expect(runnerReleaseStanding("2.338.2", RELEASES, NOW)).toEqual({
      state: "current",
      version: "2.338.2",
    });
    expect(runnerReleaseStanding("2.339.0", RELEASES, NOW)).toMatchObject({ state: "current" });
  });

  it("treats a version older than every listed release as expired", () => {
    const recent = [{ version: "2.338.2", publishedAt: NOW - DAY }];
    expect(runnerReleaseStanding("2.300.0", recent, NOW)).toMatchObject({
      state: "expired",
      successorBeforeList: true,
    });
  });

  it("refuses a version that is not x.y.z", () => {
    expect(runnerReleaseStanding("latest", RELEASES, NOW)).toBeUndefined();
  });
});

describe("runner version sources", () => {
  it("reads the Docker executor's image tag", () => {
    expect(
      runnerVersionFromImageRelease(
        `ghcr.io/actions/actions-runner:2.338.2@sha256:${"7".repeat(64)}`,
      ),
    ).toBe("2.338.2");
    expect(runnerVersionFromImageRelease("ghcr.io/actions/actions-runner:latest")).toBeUndefined();
    expect(runnerVersionFromImageRelease(IMAGE)).toBeUndefined();
  });

  it("takes the oldest valid version a Profile's Workers reported", () => {
    expect(oldestRunnerVersion(["2.338.2", undefined, "2.336.0", "garbage"])).toBe("2.336.0");
    expect(oldestRunnerVersion([undefined])).toBeUndefined();
  });
});

function profile(name: string, runnerVersion?: string): ObservedProfile {
  return {
    name,
    executor: "firecracker",
    state: "active",
    minRunners: 0,
    maxRunners: 1,
    workerLabels: [],
    labelConflicts: [],
    workers: [],
    liveAttempts: { pending: 0, preparing: 0, ready: 0, running: 0 },
    liveAttemptsTruncated: false,
    running: [],
    recentFinished: [],
    recentTruncated: false,
    controller: { status: "unknown", live: 0, controllers: [] },
    ...(runnerVersion === undefined ? {} : { runnerVersion }),
  };
}

describe("erainfra_profile_runner_release_cutoff_seconds", () => {
  it("counts down to the cutoff, negative past it, absent when nothing newer exists", () => {
    const families = buildMetricFamilies(
      {
        now: NOW,
        recentWindowMs: 60 * 60_000,
        profiles: [
          profile("expired", "2.336.0"),
          profile("supported", "2.337.0"),
          profile("current", "2.338.2"),
          profile("unknown"),
        ],
        machines: [],
        nodes: [],
        dimensionsTruncated: false,
        runnerReleases: { fetchedAt: NOW, releases: RELEASES },
      },
      [],
    );
    const cutoff = families.find(
      (family) => family.name === "erainfra_profile_runner_release_cutoff_seconds",
    );
    expect(cutoff?.samples).toEqual([
      { labels: { profile: "expired" }, value: -3 * 86_400 },
      { labels: { profile: "supported" }, value: 18 * 86_400 },
    ]);
  });
});

async function firecrackerWorker(t: Harness, token: string) {
  await t.mutation(internal.controllerApi.registerProfile, {
    name: "erainfra-4vcpu-ubuntu-2404",
    scaleSetName: "erainfra-4vcpu-ubuntu-2404",
    executor: "firecracker",
    imageRelease: IMAGE,
    vcpus: 2,
    memoryMiB: 4_096,
    minRunners: 0,
    maxRunners: 4,
  });
  await t.run(async (ctx) =>
    ctx.db.insert("machines", {
      name: "worker-a",
      os: "linux",
      labels: [],
      maxSlots: 1,
      usedSlots: 0,
      lastSeen: Date.now(),
      token,
    }),
  );
}

function failedReport(token: string, runnerVersion?: string) {
  return {
    token,
    profile: "erainfra-4vcpu-ubuntu-2404",
    executor: "firecracker" as const,
    imageRelease: IMAGE,
    state: "failed" as const,
    error: "KVM is unavailable",
    checks: [{ name: "kvm-device", passed: false, detail: "no /dev/kvm" }],
    ...(runnerVersion === undefined ? {} : { runnerVersion }),
  };
}

async function storedRunnerVersion(t: Harness) {
  return await t.run(
    async (ctx) => (await ctx.db.query("readinessEvidence").unique())?.runnerVersion,
  );
}

describe("runnerVersion readiness fact", () => {
  it("is stored, survives a report that lacks it, and a malformed one never fails readiness", async () => {
    const t = convexTest(schema, modules);
    await firecrackerWorker(t, "token-a");

    await t.mutation(api.workerApi.reportReadiness, failedReport("token-a", "2.336.0"));
    expect(await storedRunnerVersion(t)).toBe("2.336.0");

    // An older Agent, or a preflight that failed before the image was read.
    await t.mutation(api.workerApi.reportReadiness, failedReport("token-a"));
    expect(await storedRunnerVersion(t)).toBe("2.336.0");

    expect(
      await t.mutation(api.workerApi.reportReadiness, failedReport("token-a", "v2; rm -rf /")),
    ).toEqual({ state: "failed" });
    expect(await storedRunnerVersion(t)).toBe("2.336.0");
  });

  it("feeds the runner-release-expiring alert for the Profile", async () => {
    const t = convexTest(schema, modules);
    await firecrackerWorker(t, "token-a");
    await t.mutation(api.workerApi.reportReadiness, failedReport("token-a", "2.336.0"));

    const breaches = async () =>
      await t.run(async (ctx) => {
        const observation = await loadFleetObservation(ctx, NOW, { recentWindowMs: DAY });
        return evaluateCondition({ kind: "runner-release-expiring" }, undefined, observation);
      });
    // Before the first fetch there is nothing to compare against, so nothing fires.
    expect(await breaches()).toEqual([]);

    await t.mutation(internal.runnerReleases.record, { attemptedAt: NOW, releases: RELEASES });
    // A later failed fetch keeps the list.
    await t.mutation(internal.runnerReleases.record, {
      attemptedAt: NOW + 1,
      error: "GitHub responded 403: API rate limit exceeded",
    });
    expect(await t.query(internal.runnerReleases.refreshDue, { now: NOW + 2 })).toBe(false);

    const [breach, ...rest] = await breaches();
    expect(rest).toEqual([]);
    expect(breach?.subject).toBe("erainfra-4vcpu-ubuntu-2404");
    expect(breach?.summary).toContain("actions/runner 2.336.0");
    expect(breach?.summary).toContain("GitHub published 2.337.0 on 2026-10-05");
    expect(breach?.summary).toContain("stopped sending jobs to 2.336.0 on 2026-11-04");
    expect(breach?.summary).toContain("actions/runner 2.338.2");
  });
});
