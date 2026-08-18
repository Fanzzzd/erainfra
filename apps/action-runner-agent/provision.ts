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
  /**
   * The CPU ids the Agent reserved for this Attempt, as `--cpuset-cpus` writes
   * them. Required for the Docker executor and meaningless for the rest: a
   * microVM guest has real vCPUs, so its `nproc` is honest by construction.
   */
  cpuset?: string;
  /**
   * The job cache endpoint this Worker offers, or absent. Absent is the default
   * and composes exactly the environment a fleet without a cache composes.
   *
   * This is the T0 tier, and after probe run 32109974600 it is the only
   * candidate left: the runner overwrites `ACTIONS_CACHE_URL`,
   * `ACTIONS_RESULTS_URL`, `ACTIONS_CACHE_SERVICE_V2` and
   * `ACTIONS_RUNTIME_TOKEN` from the job message in every ACTION step, which is
   * what every cache client is, so neither a workflow `env:` block nor
   * `$GITHUB_ENV` can reach one. The container environment is the only place
   * left that a value can be present before the runner starts. Whether the
   * runner's injection also beats its own process environment is the next
   * measurement, and this is what makes it possible to take.
   */
  cache?: CacheEndpoint;
  jitConfig: string;
};

/**
 * What an operator configured, not what a container receives. The rename to the
 * runner's own variable names happens in provision-docker.sh, next to every
 * other `--env` decision, so there is one place that decides what a job is told.
 */
export type CacheEndpoint = {
  url?: string;
  serviceV2?: string;
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
    // Refusing here rather than omitting the variable keeps the failure at the
    // one place that can still say why. The provisioner refuses too, but by
    // then the Attempt is claimed and the message is a shell error.
    if (attempt.cpuset === undefined) {
      throw new Error(
        `Attempt ${attempt.attemptId} has no CPU reservation; the Docker executor must not ` +
          `start a container that reads the host's core count (#80)`,
      );
    }
    return {
      file: dockerProvisionerPath(),
      args: [],
      env: {
        RUNNER_NAME: attempt.runnerName,
        RC_PROFILE: attempt.profile,
        IMAGE: attempt.imageRelease,
        RC_VCPUS: String(attempt.vcpus),
        RC_MEMORY_MIB: String(attempt.memoryMiB),
        RC_CPUSET_CPUS: attempt.cpuset,
        // Named here rather than left to `{ ...process.env }` in spawnAttempt.
        // The agent's own environment would carry these to the provisioner
        // either way, and that is exactly the accident worth refusing: what a
        // job is handed should be a decision this function makes and a test can
        // read, not something that arrives because the agent happened to be
        // started with it.
        ...(attempt.cache?.url === undefined ? {} : { ERAINFRA_CACHE_URL: attempt.cache.url }),
        ...(attempt.cache?.serviceV2 === undefined
          ? {}
          : { ERAINFRA_CACHE_SERVICE_V2: attempt.cache.serviceV2 }),
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
