import { convexTest, type TestConvex } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { parseRightsizeQuery } from "../convex/operatorHttp";
import { MAX_SCANNED_SUMMARIES, windowStartFor } from "../convex/rightsize";
import {
  MAX_WINDOW_MS,
  MIN_ATTEMPTS,
  nearestRank,
  parseProfileName,
  profileName,
  qualifies,
  recommend,
  recommendAll,
  runsOnMap,
  sameFamily,
  standardSize,
  type RightsizeProfile,
  type RightsizeSample,
} from "../convex/rightsizeModel";
import schema from "../convex/schema";
import { setUpBefore } from "./support/clock.ts";

const modules = import.meta.glob("../convex/**/*.ts");
const GIB = 1024 ** 3;
const IMAGE = `ghcr.io/fanzzzd/erainfra-ubuntu-24.04-js@sha256:${"a".repeat(64)}`;
const T0 = Date.parse("2026-11-01T00:00:00.000Z");
const KEY = { repo: "acme/app", job: "build", profile: "erainfra-4vcpu-ubuntu-2404" };

function profile(
  name: string,
  vcpus: number,
  memoryGiB: number,
  extra: Partial<RightsizeProfile> = {},
) {
  return {
    name,
    executor: "firecracker" as const,
    imageRelease: IMAGE,
    vcpus,
    memoryMiB: memoryGiB * 1024,
    state: "active" as const,
    ...extra,
  };
}

const FLEET: RightsizeProfile[] = [
  profile("erainfra-2vcpu-ubuntu-2404", 2, 8),
  profile("erainfra-4vcpu-ubuntu-2404", 4, 16),
  profile("erainfra-8vcpu-ubuntu-2404", 8, 32),
  profile("erainfra-4vcpu-ubuntu-2404-32gb", 4, 32),
  // Never a candidate for the production Profiles above.
  profile("erainfra-canary-2vcpu-ubuntu-2404", 2, 8),
  profile("erainfra-2vcpu-ubuntu-2404-arm", 2, 8),
  profile("erainfra-2vcpu-ubuntu-2404-8gb-docker", 2, 8, { executor: "docker" }),
];

/** One measured Attempt of the build job on the 4 vCPU / 16 GiB Profile. */
function sample(overrides: Partial<RightsizeSample> = {}): RightsizeSample {
  return {
    ...KEY,
    executor: "firecracker",
    vcpus: 4,
    memoryMiB: 16_384,
    finishedAt: T0,
    source: "firecracker-vmm",
    final: true,
    samples: 120,
    errors: 0,
    durationMs: 600_000,
    cpuP95Vcpus: 1,
    cpuMaxVcpus: 2,
    memoryPeakBytes: 4 * GIB,
    oomKills: 0,
    ...overrides,
  };
}

function runs(count: number, overrides: Partial<RightsizeSample> = {}) {
  return Array.from({ length: count }, (_, index) =>
    sample({ finishedAt: T0 + index, ...overrides }),
  );
}

