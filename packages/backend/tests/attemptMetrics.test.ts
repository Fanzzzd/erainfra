import { convexTest, type TestConvex } from "convex-test";
import { describe, expect, it } from "vitest";

import { api, internal } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import {
  MAX_METRIC_POINTS,
  METRICS_LATE_REPORT_MS,
  METRICS_RETENTION_MS,
  summarizeMetrics,
  weightedQuantile,
  type MetricsSnapshot,
} from "../convex/attemptMetricsModel";
import schema from "../convex/schema";

const modules = import.meta.glob("../convex/**/*.ts");
const OPERATOR = { subject: "operator", issuer: "https://example.test" };
const IMAGE = `ghcr.io/fanzzzd/runner@sha256:${"a".repeat(64)}`;
const GIB = 1024 ** 3;

/** A snapshot as `jobmetrics.Snapshot` encodes one: `count` five-second buckets at 2 vCPUs. */
function snapshot(count: number, overrides: Partial<MetricsSnapshot> = {}): MetricsSnapshot {
  const columns = (value: number) => Array.from({ length: count }, () => value);
  return {
    version: 1,
    source: "cgroup-v2",
    startedAt: Date.now() - count * 5000,
    sampleSeconds: 5,
    bucketSeconds: 5,
    samples: count + 1,
    errors: 0,
    memoryPeakBytes: 3 * GIB,
    oomKills: 0,
    points: {
      offset: Array.from({ length: count }, (_, index) => index * 5),
      ms: columns(5000),
      cpuMs: columns(10_000),
      cpuMaxMilli: columns(2500),
      memBytes: columns(2 * GIB),
      netRxBytes: columns(1000),
      netTxBytes: columns(100),
      diskReadBytes: columns(4096),
      diskWriteBytes: columns(8192),
    },
    ...overrides,
  };
}

async function setup(t: TestConvex<typeof schema>) {
  return await t.run(async (ctx) => {
    const machine = {
      os: "linux" as const,
      labels: [],
      maxSlots: 2,
      usedSlots: 1,
      lastSeen: Date.now(),
    };
    const machineId = await ctx.db.insert("machines", {
      ...machine,
      name: "linux-a",
      token: "machine-token",
    });
    await ctx.db.insert("machines", { ...machine, name: "linux-b", token: "other-token" });
    const attemptId = await ctx.db.insert("attempts", {
      profile: "erainfra-4vcpu-ubuntu-2404",
      executor: "docker",
      imageRelease: IMAGE,
      vcpus: 4,
      memoryMiB: 16_384,
      runnerName: "erainfra-4vcpu-ubuntu-2404-1",
      runnerId: 1,
      state: "running",
      machineId,
      createdAt: Date.now(),
      startedAt: Date.now(),
    });
    return { machineId, attemptId };
  });
}

async function report(
  t: TestConvex<typeof schema>,
  attemptId: Id<"attempts">,
  body: MetricsSnapshot,
  final = false,
  token = "machine-token",
) {
  return await t.mutation(api.workerApi.reportAttemptMetrics, {
    token,
    attemptId,
    final,
    snapshot: body,
  });
}

async function stored(t: TestConvex<typeof schema>) {
  return await t.run(async (ctx) => ({
    series: await ctx.db.query("attemptMetrics").collect(),
    summaries: await ctx.db.query("attemptMetricSummaries").collect(),
  }));
}

