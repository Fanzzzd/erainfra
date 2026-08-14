import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export const BENCHMARK_VERSION = 1;
export const BENCHMARK_REFRESH_MS = 24 * 60 * 60_000;
export const BENCHMARK_RETRY_MS = 60 * 60_000;
const MEBIBYTE = 1024 * 1024;
const NETWORK_BYTE_LIMIT = MEBIBYTE;

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

type BenchmarkOptions = {
  directory?: string;
  cpuBytes?: number;
  memoryBytes?: number;
  memoryCopies?: number;
  diskBytes?: number;
  packageFiles?: number;
  fetchImpl?: typeof fetch;
  networkTargets?: Array<{
    target: "github" | "ghcr" | "npm";
    url: string;
  }>;
};

const defaultTargets: NonNullable<BenchmarkOptions["networkTargets"]> = [
  {
    target: "github",
    url: "https://api.github.com/repos/actions/runner/releases?per_page=20",
  },
  { target: "ghcr", url: "https://ghcr.io/v2/" },
  { target: "npm", url: "https://registry.npmjs.org/pnpm" },
];

function elapsedMs(startedAt: bigint) {
  return Math.max(0.001, Number(process.hrtime.bigint() - startedAt) / 1_000_000);
}

function throughputMiBPerSecond(bytes: number, milliseconds: number) {
  return bytes / MEBIBYTE / (milliseconds / 1_000);
}

function errorMessage(error: unknown) {
  const value = error instanceof Error ? error.message : String(error);
  return value.replaceAll(/\s+/g, " ").slice(0, 256);
}

function measureCPU(bytes: number) {
  const chunk = Buffer.alloc(Math.min(MEBIBYTE, bytes), 0x5a);
  const startedAt = process.hrtime.bigint();
  const hash = createHash("sha256");
  for (let offset = 0; offset < bytes; offset += chunk.length) {
    hash.update(chunk.subarray(0, Math.min(chunk.length, bytes - offset)));
  }
  hash.digest();
  return throughputMiBPerSecond(bytes, elapsedMs(startedAt));
}

function measureMemory(bytes: number, copies: number) {
  const source = Buffer.alloc(bytes, 0xa5);
  const target = Buffer.allocUnsafe(bytes);
  const startedAt = process.hrtime.bigint();
  for (let index = 0; index < copies; index += 1) source.copy(target);
  return throughputMiBPerSecond(bytes * copies, elapsedMs(startedAt));
}

async function measureDiskCombined(directory: string, bytes: number) {
  await mkdir(directory, { recursive: true });
  const filename = join(directory, `.rc-benchmark-${process.pid}-${randomUUID()}`);
  const chunk = Buffer.alloc(Math.min(MEBIBYTE, bytes), 0x3c);
  try {
    const writer = await open(filename, "wx", 0o600);
    let written = 0;
    const writeStartedAt = process.hrtime.bigint();
    let diskFsyncLatencyMs = 0;
    try {
      while (written < bytes) {
        const result = await writer.write(
          chunk,
          0,
          Math.min(chunk.length, bytes - written),
          written,
        );
        written += result.bytesWritten;
      }
      const fsyncStartedAt = process.hrtime.bigint();
      await writer.sync();
      diskFsyncLatencyMs = elapsedMs(fsyncStartedAt);
    } finally {
      await writer.close();
    }
    const diskWriteMiBps = throughputMiBPerSecond(written, elapsedMs(writeStartedAt));

    const reader = await open(filename, "r");
    let read = 0;
    const readStartedAt = process.hrtime.bigint();
    try {
      while (read < written) {
        const result = await reader.read(chunk, 0, Math.min(chunk.length, written - read), read);
        if (result.bytesRead === 0) break;
        read += result.bytesRead;
      }
    } finally {
      await reader.close();
    }
    return {
      diskWriteMiBps,
      diskReadMiBps: throughputMiBPerSecond(read, elapsedMs(readStartedAt)),
      diskFsyncLatencyMs,
    };
  } finally {
    await rm(filename, { force: true });
  }
}

