import { mkdtemp, rm } from "node:fs/promises";
import { arch, cpus, tmpdir, totalmem } from "node:os";
import { join } from "node:path";

import { ConvexClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";

import { readAdmissionState, type AdmissionState } from "./admission.js";
import {
  BENCHMARK_REFRESH_MS,
  BENCHMARK_RETRY_MS,
  runWorkerBenchmark,
  type BenchmarkReport,
} from "./benchmark.js";
import { config } from "./config.js";
import {
  CoreAllocator,
  CoreExhaustedError,
  CPUSET_EXHAUSTED_EXIT,
  formatCpuset,
  reconcileDockerReservations,
  RECONCILE_INTERVAL_MS,
  withCores,
} from "./cpuset.js";
import { dualEnv } from "./dual-env.js";
import { pruneImageReleases } from "./image-prune.js";
import { startAttemptMetrics, type AttemptMetrics, type MetricsReport } from "./job-metrics.js";
import { recoverFirecrackerOrphans } from "./orphan-recovery.js";
import {
  readEgressRecord,
  readRunnerExit,
  readTestReport,
  reportAttemptWithRunnerExit,
  spawnAttempt,
  spawnExperiment,
  spawnProvisioner,
  type AttemptExecution,
  type ExperimentExecution,
  type MachineOs,
} from "./provision.js";
import { clearReadinessSignal, publishReadinessSignal } from "./readiness-signal.js";
import {
  HEALTHY_READINESS_REFRESH_MS,
  readinessRefreshDelay,
  UNHEALTHY_READINESS_REFRESH_MS,
  prepareProfile,
  removePreparedFirecrackerProfile,
  warmPoolCapacityError,
  type CoreLease,
  type PublishedReadinessState,
  type ReadinessFacts,
  type ProfileSpec,
} from "./readiness.js";
import { createStopHandler, createWorkCounter } from "./stop.js";

type PendingCommand = { commandId: string; runnerName: string };
type PendingCommandsResult = {
  os: MachineOs;
  maxSlots: number;
  commands: PendingCommand[];
  liveCommandIds?: string[];
};
type ClaimedCommand = {
  jitConfig: string;
  image?: string;
  runnerName: string;
  os: MachineOs;
};

type PendingAttempt = { attemptId: string; runnerName: string };
type PendingAttemptsResult = {
  maxSlots: number;
  attempts: PendingAttempt[];
  liveAttemptIds: string[];
};
type ClaimedAttempt = Omit<AttemptExecution, "attemptId">;

type PendingExperiment = { experimentId: string; name: string };
type PendingExperimentsResult = {
  maxSlots: number;
  experiments: PendingExperiment[];
  liveExperimentIds: string[];
};
type ClaimedExperiment = Omit<ExperimentExecution, "experimentId">;

type WorkItem =
  | { kind: "command"; id: string; runnerName: string }
  | { kind: "attempt"; id: string; runnerName: string }
  | { kind: "experiment"; id: string; runnerName: string };

const pendingCommands = makeFunctionReference<"query", { token: string }, PendingCommandsResult>(
  "agentApi:pendingCommands",
);
const claimCommand = makeFunctionReference<
  "mutation",
  { token: string; commandId: string },
  ClaimedCommand | null
>("agentApi:claim");
const reportCommand = makeFunctionReference<
  "mutation",
  { token: string; commandId: string; exitCode: number },
  boolean
>("agentApi:report");
const heartbeatAgent = makeFunctionReference<
  "mutation",
  { token: string; startBudget?: AdmissionState },
  { os: MachineOs; maxSlots: number }
>("agentApi:heartbeat");

const pendingAttempts = makeFunctionReference<"query", { token: string }, PendingAttemptsResult>(
  "workerApi:pendingAttempts",
);
const claimAttempt = makeFunctionReference<
  "mutation",
  { token: string; attemptId: string },
  ClaimedAttempt | null
>("workerApi:claimAttempt");
const reportAttempt = makeFunctionReference<
  "mutation",
  {
    token: string;
    attemptId: string;
    exitCode: number;
    egress?: unknown;
    runnerExit?: { exitCode: number; ranJob: boolean; diagnostic?: string };
  },
  boolean
>("workerApi:reportAttempt");
const reportAttemptMetrics = makeFunctionReference<
  "mutation",
  { token: string; attemptId: string } & MetricsReport,
  boolean
>("workerApi:reportAttemptMetrics");
const reportAttemptTests = makeFunctionReference<
  "mutation",
  { token: string; attemptId: string; report: unknown },
  boolean
>("workerApi:reportAttemptTests");
const reportReadiness = makeFunctionReference<
  "mutation",
  {
    token: string;
    profile: string;
    executor: "docker" | "firecracker" | "tart" | "hyperv";
    imageRelease: string;
    vcpus?: number;
    memoryMiB?: number;
    state: "preparing" | "ready" | "failed";
    statusDetail?: string;
    error?: string;
  } & Partial<ReadinessFacts>,
  { state: PublishedReadinessState }
>("workerApi:reportReadiness");
const workerProfiles = makeFunctionReference<"query", { token: string }, ProfileSpec[]>(
  "workerApi:profiles",
);
const reportHostFacts = makeFunctionReference<
  "mutation",
  { token: string; arch: string; cpus: number; memoryMiB: number },
  { maxSlots: number; recommendedSlots: number }
>("workerApi:reportHostFacts");
const reportBenchmark = makeFunctionReference<
  "mutation",
  { token: string; report: BenchmarkReport },
  {
    maxSlots: number;
    recommendedSlots: number;
    scores: { cpu: number; memory: number; disk: number; network: number; balanced: number };
  }
>("workerApi:reportBenchmark");
const pendingExperiments = makeFunctionReference<
  "query",
  { token: string },
  PendingExperimentsResult
>("workerApi:pendingExperiments");
const claimExperiment = makeFunctionReference<
  "mutation",
  { token: string; experimentId: string },
  ClaimedExperiment | null
>("workerApi:claimExperiment");
const markExperimentRunning = makeFunctionReference<
  "mutation",
  { token: string; experimentId: string },
  boolean
>("workerApi:markExperimentRunning");
const reportExperiment = makeFunctionReference<
  "mutation",
  { token: string; experimentId: string; exitCode: number },
  boolean
>("workerApi:reportExperiment");

const client = new ConvexClient(config.convexUrl);
const queuedIds = new Set<string>();
const queue: WorkItem[] = [];
const running = new Map<string, ReturnType<typeof spawnProvisioner>>();
const work = createWorkCounter();
let maxSlots = 1;
let shuttingDown = false;
let acceptingWork = false;
let benchmarkTimer: ReturnType<typeof setTimeout> | undefined;
let benchmarking = false;
let latestLiveAttemptIds = new Set<string>();
let latestLiveExperimentIds = new Set<string>();
let recoveryRevision = 0;
let completedRecoveryRevision = 0;
let recoveringRuntime = false;
let recoveryRetryTimer: ReturnType<typeof setTimeout> | undefined;
let coreReconcileTimer: ReturnType<typeof setTimeout> | undefined;
/** Closing metrics uploads still running. Shutdown waits for them, bounded; nothing else does. */
const metricsFlushes = new Set<Promise<void>>();

/**
 * The Worker's CPUs, handed out in disjoint ranges so no two concurrent
 * Attempts share a core and every job's `nproc` is its own size (#80).
 */
const cores = new CoreAllocator();

/**
 * The vCPUs an executor takes out of *this* Worker's cores, or undefined when
 * it takes none of them. Docker containers and Firecracker microVMs both run
 * here; a Tart or Hyper-V Attempt runs a guest whose own provisioner owns the
 * host's capacity guard, and neither has a cpuset to be given.
 */
function coreBoundVcpus(executor: AttemptExecution["executor"], vcpus: number) {
  return executor === "docker" || executor === "firecracker" ? vcpus : undefined;
}

/**
 * Borrows a range for readiness's resource-visibility probe from the allocator
 * that pins real Attempts, so the check measures production's own arithmetic
 * rather than a hardcoded `0-N`. A busy Worker has nothing to lend; the probe
 * then shares cores for the second it takes to read `nproc`, and says so in
 * its detail rather than skipping and reporting a boolean nobody measured.
 */
function leaseCoresForProbe(profile: string) {
  return (vcpus: number): CoreLease => {
    const key = `readiness:${profile}`;
    const reservation = cores.has(key) ? undefined : cores.reserve(key, vcpus);
    if (reservation !== undefined) {
      return { spec: reservation.spec, exclusive: true, release: () => void cores.release(key) };
    }
    return {
      spec: formatCpuset(Array.from({ length: vcpus }, (_, core) => core)),
      exclusive: false,
      release: () => {},
    };
  };
}

function scheduleBenchmark(delayMs: number) {
  if (shuttingDown) return;
  if (benchmarkTimer !== undefined) clearTimeout(benchmarkTimer);
  benchmarkTimer = setTimeout(() => void refreshBenchmark(), delayMs);
}

async function refreshBenchmark() {
  if (shuttingDown || benchmarking) return;
  // Measurement never reserves a job slot. The automatic pass also waits for
  // an idle Worker so its own load cannot distort a live workload.
  if (work.active > 0 || running.size > 0 || queue.length > 0) {
    scheduleBenchmark(BENCHMARK_RETRY_MS);
    return;
  }
  benchmarking = true;
  try {
    console.log("Worker benchmark: measuring CPU, memory, local disk, GitHub, GHCR, and npm");
    const report = await runWorkerBenchmark();
    const result = await client.mutation(reportBenchmark, {
      token: config.machineToken,
      report,
    });
    maxSlots = result.maxSlots;
    console.log(
      `Worker benchmark: balanced ${result.scores.balanced}/100; ` +
        `capacity ${result.maxSlots} effective, ${result.recommendedSlots} recommended` +
        (report.errors.length > 0 ? `; partial: ${report.errors.join("; ")}` : ""),
    );
    pump();
    scheduleBenchmark(BENCHMARK_REFRESH_MS);
  } catch (error) {
    console.error("Worker benchmark failed", error);
    scheduleBenchmark(BENCHMARK_RETRY_MS);
  } finally {
    benchmarking = false;
  }
}

function workKey(kind: WorkItem["kind"], id: string) {
  return `${kind}:${id}`;
}

async function runLegacyCommand(item: Extract<WorkItem, { kind: "command" }>) {
  let exitCode = 1;
  let claimedByThisAgent = false;
  try {
    const claimed = await client.mutation(claimCommand, {
      token: config.machineToken,
      commandId: item.id,
    });
    if (claimed === null) return;
    claimedByThisAgent = true;
    console.log(`Starting legacy ephemeral runner ${claimed.runnerName}`);
    const child = spawnProvisioner(
      claimed.os,
      claimed.jitConfig,
      claimed.runnerName,
      claimed.image,
    );
    running.set(workKey(item.kind, item.id), child);
    try {
      const result = await child;
      exitCode = result.exitCode ?? 1;
    } finally {
      running.delete(workKey(item.kind, item.id));
    }
  } catch (error) {
    console.error(`Legacy provisioning ${item.runnerName} failed`, error);
  } finally {
    if (claimedByThisAgent) {
      try {
        await client.mutation(reportCommand, {
          token: config.machineToken,
          commandId: item.id,
          exitCode,
        });
      } catch (error) {
        console.error(`Reporting ${item.runnerName} failed`, error);
      }
    }
  }
}

async function runScaleSetAttempt(item: Extract<WorkItem, { kind: "attempt" }>) {
  let exitCode = 1;
  let claimedByThisAgent = false;
  let recordDirectory: string | undefined;
  const key = workKey(item.kind, item.id);
  try {
    const claimed = await client.mutation(claimAttempt, {
      token: config.machineToken,
      attemptId: item.id,
    });
    if (claimed === null) return;
    claimedByThisAgent = true;
    console.log(`Starting ${claimed.executor} Attempt ${claimed.runnerName}`);
    // A private directory per Attempt, so the runtime's record lands where
    // only this Agent reads it and nothing from another Attempt is mistaken
    // for it.
    if (claimed.executor === "firecracker") {
      recordDirectory = await mkdtemp(join(tmpdir(), "rc-egress-"));
    }
    const egressRecordFile =
      recordDirectory === undefined ? undefined : join(recordDirectory, "record.json");
    const testReportFile =
      recordDirectory === undefined ? undefined : join(recordDirectory, "tests.json");
    const runnerExitFile =
      recordDirectory === undefined ? undefined : join(recordDirectory, "runner-exit.json");
    exitCode = await withCores(
      cores,
      {
        key,
        vcpus: coreBoundVcpus(claimed.executor, claimed.vcpus),
        containerName: claimed.executor === "docker" ? claimed.runnerName : undefined,
      },
      async (reservation) => {
        if (reservation !== undefined) {
          console.log(
            `Attempt ${claimed.runnerName} holds CPUs ${reservation.spec}; ` +
              `${cores.freeCores} of ${cores.totalCores} free`,
          );
        }
        const child = spawnAttempt({
          attemptId: item.id,
          ...claimed,
          cpuset: reservation?.spec,
          // Empty unless an operator configured one, in which case every
          // Attempt on this Worker is offered the same endpoint. It is per
          // Worker rather than per Attempt because nothing yet mints anything
          // per Attempt -- an Attempt exists before GitHub assigns it a job.
          cache: config.cache,
          egressRecordFile,
          testReportFile,
          runnerExitFile,
        });
        running.set(key, child);
        let metrics: AttemptMetrics | undefined;
        try {
          if (child.pid === undefined) {
            throw new Error(`The ${claimed.executor} executor did not spawn`);
          }
          metrics = startAttemptMetrics({
            attemptId: item.id,
            executor: claimed.executor,
            runnerName: claimed.runnerName,
            upload: (report) =>
              client.mutation(reportAttemptMetrics, {
                token: config.machineToken,
                attemptId: item.id,
                ...report,
              }),
          });
          const result = await child;
          return result.exitCode ?? 1;
        } finally {
          running.delete(key);
          // Not awaited: the final snapshot uploads beside reportAttempt and the core release,
          // never in front of them. The control plane accepts it after the Attempt settles.
          if (metrics !== undefined) {
            const flush = metrics.stop();
            metricsFlushes.add(flush);
            void flush.finally(() => metricsFlushes.delete(flush));
          }
        }
      },
    );
  } catch (error) {
    exitCode = error instanceof CoreExhaustedError ? CPUSET_EXHAUSTED_EXIT : 1;
    console.error(`Attempt ${item.runnerName} failed`, error);
  } finally {
    const egress =
      recordDirectory === undefined
        ? undefined
        : await readEgressRecord(join(recordDirectory, "record.json"));
    const tests =
      recordDirectory === undefined
        ? undefined
        : await readTestReport(join(recordDirectory, "tests.json"));
    const runnerExit =
      recordDirectory === undefined
        ? undefined
        : await readRunnerExit(join(recordDirectory, "runner-exit.json"));
    if (runnerExit !== undefined) {
      console.log(
        `The runner of Attempt ${item.runnerName} exited with code ${runnerExit.exitCode}` +
          `${runnerExit.ranJob ? " after a job" : " without taking a job"}` +
          `${runnerExit.diagnostic === undefined ? "" : `: ${runnerExit.diagnostic}`}`,
      );
    }
    if (recordDirectory !== undefined) {
      await rm(recordDirectory, { recursive: true, force: true }).catch(() => undefined);
    }
    if (claimedByThisAgent) {
      try {
        await reportAttemptWithRunnerExit(
          (args) => client.mutation(reportAttempt, args),
          {
            token: config.machineToken,
            attemptId: item.id,
            exitCode,
            ...(egress === undefined ? {} : { egress }),
          },
          runnerExit,
        );
      } catch (error) {
        console.error(`Reporting Attempt ${item.runnerName} failed`, error);
      }
      // After the Attempt's own report, and separately: test results are
      // evidence about the job, so a refused or failed upload never touches
      // the Attempt's outcome.
      if (tests !== undefined) {
        try {
          await client.mutation(reportAttemptTests, {
            token: config.machineToken,
            attemptId: item.id,
            report: tests,
          });
        } catch (error) {
          console.error(`Reporting test results for ${item.runnerName} failed`, error);
        }
      }
    }
  }
}

async function runExperiment(item: Extract<WorkItem, { kind: "experiment" }>) {
  let exitCode = 1;
  let claimedByThisAgent = false;
  const key = workKey(item.kind, item.id);
  try {
    const claimed = await client.mutation(claimExperiment, {
      token: config.machineToken,
      experimentId: item.id,
    });
    if (claimed === null) return;
    claimedByThisAgent = true;
    console.log(`Starting Experiment ${claimed.name} with ${claimed.profile}`);
    // An Experiment takes the same capacity an Attempt does, by design, so it
    // reserves cores on the same allocator. It gets no cpuset: its executor is
    // Firecracker, whose guest has real vCPUs and an honest `nproc`.
    exitCode = await withCores(cores, { key, vcpus: claimed.vcpus }, async () => {
      const child = spawnExperiment({ experimentId: item.id, ...claimed });
      running.set(key, child);
      try {
        if (child.pid === undefined) {
          throw new Error("The Firecracker Experiment executor did not spawn");
        }
        const accepted = await client.mutation(markExperimentRunning, {
          token: config.machineToken,
          experimentId: item.id,
        });
        if (!accepted) {
          child.kill();
          throw new Error("The control plane cancelled the Experiment while it was starting");
        }
        const result = await child;
        return result.exitCode ?? 1;
      } finally {
        running.delete(key);
      }
    });
  } catch (error) {
    exitCode = error instanceof CoreExhaustedError ? CPUSET_EXHAUSTED_EXIT : 1;
    console.error(`Experiment ${item.runnerName} failed`, error);
  } finally {
    if (claimedByThisAgent) {
      try {
        await client.mutation(reportExperiment, {
          token: config.machineToken,
          experimentId: item.id,
          exitCode,
        });
      } catch (error) {
        console.error(`Reporting Experiment ${item.runnerName} failed`, error);
      }
    }
  }
}

async function runWork(item: WorkItem) {
  if (item.kind === "command") {
    await runLegacyCommand(item);
  } else if (item.kind === "attempt") {
    await runScaleSetAttempt(item);
  } else {
    await runExperiment(item);
  }
}

function reconcileWithServer(kind: WorkItem["kind"], liveIds: string[] | undefined) {
  if (liveIds === undefined) return;
  const live = new Set(liveIds.map((id) => workKey(kind, id)));

  for (const [key, child] of running) {
    if (!key.startsWith(`${kind}:`) || live.has(key)) continue;
    console.log(`${key} is no longer live; stopping its executor`);
    child.kill();
  }
  for (let index = queue.length - 1; index >= 0; index -= 1) {
    const queued = queue[index];
    if (queued?.kind === kind && !live.has(workKey(kind, queued.id))) {
      queue.splice(index, 1);
    }
  }
  for (const key of queuedIds) {
    if (key.startsWith(`${kind}:`) && !live.has(key) && !running.has(key)) {
      queuedIds.delete(key);
    }
  }
}

function enqueue(item: WorkItem) {
  const key = workKey(item.kind, item.id);
  if (queuedIds.has(key)) return;
  queuedIds.add(key);
  queue.push(item);
}

function liveFirecrackerIds() {
  return new Set([...latestLiveAttemptIds, ...latestLiveExperimentIds]);
}

function sameIds(left: ReadonlySet<string>, right: ReadonlySet<string>) {
  return left.size === right.size && [...left].every((id) => right.has(id));
}

function requestRuntimeRecovery() {
  recoveryRevision += 1;
  void drainRuntimeRecovery();
}

async function drainRuntimeRecovery() {
  if (shuttingDown || recoveringRuntime) return;
  recoveringRuntime = true;
  if (recoveryRetryTimer !== undefined) {
    clearTimeout(recoveryRetryTimer);
    recoveryRetryTimer = undefined;
  }
  try {
    while (completedRecoveryRevision < recoveryRevision) {
      if (shuttingDown) break;
      const targetRevision = recoveryRevision;
      try {
        await recoverFirecrackerOrphans(discoveredProfiles, liveFirecrackerIds());
        completedRecoveryRevision = targetRevision;
      } catch (error) {
        console.error("Firecracker orphan recovery failed; claims remain paused", error);
        recoveryRetryTimer = setTimeout(() => {
          recoveryRetryTimer = undefined;
          void drainRuntimeRecovery();
        }, 30_000);
        break;
      }
    }
  } finally {
    recoveringRuntime = false;
    pump();
  }
}

/**
 * Re-checks the cores held by containers this Agent did not start. Scheduled
 * only while something is adopted, or after a failed pass, so a Worker that
 * came up clean issues no Docker commands at all.
 */
function scheduleCoreReconcile(afterFailure: boolean) {
  if (coreReconcileTimer !== undefined) {
    clearTimeout(coreReconcileTimer);
    coreReconcileTimer = undefined;
  }
  if (shuttingDown) return;
  if (!afterFailure && !cores.reservations().some((reservation) => reservation.adopted)) return;
  coreReconcileTimer = setTimeout(() => void reconcileCoreReservations(), RECONCILE_INTERVAL_MS);
}

async function reconcileCoreReservations() {
  if (shuttingDown) return;
  let failed = false;
  try {
    const { adopted, released, unpinned } = await reconcileDockerReservations(cores);
    if (adopted.length + released.length + unpinned.length > 0) {
      console.log(
        `Core reservations: adopted ${adopted.length} surviving container(s), released ` +
          `${released.length}, ${unpinned.length} running without a cpuset; ` +
          `${cores.freeCores} of ${cores.totalCores} CPUs free`,
      );
    }
    if (unpinned.length > 0) {
      // The one reconcile outcome that leaves real contention standing: an
      // unpinned container floats across every CPU, including the ones the next
      // Attempt is about to be pinned to. A count cannot be acted on; a name can.
      console.error(
        `Container(s) ${unpinned.join(", ")} run with no cpuset and float across every CPU ` +
          `on this Worker; Attempts placed here will contend with them`,
      );
    }
    if (released.length > 0) pump();
  } catch (error) {
    failed = true;
    console.error("Reconciling Docker core reservations failed", error);
  } finally {
    scheduleCoreReconcile(failed);
  }
}

function pump() {
  if (
    shuttingDown ||
    !acceptingWork ||
    recoveringRuntime ||
    completedRecoveryRevision < recoveryRevision
  ) {
    return;
  }
  // A Worker with no free core cannot give the next Attempt a cpuset, and its
  // size is only known after the claim — so admitting one here would claim it
  // and immediately refuse it. Waiting costs nothing: every release pumps
  // again, including the reconciler's.
  while (work.active < maxSlots && cores.freeCores > 0 && queue.length > 0) {
    const item = queue.shift();
    if (item === undefined) break;
    work.start();
    void runWork(item).finally(() => {
      work.finish();
      pump();
    });
  }
}

async function heartbeat() {
  try {
    // Only a Firecracker Worker has a start budget; the runtime holds starts, and the control
    // plane routes new jobs elsewhere while this reports overBudget.
    const startBudget =
      preparedFirecrackerProfiles.size > 0 ? await readAdmissionState() : undefined;
    let machine: { maxSlots: number };
    try {
      machine = await client.mutation(heartbeatAgent, {
        token: config.machineToken,
        ...(startBudget ? { startBudget } : {}),
      });
    } catch (error) {
      if (!startBudget) throw error;
      // A control plane older than this Agent rejects the field. A heartbeat without it keeps
      // the Worker schedulable; only the start budget routing is lost until the control plane
      // is deployed.
      console.error("Heartbeat with the start budget failed; sending it without", error);
      machine = await client.mutation(heartbeatAgent, { token: config.machineToken });
    }
    maxSlots = machine.maxSlots;
    pump();
  } catch (error) {
    console.error("Heartbeat failed", error);
  }
}

let refreshingProfiles = false;
let discoveredProfiles: ProfileSpec[] = [];
let refreshAgain = false;
let readinessTimer: ReturnType<typeof setTimeout> | undefined;
const preparedFirecrackerProfiles = new Set<string>();
// The first prune runs after the first full readiness pass, once every Profile was prepared.
let lastImagePruneAt = Number.NEGATIVE_INFINITY;

function scheduleReadinessRefresh(delayMs: number) {
  if (shuttingDown) return;
  if (readinessTimer !== undefined) clearTimeout(readinessTimer);
  readinessTimer = setTimeout(() => void refreshProfiles(), delayMs);
}

async function refreshProfiles() {
  if (shuttingDown) return;
  if (refreshingProfiles) {
    refreshAgain = true;
    return;
  }
  refreshingProfiles = true;
  if (readinessTimer !== undefined) {
    clearTimeout(readinessTimer);
    readinessTimer = undefined;
  }
  let nextRefreshMs = HEALTHY_READINESS_REFRESH_MS;
  try {
    while (true) {
      refreshAgain = false;
      const profiles = discoveredProfiles;
      const currentFirecracker = new Set(
        profiles
          .filter((profile) => profile.executor === "firecracker")
          .map((profile) => profile.profile),
      );
      for (const profile of preparedFirecrackerProfiles) {
        if (currentFirecracker.has(profile)) continue;
        await removePreparedFirecrackerProfile(profile);
        preparedFirecrackerProfiles.delete(profile);
      }
      const poolCapacityError = warmPoolCapacityError(
        profiles,
        maxSlots,
        cpus().length,
        Math.floor(totalmem() / 1024 / 1024),
      );
      const states: PublishedReadinessState[] = [];
      for (const profile of profiles) {
        const preparingDetail = `Checking ${profile.executor} and prewarming ${profile.imageRelease}`;
        console.log(`${profile.profile} readiness: preparing; ${preparingDetail}`);
        await client.mutation(reportReadiness, {
          token: config.machineToken,
          profile: profile.profile,
          executor: profile.executor,
          imageRelease: profile.imageRelease,
          vcpus: profile.vcpus,
          memoryMiB: profile.memoryMiB,
          state: "preparing",
          statusDetail: preparingDetail,
        });
        const blockedByPoolCapacity =
          poolCapacityError !== undefined &&
          profile.executor === "firecracker" &&
          (profile.warmPool ?? 0) > 0;
        const readiness = blockedByPoolCapacity
          ? {
              state: "failed" as const,
              error: poolCapacityError,
              isolation: "firecracker-microvm",
              boundary: "guest-kernel" as const,
              checks: [{ name: "warm-pool-capacity", passed: false, detail: poolCapacityError }],
              cacheScope: "immutable-image",
              cacheSharedWritable: false,
            }
          : await prepareProfile(profile, {
              hostCores: cores.totalCores,
              leaseCores: leaseCoresForProbe(profile.profile),
            });
        if (profile.executor === "firecracker" && !blockedByPoolCapacity) {
          preparedFirecrackerProfiles.add(profile.profile);
        }
        const statusDetail =
          readiness.state === "ready"
            ? `Prepared the immutable Image Release and passed ${readiness.checks.length} readiness check(s)`
            : "Readiness check failed; retrying in five minutes";
        const reported = await client.mutation(reportReadiness, {
          token: config.machineToken,
          profile: profile.profile,
          executor: profile.executor,
          imageRelease: profile.imageRelease,
          vcpus: profile.vcpus,
          memoryMiB: profile.memoryMiB,
          statusDetail,
          ...readiness,
        });
        states.push(reported.state);
        const failed = readiness.checks.filter((check) => !check.passed).map((c) => c.name);
        console.log(
          `${profile.profile} readiness: ${reported.state} (${readiness.isolation}, ${readiness.boundary})` +
            (failed.length > 0 ? `; failed: ${failed.join(", ")}` : ""),
        );
      }
      nextRefreshMs = readinessRefreshDelay(
        states,
        profiles.some(
          (profile) => profile.executor === "firecracker" && (profile.warmPool ?? 0) > 0,
        ),
      );
      if (!refreshAgain || shuttingDown) break;
    }
    if (preparedFirecrackerProfiles.size > 0) {
      lastImagePruneAt = await pruneImageReleases(discoveredProfiles, lastImagePruneAt, Date.now());
    }
  } catch (error) {
    console.error("Refreshing Profile readiness failed", error);
    nextRefreshMs = UNHEALTHY_READINESS_REFRESH_MS;
  } finally {
    refreshingProfiles = false;
    scheduleReadinessRefresh(nextRefreshMs);
  }
}

const [initialProfiles, initialAttempts, initialExperiments] = await Promise.all([
  client.query(workerProfiles, { token: config.machineToken }),
  client.query(pendingAttempts, { token: config.machineToken }),
  client.query(pendingExperiments, { token: config.machineToken }),
]);
discoveredProfiles = initialProfiles;
latestLiveAttemptIds = new Set(initialAttempts.liveAttemptIds);
latestLiveExperimentIds = new Set(initialExperiments.liveExperimentIds);
await recoverFirecrackerOrphans(discoveredProfiles, liveFirecrackerIds());
// Reservations live in this process and the containers holding them do not, so
// a Worker whose Agent was killed comes back believing every CPU is free while
// the previous run's containers are still pinned to some of them. Reconcile
// against the daemon before any of the capacity below is advertised, for the
// same reason the privileged runtime is reconciled first.
if (discoveredProfiles.some((profile) => profile.executor === "docker")) {
  await reconcileCoreReservations();
}

const hostCapacity = await client.mutation(reportHostFacts, {
  token: config.machineToken,
  arch: arch(),
  cpus: cpus().length,
  memoryMiB: Math.floor(totalmem() / 1024 / 1024),
});
maxSlots = hostCapacity.maxSlots;
console.log(
  `Worker capacity: ${maxSlots} slot(s), ${hostCapacity.recommendedSlots} recommended from host resources`,
);
await heartbeat();
const heartbeatTimer = setInterval(() => void heartbeat(), config.heartbeatMs);
await publishReadinessSignal(dualEnv("RC_READY_FILE"), dualEnv("RC_AGENT_VERSION"));
console.log(`EraInfra Worker connected to ${config.convexUrl}; discovering compatible Profiles`);
acceptingWork = true;

const unsubscribeCommands = client.onUpdate(
  pendingCommands,
  { token: config.machineToken },
  (result) => {
    maxSlots = result.maxSlots;
    reconcileWithServer("command", result.liveCommandIds);
    for (const command of result.commands) {
      enqueue({ kind: "command", id: command.commandId, runnerName: command.runnerName });
    }
    pump();
  },
  (error) => console.error("Legacy command subscription failed", error),
);

const unsubscribeAttempts = client.onUpdate(
  pendingAttempts,
  { token: config.machineToken },
  (result) => {
    maxSlots = result.maxSlots;
    const nextLiveAttemptIds = new Set(result.liveAttemptIds);
    const liveSetChanged = !sameIds(latestLiveAttemptIds, nextLiveAttemptIds);
    latestLiveAttemptIds = nextLiveAttemptIds;
    reconcileWithServer("attempt", result.liveAttemptIds);
    for (const attempt of result.attempts) {
      enqueue({ kind: "attempt", id: attempt.attemptId, runnerName: attempt.runnerName });
    }
    if (liveSetChanged) requestRuntimeRecovery();
    else pump();
  },
  (error) => console.error("Attempt subscription failed", error),
);

const unsubscribeExperiments = client.onUpdate(
  pendingExperiments,
  { token: config.machineToken },
  (result) => {
    maxSlots = result.maxSlots;
    const nextLiveExperimentIds = new Set(result.liveExperimentIds);
    const liveSetChanged = !sameIds(latestLiveExperimentIds, nextLiveExperimentIds);
    latestLiveExperimentIds = nextLiveExperimentIds;
    reconcileWithServer("experiment", result.liveExperimentIds);
    for (const experiment of result.experiments) {
      enqueue({
        kind: "experiment",
        id: experiment.experimentId,
        runnerName: experiment.name,
      });
    }
    if (liveSetChanged) requestRuntimeRecovery();
    else pump();
  },
  (error) => console.error("Experiment subscription failed", error),
);

const unsubscribeProfiles = client.onUpdate(
  workerProfiles,
  { token: config.machineToken },
  (profiles) => {
    discoveredProfiles = profiles;
    if (refreshingProfiles) refreshAgain = true;
    void refreshProfiles();
  },
  (error) => console.error("Profile discovery failed", error),
);

void refreshBenchmark();

// Heartbeats and the Attempt subscription stay up while running work drains:
// the control plane must keep seeing this Worker alive, and a cancelled
// Attempt must still stop its executor through reconcileWithServer.
const shutdown = createStopHandler({
  activeWork: () => work.active,
  waitForIdle: () => work.idle(),
  stopClaiming: () => {
    shuttingDown = true;
    if (readinessTimer !== undefined) clearTimeout(readinessTimer);
    if (benchmarkTimer !== undefined) clearTimeout(benchmarkTimer);
    if (recoveryRetryTimer !== undefined) clearTimeout(recoveryRetryTimer);
  },
  cancelWork: () => {
    for (const child of running.values()) child.kill();
  },
  finish: async () => {
    clearInterval(heartbeatTimer);
    if (coreReconcileTimer !== undefined) clearTimeout(coreReconcileTimer);
    unsubscribeCommands();
    unsubscribeAttempts();
    unsubscribeExperiments();
    unsubscribeProfiles();
    // Each flush is already bounded; this only stops the client closing underneath them.
    await Promise.allSettled(metricsFlushes);
    await clearReadinessSignal(dualEnv("RC_READY_FILE"));
    await client.close();
  },
});

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
