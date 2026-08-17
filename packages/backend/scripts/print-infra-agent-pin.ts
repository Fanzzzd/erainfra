/**
 * Prints the `infraAgent` literal for `AGENT_RELEASE`, read out of the checksum sidecars that
 * `pnpm --filter @erainfra/release build-go-assets` just wrote.
 *
 * A release commit pastes this in rather than transcribing five 64-character digests by hand. The
 * release workflow verifies the result against the bytes it builds, so a stale or mistyped pin
 * fails the tag rather than reaching a Node.
 *
 * Usage: pnpm --filter @erainfra/backend print-infra-agent-pin [<directory>]
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { INFRA_AGENT_TARGETS, infraAgentAssetName } from "../convex/agentRelease.ts";

const repoRoot = path.resolve(import.meta.dirname, "..", "..", "..");
const releaseDirectory = path.resolve(repoRoot, process.argv[2] ?? path.join("dist", "release"));

const lines = INFRA_AGENT_TARGETS.map((target) => {
  const asset = infraAgentAssetName(target);
  const sidecar = path.join(releaseDirectory, `${asset}.sha256`);
  const digest = readFileSync(sidecar, "utf8").split(" ")[0];
  if (!/^[0-9a-f]{64}$/.test(digest)) {
    throw new Error(`${sidecar} does not start with a lowercase SHA-256 digest`);
  }
  return `    "${target}": "${digest}",`;
});

process.stdout.write(`  infraAgent: {\n${lines.join("\n")}\n  },\n`);
