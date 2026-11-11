/**
 * Prints the `mesh` literal for `AGENT_RELEASE`, read out of the checksum sidecars of the five
 * `erainfra-mesh` assets. They come from a hand-run of the release workflow (README, release
 * section), because no single machine builds the macOS and Windows sidecars.
 *
 * A release commit pastes this in rather than transcribing the digests by hand. The release
 * workflow verifies the result against the bytes it builds, so a stale or mistyped pin fails the
 * tag rather than reaching a host that runs `/install --role node --mesh`.
 *
 * Usage: pnpm --filter @erainfra/backend print-mesh-pin [<directory>]
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { MESH_TARGETS, meshAssetName } from "../convex/agentRelease.ts";

const repoRoot = path.resolve(import.meta.dirname, "..", "..", "..");
const releaseDirectory = path.resolve(repoRoot, process.argv[2] ?? path.join("dist", "release"));

const lines = MESH_TARGETS.map((target) => {
  const asset = meshAssetName(target);
  const sidecar = path.join(releaseDirectory, `${asset}.sha256`);
  const digest = readFileSync(sidecar, "utf8").split(" ")[0];
  if (!/^[0-9a-f]{64}$/.test(digest)) {
    throw new Error(`${sidecar} does not start with a lowercase SHA-256 digest`);
  }
  return `    "${target}": "${digest}",`;
});

process.stdout.write(`  mesh: {\n${lines.join("\n")}\n  },\n`);
