import { ConvexError, v, type Infer } from "convex/values";

/**
 * Per-Attempt resource metrics: CPU, memory, network and disk over the job, measured on the
 * Worker from outside the boundary (the VMM process and its tap for Firecracker, the container's
 * cgroup for Docker) and uploaded by the Action Runner Agent. The Go side
 * (`apps/runtime/internal/jobmetrics`) samples and downsamples; this module holds the document's
 * shape, its bounds and the summary math, and `attemptMetrics.ts` stores and expires it.
 *
 * Nothing here touches the database, so the schema can import the validators.
 */

/** The Go Series' own bound. A snapshot with more points did not come from it. */
export const MAX_METRIC_POINTS = 360;
/** How long a series is kept after its last upload. */
export const METRICS_RETENTION_MS = 14 * 24 * 60 * 60_000;
/**
 * How long after an Attempt settles its Worker may still upload. The final snapshot normally
 * arrives within seconds of the executor exiting, behind `reportAttempt`; the margin covers a
 * Worker that lost its connection at that moment. Past it, nothing writes to the Attempt again.
 */
export const METRICS_LATE_REPORT_MS = 15 * 60_000;
/** The Runs page asks for at most this many summaries at once: its own row bound. */
export const MAX_SUMMARY_LOOKUP = 200;
const MAX_SOURCE_LENGTH = 32;
const MIB = 1024 * 1024;

export const pointsValidator = v.object({
  offset: v.array(v.number()),
  ms: v.array(v.number()),
  cpuMs: v.array(v.number()),
  cpuMaxMilli: v.array(v.number()),
  memBytes: v.array(v.number()),
  netRxBytes: v.optional(v.array(v.number())),
  netTxBytes: v.optional(v.array(v.number())),
  diskReadBytes: v.optional(v.array(v.number())),
  diskWriteBytes: v.optional(v.array(v.number())),
});

/** `jobmetrics.Snapshot`, version 1, field for field. */
export const metricsSnapshotValidator = v.object({
  version: v.literal(1),
  source: v.string(),
  startedAt: v.number(),
  sampleSeconds: v.number(),
  bucketSeconds: v.number(),
  samples: v.number(),
  errors: v.number(),
  lastError: v.optional(v.string()),
  memoryPeakBytes: v.number(),
  oomKills: v.union(v.number(), v.null()),
  points: pointsValidator,
});
export type MetricsSnapshot = Infer<typeof metricsSnapshotValidator>;

/** What the series table stores: the snapshot, minus its wire version, keyed by Attempt. */
export const attemptMetricsFields = {
  attemptId: v.id("attempts"),
  source: v.string(),
  startedAt: v.number(),
  sampleSeconds: v.number(),
  bucketSeconds: v.number(),
  samples: v.number(),
  errors: v.number(),
  lastError: v.optional(v.string()),
  memoryPeakBytes: v.number(),
  oomKills: v.union(v.number(), v.null()),
  points: pointsValidator,
};

const summaryValueFields = {
  source: v.string(),
  samples: v.number(),
  errors: v.number(),
  final: v.boolean(),
  durationMs: v.number(),
  vcpus: v.number(),
  cpuAvgVcpus: v.number(),
  cpuP95Vcpus: v.number(),
  cpuMaxVcpus: v.number(),
  memoryLimitBytes: v.number(),
  memoryPeakBytes: v.number(),
  netRxBytes: v.optional(v.number()),
  netTxBytes: v.optional(v.number()),
  diskReadBytes: v.optional(v.number()),
  diskWriteBytes: v.optional(v.number()),
  oomKills: v.union(v.number(), v.null()),
};

/**
 * The summary row is separate from the series so the Runs page reads 200 small rows rather
 * than 200 series, and so an upload's idempotency check reads the small row only.
 */
export const attemptMetricSummaryFields = {
  attemptId: v.id("attempts"),
  machineId: v.id("machines"),
  seriesId: v.id("attemptMetrics"),
  updatedAt: v.number(),
  ...summaryValueFields,
};

export const summaryValidator = v.object(summaryValueFields);
export type AttemptMetricsSummary = Infer<typeof summaryValidator>;

function sum(values: readonly number[] | undefined) {
  return values?.reduce((total, value) => total + value, 0);
}

/**
 * The time-weighted quantile of per-bucket CPU, in vCPUs. Each point weighs as much as the
 * wall-clock time it covered, so a partial last bucket counts for what it measured. This is the
 * p95 of bucket averages: a burst shorter than a bucket is averaged into it, which is why the
 * busiest single sample interval is reported beside it as the maximum.
 */
export function weightedQuantile(
  points: ReadonlyArray<{ value: number; weight: number }>,
  quantile: number,
) {
  const weighted = points.filter((point) => point.weight > 0);
  if (weighted.length === 0) return 0;
  const sorted = weighted.toSorted((left, right) => left.value - right.value);
  const total = sum(sorted.map((point) => point.weight)) ?? 0;
  let cumulative = 0;
  for (const point of sorted) {
    cumulative += point.weight;
    if (cumulative >= quantile * total) return point.value;
  }
  return sorted[sorted.length - 1].value;
}

