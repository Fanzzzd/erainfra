import { execa } from "execa";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

export type MachineOs = "linux" | "mac" | "win";

// "../" is the compiled layout (dist/provision.js), "./" is the source layout
// the test suite and `node --experimental-strip-types` see.
const PROVISIONER_DIRS = ["../provisioners/", "./provisioners/"];

export function provisionerPath(os: MachineOs) {
  const filename = os === "win" ? "provision-win.ps1" : `provision-${os}.sh`;

  for (const dir of PROVISIONER_DIRS) {
    const candidate = fileURLToPath(new URL(`${dir}${filename}`, import.meta.url));
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  throw new Error(`Could not find ${filename} next to the agent; the install is incomplete.`);
}

export type ProvisionInvocation = {
  file: string;
  args: string[];
  env: Record<string, string>;
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
