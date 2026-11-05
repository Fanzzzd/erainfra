import type { api } from "@erainfra/backend/api";
import type { FunctionReturnType } from "convex/server";

type AttemptPage = NonNullable<FunctionReturnType<typeof api.attemptMetrics.get>>;
export type MetricsSeries = NonNullable<AttemptPage["series"]>;
export type MetricsSummary = NonNullable<AttemptPage["summary"]>;

const GIB = 1024 ** 3;
const UNITS = ["B", "KiB", "MiB", "GiB", "TiB"];

export function formatBytes(bytes: number) {
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = unit === 0 || value >= 100 ? 0 : 1;
  return `${value.toFixed(digits)} ${UNITS[unit]}`;
}

export function formatRate(bytesPerSecond: number) {
  return `${formatBytes(bytesPerSecond)}/s`;
}

export function formatVcpus(vcpus: number) {
  return vcpus >= 10 ? vcpus.toFixed(0) : vcpus.toFixed(1);
}

function formatGiB(bytes: number) {
  const gib = bytes / GIB;
  return gib >= 10 || Number.isInteger(gib) ? gib.toFixed(0) : gib.toFixed(1);
}

/** The Runs page's one-line resource readout, e.g. "peak 11.2/16 GiB · cpu p95 3.6/4". */
export function summaryLine(summary: MetricsSummary) {
  const peak = (summary.memoryPeakBytes / GIB).toFixed(1);
  return `peak ${peak}/${formatGiB(summary.memoryLimitBytes)} GiB · cpu p95 ${formatVcpus(
    summary.cpuP95Vcpus,
  )}/${summary.vcpus}`;
}

/** Elapsed seconds as m:ss or h:mm:ss. */
export function formatElapsed(seconds: number) {
  const whole = Math.max(0, Math.round(seconds));
  const h = Math.floor(whole / 3600);
  const m = Math.floor((whole % 3600) / 60);
  const s = String(whole % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

/** One chartable row per bucket, in the units the charts draw. */
export type MetricsRow = {
  seconds: number;
  cpuAvg: number;
  cpuMax: number;
  memory: number;
  netRx?: number;
  netTx?: number;
  diskRead?: number;
  diskWrite?: number;
};

function rate(bytes: number[] | undefined, index: number, ms: number) {
  return bytes === undefined || ms <= 0 ? undefined : ((bytes[index] ?? 0) * 1000) / ms;
}

export function metricsRows(series: MetricsSeries): MetricsRow[] {
  const { points } = series;
  return points.offset.map((offset, index) => {
    const ms = points.ms[index] ?? 0;
    return {
      seconds: offset,
      cpuAvg: ms > 0 ? (points.cpuMs[index] ?? 0) / ms : 0,
      cpuMax: (points.cpuMaxMilli[index] ?? 0) / 1000,
      memory: points.memBytes[index] ?? 0,
      netRx: rate(points.netRxBytes, index, ms),
      netTx: rate(points.netTxBytes, index, ms),
      diskRead: rate(points.diskReadBytes, index, ms),
      diskWrite: rate(points.diskWriteBytes, index, ms),
    };
  });
}

/** Where the numbers came from, in words an operator reads. */
export function sourceLabel(source: string) {
  switch (source) {
    case "firecracker-vmm":
      return "Firecracker VMM process and tap device";
    case "cgroup-v2":
      return "container cgroup (v2)";
    case "cgroup-v1":
      return "container cgroup (v1)";
    default:
      return source;
  }
}