describe("right-sizing math", () => {
  it("takes the nearest-rank quantile, so a small sample is judged by its worst run", () => {
    expect(nearestRank([], 0.95)).toBe(0);
    expect(nearestRank([3, 1, 2, 5, 4], 0.95)).toBe(5);
    expect(nearestRank([3, 1, 2, 5, 4], 0.5)).toBe(3);
    const hundred = Array.from({ length: 100 }, (_, index) => index + 1);
    expect(nearestRank(hundred, 0.95)).toBe(95);
  });

  it("uses only finished, long enough and mostly readable series", () => {
    expect(qualifies(sample())).toBe(true);
    expect(qualifies(sample({ final: false }))).toBe(false);
    expect(qualifies(sample({ durationMs: 29_999 }))).toBe(false);
    expect(qualifies(sample({ samples: 80, errors: 20 }))).toBe(false);
    expect(qualifies(sample({ samples: 90, errors: 10 }))).toBe(true);
    expect(qualifies(sample({ samples: 0, errors: 0 }))).toBe(false);
  });

  it("reads and writes ADR 0010 names", () => {
    expect(parseProfileName("erainfra-4vcpu-ubuntu-2404")).toEqual({
      canary: false,
      vcpus: 4,
      os: "ubuntu-2404",
      arm: false,
      memoryGiB: null,
      flavour: null,
    });
    expect(parseProfileName("erainfra-canary-16vcpu-ubuntu-2404-arm-32gb")).toEqual({
      canary: true,
      vcpus: 16,
      os: "ubuntu-2404",
      arm: true,
      memoryGiB: 32,
      flavour: null,
    });
    expect(parseProfileName("rc-linux-js")).toBeNull();
    const family = parseProfileName("erainfra-4vcpu-ubuntu-2404-arm")!;
    expect(profileName(family, 8, 32)).toBe("erainfra-8vcpu-ubuntu-2404-arm");
    expect(profileName(family, 2, 16)).toBe("erainfra-2vcpu-ubuntu-2404-arm-16gb");
  });

  it("only moves a job between Profiles that boot the same way", () => {
    const [two, four] = FLEET;
    expect(sameFamily(two, four)).toBe(true);
    expect(sameFamily(four, FLEET[4])).toBe(false); // canary
    expect(sameFamily(four, FLEET[5])).toBe(false); // arm
    expect(sameFamily(four, FLEET[6])).toBe(false); // docker
    // A legacy name falls back to the image it boots.
    const legacy = profile("rc-linux-js", 4, 16);
    expect(sameFamily(legacy, two)).toBe(true);
    expect(
      sameFamily(
        legacy,
        profile("erainfra-2vcpu-ubuntu-2404", 2, 8, {
          imageRelease: "ghcr.io/other/image@sha256:" + "b".repeat(64),
        }),
      ),
    ).toBe(false);
  });

  it("names the smallest standard size that covers a need", () => {
    expect(
      standardSize({ vcpus: 1.2, vcpusAbove: null, memoryBytes: 3 * GIB, memoryAbove: null }),
    ).toEqual({ vcpus: 2, memoryMiB: 8192 });
    expect(standardSize({ vcpus: 1, vcpusAbove: 4, memoryBytes: 0, memoryAbove: null })).toEqual({
      vcpus: 8,
      memoryMiB: 32_768,
    });
    expect(
      standardSize({ vcpus: 4, vcpusAbove: null, memoryBytes: 0, memoryAbove: 16 * GIB }),
    ).toEqual({ vcpus: 4, memoryMiB: 32_768 });
    expect(
      standardSize({ vcpus: 65, vcpusAbove: null, memoryBytes: 0, memoryAbove: null }),
    ).toBeNull();
  });
});