/**
 * The per-Attempt numbers the Runs page and the Attempt page lead with. What was allotted comes
 * from the Attempt row, which the control plane wrote, never from the upload.
 */
export function summarizeMetrics(
  snapshot: Pick<MetricsSnapshot, "points" | "memoryPeakBytes" | "oomKills" | "source"> &
    Partial<Pick<MetricsSnapshot, "samples" | "errors">>,
  allotted: { vcpus: number; memoryMiB: number },
  final: boolean,
): AttemptMetricsSummary {
  const { points } = snapshot;
  const durationMs = sum(points.ms) ?? 0;
  const cpuMs = sum(points.cpuMs) ?? 0;
  const perBucket = points.ms.map((ms, index) => ({
    value: ms > 0 ? (points.cpuMs[index] ?? 0) / ms : 0,
    weight: ms,
  }));
  const busiestBucket = Math.max(0, ...perBucket.map((point) => point.value));
  const busiestInterval = Math.max(0, ...points.cpuMaxMilli) / 1000;
  return {
    source: snapshot.source,
    samples: snapshot.samples ?? 0,
    errors: snapshot.errors ?? 0,
    final,
    durationMs,
    vcpus: allotted.vcpus,
    cpuAvgVcpus: durationMs > 0 ? cpuMs / durationMs : 0,
    cpuP95Vcpus: weightedQuantile(perBucket, 0.95),
    cpuMaxVcpus: Math.max(busiestBucket, busiestInterval),
    memoryLimitBytes: allotted.memoryMiB * MIB,
    memoryPeakBytes: Math.max(snapshot.memoryPeakBytes, ...points.memBytes),
    netRxBytes: sum(points.netRxBytes),
    netTxBytes: sum(points.netTxBytes),
    diskReadBytes: sum(points.diskReadBytes),
    diskWriteBytes: sum(points.diskWriteBytes),
    oomKills: snapshot.oomKills,
  };
}

function isCount(value: number) {
  return Number.isSafeInteger(value) && value >= 0;
}

/**
 * Refuses anything the Go Series could not have produced. The bounds are what keep one
 * Attempt's documents small whatever a Worker sends: at most 360 points in each of at most nine
 * columns, every value a non-negative integer, and offsets inside the bounded span.
 */
function fail(reason: string): never {
  throw new ConvexError(`Invalid metrics snapshot: ${reason}`);
}

export function assertValidSnapshot(snapshot: MetricsSnapshot, now: number) {
  if (snapshot.source.length === 0 || snapshot.source.length > MAX_SOURCE_LENGTH) {
    fail("source must be 1-32 characters");
  }
  if (
    !isCount(snapshot.sampleSeconds) ||
    snapshot.sampleSeconds < 1 ||
    snapshot.sampleSeconds > 3600
  ) {
    fail("sampleSeconds must be an integer between 1 and 3600");
  }
  if (
    !isCount(snapshot.bucketSeconds) ||
    snapshot.bucketSeconds < snapshot.sampleSeconds ||
    snapshot.bucketSeconds > 86_400
  ) {
    fail("bucketSeconds must be an integer between sampleSeconds and 86400");
  }
  if (!isCount(snapshot.samples) || snapshot.samples < 1)
    fail("samples must be a positive integer");
  if (!isCount(snapshot.errors)) fail("errors must be a non-negative integer");
  if (!isCount(snapshot.memoryPeakBytes)) fail("memoryPeakBytes must be a non-negative integer");
  if (snapshot.oomKills !== null && !isCount(snapshot.oomKills)) {
    fail("oomKills must be a non-negative integer or null");
  }
  if (!isCount(snapshot.startedAt) || snapshot.startedAt > now + 60 * 60_000) {
    fail("startedAt must be a past Unix millisecond time");
  }
  const { points } = snapshot;
  const length = points.offset.length;
  if (length > MAX_METRIC_POINTS) fail(`at most ${MAX_METRIC_POINTS} points`);
  const columns: Array<[string, number[] | undefined]> = Object.entries(points);
  for (const [name, column] of columns) {
    if (column === undefined) continue;
    if (column.length !== length)
      fail(`${name} has ${column.length} entries, offset has ${length}`);
    if (!column.every(isCount)) fail(`${name} must hold non-negative integers`);
  }
  if ((points.netRxBytes === undefined) !== (points.netTxBytes === undefined)) {
    fail("network columns come in pairs");
  }
  if ((points.diskReadBytes === undefined) !== (points.diskWriteBytes === undefined)) {
    fail("disk columns come in pairs");
  }
  for (let index = 0; index < length; index += 1) {
    const offset = points.offset[index];
    if (offset % snapshot.bucketSeconds !== 0) fail("offsets must fall on bucket boundaries");
    if (offset >= MAX_METRIC_POINTS * snapshot.bucketSeconds)
      fail("offset beyond the bounded span");
    if (index > 0 && offset <= points.offset[index - 1]) fail("offsets must increase");
  }
}
