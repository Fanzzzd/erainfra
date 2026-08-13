import { ConvexError, v } from "convex/values";

export const BENCHMARK_VERSION = 1;
export const BENCHMARK_STALE_AFTER_MS = 7 * 24 * 60 * 60_000;
export const NEUTRAL_BENCHMARK_SCORE = 50;

export const fitPolicyValidator = v.union(
  v.literal("balanced"),
  v.literal("cpu"),
  v.literal("network"),
  v.literal("io"),
);

export type FitPolicy = "balanced" | "cpu" | "network" | "io";

export const networkObservationValidator = v.object({
  target: v.union(v.literal("github"), v.literal("ghcr"), v.literal("npm")),
  ttfbMs: v.optional(v.number()),
  throughputMbps: v.optional(v.number()),
  bytes: v.optional(v.number()),
  error: v.optional(v.string()),
});

export const benchmarkReportValidator = v.object({
  version: v.number(),
  measuredAt: v.number(),
  durationMs: v.number(),
  sampleSize: v.number(),
  cpuSha256MiBps: v.optional(v.number()),
  memoryCopyMiBps: v.optional(v.number()),
  diskWriteMiBps: v.optional(v.number()),
  diskReadMiBps: v.optional(v.number()),
  diskFsyncLatencyMs: v.optional(v.number()),
  packageLinkOpsPerSec: v.optional(v.number()),
  network: v.array(networkObservationValidator),
  errors: v.array(v.string()),
});

export const benchmarkScoresValidator = v.object({
  cpu: v.number(),
  memory: v.number(),
  disk: v.number(),
  network: v.number(),
  balanced: v.number(),
});

export const benchmarkSummaryValidator = v.object({
  measuredAt: v.number(),
  scores: benchmarkScoresValidator,
});

export const storedBenchmarkValidator = v.object({
  version: v.number(),
  measuredAt: v.number(),
  reportedAt: v.number(),
  durationMs: v.number(),
  sampleSize: v.number(),
  cpuSha256MiBps: v.optional(v.number()),
  memoryCopyMiBps: v.optional(v.number()),
  diskWriteMiBps: v.optional(v.number()),
  diskReadMiBps: v.optional(v.number()),
  diskFsyncLatencyMs: v.optional(v.number()),
  packageLinkOpsPerSec: v.optional(v.number()),
  network: v.array(networkObservationValidator),
  errors: v.array(v.string()),
  confidence: v.union(v.literal("complete"), v.literal("partial"), v.literal("failed")),
  scores: benchmarkScoresValidator,
});

export type BenchmarkReport = {
  version: number;
  measuredAt: number;
  durationMs: number;
  sampleSize: number;
  cpuSha256MiBps?: number;
  memoryCopyMiBps?: number;
  diskWriteMiBps?: number;
  diskReadMiBps?: number;
  diskFsyncLatencyMs?: number;
  packageLinkOpsPerSec?: number;
  network: Array<{
    target: "github" | "ghcr" | "npm";
    ttfbMs?: number;
    throughputMbps?: number;
    bytes?: number;
    error?: string;
  }>;
  errors: string[];
};

export type StoredBenchmark = BenchmarkReport & {
  reportedAt: number;
  confidence: "complete" | "partial" | "failed";
  scores: {
    cpu: number;
    memory: number;
    disk: number;
    network: number;
    balanced: number;
  };
};

export type BenchmarkSummary = Pick<StoredBenchmark, "measuredAt" | "scores">;

export function isStoredBenchmark(
  benchmark: BenchmarkSummary | StoredBenchmark | undefined,
): benchmark is StoredBenchmark {
  return benchmark !== undefined && "reportedAt" in benchmark;
}

function boundedNumber(value: number | undefined, name: string, minimum: number, maximum: number) {
  if (value !== undefined && (!Number.isFinite(value) || value < minimum || value > maximum)) {
    throw new ConvexError(`${name} is outside the accepted benchmark range`);
  }
}

