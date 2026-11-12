import { execa } from "execa";

import { childEnvironment, runtimeBinary } from "./dual-env.ts";
import type { ProfileSpec } from "./readiness.ts";

/**
 * Asks the Firecracker runtime to delete Image Releases no Profile of this Worker uses.
 *
 * The runtime keeps the ones sent here, its warm pools' and the newest other one, so a rollback
 * needs no pull (apps/runtime/internal/firecracker/imagegc.go). Only this Agent knows every
 * Profile the Worker serves, which is why the list comes from here. A prune is at most hourly:
 * it frees disk, not capacity, and an Image Release replaced by a repin can wait an hour.
 */
export const IMAGE_PRUNE_INTERVAL_MS = 60 * 60_000;

/** The Image Releases of the Worker's Firecracker Profiles, in Profile order, without repeats. */
export function imageReleasesToKeep(profiles: readonly ProfileSpec[]) {
  return [
    ...new Set(
      profiles
        .filter((profile) => profile.executor === "firecracker")
        .map((profile) => profile.imageRelease),
    ),
  ];
}

export type RunPrune = (
  keep: string[],
) => Promise<{ exitCode?: number; stdout: string; stderr: string }>;

const runPrune: RunPrune = (keep) =>
  execa(runtimeBinary(), ["prune-images"], {
    env: childEnvironment({}),
    input: JSON.stringify(keep),
    // The last delete waits for containerd's garbage collection of the freed layers.
    timeout: 10 * 60_000,
    reject: false,
  });

/**
 * Prunes once the interval has passed since lastPrunedAt. Returns the time to remember: now
 * after an attempt, success or not, so a failing runtime is asked again an hour later rather than
 * on every readiness pass; lastPrunedAt when it did nothing.
 */
export async function pruneImageReleases(
  profiles: readonly ProfileSpec[],
  lastPrunedAt: number,
  now: number,
  run: RunPrune = runPrune,
) {
  const keep = imageReleasesToKeep(profiles);
  if (keep.length === 0 || now - lastPrunedAt < IMAGE_PRUNE_INTERVAL_MS) return lastPrunedAt;
  try {
    const result = await run(keep);
    if (result.exitCode !== 0) {
      console.error(
        `Image Release prune failed: ${result.stderr.trim() || `exit ${result.exitCode}`}`,
      );
      return now;
    }
    const { deleted } = JSON.parse(result.stdout) as { deleted?: string[] };
    if (deleted && deleted.length > 0) {
      console.log(
        `Deleted ${deleted.length} Image Release(s) no Profile uses: ${deleted.join(", ")}`,
      );
    }
  } catch (error) {
    console.error("Image Release prune failed", error);
  }
  return now;
}
