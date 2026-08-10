import { execa } from "execa";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

export type MachineOs = "linux" | "mac" | "win";

// "../" is the compiled layout (dist/provision.js), "./" is the source layout
// the test suite and `node --experimental-strip-types` see.
const PROVISIONER_DIRS = ["../provisioners/", "./provisioners/"];

function provisionerFile(filename: string) {
  for (const dir of PROVISIONER_DIRS) {
    const candidate = fileURLToPath(new URL(`${dir}${filename}`, import.meta.url));
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  throw new Error(`Could not find ${filename} next to the agent; the install is incomplete.`);
}

export function provisionerPath(os: MachineOs) {
  return provisionerFile(os === "win" ? "provision-win.ps1" : `provision-${os}.sh`);
}

export function dockerProvisionerPath() {
  return provisionerFile("provision-docker.sh");
}

export type ProvisionInvocation = {
  file: string;
  args: string[];
  env: Record<string, string>;
};

export type AttemptExecution = {
  attemptId: string;
  runnerName: string;
  profile: string;
  executor: "docker" | "firecracker" | "tart" | "hyperv";
  imageRelease: string;
  vcpus: number;
  memoryMiB: number;
  jitConfig: string;
};

export type ExperimentExecution = {
  experimentId: string;
  name: string;
  profile: string;
  executor: "firecracker";
  imageRelease: string;
  vcpus: number;
  memoryMiB: number;
  command: string[];
  timeoutSeconds: number;
};

/**
 * How a provisioner is launched. The JIT configuration is deliberately absent:
 * it is written to the child's stdin instead, so it never lands in argv or in
 * an environment block that `ps` can print.
 *
 * On Windows, Bypass covers the default Restricted policy on client SKUs, and
 * NonInteractive turns a would-be prompt into a failure the agent can report.
 */
export function provisionInvocation(
  os: MachineOs,
  runnerName: string,
  image?: string,
): ProvisionInvocation {
  const script = provisionerPath(os);
  const env: Record<string, string> = { RUNNER_NAME: runnerName };
  if (image !== undefined) {
    env.IMAGE = image;
  }

  return os === "win"
    ? {
        file: "powershell.exe",
        args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script],
        env,
      }
    : { file: script, args: [], env };
}

/**
 * Starts a provisioner and hands back the running child so the caller can wait
 * on it or cancel it.
 *
 * SIGTERM reaches the provisioner, whose own traps delete the container or VM;
 * killing the agent's child alone would leave the runner behind.
 */
export function spawnProvisioner(
  os: MachineOs,
  jitConfig: string,
  runnerName: string,
  image?: string,
) {
  const { file, args, env } = provisionInvocation(os, runnerName, image);
  return execa(file, args, {
    env: { ...process.env, ...env },
    input: jitConfig,
    stdout: "inherit",
    stderr: "inherit",
    reject: false,
    killSignal: "SIGTERM",
    forceKillAfterDelay: 30_000,
  });
}

export function attemptInvocation(
  attempt: Omit<AttemptExecution, "jitConfig">,
): ProvisionInvocation {
  if (attempt.executor === "firecracker") {
    return {
      file: process.env.RC_RUNTIME_BINARY?.trim() || "runner-center-runtime",
      args: ["run"],
      env: {
        RC_ATTEMPT_ID: attempt.attemptId,
        RC_RUNNER_NAME: attempt.runnerName,
        RC_PROFILE: attempt.profile,
        RC_IMAGE_RELEASE: attempt.imageRelease,
        RC_VCPUS: String(attempt.vcpus),
        RC_MEMORY_MIB: String(attempt.memoryMiB),
      },
    };
  }

  if (attempt.executor === "docker") {
    return {
      file: dockerProvisionerPath(),
      args: [],
      env: {
        RUNNER_NAME: attempt.runnerName,
        RC_PROFILE: attempt.profile,
        IMAGE: attempt.imageRelease,
        RC_VCPUS: String(attempt.vcpus),
        RC_MEMORY_MIB: String(attempt.memoryMiB),
      },
    };
  }

  const os = attempt.executor === "tart" ? "mac" : "win";
  return provisionInvocation(os, attempt.runnerName, attempt.imageRelease);
}

export function spawnAttempt(attempt: AttemptExecution) {
  const { file, args, env } = attemptInvocation(attempt);
  return execa(file, args, {
    env: { ...process.env, ...env },
    input: attempt.jitConfig,
    stdout: "inherit",
    stderr: "inherit",
    reject: false,
    killSignal: "SIGTERM",
    forceKillAfterDelay: 30_000,
  });
}

export function experimentInvocation(
  experiment: Omit<ExperimentExecution, "command">,
): ProvisionInvocation {
  return {
    file: process.env.RC_RUNTIME_BINARY?.trim() || "runner-center-runtime",
    args: ["experiment"],
    env: {
      RC_ATTEMPT_ID: experiment.experimentId,
      RC_RUNNER_NAME: `experiment-${experiment.experimentId.slice(-32)}`,
      RC_PROFILE: experiment.profile,
      RC_IMAGE_RELEASE: experiment.imageRelease,
      RC_VCPUS: String(experiment.vcpus),
      RC_MEMORY_MIB: String(experiment.memoryMiB),
      RC_JOB_TIMEOUT_S: String(experiment.timeoutSeconds),
    },
  };
}

export function spawnExperiment(experiment: ExperimentExecution) {
  const { file, args, env } = experimentInvocation(experiment);
  return execa(file, args, {
    env: { ...process.env, ...env },
    input: JSON.stringify(experiment.command),
    stdout: "inherit",
    stderr: "inherit",
    reject: false,
    killSignal: "SIGTERM",
    forceKillAfterDelay: 30_000,
  });
}
