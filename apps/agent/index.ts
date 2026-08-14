import { arch, cpus, totalmem } from "node:os";
import { ConvexClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import {
  BENCHMARK_REFRESH_MS,
  BENCHMARK_RETRY_MS,
  runWorkerBenchmark,
  type BenchmarkReport,
} from "./benchmark.js";
import { config } from "./config.js";
import { recoverFirecrackerOrphans } from "./orphan-recovery.js";
import {
  spawnAttempt,
  spawnExperiment,
  spawnProvisioner,
  type AttemptExecution,
  type ExperimentExecution,
  type MachineOs,
} from "./provision.js";
import {
  HEALTHY_READINESS_REFRESH_MS,
  readinessRefreshDelay,
  UNHEALTHY_READINESS_REFRESH_MS,
  prepareProfile,
  type PublishedReadinessState,
  type ReadinessFacts,
  type ProfileSpec,
} from "./readiness.js";
import { clearReadinessSignal, publishReadinessSignal } from "./readiness-signal.js";

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
  { token: string },
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
  { token: string; attemptId: string; exitCode: number },
  boolean
>("workerApi:reportAttempt");
const reportReadiness = makeFunctionReference<
  "mutation",
  {
    token: string;
    profile: string;
    executor: "docker" | "firecracker" | "tart" | "hyperv";
    imageRelease: string;
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
let active = 0;
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

function scheduleBenchmark(delayMs: number) {
  if (shuttingDown) return;
  if (benchmarkTimer !== undefined) clearTimeout(benchmarkTimer);
  benchmarkTimer = setTimeout(() => void refreshBenchmark(), delayMs);
}

async function refreshBenchmark() {
  if (shuttingDown || benchmarking) return;
  // Measurement never reserves a job slot. The automatic pass also waits for
  // an idle Worker so its own load cannot distort a live workload.
  if (active > 0 || running.size > 0 || queue.length > 0) {
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
  try {
    const claimed = await client.mutation(claimAttempt, {
      token: config.machineToken,
      attemptId: item.id,
    });
    if (claimed === null) return;
    claimedByThisAgent = true;
    console.log(`Starting ${claimed.executor} Attempt ${claimed.runnerName}`);
    const child = spawnAttempt({ attemptId: item.id, ...claimed });
    running.set(workKey(item.kind, item.id), child);
    try {
      if (child.pid === undefined) {
        throw new Error(`The ${claimed.executor} executor did not spawn`);
      }
      const result = await child;
      exitCode = result.exitCode ?? 1;
    } finally {
      running.delete(workKey(item.kind, item.id));
    }
  } catch (error) {
    console.error(`Attempt ${item.runnerName} failed`, error);
  } finally {
    if (claimedByThisAgent) {
      try {
        await client.mutation(reportAttempt, {
          token: config.machineToken,
          attemptId: item.id,
          exitCode,
        });
      } catch (error) {
        console.error(`Reporting Attempt ${item.runnerName} failed`, error);
      }
    }
  }
}

async function runExperiment(item: Extract<WorkItem, { kind: "experiment" }>) {
  let exitCode = 1;
  let claimedByThisAgent = false;
  try {
    const claimed = await client.mutation(claimExperiment, {
      token: config.machineToken,
      experimentId: item.id,
    });
    if (claimed === null) return;
    claimedByThisAgent = true;
    console.log(`Starting Experiment ${claimed.name} with ${claimed.profile}`);
    const child = spawnExperiment({ experimentId: item.id, ...claimed });
    running.set(workKey(item.kind, item.id), child);
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
      exitCode = result.exitCode ?? 1;
    } finally {
      running.delete(workKey(item.kind, item.id));
    }
  } catch (error) {
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

function pump() {
  if (
    shuttingDown ||
    !acceptingWork ||
    recoveringRuntime ||
    completedRecoveryRevision < recoveryRevision
  ) {
    return;
  }
  while (active < maxSlots && queue.length > 0) {
    const item = queue.shift();
    if (item === undefined) break;
    active += 1;
    void runWork(item).finally(() => {
      active -= 1;
      pump();
    });
  }
}

async function heartbeat() {
  try {
    const machine = await client.mutation(heartbeatAgent, { token: config.machineToken });
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
      const states: PublishedReadinessState[] = [];
      for (const profile of profiles) {
        const preparingDetail = `Checking ${profile.executor} and prewarming ${profile.imageRelease}`;
        console.log(`${profile.profile} readiness: preparing; ${preparingDetail}`);
        await client.mutation(reportReadiness, {
          token: config.machineToken,
          profile: profile.profile,
          executor: profile.executor,
          imageRelease: profile.imageRelease,
          state: "preparing",
          statusDetail: preparingDetail,
        });
        const readiness = await prepareProfile(profile);
        const statusDetail =
          readiness.state === "ready"
            ? `Prepared the immutable Image Release and passed ${readiness.checks.length} readiness check(s)`
            : "Readiness check failed; retrying in five minutes";
        const reported = await client.mutation(reportReadiness, {
          token: config.machineToken,
          profile: profile.profile,
          executor: profile.executor,
          imageRelease: profile.imageRelease,
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
      nextRefreshMs = readinessRefreshDelay(states);
      if (!refreshAgain || shuttingDown) break;
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
await publishReadinessSignal(process.env.RC_READY_FILE, process.env.RC_AGENT_VERSION);
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

async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Received ${signal}; stopping Worker`);
  clearInterval(heartbeatTimer);
  if (readinessTimer !== undefined) clearTimeout(readinessTimer);
  if (benchmarkTimer !== undefined) clearTimeout(benchmarkTimer);
  if (recoveryRetryTimer !== undefined) clearTimeout(recoveryRetryTimer);
  unsubscribeCommands();
  unsubscribeAttempts();
  unsubscribeExperiments();
  unsubscribeProfiles();
  for (const child of running.values()) child.kill();
  await Promise.allSettled(running.values());
  await clearReadinessSignal(process.env.RC_READY_FILE);
  await client.close();
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
