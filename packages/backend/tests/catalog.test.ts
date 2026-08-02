import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { findImageLabel, IMAGE_CATALOG, selectImageForMachine } from "../convex/catalog.ts";

const linuxMachine = { os: "linux", labels: [] } as const;
const macMachine = { os: "mac", labels: [] } as const;
const winMachine = { os: "win", labels: [] } as const;

describe("findImageLabel", () => {
  it("returns the first label that is in the catalog", () => {
    assert.equal(findImageLabel(["self-hosted", "gpu", "windows-2025"]), "windows-2025");
  });

  it("returns undefined when no label is a catalog image", () => {
    assert.equal(findImageLabel(["self-hosted", "gpu"]), undefined);
  });
});

describe("selectImageForMachine", () => {
  it("matches a Windows machine to the requested Windows image", () => {
    const entry = selectImageForMachine(["self-hosted", "windows-2025"], winMachine);
    assert.equal(entry?.image, IMAGE_CATALOG["windows-2025"]?.image);
  });

  it("distinguishes the two Windows images", () => {
    const entry = selectImageForMachine(["self-hosted", "windows-2022"], winMachine);
    assert.equal(entry?.image, IMAGE_CATALOG["windows-2022"]?.image);
    assert.notEqual(entry?.image, IMAGE_CATALOG["windows-2025"]?.image);
  });

  // Regression: a bare self-hosted job used to fall through to `undefined` on
  // Windows, so a registered Windows machine silently never got any work.
  it("falls back to the default image when the job names none", () => {
    assert.equal(selectImageForMachine(["self-hosted"], winMachine)?.image, "rc-win2025");
    assert.ok(selectImageForMachine(["self-hosted"], linuxMachine) !== undefined);
    assert.ok(selectImageForMachine(["self-hosted"], macMachine) !== undefined);
  });

  it("refuses an image whose OS does not match the machine", () => {
    assert.equal(selectImageForMachine(["self-hosted", "ubuntu-24.04"], winMachine), undefined);
    assert.equal(selectImageForMachine(["self-hosted", "windows-2025"], linuxMachine), undefined);
    assert.equal(selectImageForMachine(["self-hosted", "macos-15"], winMachine), undefined);
  });

  it("requires the machine to carry every non-image capability label", () => {
    const gpuWin = { os: "win", labels: ["gpu"] } as const;
    assert.ok(selectImageForMachine(["self-hosted", "rc-win", "gpu"], gpuWin) !== undefined);
    assert.equal(selectImageForMachine(["self-hosted", "rc-win", "gpu"], winMachine), undefined);
  });

  it("treats rc-win as an alias of the default Windows image", () => {
    assert.equal(
      selectImageForMachine(["self-hosted", "rc-win"], winMachine)?.image,
      selectImageForMachine(["self-hosted", "windows-2025"], winMachine)?.image,
    );
  });
});

describe("IMAGE_CATALOG", () => {
  it("covers every OS with a reachable default", () => {
    for (const os of ["linux", "mac", "win"] as const) {
      const entry = selectImageForMachine(["self-hosted"], { os, labels: [] });
      assert.ok(entry !== undefined, `${os} has no default image`);
      assert.equal(entry.os, os);
    }
  });

  it("keeps every entry's os consistent with its label prefix", () => {
    const prefixes = { ubuntu: "linux", macos: "mac", windows: "win" } as const;
    for (const [label, entry] of Object.entries(IMAGE_CATALOG)) {
      const prefix = label.split("-")[0] as keyof typeof prefixes;
      if (prefix in prefixes) {
        assert.equal(entry.os, prefixes[prefix], `${label} is declared as ${entry.os}`);
      }
    }
  });
});
