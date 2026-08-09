import { ConvexClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import { config } from "./config.js";
import { type MachineOs, spawnProvisioner } from "./provision.js";

type PendingCommand = { commandId: string; runnerName: string };

type PendingCommandsResult = {
  os: MachineOs;
  maxSlots: number;
  commands: PendingCommand[];
  // Added by newer backends. Absent means the backend cannot tell us about
  // cancellations, so we leave running provisioners alone.
  liveCommandIds?: string[];
};

type ClaimedCommand = {
  jitConfig: string;
  image?: string;
  runnerName: string;
  os: MachineOs;
};

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

const client = new ConvexClient(config.convexUrl);
const queuedIds = new Set<string>();
const queue: PendingCommand[] = [];
const running = new Map<string, ReturnType<typeof spawnProvisioner>>();
let active = 0;
let maxSlots = 1;
let shuttingDown = false;

async function runCommand(command: PendingCommand) {
  let exitCode = 1;
  let claimedByThisAgent = false;
  try {
    const claimed = await client.mutation(claimCommand, {
      token: config.machineToken,
      commandId: command.commandId,
    });
    if (claimed === null) {
      return;
    }
    claimedByThisAgent = true;
    console.log(`Starting ephemeral runner ${claimed.runnerName}`);
    const child = spawnProvisioner(
      claimed.os,
      claimed.jitConfig,
      claimed.runnerName,
      claimed.image,
    );
    running.set(command.commandId, child);
    try {
      const result = await child;
      exitCode = result.exitCode ?? 1;
    } finally {
      running.delete(command.commandId);
    }
    console.log(`Ephemeral runner ${claimed.runnerName} exited with code ${exitCode}`);
  } catch (error) {
    console.error(`Provisioning ${command.runnerName} failed`, error);
  } finally {
    if (claimedByThisAgent) {
      try {
        await client.mutation(reportCommand, {
          token: config.machineToken,
          commandId: command.commandId,
          exitCode,
        });
      } catch (error) {
        console.error(`Reporting ${command.runnerName} failed`, error);
      }
    }
  }
}

/**
 * Tear down work the control plane no longer considers live: a cancelled job,
 * a command reconciled away, or a machine whose registration was removed.
 * Without this the provisioner would keep an ephemeral runner — and this
 * agent's slot — occupied forever.
 */
function reconcileWithServer(liveCommandIds: string[] | undefined) {
  if (liveCommandIds === undefined) {
    return;
  }
  const live = new Set(liveCommandIds);

  for (const [commandId, child] of running) {
    if (live.has(commandId)) {
      continue;
    }
    console.log(`Command ${commandId} is no longer live; stopping its runner`);
    child.kill();
  }

  for (let index = queue.length - 1; index >= 0; index -= 1) {
    const queued = queue[index];
    if (queued !== undefined && !live.has(queued.commandId)) {
      queue.splice(index, 1);
    }
  }
  // Keeps the dedup set bounded over the daemon's lifetime.
  for (const commandId of queuedIds) {
    if (!live.has(commandId) && !running.has(commandId)) {
      queuedIds.delete(commandId);
    }
  }
}

function pump() {
  if (shuttingDown) {
    return;
  }
  while (active < maxSlots && queue.length > 0) {
    const command = queue.shift();
    if (command === undefined) {
      break;
    }
    active += 1;
    void runCommand(command).finally(() => {
      active -= 1;
      pump();
    });
  }
}

const unsubscribe = client.onUpdate(
  pendingCommands,
  { token: config.machineToken },
  (result) => {
    maxSlots = result.maxSlots;
    reconcileWithServer(result.liveCommandIds);
    for (const command of result.commands) {
      if (!queuedIds.has(command.commandId)) {
        queuedIds.add(command.commandId);
        queue.push(command);
      }
    }
    pump();
  },
  (error) => console.error("Command subscription failed", error),
);

async function heartbeat() {
  try {
    const machine = await client.mutation(heartbeatAgent, {
      token: config.machineToken,
    });
    maxSlots = machine.maxSlots;
    pump();
  } catch (error) {
    console.error("Heartbeat failed", error);
  }
}

await heartbeat();
const heartbeatTimer = setInterval(() => void heartbeat(), config.heartbeatMs);
console.log(`Runner Center agent connected to ${config.convexUrl}`);

async function shutdown(signal: string) {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  console.log(`Received ${signal}; stopping agent`);
  clearInterval(heartbeatTimer);
  unsubscribe();
  await client.close();
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
