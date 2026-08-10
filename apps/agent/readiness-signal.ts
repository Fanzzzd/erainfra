import { chmod, rm, writeFile } from "node:fs/promises";

/**
 * Publish proof that this exact Agent version reached the control plane.
 *
 * The installer removes the file before every service start and accepts only
 * the version it just installed, so stale logs or a previous process cannot
 * make a failed rollout look healthy.
 */
export async function publishReadinessSignal(
  filePath: string | undefined,
  version: string | undefined,
) {
  if (filePath === undefined) return;
  if (version === undefined || version.length === 0) {
    throw new Error("RC_AGENT_VERSION is required when RC_READY_FILE is configured");
  }
  await writeFile(filePath, `${version}\n`, { encoding: "utf8", mode: 0o600 });
  await chmod(filePath, 0o600);
}

export async function clearReadinessSignal(filePath: string | undefined) {
  if (filePath !== undefined) await rm(filePath, { force: true });
}
