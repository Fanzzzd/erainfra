import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { readPinnedGoToolchain } from "../src/go-toolchain.ts";

const repoRoot = path.resolve(import.meta.dirname, "..", "..", "..");
const buildAgents = readFileSync(path.join(repoRoot, "deploy", "infra", "build-agents.sh"), "utf8");
const buildGoAssets = readFileSync(
  path.join(repoRoot, "packages", "release", "bin", "build-go-assets.ts"),
  "utf8",
);

/**
 * A Node verifies its Infra Agent against a digest the release attested, and a hub compiles its own
 * mirror of those bytes with deploy/infra/build-agents.sh. Two build paths that happen to agree
 * today is exactly the shape of the -buildid= bug: the digest comparison cannot tell a toolchain
 * difference from tampering, so the toolchain has to be pinned in both from one declaration and
 * asserted rather than merely set.
 */
describe("the Go toolchain both build paths use", () => {
  it("is declared once, in go.mod, and nowhere else", () => {
    const pinned = readPinnedGoToolchain(repoRoot);
    assert.match(pinned.version, /^\d+\.\d+\.\d+$/);

    // A patch-level pin is the whole point: go1.25.3 and go1.25.5 produce different bytes from
    // identical source and flags. A `go 1.25` directive would pin nothing.
    assert.equal(pinned.goToolchain, `go${pinned.version}`);
  });

  it("resolves identically in the shell path, which has no Node.js to read go.mod with", () => {
    const pinned = readPinnedGoToolchain(repoRoot);

    // Run build-agents.sh's own extraction, lifted verbatim from the script, against the real
    // go.mod. If someone edits either parser, this is what disagrees.
    const extraction = /^GO_DIRECTIVE=\$\((.*)\)$/m.exec(buildAgents);
    assert.ok(extraction, "build-agents.sh must derive GO_DIRECTIVE from go.mod");
    const fromShell = execFileSync("sh", ["-c", extraction[1]], {
      cwd: repoRoot,
      encoding: "utf8",
      env: { ...process.env, REPO: repoRoot },
    }).trim();
    assert.equal(fromShell, pinned.version);
    assert.match(extraction[1], /go\.mod/, "the shell path must read the same file, not a copy");
  });

  it("is set explicitly in both build paths, because the default resolves to at-least", () => {
    // GOTOOLCHAIN=auto takes the later of the local toolchain and go.mod's requirement, so it can
    // only go up. Neither path may rely on it.
    assert.match(buildAgents, /GOTOOLCHAIN="go\$GO_DIRECTIVE"/);
    assert.match(buildGoAssets, /GOTOOLCHAIN: toolchain\.goToolchain/);
    assert.match(buildGoAssets, /readPinnedGoToolchain\(repoRoot\)/);
  });

  it("is verified after it is set, in both build paths", () => {
    // Setting GOTOOLCHAIN on a box that cannot download that toolchain fails; failing loudly here,
    // naming the toolchain, is better than shipping bytes whose refusal reads like tampering.
    assert.match(buildAgents, /refusing to build on an unpinned toolchain/);
    assert.match(buildGoAssets, /would use \$\{reported\}/);
  });

  it("is what CI installs, from the same file rather than a literal", () => {
    for (const workflow of ["ci.yml", "release.yml"]) {
      const text = readFileSync(path.join(repoRoot, ".github", "workflows", workflow), "utf8");
      const steps = [
        ...text.matchAll(/uses:\s+actions\/setup-go@[^\n]*\n([\s\S]*?)(?=\n\s*-\s|\n\S|$)/g),
      ];
      // Asserted, so that renaming the step cannot turn this check into a vacuous pass.
      assert.ok(steps.length > 0, `${workflow} must install Go`);
      for (const step of steps) {
        assert.match(
          step[1],
          /go-version-file:\s*go\.mod/,
          `${workflow} must take the Go version from go.mod, not a literal`,
        );
      }
    }
  });
});