export function validateBenchmarkReport(report: BenchmarkReport, now: number) {
  if (report.version !== BENCHMARK_VERSION) {
    throw new ConvexError(`Unsupported benchmark version ${report.version}`);
  }
  if (
    !Number.isSafeInteger(report.measuredAt) ||
    report.measuredAt < 1 ||
    report.measuredAt > now + 5 * 60_000
  ) {
    throw new ConvexError("Invalid benchmark measurement time");
  }
  if (
    !Number.isSafeInteger(report.durationMs) ||
    report.durationMs < 1 ||
    report.durationMs > 120_000 ||
    !Number.isSafeInteger(report.sampleSize) ||
    report.sampleSize < 1 ||
    report.sampleSize > 16
  ) {
    throw new ConvexError("Invalid benchmark duration or sample count");
  }
  boundedNumber(report.cpuSha256MiBps, "CPU throughput", 0.01, 1_000_000);
  boundedNumber(report.memoryCopyMiBps, "memory throughput", 0.01, 10_000_000);
  boundedNumber(report.diskWriteMiBps, "disk write throughput", 0.01, 1_000_000);
  boundedNumber(report.diskReadMiBps, "disk read throughput", 0.01, 1_000_000);
  boundedNumber(report.diskFsyncLatencyMs, "disk fsync latency", 0, 120_000);
  boundedNumber(report.packageLinkOpsPerSec, "package-link throughput", 0.01, 10_000_000);
  if (
    report.network.length > 3 ||
    new Set(report.network.map((row) => row.target)).size !== report.network.length
  ) {
    throw new ConvexError("Benchmark network targets must be unique and bounded");
  }
  for (const observation of report.network) {
    boundedNumber(observation.ttfbMs, `${observation.target} TTFB`, 0, 120_000);
    boundedNumber(
      observation.throughputMbps,
      `${observation.target} throughput`,
      0.000_1,
      1_000_000,
    );
    boundedNumber(observation.bytes, `${observation.target} byte count`, 0, 1_048_576);
    if (observation.bytes !== undefined && !Number.isSafeInteger(observation.bytes)) {
      throw new ConvexError("Benchmark network byte counts must be integers");
    }
    if (observation.error !== undefined && observation.error.length > 256) {
      throw new ConvexError("Benchmark network errors must fit within 256 characters");
    }
  }
  if (report.errors.length > 8 || report.errors.some((error) => error.length > 256)) {
    throw new ConvexError("Benchmark errors must contain at most 8 bounded messages");
  }
}

function clampScore(value: number) {
  return Math.round(Math.min(100, Math.max(0, value)));
}

function higherIsBetter(value: number | undefined, poor: number, good: number) {
  if (value === undefined) return NEUTRAL_BENCHMARK_SCORE;
  return clampScore(((value - poor) / (good - poor)) * 100);
}

function lowerIsBetter(value: number | undefined, good: number, poor: number) {
  if (value === undefined) return NEUTRAL_BENCHMARK_SCORE;
  return clampScore(((poor - value) / (poor - good)) * 100);
}

