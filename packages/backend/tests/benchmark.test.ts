import { describe, expect, it } from "vitest";

import {
  BENCHMARK_STALE_AFTER_MS,
  benchmarkRecommendedSlots,
  benchmarkScore,
  normalizeBenchmark,
  resourceRecommendedSlots,
} from "../convex/benchmark";

const NOW = 1_786_300_000_000;

function report(overrides: Partial<Parameters<typeof normalizeBenchmark>[0]> = {}) {
  return {
    version: 1,
    measuredAt: NOW - 1_000,
    durationMs: 10_000,
    sampleSize: 1,
    cpuSha256MiBps: 800,
    memoryCopyMiBps: 10_000,
    diskWriteMiBps: 500,
    diskReadMiBps: 1_000,
    diskFsyncLatencyMs: 5,
    packageLinkOpsPerSec: 5_000,
    network: [
      { target: "github" as const, ttfbMs: 100, throughputMbps: 50, bytes: 1_024 },
      { target: "ghcr" as const, ttfbMs: 120, throughputMbps: 40, bytes: 1_024 },
    ],
    errors: [],
    ...overrides,
  };
}

describe("worker benchmark policy", () => {
  it("normalizes bounded raw observations into transparent dimension scores", () => {
    const benchmark = normalizeBenchmark(report(), NOW);
    expect(benchmark.confidence).toBe("complete");
    expect(benchmark.scores).toEqual({
      cpu: expect.any(Number),
      memory: expect.any(Number),
      disk: expect.any(Number),
      network: expect.any(Number),
      balanced: expect.any(Number),
    });
    expect(Object.values(benchmark.scores).every((score) => score >= 0 && score <= 100)).toBe(true);
  });

  it("rejects non-finite, oversized, duplicate, or future observations", () => {
    expect(() => normalizeBenchmark(report({ cpuSha256MiBps: Number.NaN }), NOW)).toThrow(
      /CPU throughput/,
    );
    expect(() =>
      normalizeBenchmark(
        report({
          network: [
            { target: "github", bytes: 1 },
            { target: "github", bytes: 1 },
          ],
        }),
        NOW,
      ),
    ).toThrow(/unique and bounded/);
    expect(() => normalizeBenchmark(report({ measuredAt: NOW + 6 * 60_000 }), NOW)).toThrow(
      /measurement time/,
    );
  });

  it("uses neutral ranking for missing and stale scores", () => {
    expect(benchmarkScore(undefined, "cpu", NOW)).toEqual({ score: 50, source: "missing" });
    const stale = normalizeBenchmark(report({ measuredAt: NOW - BENCHMARK_STALE_AFTER_MS }), NOW);
    expect(benchmarkScore(stale, "network", NOW)).toEqual({ score: 50, source: "stale" });
  });

  it("can only reduce the hard resource recommendation and keeps missing data unchanged", () => {
    expect(benchmarkRecommendedSlots(16, undefined, NOW)).toBe(16);
    const weakDisk = normalizeBenchmark(
      report({ diskWriteMiBps: 5, diskReadMiBps: 10, diskFsyncLatencyMs: 100 }),
      NOW,
    );
    expect(benchmarkRecommendedSlots(16, weakDisk, NOW)).toBe(4);
  });

  it("never lets network latency shrink a Worker's slot envelope", () => {
    const farFromGitHub = normalizeBenchmark(
      report({
        network: [
          { target: "github" as const, ttfbMs: 1_400, throughputMbps: 2, bytes: 1_024 },
          { target: "ghcr" as const, ttfbMs: 1_400, throughputMbps: 2, bytes: 1_024 },
          { target: "npm" as const, ttfbMs: 1_400, throughputMbps: 2, bytes: 1_024 },
        ],
      }),
      NOW,
    );
    const nextToGitHub = normalizeBenchmark(report(), NOW);
    expect(farFromGitHub.scores.network).toBeLessThan(10);
    expect(farFromGitHub.scores.network).toBeLessThan(nextToGitHub.scores.network);
    expect(benchmarkRecommendedSlots(16, farFromGitHub, NOW)).toBe(
      benchmarkRecommendedSlots(16, nextToGitHub, NOW),
    );
    expect(benchmarkScore(farFromGitHub, "network", NOW).score).toBe(farFromGitHub.scores.network);
  });

  // ubuntu0 on 2026-11-09: a 64-core Xeon Gold 6444Y scored cpu 100, disk 46, memory 12 and
  // was cut from 16 slots to 5. The memory probe is one thread copying one buffer, which says
  // nothing about how many 4-vCPU guests a many-core host can carry.
  it("never lets the single-thread memory score shrink a Worker's slot envelope", () => {
    const serverPart = normalizeBenchmark(
      report({ cpuSha256MiBps: 1_500, memoryCopyMiBps: 3_280, diskWriteMiBps: 400 }),
      NOW,
    );
    const desktopPart = normalizeBenchmark(
      report({ cpuSha256MiBps: 1_500, memoryCopyMiBps: 20_000, diskWriteMiBps: 400 }),
      NOW,
    );
    expect(serverPart.scores.memory).toBe(12);
    expect(serverPart.scores.disk).toBe(desktopPart.scores.disk);
    expect(serverPart.scores.disk).toBeLessThan(serverPart.scores.cpu);
    expect(benchmarkRecommendedSlots(16, serverPart, NOW)).toBe(
      benchmarkRecommendedSlots(16, desktopPart, NOW),
    );
    // The weakest remaining dimension, disk, still sets the factor.
    expect(benchmarkRecommendedSlots(16, serverPart, NOW)).toBe(
      Math.floor(16 * (0.25 + (serverPart.scores.disk / 100) * 0.75)),
    );
    // The memory score still ranks candidates through the balanced score.
    expect(benchmarkScore(serverPart, "balanced", NOW).score).toBeLessThan(
      benchmarkScore(desktopPart, "balanced", NOW).score,
    );
  });

  it("uses the shared resource policy with and without memory discovery", () => {
    expect(resourceRecommendedSlots("linux", 64, 256 * 1_024)).toBe(16);
    expect(resourceRecommendedSlots("linux", 32, undefined)).toBe(8);
    expect(resourceRecommendedSlots("mac", 32, undefined)).toBe(2);
    expect(resourceRecommendedSlots("win", 32, undefined)).toBe(1);
  });

  // At a flat 8 GiB a slot, a 251 GiB host serving 16 GiB Profiles was offered 16 slots, which
  // is 256 GiB of guests.
  it("sizes the memory envelope by the largest Profile the Worker serves", () => {
    expect(resourceRecommendedSlots("linux", 64, 251 * 1_024)).toBe(16);
    expect(resourceRecommendedSlots("linux", 64, 251 * 1_024, 16 * 1_024)).toBe(15);
    expect(resourceRecommendedSlots("linux", 64, 251 * 1_024, 32 * 1_024)).toBe(7);
    expect(resourceRecommendedSlots("mac", 16, 48 * 1_024, 32 * 1_024)).toBe(1);
  });
});
