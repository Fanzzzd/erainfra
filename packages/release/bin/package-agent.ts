/**
 * Builds the release archive for `apps/agent`.
 *
 * Usage: pnpm release:package [--out <directory>]
 *
 * Run `pnpm --filter @runner-center/agent build` first: this script packages
 * `apps/agent/dist`, it does not compile it.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  archiveName,
  buildAgentArchive,
  checksumLine,
  collectAgentFiles,
  readProductVersion,
} from "../src/agent-archive.ts";

const repoRoot = path.resolve(import.meta.dirname, "..", "..", "..");

function parseOutDirectory(argv: readonly string[]) {
  const index = argv.indexOf("--out");
  if (index === -1) {
    return path.join(repoRoot, "dist", "release");
  }
  const value = argv[index + 1];
  if (value === undefined) {
    throw new Error("--out requires a directory");
  }
  return path.resolve(repoRoot, value);
}

const outDirectory = parseOutDirectory(process.argv.slice(2));
const version = readProductVersion(repoRoot);
const entries = collectAgentFiles(
  path.join(repoRoot, "apps", "agent"),
  path.join(repoRoot, "apps", "runtime", "dist", "release"),
);
const { archive, sha256 } = buildAgentArchive(entries);

const name = archiveName(version);
mkdirSync(outDirectory, { recursive: true });
writeFileSync(path.join(outDirectory, name), archive);
writeFileSync(path.join(outDirectory, `${name}.sha256`), checksumLine(sha256, name));

const files = entries.filter((entry) => !entry.path.endsWith("/"));
console.log(`version   ${version}`);
console.log(`archive   ${path.relative(repoRoot, path.join(outDirectory, name))}`);
console.log(`files     ${files.length}`);
console.log(`bytes     ${archive.length}`);
console.log(`sha256    ${sha256}`);
