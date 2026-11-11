import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { PRODUCT_PACKAGES, syncProductVersion } from "../src/product-version.ts";

const repoRoot = path.resolve(import.meta.dirname, "..", "..", "..");
const FILES = [
  "package.json",
  "apps/mesh/Cargo.toml",
  "apps/mesh/Cargo.lock",
  "apps/action-runner-agent/package-lock.json",
  "packages/backend/convex/agentRelease.ts",
  ...PRODUCT_PACKAGES.map((dir) => `${dir}/package.json`),
];
const scratch: string[] = [];
after(() => scratch.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

/** A copy of the real version-bearing files, so the test fails when their shape drifts. */
function copyOfRepo() {
  const root = mkdtempSync(path.join(tmpdir(), "product-version-"));
  scratch.push(root);
  for (const file of FILES) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    cpSync(path.join(repoRoot, file), path.join(root, file));
  }
  return root;
}

function setPackageVersion(root: string, dir: string, version: string) {
  const file = path.join(root, dir, "package.json");
  const pkg = JSON.parse(readFileSync(file, "utf8"));
  pkg.version = version;
  writeFileSync(file, `${JSON.stringify(pkg, null, 2)}\n`);
}

const read = (root: string, file: string) => readFileSync(path.join(root, file), "utf8");

describe("syncProductVersion", () => {
  it("copies the fixed group's version to every file Changesets does not edit", () => {
    const root = copyOfRepo();
    for (const dir of PRODUCT_PACKAGES) setPackageVersion(root, dir, "9.8.7-rc.6");

    const { version, changed } = syncProductVersion(root);

    assert.equal(version, "9.8.7-rc.6");
    assert.deepEqual(changed.toSorted(), FILES.slice(0, 5).toSorted());
    assert.equal(JSON.parse(read(root, "package.json")).version, "9.8.7-rc.6");
    assert.match(read(root, "apps/mesh/Cargo.toml"), /^version = "9\.8\.7-rc\.6"$/m);
    assert.match(
      read(root, "apps/mesh/Cargo.lock"),
      /name = "erainfra-mesh"\nversion = "9\.8\.7-rc\.6"/,
    );
    const lock = JSON.parse(read(root, "apps/action-runner-agent/package-lock.json"));
    assert.equal(lock.version, "9.8.7-rc.6");
    assert.equal(lock.packages[""].version, "9.8.7-rc.6");
    assert.match(
      read(root, "packages/backend/convex/agentRelease.ts"),
      /AGENT_RELEASE: AgentRelease = \{\n {2}repo: "[^"]*",\n {2}version: "9\.8\.7-rc\.6"/,
    );
  });

  it("changes nothing when every file already agrees", () => {
    const root = copyOfRepo();
    assert.deepEqual(syncProductVersion(root).changed, []);
  });

  it("refuses when the product packages disagree", () => {
    const root = copyOfRepo();
    setPackageVersion(root, "apps/runtime", "9.9.9");
    assert.throws(() => syncProductVersion(root), /product packages disagree/);
  });
});