describe("Attempt metrics ingestion", () => {
  it("accepts a snapshot only from the Worker that runs the Attempt", async () => {
    const t = convexTest(schema, modules);
    const { attemptId } = await setup(t);
    await expect(report(t, attemptId, snapshot(3), false, "forged")).rejects.toThrow(
      "Invalid machine token",
    );
    expect(await report(t, attemptId, snapshot(3), false, "other-token")).toBe(false);
    expect((await stored(t)).series).toHaveLength(0);

    expect(await report(t, attemptId, snapshot(3))).toBe(true);
    const { series, summaries } = await stored(t);
    expect(series).toHaveLength(1);
    expect(summaries).toHaveLength(1);
    expect(summaries[0]!.seriesId).toBe(series[0]!._id);
  });

  it("keeps the dashboard queries behind dashboard authentication", async () => {
    const t = convexTest(schema, modules);
    const { attemptId } = await setup(t);
    await report(t, attemptId, snapshot(3));
    await expect(t.query(api.attemptMetrics.get, { attemptId })).rejects.toThrow(
      "Authentication required",
    );
    await expect(
      t.query(api.attemptMetrics.summaries, { attemptIds: [attemptId] }),
    ).rejects.toThrow("Authentication required");

    const operator = t.withIdentity(OPERATOR);
    const page = await operator.query(api.attemptMetrics.get, { attemptId });
    expect(page?.attempt.machineName).toBe("linux-a");
    expect(page?.series?.points.offset).toEqual([0, 5, 10]);
    expect(page?.summary?.vcpus).toBe(4);
    const list = await operator.query(api.attemptMetrics.summaries, {
      attemptIds: [attemptId, attemptId],
    });
    expect(list).toHaveLength(1);
    await expect(
      operator.query(api.attemptMetrics.summaries, {
        attemptIds: Array.from({ length: 201 }, () => attemptId),
      }),
    ).rejects.toThrow("at most 200");
  });

  it.each([
    ["more points than the Go series keeps", snapshot(MAX_METRIC_POINTS + 1), "at most 360"],
    [
      "columns of different lengths",
      { ...snapshot(3), points: { ...snapshot(3).points, cpuMs: [1, 2] } },
      "cpuMs has 2 entries",
    ],
    [
      "a negative counter",
      { ...snapshot(2), points: { ...snapshot(2).points, netRxBytes: [1, -1] } },
      "non-negative integers",
    ],
    [
      "a fractional counter",
      { ...snapshot(2), points: { ...snapshot(2).points, memBytes: [1.5, 2] } },
      "non-negative integers",
    ],
    [
      "an offset off the bucket grid",
      { ...snapshot(2), points: { ...snapshot(2).points, offset: [0, 7] } },
      "bucket boundaries",
    ],
    [
      "offsets out of order",
      { ...snapshot(2), points: { ...snapshot(2).points, offset: [5, 0] } },
      "must increase",
    ],
    [
      "an offset past the bounded span",
      { ...snapshot(1), points: { ...snapshot(1).points, offset: [MAX_METRIC_POINTS * 5] } },
      "bounded span",
    ],
    [
      "half a network pair",
      { ...snapshot(1), points: { ...snapshot(1).points, netTxBytes: undefined } },
      "pairs",
    ],
    ["a bucket narrower than a sample", snapshot(1, { bucketSeconds: 1 }), "bucketSeconds"],
    ["no samples", snapshot(0, { samples: 0 }), "samples"],
    [
      "a start in the future",
      snapshot(1, { startedAt: Date.now() + 2 * 60 * 60_000 }),
      "startedAt",
    ],
  ])("refuses %s", async (_name, body, message) => {
    const t = convexTest(schema, modules);
    const { attemptId } = await setup(t);
    await expect(report(t, attemptId, body)).rejects.toThrow(message);
    expect((await stored(t)).series).toHaveLength(0);
  });

  it("truncates an overlong last error rather than storing it whole", async () => {
    const t = convexTest(schema, modules);
    const { attemptId } = await setup(t);
    await report(t, attemptId, snapshot(1, { errors: 1, lastError: "x".repeat(5000) }));
    expect((await stored(t)).series[0]!.lastError).toHaveLength(200);
  });

  it("treats uploads as idempotent whole snapshots ordered by sample count", async () => {
    const t = convexTest(schema, modules);
    const { attemptId } = await setup(t);
    expect(await report(t, attemptId, snapshot(4))).toBe(true);
    const first = await stored(t);

    // A replay changes nothing.
    expect(await report(t, attemptId, snapshot(4))).toBe(true);
    const replayed = await stored(t);
    expect(replayed.summaries[0]!.updatedAt).toBe(first.summaries[0]!.updatedAt);
    expect(replayed.series).toHaveLength(1);

    // An older upload that arrives late is ignored.
    expect(await report(t, attemptId, snapshot(2))).toBe(true);
    expect((await stored(t)).series[0]!.points.offset).toHaveLength(4);

    // A newer one replaces the series in place.
    expect(await report(t, attemptId, snapshot(6))).toBe(true);
    let current = await stored(t);
    expect(current.series).toHaveLength(1);
    expect(current.series[0]!._id).toBe(first.series[0]!._id);
    expect(current.series[0]!.points.offset).toHaveLength(6);

    // The final upload may carry no new sample and still marks the series final.
    expect(await report(t, attemptId, snapshot(6), true)).toBe(true);
    current = await stored(t);
    expect(current.summaries[0]!.final).toBe(true);

    // Nothing replaces a final snapshot.
    expect(await report(t, attemptId, snapshot(9))).toBe(true);
    current = await stored(t);
    expect(current.series[0]!.points.offset).toHaveLength(6);
    expect(current.summaries).toHaveLength(1);
  });

  it("stops accepting uploads once the Attempt has been settled past the late window", async () => {
    const t = convexTest(schema, modules);
    const { attemptId } = await setup(t);
    await t.run(async (ctx) => {
      await ctx.db.patch(attemptId, {
        state: "completed",
        finishedAt: Date.now() - METRICS_LATE_REPORT_MS + 60_000,
      });
    });
    expect(await report(t, attemptId, snapshot(2), true)).toBe(true);
    await t.run(async (ctx) => {
      await ctx.db.patch(attemptId, { finishedAt: Date.now() - METRICS_LATE_REPORT_MS - 1 });
    });
    const before = await stored(t);
    expect(await report(t, attemptId, snapshot(5), true)).toBe(false);
    expect((await stored(t)).series[0]!.samples).toBe(before.series[0]!.samples);
  });

  it("summarises against what the control plane allotted, not what the upload says", async () => {
    const t = convexTest(schema, modules);
    const { attemptId } = await setup(t);
    await report(t, attemptId, snapshot(4));
    const summary = (await stored(t)).summaries[0]!;
    expect(summary.vcpus).toBe(4);
    expect(summary.memoryLimitBytes).toBe(16 * GIB);
    expect(summary.cpuAvgVcpus).toBe(2);
    expect(summary.memoryPeakBytes).toBe(3 * GIB);
    expect(summary.netRxBytes).toBe(4000);
    expect(summary.diskWriteBytes).toBe(4 * 8192);
  });
});

