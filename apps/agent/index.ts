import { ConvexClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import { execa } from "execa";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";

type MachineOs = "linux" | "mac" | "win";
type PendingCommand = { commandId: string; runnerName: string };

type PendingCommandsResult = {
  os: MachineOs;
  maxSlots: number;
  commands: PendingCommand[];
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
let active = 0;
let maxSlots = 1;
let shuttingDown = false;

function provisionerPath(os: MachineOs) {
  const filename = os === "win" ? "provision-win.ps1" : `provision-${os}.sh`;
  return fileURLToPath(new URL(`../provisioners/${filename}`, import.meta.url));
}

async function provision(os: MachineOs, jitConfig: string, runnerName: string, image?: string) {
  const script = provisionerPath(os);
  const env = {
    ...process.env,
    JIT_CONFIG: jitConfig,
    RUNNER_NAME: runnerName,
    ...(image === undefined ? {} : { IMAGE: image }),
  };
  const result =
    os === "win"
      ? await execa("powershell.exe", ["-NoProfile", "-File", script], {
          env,
          reject: false,
          stdio: "inherit",
        })
      : await execa(script, [], {
          env,
          reject: false,
          stdio: "inherit",
        });
  return result.exitCode ?? 1;
}

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
    exitCode = await provision(claimed.os, claimed.jitConfig, claimed.runnerName, claimed.image);
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
