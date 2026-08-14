import { stat } from "node:fs/promises";
import { execa } from "execa";
import type { ProfileSpec } from "./readiness.js";

const DEFAULT_RUNTIME_SOCKET = "/run/runner-center/runtime.sock";
const RECOVERY_TIMEOUT_MS = 5 * 60_000;

type RecoveryOptions = {
  platform?: NodeJS.Platform;
  socketAvailable?: (path: string) => Promise<boolean>;
  run?: (
    file: string,
    args: string[],
    options: { input: string; timeout: number },
  ) => Promise<unknown>;
};

export function runtimeSocketPath() {
  return process.env.RC_RUNTIME_SOCKET?.trim() || DEFAULT_RUNTIME_SOCKET;
}

async function isSocket(path: string) {
  try {
    return (await stat(path)).isSocket();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return false;
    throw error;
  }
}

/**
 * Reconciles a Linux Firecracker runtime before the Worker advertises itself
 * or enters the claim loop. The socket is the local capability boundary: all
 * Linux archives carry the CLI, but Docker-only hosts do not run the privileged
 * service, while a provisioned Firecracker host keeps the socket even when its
 * last Profile was removed and old orphan state still needs cleanup.
 */
export async function recoverFirecrackerOrphans(
  profiles: readonly ProfileSpec[],
  liveAttemptIds: Iterable<string>,
  options: RecoveryOptions = {},
) {
  if ((options.platform ?? process.platform) !== "linux") return false;

  const socket = runtimeSocketPath();
  if (!(await (options.socketAvailable ?? isSocket)(socket))) return false;

  const live = [...new Set(liveAttemptIds)];
  const binary = process.env.RC_RUNTIME_BINARY?.trim() || "runner-center-runtime";
  await (options.run ?? execa)(binary, ["recover"], {
    input: JSON.stringify(live),
    timeout: RECOVERY_TIMEOUT_MS,
  });
  const firecrackerProfiles = profiles.filter((profile) => profile.executor === "firecracker");
  console.log(
    `Firecracker recovery: preserved ${live.length} server-live execution(s); ` +
      `${firecrackerProfiles.length} compatible Profile(s) discovered`,
  );
  return true;
}