describe("Attempt metrics retention", () => {
  it("purges series older than 14 days in bounded batches and keeps recent ones", async () => {
    const t = convexTest(schema, modules);
    const { attemptId, machineId } = await setup(t);
    const now = Date.now();
    await t.run(async (ctx) => {
      const body = snapshot(1);
      const { version: _version, ...series } = body;
      const summary = summarizeMetrics(body, { vcpus: 4, memoryMiB: 16_384 }, true);
      for (let index = 0; index < 101; index += 1) {
        const seriesId = await ctx.db.insert("attemptMetrics", { ...series, attemptId });
        await ctx.db.insert("attemptMetricSummaries", {
          ...summary,
          attemptId,
          machineId,
          seriesId,
          updatedAt: now - METRICS_RETENTION_MS - 1 - index,
        });
      }
      const seriesId = await ctx.db.insert("attemptMetrics", { ...series, attemptId });
      await ctx.db.insert("attemptMetricSummaries", {
        ...summary,
        attemptId,
        machineId,
        seriesId,
        updatedAt: now - METRICS_RETENTION_MS + 60_000,
      });
    });

    expect(await t.mutation(internal.attemptMetrics.purgeExpired, {})).toBe(100);
    expect(await t.mutation(internal.attemptMetrics.purgeExpired, {})).toBe(1);
    expect(await t.mutation(internal.attemptMetrics.purgeExpired, {})).toBe(0);
    const { series, summaries } = await stored(t);
    expect(series).toHaveLength(1);
    expect(summaries).toHaveLength(1);
    expect(summaries[0]!.seriesId).toBe(series[0]!._id);
  });
});

