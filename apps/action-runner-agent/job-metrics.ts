import { spawn } from "node:child_process";
import type { Readable, Writable } from "node:stream";

/**
 * Per-Attempt resource metrics, from the Worker's side.
 *
 * The measuring happens in Go: `runner-center-runtime sample` reads the boundary from the host
 * (the privileged runtime's sampler for a microVM, the container's cgroup for Docker), keeps the
 * bounded series and prints a whole snapshot as one JSON line every 30 seconds, then a final one
 * when its stdin closes. This module runs that process beside an Attempt and forwards its lines
 * to the control plane.
 *
 * None of it may cost the job anything, so every path here is lossy rather than blocking: at
 * most one upload is in flight and only the newest unsent snapshot waits behind it (each one is
 * complete, so a dropped one loses nothing the next does not carry); the closing collection and
 * upload are bounded; and every failure is logged and swallowed. An Attempt's outcome never
 * depends on whether its metrics arrived.
 */

/** One line of `runner-center-runtime sample` output. The snapshot is checked by the server. */
export type MetricsReport = { final: boolean; snapshot: Record<string, unknown> };

export type MetricsUpload = (report: MetricsReport) => Promise<unknown>;

/** The slice of a child process this module uses, so tests can stand one in. */
export type SamplerProcess = {
  stdin: Writable | null;
  stdout: Readable | null;
  kill(signal?: NodeJS.Signals): boolean;
  once(event: "close", listener: () => void): unknown;
  once(event: "error", listener: (error: Error) => void): unknown;
};

export type SpawnSampler = (
  file: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv },
) => SamplerProcess;

export type AttemptMetricsOptions = {
  attemptId: string;
  executor: "docker" | "firecracker" | "tart" | "hyperv";
  runnerName: string;
  upload: MetricsUpload;
  platform?: NodeJS.Platform;
  spawnSampler?: SpawnSampler;
  /** How long the sampler gets to write its final line after stdin closes. */
  exitTimeoutMs?: number;
  /** How long the closing upload may take before it is abandoned. */
  flushTimeoutMs?: number;
  log?: (message: string) => void;
};

export type AttemptMetrics = {
  /** Ends sampling and uploads the final snapshot. Never rejects, and is bounded. */
  stop(): Promise<void>;
};

// The sampler's own closing collection is bounded at 10 seconds; this leaves it room.
const DEFAULT_EXIT_TIMEOUT_MS = 15_000;
const DEFAULT_FLUSH_TIMEOUT_MS = 15_000;
// A 360-point snapshot is about 30 KiB. Anything near this is not a snapshot.
const MAX_LINE_BYTES = 1 << 20;

const noMetrics: AttemptMetrics = { stop: async () => {} };

const defaultSpawn: SpawnSampler = (file, args, options) =>
  spawn(file, args, { env: options.env, stdio: ["pipe", "pipe", "inherit"] });

/**
 * Waits for `promise` or `ms`, whichever comes first.
 *
 * The timer is referenced and cleared the moment the race settles. An unreferenced timer cannot
 * bound anything: when nothing else holds the event loop open (a quiet Agent mid-shutdown, or
 * the test runner) the loop drains with the wait still pending and the bound never fires. A
 * referenced one that is not cleared would hold the loop open for its full length after the
 * race was already decided.
 */
async function within(promise: Promise<unknown>, ms: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
  });
  try {
    await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Whether a parsed line has the shape the sampler writes. */
export function parseMetricsReport(line: string): MetricsReport | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const { final, snapshot } = parsed as Record<string, unknown>;
  if (typeof final !== "boolean" || typeof snapshot !== "object" || snapshot === null) {
    return undefined;
  }
  return { final, snapshot: snapshot as Record<string, unknown> };
}

/**
 * Starts measuring an Attempt. Only Linux executors are measured: Tart and Hyper-V guests run
 * on hosts whose provisioners own the VM, and nothing on those hosts samples it yet.
 */
export function startAttemptMetrics(options: AttemptMetricsOptions): AttemptMetrics {
  if ((options.platform ?? process.platform) !== "linux") return noMetrics;
  if (options.executor !== "docker" && options.executor !== "firecracker") return noMetrics;
  const log = options.log ?? ((message: string) => console.error(message));
  const label = `Attempt ${options.runnerName} metrics`;

  let child: SamplerProcess;
  try {
    child = (options.spawnSampler ?? defaultSpawn)(
      process.env.RC_RUNTIME_BINARY?.trim() || "runner-center-runtime",
      ["sample"],
      {
        env: {
          ...process.env,
          RC_EXECUTOR: options.executor,
          RC_ATTEMPT_ID: options.attemptId,
          RC_RUNNER_NAME: options.runnerName,
        },
      },
    );
  } catch (error) {
    log(`${label}: sampler did not start: ${String(error)}`);
    return noMetrics;
  }

  let exited = false;
  const exit = new Promise<void>((resolve) => {
    child.once("close", () => {
      exited = true;
      resolve();
    });
    child.once("error", (error) => {
      log(`${label}: sampler failed: ${error.message}`);
      exited = true;
      resolve();
    });
  });
  // A sampler that dies early leaves a broken pipe behind; writing to it must not throw.
  child.stdin?.on("error", () => {});

  let pending: MetricsReport | undefined;
  let inFlight: Promise<void> | undefined;
  let failures = 0;

  const send = async (report: MetricsReport) => {
    try {
      await options.upload(report);
    } catch (error) {
      failures += 1;
      // One line per Attempt is enough to diagnose; a line every 30 seconds is noise.
      if (failures === 1) log(`${label}: upload failed: ${String(error)}`);
    }
  };
  const pump = () => {
    if (inFlight !== undefined || pending === undefined) return;
    const report = pending;
    pending = undefined;
    inFlight = send(report).finally(() => {
      inFlight = undefined;
      pump();
    });
  };
  const busy = () => inFlight !== undefined || pending !== undefined;

  const accept = (line: string) => {
    const report = parseMetricsReport(line);
    if (report === undefined) return;
    // A final snapshot is never replaced by a later ordinary one.
    if (pending?.final && !report.final) return;
    pending = report;
    pump();
  };

  let buffer = "";
  let discarding = false;
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    buffer += chunk;
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (!discarding) accept(line);
      discarding = false;
      newline = buffer.indexOf("\n");
    }
    if (buffer.length > MAX_LINE_BYTES) {
      buffer = "";
      discarding = true;
    }
  });
  child.stdout?.on("error", () => {});

  let stopping: Promise<void> | undefined;
  const stop = async () => {
    // Closing stdin is the sampler's signal that the Attempt is over.
    child.stdin?.end();
    const exitTimeout = options.exitTimeoutMs ?? DEFAULT_EXIT_TIMEOUT_MS;
    await within(exit, exitTimeout);
    if (!exited) {
      log(`${label}: sampler did not exit within ${exitTimeout} ms; killing it`);
      child.kill("SIGKILL");
    }
    const flushTimeout = options.flushTimeoutMs ?? DEFAULT_FLUSH_TIMEOUT_MS;
    const deadline = Date.now() + flushTimeout;
    while (busy() && Date.now() < deadline) {
      pump();
      await within(inFlight ?? Promise.resolve(), Math.max(0, deadline - Date.now()));
    }
    if (busy()) {
      log(`${label}: final upload abandoned after ${flushTimeout} ms`);
      pending = undefined;
    }
  };

  return {
    stop: () => {
      stopping ??= stop().catch((error: unknown) => log(`${label}: ${String(error)}`));
      return stopping;
    },
  };
}
