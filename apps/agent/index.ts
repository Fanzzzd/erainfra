import { arch, cpus, totalmem } from "node:os";
import { ConvexClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import { config } from "./config.js";
import {
  spawnAttempt,
  spawnExperiment,
  spawnProvisioner,
  type AttemptExecution,
  type ExperimentExecution,
  type MachineOs,
} from "./provision.js";
import { prepareProfile, type ProfileSpec } from "./readiness.js";

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
    error?: string;
  },
  null
>("workerApi:reportReadiness");
const workerProfiles = makeFunctionReference<"query", { token: string }, ProfileSpec[]>(
  "workerApi:profiles",
);
const reportHostFacts = makeFunctionReference<
  "mutation",
  { token: string; arch: string; cpus: number; memoryMiB: number },
  { maxSlots: number; recommendedSlots: number }
>("workerApi:reportHostFacts");
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

function pump() {
  if (shuttingDown) return;
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
    reconcileWithServer("attempt", result.liveAttemptIds);
    for (const attempt of result.attempts) {
      enqueue({ kind: "attempt", id: attempt.attemptId, runnerName: attempt.runnerName });
    }
    pump();
  },
  (error) => console.error("Attempt subscription failed", error),
);

const unsubscribeExperiments = client.onUpdate(
  pendingExperiments,
  { token: config.machineToken },
  (result) => {
    maxSlots = result.maxSlots;
    reconcileWithServer("experiment", result.liveExperimentIds);
    for (const experiment of result.experiments) {
      enqueue({
        kind: "experiment",
        id: experiment.experimentId,
        runnerName: experiment.name,
      });
    }
    pump();
  },
  (error) => console.error("Experiment subscription failed", error),
);

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
async function refreshProfiles() {
  if (refreshingProfiles || shuttingDown) return;
  refreshingProfiles = true;
  try {
    while (true) {
      refreshAgain = false;
      const profiles = discoveredProfiles;
      for (const profile of profiles) {
        await client.mutation(reportReadiness, {
          token: config.machineToken,
          profile: profile.profile,
          executor: profile.executor,
          imageRelease: profile.imageRelease,
          state: "preparing",
        });
        const readiness = await prepareProfile(profile);
        await client.mutation(reportReadiness, {
          token: config.machineToken,
          profile: profile.profile,
          executor: profile.executor,
          imageRelease: profile.imageRelease,
          ...readiness,
        });
        console.log(`${profile.profile} readiness: ${readiness.state}`);
      }
      if (!refreshAgain || shuttingDown) break;
    }
  } catch (error) {
    console.error("Refreshing Profile readiness failed", error);
  } finally {
    refreshingProfiles = false;
  }
}

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
const readinessTimer = setInterval(() => void refreshProfiles(), 6 * 60 * 60_000);
console.log(
  `Runner Center Worker connected to ${config.convexUrl}; discovering compatible Profiles`,
);

async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Received ${signal}; stopping Worker`);
  clearInterval(heartbeatTimer);
  clearInterval(readinessTimer);
  unsubscribeCommands();
  unsubscribeAttempts();
  unsubscribeExperiments();
  unsubscribeProfiles();
  for (const child of running.values()) child.kill();
  await Promise.allSettled(running.values());
  await client.close();
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