describe("Attempt metrics summary math", () => {
  it("weights each bucket by the time it covered", () => {
    const summary = summarizeMetrics(
      {
        source: "firecracker-vmm",
        memoryPeakBytes: 5 * GIB,
        oomKills: null,
        points: {
          offset: [0, 5, 10, 15],
          ms: [5000, 5000, 5000, 2500],
          cpuMs: [5000, 10_000, 20_000, 10_000],
          cpuMaxMilli: [1500, 2500, 3900, 4000],
          memBytes: [GIB, 2 * GIB, 4 * GIB, 3 * GIB],
        },
      },
      { vcpus: 4, memoryMiB: 8192 },
      false,
    );
    expect(summary.durationMs).toBe(17_500);
    // 45 CPU-seconds over 17.5 seconds.
    expect(summary.cpuAvgVcpus).toBeCloseTo(45 / 17.5, 10);
    expect(summary.cpuP95Vcpus).toBe(4);
    expect(summary.cpuMaxVcpus).toBe(4);
    // The kernel's own high-water mark outranks the bucket maxima.
    expect(summary.memoryPeakBytes).toBe(5 * GIB);
    expect(summary.memoryLimitBytes).toBe(8 * GIB);
    expect(summary.netRxBytes).toBeUndefined();
    expect(summary.diskReadBytes).toBeUndefined();
    expect(summary.oomKills).toBeNull();
  });

  it("takes p95 as the first value at or past 95% of the covered time", () => {
    const twenty = Array.from({ length: 20 }, (_, index) => ({ value: index + 1, weight: 1 }));
    expect(weightedQuantile(twenty, 0.95)).toBe(19);
    // One long quiet bucket outweighs many short busy ones.
    expect(
      weightedQuantile(
        [
          { value: 0.5, weight: 96 },
          { value: 4, weight: 1 },
          { value: 4, weight: 1 },
          { value: 4, weight: 1 },
          { value: 4, weight: 1 },
        ],
        0.95,
      ),
    ).toBe(0.5);
    expect(weightedQuantile([], 0.95)).toBe(0);
    expect(weightedQuantile([{ value: 3, weight: 0 }], 0.95)).toBe(0);
  });

  it("never reports a maximum below the busiest bucket", () => {
    const summary = summarizeMetrics(
      {
        source: "cgroup-v1",
        memoryPeakBytes: 0,
        oomKills: 2,
        points: { offset: [0], ms: [1000], cpuMs: [3000], cpuMaxMilli: [0], memBytes: [GIB] },
      },
      { vcpus: 4, memoryMiB: 4096 },
      true,
    );
    expect(summary.cpuMaxVcpus).toBe(3);
    expect(summary.memoryPeakBytes).toBe(GIB);
    expect(summary.oomKills).toBe(2);
    expect(summary.final).toBe(true);
  });

  it("reads an empty series as zero usage rather than NaN", () => {
    const summary = summarizeMetrics(
      {
        source: "cgroup-v2",
        memoryPeakBytes: 0,
        oomKills: 0,
        points: { offset: [], ms: [], cpuMs: [], cpuMaxMilli: [], memBytes: [] },
      },
      { vcpus: 2, memoryMiB: 4096 },
      false,
    );
    expect([summary.cpuAvgVcpus, summary.cpuP95Vcpus, summary.cpuMaxVcpus]).toEqual([0, 0, 0]);
    expect(summary.durationMs).toBe(0);
  });
});
