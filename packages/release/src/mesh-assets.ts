import path from "node:path";
import { MESH_TARGETS, meshAssetName } from "../../backend/convex/agentRelease.ts";

/**
 * How each `erainfra-mesh` release asset is built (ADR 0016).
 *
 * Linux targets are musl and cross-compiled with cargo-zigbuild: Zig supplies a C compiler and
 * linker for both CPUs, so ring's C and assembly build for aarch64 on an x86_64 runner without a
 * Docker image per target (which `cross` would need) and the result is a static binary that runs
 * on any distribution. macOS links Apple's frameworks (Security, SystemConfiguration) and the SDK
 * cannot legally be shipped to a Linux box, so both darwin targets build on a macOS runner, where
 * the Xcode toolchain cross-compiles x86_64 from arm64 natively. Windows builds on a Windows runner
 * with MSVC and a static C runtime, the target Rust supports best there.
 */
export type MeshBuild = {
  /** The asset's `<os>-<cpu>` suffix, the same spelling the Infra Agent uses. */
  target: MeshTarget;
  /** The Rust target triple. */
  triple: string;
  /** `zigbuild` cross-compiles with cargo-zigbuild; `native` uses plain cargo on that OS. */
  tool: "zigbuild" | "native";
  /** The runner OS this target builds on. */
  host: "linux" | "darwin" | "windows";
};

export const MESH_BUILDS = [
  { target: "linux-x86_64", triple: "x86_64-unknown-linux-musl", tool: "zigbuild", host: "linux" },
  { target: "linux-arm64", triple: "aarch64-unknown-linux-musl", tool: "zigbuild", host: "linux" },
  { target: "darwin-x86_64", triple: "x86_64-apple-darwin", tool: "native", host: "darwin" },
  { target: "darwin-arm64", triple: "aarch64-apple-darwin", tool: "native", host: "darwin" },
  { target: "windows-x86_64", triple: "x86_64-pc-windows-msvc", tool: "native", host: "windows" },
] as const satisfies readonly MeshBuild[];

export type MeshTarget = (typeof MESH_TARGETS)[number];

// The asset names are the control plane's, so the installer that later pins and downloads them
// and this build can never disagree about what a file is called.
export { meshAssetName, MESH_TARGETS };

export function meshBuild(target: string): MeshBuild {
  const build = MESH_BUILDS.find((b) => b.target === target);
  if (build === undefined) {
    throw new Error(
      `unknown erainfra-mesh target ${target}; expected one of ${MESH_BUILDS.map((b) => b.target).join(", ")}`,
    );
  }
  return build;
}

/**
 * The compiler flags that make a build a function of the source alone.
 *
 * Absolute paths of the checkout, the cargo registry and the target directory are rewritten to
 * fixed prefixes, so two checkouts in different places produce the same bytes. On Windows,
 * `/Brepro` makes the MSVC linker write a content hash where it would otherwise write the link
 * time, and `+crt-static` links the C runtime in so the binary needs no redistributable.
 */
export function meshRustflags(
  build: MeshBuild,
  paths: { repoRoot: string; cargoHome: string; targetDir: string },
) {
  // rustc applies the last matching prefix, so the target directory, which sits inside the
  // checkout, comes after the checkout.
  const flags = [
    `--remap-path-prefix=${paths.repoRoot}=/erainfra`,
    `--remap-path-prefix=${path.join(paths.cargoHome, "registry")}=/cargo/registry`,
    `--remap-path-prefix=${path.join(paths.cargoHome, "git")}=/cargo/git`,
    `--remap-path-prefix=${paths.targetDir}=/target`,
  ];
  if (build.triple.endsWith("-windows-msvc")) {
    flags.push("-Ctarget-feature=+crt-static", "-Clink-arg=/Brepro");
  }
  // RUSTFLAGS splits on whitespace, so a path containing a space would silently become two flags.
  // CARGO_ENCODED_RUSTFLAGS separates with 0x1f instead.
  return flags.join("\x1f");
}
