import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * The one place the Go toolchain is declared: the `go` directive in the repository's go.mod.
 *
 * Reproducibility is scoped to a toolchain, not to the build flags. `-trimpath -buildvcs=false
 * -buildid=` makes two builds of one commit on one toolchain identical; it does not make two
 * toolchains agree, and a PATCH release is enough to disagree. Measured on apps/infra-agent
 * linux/arm64 at commit 459f7cf, identical flags and version string:
 *
 *   go1.25.3  39f8bfb1d440d3bbe6a1056f9d48bf841157e448798cf45b4bb01de51adbe68a
 *   go1.25.5  f0763eb69ffe8ad75c3b383b36355a9c4b7169c96c0fe1e16a3d8d86a621063f
 *
 * Both digests name a commit because they are perishable in a way worth knowing about: `-s -w`
 * strips the symbol table and DWARF but not the pclntab, so the binary carries line numbers, and a
 * comment inserted above existing code moves every later line and changes the bytes. That is the
 * build being reproducible *to the line*, not being nondeterministic — see build-agents.sh's header
 * for the measurement.
 *
 * That matters because a Node verifies its Infra Agent against a digest the release attested, and
 * deploy/infra/build-agents.sh compiles the hub's mirror of those same bytes. If the two build
 * paths can drift by a patch upgrade, every install from that mirror is refused — a correct refusal
 * for the wrong reason, pointing the operator at the wrong fix.
 *
 * `GOTOOLCHAIN=auto`, the default, takes the LATER of the local toolchain and what go.mod asks for,
 * so a `toolchain` directive raises a floor and never caps: with `toolchain go1.25.5` and a local
 * go1.25.3, go reports go1.25.5. Only an explicit GOTOOLCHAIN pins, which is what both build paths
 * set from this value.
 */
export type PinnedGoToolchain = {
  /** The bare version, e.g. `1.25.3`. */
  version: string;
  /** What GOTOOLCHAIN is set to, e.g. `go1.25.3`. */
  goToolchain: string;
  /** What `go version` must report, e.g. `go1.25.3`. */
  expectedGoVersion: string;
};

export function readPinnedGoToolchain(repoRoot: string): PinnedGoToolchain {
  const goMod = readFileSync(path.join(repoRoot, "go.mod"), "utf8");

  // A `toolchain` directive would be a second declaration that can disagree with the first, and
  // under GOTOOLCHAIN=auto it is the one that wins. One source or none.
  const toolchain = /^toolchain\s+(\S+)$/m.exec(goMod);
  if (toolchain !== null) {
    throw new Error(
      `go.mod declares "toolchain ${toolchain[1]}" as well as its go directive. The go directive is the single source both build paths read; remove the toolchain line or move the version onto it.`,
    );
  }

  // Deliberately the same shape deploy/infra/build-agents.sh matches with sed, so a hub with no
  // Node.js resolves the identical version. A test runs both and compares.
  const directive = /^go\s+([0-9][0-9.]*)$/m.exec(goMod);
  if (directive === null) {
    throw new Error("go.mod has no usable go directive");
  }

  const version = directive[1];
  return { version, goToolchain: `go${version}`, expectedGoVersion: `go${version}` };
}