function average(values: number[]) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function normalizeBenchmark(report: BenchmarkReport, reportedAt: number): StoredBenchmark {
  validateBenchmarkReport(report, reportedAt);
  const cpu = higherIsBetter(report.cpuSha256MiBps, 100, 1_500);
  const memory = higherIsBetter(report.memoryCopyMiBps, 1_000, 20_000);
  const disk = clampScore(
    average([
      higherIsBetter(report.diskWriteMiBps, 25, 1_000),
      higherIsBetter(report.diskReadMiBps, 50, 2_000),
      lowerIsBetter(report.diskFsyncLatencyMs, 1, 50),
      higherIsBetter(report.packageLinkOpsPerSec, 100, 20_000),
    ]),
  );
  const networkRows = report.network.filter(
    (row) => row.ttfbMs !== undefined || row.throughputMbps !== undefined,
  );
  const network =
    networkRows.length === 0
      ? NEUTRAL_BENCHMARK_SCORE
      : clampScore(
          average(
            networkRows.map((row) =>
              average([
                lowerIsBetter(row.ttfbMs, 75, 1_500),
                higherIsBetter(row.throughputMbps, 1, 100),
              ]),
            ),
          ),
        );
  const scores = {
    cpu,
    memory,
    disk,
    network,
    balanced: clampScore(average([cpu, memory, disk, network])),
  };
  const hasCPU = report.cpuSha256MiBps !== undefined;
  const hasMemory = report.memoryCopyMiBps !== undefined;
  const hasDisk =
    report.diskWriteMiBps !== undefined &&
    report.diskReadMiBps !== undefined &&
    report.diskFsyncLatencyMs !== undefined;
  const hasPackageLink = report.packageLinkOpsPerSec !== undefined;
  const hasNetwork = networkRows.length >= 2;
  const measuredDimensions = [hasCPU, hasMemory, hasDisk && hasPackageLink, hasNetwork].filter(
    Boolean,
  ).length;
  const confidence =
    measuredDimensions === 4 && report.errors.length === 0
      ? "complete"
      : measuredDimensions === 0
        ? "failed"
        : "partial";
  return { ...report, reportedAt, confidence, scores };
}

export function benchmarkScore(
  benchmark: BenchmarkSummary | undefined,
  policy: FitPolicy,
  now: number,
) {
  if (benchmark === undefined) {
    return { score: NEUTRAL_BENCHMARK_SCORE, source: "missing" as const };
  }
  if (now - benchmark.measuredAt >= BENCHMARK_STALE_AFTER_MS) {
    return { score: NEUTRAL_BENCHMARK_SCORE, source: "stale" as const };
  }
  const score =
    policy === "cpu"
      ? benchmark.scores.cpu
      : policy === "network"
        ? benchmark.scores.network
        : policy === "io"
          ? benchmark.scores.disk
          : benchmark.scores.balanced;
  return { score, source: "fresh" as const };
}

export function resourceRecommendedSlots(
  os: "linux" | "mac" | "win",
  cpus: number,
  memoryMiB: number,
) {
  const cpuSlots = Math.max(1, Math.floor(cpus / 4));
  const memorySlots = Math.max(1, Math.floor(memoryMiB / 8_192));
  return os === "linux"
    ? Math.min(16, cpuSlots, memorySlots)
    : os === "mac"
      ? Math.min(2, cpuSlots, memorySlots)
      : 1;
}

export function benchmarkRecommendedSlots(
  resourceSlots: number,
  benchmark: StoredBenchmark | undefined,
  now: number,
) {
  if (benchmark === undefined || now - benchmark.measuredAt >= BENCHMARK_STALE_AFTER_MS) {
    return resourceSlots;
  }
  const measuredScores: number[] = [];
  if (benchmark.cpuSha256MiBps !== undefined) measuredScores.push(benchmark.scores.cpu);
  if (benchmark.memoryCopyMiBps !== undefined) measuredScores.push(benchmark.scores.memory);
  if (
    benchmark.diskWriteMiBps !== undefined ||
    benchmark.diskReadMiBps !== undefined ||
    benchmark.diskFsyncLatencyMs !== undefined ||
    benchmark.packageLinkOpsPerSec !== undefined
  ) {
    measuredScores.push(benchmark.scores.disk);
  }
  if (
    benchmark.network.some((row) => row.ttfbMs !== undefined || row.throughputMbps !== undefined)
  ) {
    measuredScores.push(benchmark.scores.network);
  }
  if (measuredScores.length === 0) return resourceSlots;
  // Benchmarks can conservatively reduce automatic fan-out, never inflate the
  // hard CPU/memory cap. A weak dimension can take a host down to one quarter
  // of that envelope, which addresses high-core hosts backed by slow disks.
  const weakest = Math.min(...measuredScores);
  const factor = 0.25 + (weakest / 100) * 0.75;
  return Math.max(1, Math.min(resourceSlots, Math.floor(resourceSlots * factor)));
}
