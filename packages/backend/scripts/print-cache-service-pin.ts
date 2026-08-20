/**
 * Prints the `cacheService` literal for `AGENT_RELEASE`, read out of the checksum sidecars that
 * `pnpm --filter @erainfra/release build-go-assets` just wrote.
 *
 * A release commit pastes this in rather than transcribing the digest by hand. The release workflow
 * verifies the result against the bytes it builds, so a stale or mistyped pin fails the tag rather
 * than reaching a machine that installs the cache service (ADR 0009).
 *
 * Usage: pnpm --filter @erainfra/backend print-cache-service-pin [<directory>]
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { CACHE_SERVICE_TARGETS, cacheServiceAssetName } from "../convex/agentRelease.ts";

const repoRoot = path.resolve(import.meta.dirname, "..", "..", "..");
const releaseDirectory = path.resolve(repoRoot, process.argv[2] ?? path.join("dist", "release"));

const lines = CACHE_SERVICE_TARGETS.map((target) => {
  const asset = cacheServiceAssetName(target);
  const sidecar = path.join(releaseDirectory, `${asset}.sha256`);
  const digest = readFileSync(sidecar, "utf8").split(" ")[0];
  if (!/^[0-9a-f]{64}$/.test(digest)) {
    throw new Error(`${sidecar} does not start with a lowercase SHA-256 digest`);
  }
  return `    "${target}": "${digest}",`;
});

process.stdout.write(`  cacheService: {\n${lines.join("\n")}\n  },\n`);