async function measurePackageLinkFanout(directory: string, files: number) {
  const fanoutDirectory = join(directory, `.rc-package-link-${process.pid}-${randomUUID()}`);
  await mkdir(fanoutDirectory, { recursive: true });
  const payload = Buffer.alloc(4 * 1024, 0x7d);
  const startedAt = process.hrtime.bigint();
  try {
    for (let index = 0; index < files; index += 1) {
      await writeFile(join(fanoutDirectory, `${index}.js`), payload, { mode: 0o600 });
    }
    return files / (elapsedMs(startedAt) / 1_000);
  } finally {
    await rm(fanoutDirectory, { recursive: true, force: true });
  }
}

async function measureNetwork(
  fetchImpl: typeof fetch,
  target: "github" | "ghcr" | "npm",
  url: string,
): Promise<BenchmarkReport["network"][number]> {
  const startedAt = process.hrtime.bigint();
  try {
    const response = await fetchImpl(url, {
      headers: {
        Accept: "application/json",
        Range: `bytes=0-${NETWORK_BYTE_LIMIT - 1}`,
        "User-Agent": "erainfra-agent-benchmark/1",
      },
      signal: AbortSignal.timeout(5_000),
    });
    const ttfbMs = elapsedMs(startedAt);
    if (!response.ok && !(target === "ghcr" && response.status === 401)) {
      throw new Error(`HTTP ${response.status}`);
    }
    // GHCR intentionally challenges anonymous /v2/ clients. That latency is a
    // useful registry-path observation, but its tiny error body is not a
    // meaningful throughput sample.
    if (target === "ghcr" && response.status === 401) {
      await response.body?.cancel().catch(() => undefined);
      return { target, ttfbMs };
    }
    if (response.body === null) throw new Error("response had no body");
    const reader = response.body.getReader();
    let bytes = 0;
    const transferStartedAt = process.hrtime.bigint();
    try {
      while (bytes < NETWORK_BYTE_LIMIT) {
        const result = await reader.read();
        if (result.done) break;
        bytes += Math.min(result.value.byteLength, NETWORK_BYTE_LIMIT - bytes);
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }
    const transferMs = elapsedMs(transferStartedAt);
    return {
      target,
      ttfbMs,
      throughputMbps: Math.max(0.000_1, (bytes * 8) / 1_000_000 / (transferMs / 1_000)),
      bytes,
    };
  } catch (error) {
    return { target, error: errorMessage(error) };
  }
}

export async function runWorkerBenchmark(options: BenchmarkOptions = {}): Promise<BenchmarkReport> {
  const measuredAt = Date.now();
  const startedAt = process.hrtime.bigint();
  const report: BenchmarkReport = {
    version: BENCHMARK_VERSION,
    measuredAt,
    durationMs: 1,
    sampleSize: 1,
    network: [],
    errors: [],
  };
  try {
    report.cpuSha256MiBps = measureCPU(options.cpuBytes ?? 64 * MEBIBYTE);
  } catch (error) {
    report.errors.push(`cpu: ${errorMessage(error)}`);
  }
  try {
    report.memoryCopyMiBps = measureMemory(
      options.memoryBytes ?? 64 * MEBIBYTE,
      options.memoryCopies ?? 4,
    );
  } catch (error) {
    report.errors.push(`memory: ${errorMessage(error)}`);
  }
  try {
    Object.assign(
      report,
      await measureDiskCombined(
        options.directory ??
          process.env.RC_BENCHMARK_DIR ??
          join(homedir(), ".runner-center", "benchmarks"),
        options.diskBytes ?? 32 * MEBIBYTE,
      ),
    );
    report.packageLinkOpsPerSec = await measurePackageLinkFanout(
      options.directory ??
        process.env.RC_BENCHMARK_DIR ??
        join(homedir(), ".runner-center", "benchmarks"),
      options.packageFiles ?? 512,
    );
  } catch (error) {
    report.errors.push(`disk: ${errorMessage(error)}`);
  }
  for (const { target, url } of options.networkTargets ?? defaultTargets) {
    const observation = await measureNetwork(options.fetchImpl ?? fetch, target, url);
    report.network.push(observation);
    if (observation.error !== undefined) {
      report.errors.push(`${target}: ${observation.error}`);
    }
  }
  report.durationMs = Math.max(1, Math.round(elapsedMs(startedAt)));
  return report;
}
