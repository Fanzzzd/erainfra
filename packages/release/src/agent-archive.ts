/**
 * Packs `apps/agent` into the immutable archive that runner machines download.
 *
 * The archive carries the compiled daemon, the provisioners, and the npm
 * lockfile, so a machine only has to run `npm ci --omit=dev` — it never needs a
 * TypeScript toolchain, and it never resolves a dependency range on its own.
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { createTarGz, type TarEntry } from "./tar.ts";

/** Every archive path lives under this directory, stripped on extraction. */
export const ARCHIVE_ROOT = "agent";

const DIRECTORY_MODE = 0o755;
const EXECUTABLE_MODE = 0o755;
const FILE_MODE = 0o644;

const ROOT_FILES = ["package.json", "package-lock.json"];

function byPath(a: string, b: string) {
  if (a === b) {
    return 0;
  }
  return a < b ? -1 : 1;
}

function modeFor(relativePath: string) {
  return relativePath.endsWith(".sh") || relativePath.endsWith("runner-center-runtime")
    ? EXECUTABLE_MODE
    : FILE_MODE;
}

function listFiles(directory: string, prefix: string, filter: (name: string) => boolean) {
  const found: string[] = [];
  for (const item of readdirSync(directory, { withFileTypes: true })) {
    const relativePath = `${prefix}/${item.name}`;
    if (item.isDirectory()) {
      found.push(...listFiles(path.join(directory, item.name), relativePath, filter));
    } else if (item.isFile() && filter(item.name)) {
      found.push(relativePath);
    }
  }
  return found;
}

/** Insert the parent directory entries tar readers expect, then sort. */
function withDirectories(files: readonly TarEntry[]) {
  const directories = new Set<string>();
  for (const file of files) {
    const segments = file.path.split("/").slice(0, -1);
    for (let index = 1; index <= segments.length; index += 1) {
      directories.add(`${segments.slice(0, index).join("/")}/`);
    }
  }
  const entries = [
    ...[...directories].map((directoryPath) => ({
      path: directoryPath,
      mode: DIRECTORY_MODE,
      data: new Uint8Array(),
    })),
    ...files,
  ];
  return entries.toSorted((a, b) => byPath(a.path, b.path));
}

/**
 * Read the files that belong in the archive, in a fixed order and with modes
 * from policy rather than from the working tree.
 */
export function collectAgentFiles(agentDir: string, runtimeDir?: string): TarEntry[] {
  const relativePaths = [
    ...ROOT_FILES,
    ...listFiles(path.join(agentDir, "dist"), "dist", (name) => name.endsWith(".js")),
    ...listFiles(path.join(agentDir, "provisioners"), "provisioners", () => true),
  ].toSorted(byPath);

  if (!relativePaths.includes("dist/index.js")) {
    throw new Error(`${agentDir}/dist/index.js is missing; build the agent first`);
  }

  const files = relativePaths.map((relativePath) => ({
    path: `${ARCHIVE_ROOT}/${relativePath}`,
    mode: modeFor(relativePath),
    data: readFileSync(path.join(agentDir, relativePath)),
  }));

  if (runtimeDir !== undefined) {
    for (const platform of ["linux-x86_64", "linux-arm64"]) {
      const relativePath = `runtime/${platform}/runner-center-runtime`;
      files.push({
        path: `${ARCHIVE_ROOT}/${relativePath}`,
        mode: modeFor(relativePath),
        data: readFileSync(path.join(runtimeDir, platform, "runner-center-runtime")),
      });
    }
  }

  return withDirectories(files);
}

export function sha256Hex(data: Uint8Array) {
  return createHash("sha256").update(data).digest("hex");
}

export function archiveName(version: string) {
  return `runner-center-agent-${version}.tar.gz`;
}

/** The `<hash>  <name>` line format that `sha256sum -c` and `shasum -c` read. */
export function checksumLine(sha256: string, name: string) {
  return `${sha256}  ${name}\n`;
}

export function buildAgentArchive(entries: readonly TarEntry[]) {
  const archive = createTarGz(entries);
  return { archive, sha256: sha256Hex(archive) };
}

function readVersion(packageJsonPath: string) {
  const parsed: unknown = JSON.parse(readFileSync(packageJsonPath, "utf8"));
  const version =
    typeof parsed === "object" && parsed !== null && "version" in parsed
      ? (parsed as { version: unknown }).version
      : undefined;
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)*$/.test(version)) {
    throw new Error(`${packageJsonPath} has no valid semver version`);
  }
  return version;
}

/**
 * Runner Center ships as one product, so the workspace root and the agent carry
 * the same version and a release tag is `v<version>`.
 */
export function readProductVersion(repoRoot: string) {
  const rootVersion = readVersion(path.join(repoRoot, "package.json"));
  const agentVersion = readVersion(path.join(repoRoot, "apps", "agent", "package.json"));
  const controllerVersion = readVersion(path.join(repoRoot, "apps", "controller", "package.json"));
  const runtimeVersion = readVersion(path.join(repoRoot, "apps", "runtime", "package.json"));
  if (
    rootVersion !== agentVersion ||
    rootVersion !== controllerVersion ||
    rootVersion !== runtimeVersion
  ) {
    throw new Error(
      `Version drift: root=${rootVersion} agent=${agentVersion} controller=${controllerVersion} runtime=${runtimeVersion}`,
    );
  }
  return rootVersion;
}