describe("right-sizing recommendations", () => {
  it("waits for enough measured runs before saying anything", () => {
    const result = recommend(KEY, [...runs(MIN_ATTEMPTS - 1), sample({ final: false })], FLEET);
    expect(result.verdict).toBe("insufficient_data");
    expect(result.recommendedProfile).toBeNull();
    expect(result.attempts).toBe(MIN_ATTEMPTS - 1);
    expect(result.excludedAttempts).toBe(1);
    expect(result.explanation).toContain(`needs at least ${MIN_ATTEMPTS}`);
  });

  it("mentions OOM kills even when there is too little data to act on", () => {
    const result = recommend(KEY, runs(2, { oomKills: 1 }), FLEET);
    expect(result.verdict).toBe("insufficient_data");
    expect(result.explanation).toContain("OOM-killed");
  });

  it("downsizes an idle job to the smallest registered Profile with headroom", () => {
    const result = recommend(KEY, runs(8, { cpuP95Vcpus: 1.2, memoryPeakBytes: 5 * GIB }), FLEET);
    expect(result.verdict).toBe("downsize");
    expect(result.recommendedProfile).toBe("erainfra-2vcpu-ubuntu-2404");
    expect(result.target).toEqual({ vcpus: 2, memoryMiB: 8192 });
    expect(result.explanation).toContain("CPU p95 was 1.2 of 4 vCPUs");
    expect(result.explanation).toContain("erainfra-2vcpu-ubuntu-2404 (2 vCPU, 8.0 GiB)");
  });

  it("keeps the job when the smaller Profile would run its CPU above the 70% target", () => {
    // 1.5 / 0.7 = 2.14 vCPUs needed: 2 is not enough.
    const result = recommend(KEY, runs(8, { cpuP95Vcpus: 1.5 }), FLEET);
    expect(result.verdict).toBe("keep");
    expect(result.recommendedProfile).toBeNull();
  });

  it("judges a downsize by the busiest runs, not the typical one", () => {
    const result = recommend(
      KEY,
      [...runs(19, { cpuP95Vcpus: 0.5 }), sample({ cpuP95Vcpus: 2.5, finishedAt: T0 + 99 })],
      FLEET,
    );
    // Nearest-rank p95 of 20 runs is the 19th: 0.5, so one outlier does not block it.
    expect(result.verdict).toBe("downsize");
    const tight = recommend(
      KEY,
      [...runs(10, { cpuP95Vcpus: 0.5 }), ...runs(2, { cpuP95Vcpus: 2.5 })],
      FLEET,
    );
    expect(tight.verdict).toBe("keep");
  });

  it("needs 30% memory headroom on the smaller Profile", () => {
    // 6.5 GiB * 1.3 = 8.45 GiB > 8 GiB.
    const result = recommend(KEY, runs(6, { cpuP95Vcpus: 0.4, memoryPeakBytes: 6.5 * GIB }), FLEET);
    expect(result.recommendedProfile).toBeNull();
    // Only a Profile that keeps 16 GiB qualifies, and none with fewer vCPUs is registered.
    expect(result.verdict).toBe("downsize");
    expect(result.suggestedProfile).toBe("erainfra-1vcpu-ubuntu-2404-16gb");
    expect(result.target).toEqual({ vcpus: 1, memoryMiB: 16_384 });
    // Docker's working set is compared the same way.
    const docker = recommend(
      KEY,
      runs(6, { cpuP95Vcpus: 0.4, memoryPeakBytes: 6 * GIB, source: "cgroup-v2" }),
      FLEET.map((entry) => ({
        ...entry,
        executor: entry.executor === "docker" ? "firecracker" : "docker",
      })),
    );
    expect(docker.verdict).toBe("downsize");
    expect(docker.memory.measure).toBe("working-set");
  });

  it("never treats Firecracker's resident memory as pressure", () => {
    // The VMM's RSS fills the allotment with page cache; that alone must not upsize.
    const result = recommend(
      KEY,
      runs(6, { cpuP95Vcpus: 2, memoryPeakBytes: 16 * GIB - 1 }),
      FLEET,
    );
    expect(result.verdict).toBe("keep");
    expect(result.memory.measure).toBe("host-resident");
    expect(result.explanation).toContain("host-resident, an upper bound");
  });

  it("still lets a Firecracker job shed vCPUs when its memory filled with page cache", () => {
    // A same-memory Profile with fewer vCPUs is the one move resident memory cannot argue with.
    const fleet = [...FLEET, profile("erainfra-2vcpu-ubuntu-2404-16gb", 2, 16)];
    const result = recommend(
      KEY,
      runs(6, { cpuP95Vcpus: 0.6, memoryPeakBytes: 15.5 * GIB }),
      fleet,
    );
    expect(result.verdict).toBe("downsize");
    expect(result.recommendedProfile).toBe("erainfra-2vcpu-ubuntu-2404-16gb");
  });

  it("upsizes memory on any OOM kill and never shrinks it", () => {
    const result = recommend(
      KEY,
      [
        ...runs(5, { cpuP95Vcpus: 0.4, memoryPeakBytes: 2 * GIB }),
        sample({ oomKills: 1, finishedAt: T0 + 50 }),
      ],
      FLEET,
    );
    expect(result.verdict).toBe("upsize");
    // More memory than 16 GiB without giving up vCPUs: the 4 vCPU / 32 GiB Profile, not 8 vCPU.
    expect(result.recommendedProfile).toBe("erainfra-4vcpu-ubuntu-2404-32gb");
    expect(result.memory.oomAttempts).toBe(1);
    expect(result.explanation).toContain("1 run was OOM-killed");
  });

  it("upsizes on Docker memory pressure at 90% of the limit", () => {
    const dockerFleet = FLEET.map((entry) => ({ ...entry, executor: "docker" as const }));
    const result = recommend(
      KEY,
      runs(6, { executor: "docker", source: "cgroup-v1", memoryPeakBytes: 14.9 * GIB }),
      dockerFleet,
    );
    expect(result.verdict).toBe("upsize");
    expect(result.recommendedProfile).toBe("erainfra-4vcpu-ubuntu-2404-32gb");
    expect(result.explanation).toContain("90% or more of its memory");
  });

  it("upsizes CPU only when the typical run is saturated", () => {
    const busy = recommend(KEY, runs(6, { cpuP95Vcpus: 3.8 }), FLEET);
    expect(busy.verdict).toBe("upsize");
    expect(busy.recommendedProfile).toBe("erainfra-8vcpu-ubuntu-2404");
    expect(busy.cpu.saturatedAttempts).toBe(6);
    expect(busy.explanation).toContain("6 of 6 runs held CPU at 90%");

    // Two saturated runs out of six: the median is not, so nothing changes.
    const occasional = recommend(
      KEY,
      [...runs(4, { cpuP95Vcpus: 2 }), ...runs(2, { cpuP95Vcpus: 3.9 })],
      FLEET,
    );
    expect(occasional.verdict).toBe("keep");
  });

  it("names the ADR 0010 Profile to register when none is big enough", () => {
    const small = FLEET.filter((entry) => entry.vcpus <= 4 && entry.memoryMiB <= 16_384);
    const result = recommend(KEY, runs(6, { cpuP95Vcpus: 4 }), small);
    expect(result.verdict).toBe("upsize");
    expect(result.recommendedProfile).toBeNull();
    expect(result.suggestedProfile).toBe("erainfra-8vcpu-ubuntu-2404");
    expect(result.target).toEqual({ vcpus: 8, memoryMiB: 32_768 });
    expect(result.explanation).toContain("register erainfra-8vcpu-ubuntu-2404");
  });

  it("names the ADR 0010 Profile to register when a smaller one would do", () => {
    const onlyFour = FLEET.filter((entry) => entry.name === KEY.profile);
    const result = recommend(
      KEY,
      runs(6, { cpuP95Vcpus: 0.3, memoryPeakBytes: 2 * GIB }),
      onlyFour,
    );
    expect(result.verdict).toBe("downsize");
    expect(result.recommendedProfile).toBeNull();
    expect(result.suggestedProfile).toBe("erainfra-1vcpu-ubuntu-2404");
  });

  it("ignores paused Profiles and leaves a legacy name without a suggestion", () => {
    const paused = FLEET.map((entry) =>
      entry.name === "erainfra-2vcpu-ubuntu-2404" ? { ...entry, state: "paused" as const } : entry,
    );
    expect(recommend(KEY, runs(6, { cpuP95Vcpus: 0.3 }), paused).recommendedProfile).toBeNull();

    const legacyKey = { ...KEY, profile: "rc-linux-js" };
    const legacy = recommend(legacyKey, runs(6, { profile: "rc-linux-js", cpuP95Vcpus: 4 }), [
      profile("rc-linux-js", 4, 16),
    ]);
    expect(legacy.verdict).toBe("upsize");
    expect(legacy.suggestedProfile).toBeNull();
    expect(legacy.explanation).toContain("register one with 8 vCPU, 32 GiB");
  });

  it("falls back to the newest Attempt's size for a Profile no longer registered", () => {
    const result = recommend(
      { ...KEY, profile: "erainfra-4vcpu-ubuntu-2204" },
      runs(6, { profile: "erainfra-4vcpu-ubuntu-2204" }),
      FLEET,
    );
    expect(result.current).toEqual({ vcpus: 4, memoryMiB: 16_384 });
  });

  it("groups by repository, job and Profile and puts upsizes first", () => {
    const all = recommendAll(
      [
        ...runs(6, { cpuP95Vcpus: 0.3 }),
        ...runs(6, { job: "test", cpuP95Vcpus: 3.9 }),
        ...runs(2, { repo: "acme/other" }),
      ],
      FLEET,
    );
    expect(all.map((entry) => [entry.repo, entry.job, entry.verdict])).toEqual([
      ["acme/app", "test", "upsize"],
      ["acme/app", "build", "downsize"],
      ["acme/other", "build", "insufficient_data"],
    ]);
    expect(runsOnMap(all)).toEqual({
      "acme/app": {
        test: { "erainfra-4vcpu-ubuntu-2404": "erainfra-8vcpu-ubuntu-2404" },
        build: { "erainfra-4vcpu-ubuntu-2404": "erainfra-2vcpu-ubuntu-2404" },
      },
    });
  });
});

