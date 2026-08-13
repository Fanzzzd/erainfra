import { describe, expect, it } from "vitest";
import {
  BENCHMARK_STALE_AFTER_MS,
  benchmarkRecommendedSlots,
  benchmarkScore,
  normalizeBenchmark,
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
});
