import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { INFRA_AGENT_TARGETS, infraAgentAssetName } from "../../backend/convex/agentRelease.ts";
import {
  MESH_BUILDS,
  MESH_TARGETS,
  meshAssetName,
  meshBuild,
  meshRustflags,
} from "../src/mesh-assets.ts";

const repoRoot = path.resolve(import.meta.dirname, "..", "..", "..");
const read = (relative: string) => readFileSync(path.join(repoRoot, relative), "utf8");

describe("erainfra-mesh release assets", () => {
  it("builds exactly the targets the control plane names, once each", () => {
    assert.deepEqual(MESH_BUILDS.map((b) => b.target).toSorted(), [...MESH_TARGETS].toSorted());
    // Every Node runs the Infra Agent beside the mesh, so the two cover the same platforms.
    assert.deepEqual([...MESH_TARGETS].toSorted(), [...INFRA_AGENT_TARGETS].toSorted());
  });

  it("names assets the way the Infra Agent's are named", () => {
    for (const target of MESH_TARGETS) {
      assert.equal(
        meshAssetName(target),
        infraAgentAssetName(target).replace(/^infra-agent-/, "erainfra-mesh-"),
      );
    }
    assert.equal(meshAssetName("windows-x86_64"), "erainfra-mesh-windows-x86_64.exe");
    assert.equal(meshAssetName("linux-arm64"), "erainfra-mesh-linux-arm64");
  });

  it("builds Linux static with musl and every target for the CPU its name claims", () => {
    for (const build of MESH_BUILDS) {
      const [os, cpu] = build.target.split("-");
      const arch = build.triple.split("-")[0];
      assert.equal(arch, cpu === "arm64" ? "aarch64" : "x86_64", build.target);
      assert.ok(build.triple.includes(os === "darwin" ? "apple-darwin" : os), build.target);
      if (os === "linux") {
        assert.ok(build.triple.endsWith("-musl"), `${build.target} must be a static musl build`);
        assert.equal(build.tool, "zigbuild");
      }
    }
    assert.throws(() => meshBuild("freebsd-x86_64"), /unknown erainfra-mesh target/);
  });

  it("rewrites build paths so the bytes do not depend on where the checkout lives", () => {
    const paths = {
      repoRoot: "/home/runner/work/erainfra",
      cargoHome: "/home/runner/.cargo",
      targetDir: "/home/runner/work/erainfra/apps/mesh/target/assets-release",
    };
    const flags = meshRustflags(meshBuild("linux-x86_64"), paths).split("\x1f");
    assert.ok(flags.includes("--remap-path-prefix=/home/runner/work/erainfra=/erainfra"));
    assert.ok(flags.includes("--remap-path-prefix=/home/runner/.cargo/registry=/cargo/registry"));
    // The target directory is inside the checkout, and rustc applies the last matching prefix.
    assert.equal(flags.at(-1), `--remap-path-prefix=${paths.targetDir}=/target`);
    assert.ok(!flags.some((f) => f.includes("Brepro")));

    const windows = meshRustflags(meshBuild("windows-x86_64"), paths).split("\x1f");
    assert.ok(windows.includes("-Clink-arg=/Brepro"), "MSVC must not stamp the link time");
    assert.ok(windows.includes("-Ctarget-feature=+crt-static"));
    assert.ok(!flags.some((f) => f.includes("oso_prefix")));

    // Apple's linker hashes the object paths it records into LC_UUID before strip removes them,
    // so without this two builds in differently named target directories differ in 16 bytes.
    for (const target of ["darwin-arm64", "darwin-x86_64"] as const) {
      const darwin = meshRustflags(meshBuild(target), paths).split("\x1f");
      assert.ok(darwin.includes(`-Clink-arg=-Wl,-oso_prefix,${paths.targetDir}`), target);
      assert.ok(!darwin.some((f) => f.includes("Brepro")));
    }
  });

  it("pins the crate's version, toolchain and iroh", () => {
    const productVersion = JSON.parse(read("package.json")).version;
    const cargo = read("apps/mesh/Cargo.toml");
    assert.equal(/^version\s*=\s*"([^"]+)"/m.exec(cargo)?.[1], productVersion);
    assert.match(cargo, /^iroh = \{ version = "=1\.\d+\.\d+"/m, "iroh is pinned to one exact 1.x");
    const lock = read("apps/mesh/Cargo.lock");
    assert.match(
      lock,
      new RegExp(`name = "erainfra-mesh"\\nversion = "${productVersion.replace(/\./g, "\\.")}"`),
      "Cargo.lock agrees with Cargo.toml, so --locked builds",
    );
    for (const forbidden of ["iroh-gossip", "iroh-docs", "iroh-blobs"]) {
      assert.ok(!lock.includes(`name = "${forbidden}"`), `${forbidden} is not 1.0 and stays out`);
    }
    assert.match(read("apps/mesh/rust-toolchain.toml"), /^channel = "\d+\.\d+\.\d+"$/m);
  });

  it("accepts file's static ELF spelling and rejects dynamic Linux binaries", () => {
    const release = read(".github/workflows/release.yml");
    const ci = read(".github/workflows/ci.yml");
    for (const [target, cpu] of [
      ["linux-x86_64", "x86-64"],
      ["linux-arm64", "ARM aarch64"],
    ]) {
      const asset = meshAssetName(target);
      const releaseLine = release.split("\n").find((line) => line.includes(`expect ${asset} '`));
      const ciLine = ci.split("\n").find((line) => line.includes(`file dist/mesh-ci/${asset} |`));
      for (const [source, line] of [
        ["release", releaseLine],
        ["CI", ciLine],
      ]) {
        const pattern = line?.split("'")[1];
        assert.ok(pattern, `${source} must check ${asset}'s header`);
        const regex = new RegExp(pattern);
        for (const spelling of ["statically linked", "static-pie linked"]) {
          assert.match(
            `ELF 64-bit LSB executable, ${cpu}, version 1 (SYSV), ${spelling}, stripped`,
            regex,
          );
        }
        assert.doesNotMatch(`ELF 64-bit LSB executable, ${cpu}, dynamically linked`, regex);
      }
    }
  });

  it("is published by the release workflow beside the other binaries", () => {
    const release = read(".github/workflows/release.yml");
    assert.match(release, /dist\/release\/erainfra-mesh-\*/);
    for (const target of MESH_TARGETS) {
      assert.ok(release.includes(`--target ${target}`), `release.yml builds ${target}`);
    }
  });
});