describe("right-sizing window and query", () => {
  it("never reaches past the metrics retention", () => {
    const now = T0;
    expect(windowStartFor(undefined, now)).toBe(now - MAX_WINDOW_MS);
    expect(windowStartFor(now - 30 * 86_400_000, now)).toBe(now - MAX_WINDOW_MS);
    expect(windowStartFor(now - 86_400_000, now)).toBe(now - 86_400_000);
    expect(windowStartFor(now + 1000, now)).toBe(now);
  });

  it("validates the operator API's parameters", () => {
    const parse = (query: string) => parseRightsizeQuery(new URLSearchParams(query), T0);
    expect(parse("since=7d&repo=acme/app")).toEqual({
      ok: true,
      query: { since: T0 - 7 * 86_400_000, repo: "acme/app" },
    });
    expect(parse("since=soon")).toMatchObject({ ok: false });
    expect(parse("repo=a/b/c")).toMatchObject({ ok: false });
    expect(parse("limit=5")).toEqual({ ok: false, error: "unknown parameter limit" });
  });
});

describe("right-sizing over stored metrics", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
  });
  afterEach(() => vi.useRealTimers());

  async function seed(t: TestConvex<typeof schema>) {
    return t.run(async (ctx) => {
      const machineId = await ctx.db.insert("machines", {
        name: "worker-a",
        os: "linux",
        labels: [],
        maxSlots: 4,
        usedSlots: 0,
        lastSeen: T0,
        token: "machine-token",
      });
      for (const [name, vcpus, memoryGiB] of [
        ["erainfra-2vcpu-ubuntu-2404", 2, 8],
        ["erainfra-4vcpu-ubuntu-2404", 4, 16],
      ] as const) {
        await ctx.db.insert("profiles", {
          name,
          scaleSetName: name,
          executor: "firecracker",
          imageRelease: IMAGE,
          vcpus,
          memoryMiB: memoryGiB * 1024,
          minRunners: 0,
          maxRunners: 2,
          state: "active",
          updatedAt: T0,
        });
      }
      const insert = async (
        index: number,
        fields: {
          repo?: string;
          owner?: string;
          displayName?: string;
          final?: boolean;
          updatedAt?: number;
        },
      ) => {
        const attemptId: Id<"attempts"> = await ctx.db.insert("attempts", {
          profile: "erainfra-4vcpu-ubuntu-2404",
          executor: "firecracker",
          imageRelease: IMAGE,
          vcpus: 4,
          memoryMiB: 16_384,
          runnerName: `runner-${index}`,
          runnerId: index,
          state: "completed",
          machineId,
          createdAt: T0 - 3_600_000,
          finishedAt: T0 - 60_000,
          repo: fields.repo,
          owner: fields.owner,
          displayName: fields.displayName,
        });
        const seriesId = await ctx.db.insert("attemptMetrics", {
          attemptId,
          source: "firecracker-vmm",
          startedAt: T0 - 3_600_000,
          sampleSeconds: 5,
          bucketSeconds: 5,
          samples: 1,
          errors: 0,
          memoryPeakBytes: 0,
          oomKills: 0,
          points: { offset: [], ms: [], cpuMs: [], cpuMaxMilli: [], memBytes: [] },
        });
        await ctx.db.insert("attemptMetricSummaries", {
          attemptId,
          machineId,
          seriesId,
          updatedAt: fields.updatedAt ?? T0 - 60_000,
          source: "firecracker-vmm",
          samples: 120,
          errors: 0,
          final: fields.final ?? true,
          durationMs: 600_000,
          vcpus: 4,
          cpuAvgVcpus: 0.5,
          cpuP95Vcpus: 0.8,
          cpuMaxVcpus: 1.5,
          memoryLimitBytes: 16 * GIB,
          memoryPeakBytes: 3 * GIB,
          oomKills: 0,
        });
      };
      for (let index = 0; index < 6; index += 1) {
        await insert(index, { repo: "app", owner: "acme", displayName: "build" });
      }
      // Not counted: a live series, an unbound Attempt, a series older than the retention.
      await insert(10, { repo: "app", owner: "acme", displayName: "build", final: false });
      await insert(11, {});
      await insert(12, {
        repo: "app",
        owner: "acme",
        displayName: "build",
        updatedAt: T0 - MAX_WINDOW_MS - 1,
      });
      await insert(13, { repo: "other", owner: "acme", displayName: "lint" });
    });
  }

  it("serves the dashboard behind dashboard authentication", async () => {
    const t = convexTest(schema, modules);
    await seed(t);
    await expect(t.query(api.rightsize.report, {})).rejects.toThrow("Authentication required");
    const operator = t.withIdentity({ subject: "operator", issuer: "https://example.test" });
    const report = await operator.query(api.rightsize.report, { sinceDays: 30 });
    expect(report.windowStart).toBe(T0 - MAX_WINDOW_MS);
    expect(report.truncated).toBe(false);
    expect(
      report.recommendations.map((entry) => [entry.repo, entry.job, entry.verdict, entry.attempts]),
    ).toEqual([
      ["acme/app", "build", "downsize", 6],
      ["acme/other", "lint", "insufficient_data", 1],
    ]);
    expect(report.recommendations[0].recommendedProfile).toBe("erainfra-2vcpu-ubuntu-2404");

    const filtered = await operator.query(api.rightsize.report, { repo: "other" });
    expect(filtered.recommendations.map((entry) => entry.repo)).toEqual(["acme/other"]);
  });

  it("reads one repository's runs by its index, past a busier repository's newer ones", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      const machineId = await ctx.db.insert("machines", {
        name: "w",
        os: "linux",
        labels: [],
        maxSlots: 4,
        usedSlots: 0,
        lastSeen: T0,
        token: "t",
      });
      await ctx.db.insert("profiles", {
        name: "erainfra-4vcpu-ubuntu-2404",
        scaleSetName: "erainfra-4vcpu-ubuntu-2404",
        executor: "firecracker",
        imageRelease: IMAGE,
        vcpus: 4,
        memoryMiB: 16_384,
        minRunners: 0,
        maxRunners: 2,
        state: "active",
        updatedAt: T0,
      });
      const add = async (index: number, repo: string, finishedAt: number) => {
        const attemptId = await ctx.db.insert("attempts", {
          profile: "erainfra-4vcpu-ubuntu-2404",
          executor: "firecracker",
          imageRelease: IMAGE,
          vcpus: 4,
          memoryMiB: 16_384,
          runnerName: `r${index}`,
          runnerId: index,
          state: "completed",
          machineId,
          createdAt: finishedAt - 1000,
          finishedAt,
          repo,
          owner: "acme",
          displayName: "build",
        });
        const seriesId = await ctx.db.insert("attemptMetrics", {
          attemptId,
          source: "firecracker-vmm",
          startedAt: finishedAt - 1000,
          sampleSeconds: 5,
          bucketSeconds: 5,
          samples: 1,
          errors: 0,
          memoryPeakBytes: 0,
          oomKills: 0,
          points: { offset: [], ms: [], cpuMs: [], cpuMaxMilli: [], memBytes: [] },
        });
        await ctx.db.insert("attemptMetricSummaries", {
          attemptId,
          machineId,
          seriesId,
          updatedAt: finishedAt,
          source: "firecracker-vmm",
          samples: 120,
          errors: 0,
          final: true,
          durationMs: 600_000,
          vcpus: 4,
          cpuAvgVcpus: 0.5,
          cpuP95Vcpus: 0.8,
          cpuMaxVcpus: 1.5,
          memoryLimitBytes: 16 * GIB,
          memoryPeakBytes: GIB,
          oomKills: 0,
        });
      };
      for (let index = 0; index < 6; index++) await add(index, "quiet", T0 - 3 * 86_400_000);
      for (let index = 0; index < MAX_SCANNED_SUMMARIES + 1; index++) {
        await add(100 + index, "busy", T0 - 86_400_000 + index);
      }
    });
    const operator = t.withIdentity({ subject: "operator", issuer: "https://example.test" });
    // Unfiltered, the busy repository's newer runs fill the scan.
    const all = await operator.query(api.rightsize.report, {});
    expect(all.truncated).toBe(true);
    expect(all.recommendations.map((entry) => entry.repo)).toEqual(["acme/busy"]);
    for (const repo of ["acme/quiet", "quiet", "ACME/QUIET"]) {
      const report = await operator.query(api.rightsize.report, { repo });
      expect(report.truncated).toBe(false);
      expect(report.scanned).toBe(6);
      expect(report.recommendations.map((entry) => [entry.repo, entry.attempts])).toEqual([
        ["acme/quiet", 6],
      ]);
    }
    const otherOwner = await operator.query(api.rightsize.report, { repo: "other/quiet" });
    expect(otherOwner.recommendations).toEqual([]);
    const busy = await operator.query(api.rightsize.report, { repo: "acme/busy" });
    expect(busy.truncated).toBe(true);
    expect(busy.scanned).toBe(MAX_SCANNED_SUMMARIES);
  });

  it("answers /api/v1/rightsize with a read token, including the runs-on map", async () => {
    const { t, token } = await setUpBefore(T0, async () => {
      const harness = convexTest(schema, modules);
      await seed(harness);
      const userId = await harness.run(async (ctx) =>
        ctx.db.insert("users", { email: "op@example.test" }),
      );
      const operator = harness.withIdentity({ subject: `${userId}|session` });
      const minted = await operator.mutation(api.apiTokens.create, {
        name: "read",
        scope: "read",
      });
      return { t: harness, token: minted.token };
    });

    expect((await t.fetch("/api/v1/rightsize", { method: "GET" })).status).toBe(401);
    const bad = await t.fetch("/api/v1/rightsize?since=never", {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(bad.status).toBe(400);

    const response = await t.fetch("/api/v1/rightsize?repo=acme/app&since=7d", {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.window).toEqual({
      start: new Date(T0 - 7 * 86_400_000).toISOString(),
      end: new Date(T0).toISOString(),
    });
    expect(body.policy.minAttempts).toBe(MIN_ATTEMPTS);
    expect(body.recommendations).toHaveLength(1);
    expect(body.recommendations[0]).toMatchObject({
      repo: "acme/app",
      job: "build",
      profile: "erainfra-4vcpu-ubuntu-2404",
      verdict: "downsize",
      recommendedProfile: "erainfra-2vcpu-ubuntu-2404",
      suggestedProfile: null,
      lastSeenAt: new Date(T0 - 60_000).toISOString(),
      cpu: { p95Vcpus: 0.8, maxVcpus: 1.5, saturatedAttempts: 0 },
      memory: { peakBytes: 3 * GIB, measure: "host-resident", oomAttempts: 0 },
    });
    expect(body.map).toEqual({
      "acme/app": { build: { "erainfra-4vcpu-ubuntu-2404": "erainfra-2vcpu-ubuntu-2404" } },
    });
  });
});
