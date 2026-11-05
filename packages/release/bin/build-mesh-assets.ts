import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { MESH_BUILDS, meshAssetName, meshBuild, meshRustflags } from "../src/mesh-assets.ts";

/**
 * Builds `erainfra-mesh` release assets (ADR 0016) into `--out` (default `dist/release`).
 *
 *   build-mesh-assets --target linux-x86_64 --target linux-arm64 [--out <dir>]
 *
 * Without `--target` it builds every target this host can build. Each target gets its own cargo
 * target directory named after `--out`, so a second build into another directory starts from
 * nothing and the release workflow's `cmp` of the two compares two real builds. Unlike
 * build-go-assets this never wipes `--out`: the release job downloads these assets into a
 * directory build-go-assets has already filled.
 */
const repoRoot = path.resolve(import.meta.dirname, "..", "..", "..");
const crate = path.join(repoRoot, "apps", "mesh");

function parseArgs(argv: readonly string[]) {
  const targets: string[] = [];
  let out = path.join(repoRoot, "dist", "release");
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag !== "--target" && flag !== "--out") {
      throw new Error(`unknown argument ${flag}`);
    }
    if (value === undefined) {
      throw new Error(`${flag} requires a value`);
    }
    if (flag === "--target") {
      targets.push(value);
    } else {
      out = path.resolve(repoRoot, value);
    }
    i += 1;
  }
  return { targets, out };
}

const hostOs = ({ linux: "linux", darwin: "darwin", win32: "windows" } as const)[
  process.platform as "linux" | "darwin" | "win32"
];
const { targets, out } = parseArgs(process.argv.slice(2));
const builds =
  targets.length > 0 ? targets.map(meshBuild) : MESH_BUILDS.filter((b) => b.host === hostOs);
if (builds.length === 0) {
  throw new Error(`no erainfra-mesh target builds on ${process.platform}`);
}

// The crate's version is the product version, as for every other binary in the release.
const productVersion = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"))
  .version as string;
const crateVersion = /^version\s*=\s*"([^"]+)"/m.exec(
  readFileSync(path.join(crate, "Cargo.toml"), "utf8"),
)?.[1];
if (crateVersion !== productVersion) {
  throw new Error(
    `apps/mesh/Cargo.toml is version ${crateVersion}, but the product version is ${productVersion}`,
  );
}

const cargoHome = process.env.CARGO_HOME ?? path.join(homedir(), ".cargo");
mkdirSync(out, { recursive: true });

for (const build of builds) {
  // Run from the crate so rustup picks the toolchain apps/mesh/rust-toolchain.toml pins.
  const targetDir = path.join(crate, "target", `assets-${path.basename(out)}`);
  execFileSync("rustup", ["target", "add", build.triple], { cwd: crate, stdio: "inherit" });
  const cargoArgs = [
    build.tool === "zigbuild" ? "zigbuild" : "build",
    "--release",
    "--locked",
    "--target",
    build.triple,
  ];
  execFileSync("cargo", cargoArgs, {
    cwd: crate,
    stdio: "inherit",
    env: {
      ...process.env,
      CARGO_TARGET_DIR: targetDir,
      CARGO_ENCODED_RUSTFLAGS: meshRustflags(build, { repoRoot, cargoHome, targetDir }),
      // Any RUSTFLAGS in the environment would be ignored next to the encoded form; say so by
      // clearing it rather than letting a runner's setting look as if it applied.
      RUSTFLAGS: "",
    },
  });
  const exe = build.target.startsWith("windows-") ? "erainfra-mesh.exe" : "erainfra-mesh";
  const asset = path.join(out, meshAssetName(build.target));
  copyFileSync(path.join(targetDir, build.triple, "release", exe), asset);
  const digest = createHash("sha256").update(readFileSync(asset)).digest("hex");
  writeFileSync(`${asset}.sha256`, `${digest}  ${path.basename(asset)}\n`);
  console.log(`${digest}  ${path.basename(asset)}`);
}
