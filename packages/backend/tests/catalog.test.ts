import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  findImageLabel,
  IMAGE_CATALOG,
  PREVIEW_OPT_IN_LABEL,
  selectImageForMachine,
} from "../convex/catalog.ts";

const linuxMachine = { os: "linux", labels: [] } as const;
const macMachine = { os: "mac", labels: [] } as const;
// Windows is preview-gated, so the opted-in machine is the one that can match
// anything at all; `winMachine` stands for a Windows host that did not opt in.
const winMachine = { os: "win", labels: [] } as const;
const previewWinMachine = { os: "win", labels: [PREVIEW_OPT_IN_LABEL] } as const;

describe("findImageLabel", () => {
  it("returns the first label that is in the catalog", () => {
    assert.equal(findImageLabel(["self-hosted", "gpu", "windows-2025"]), "windows-2025");
  });

  it("returns undefined when no label is a catalog image", () => {
    assert.equal(findImageLabel(["self-hosted", "gpu"]), undefined);
  });
});

describe("selectImageForMachine", () => {
  it("matches an opted-in Windows machine to the requested Windows image", () => {
    const entry = selectImageForMachine(["self-hosted", "windows-2025"], previewWinMachine);
    assert.equal(entry?.image, IMAGE_CATALOG["windows-2025"]?.image);
  });

  it("distinguishes the two Windows images", () => {
    const entry = selectImageForMachine(["self-hosted", "windows-2022"], previewWinMachine);
    assert.equal(entry?.image, IMAGE_CATALOG["windows-2022"]?.image);
    assert.notEqual(entry?.image, IMAGE_CATALOG["windows-2025"]?.image);
  });

  // Regression: a bare self-hosted job used to fall through to `undefined` on
  // Windows, so a registered Windows machine silently never got any work.
  it("falls back to the default image when the job names none", () => {
    assert.equal(selectImageForMachine(["self-hosted"], previewWinMachine)?.image, "rc-win2025");
    assert.ok(selectImageForMachine(["self-hosted"], linuxMachine) !== undefined);
    assert.ok(selectImageForMachine(["self-hosted"], macMachine) !== undefined);
  });

  it("refuses an image whose OS does not match the machine", () => {
    assert.equal(
      selectImageForMachine(["self-hosted", "ubuntu-24.04"], previewWinMachine),
      undefined,
    );
    assert.equal(selectImageForMachine(["self-hosted", "windows-2025"], linuxMachine), undefined);
    assert.equal(selectImageForMachine(["self-hosted", "macos-15"], previewWinMachine), undefined);
  });

  it("requires the machine to carry every non-image capability label", () => {
    const gpuWin = { os: "win", labels: [PREVIEW_OPT_IN_LABEL, "gpu"] } as const;
    assert.ok(selectImageForMachine(["self-hosted", "rc-win", "gpu"], gpuWin) !== undefined);
    assert.equal(
      selectImageForMachine(["self-hosted", "rc-win", "gpu"], previewWinMachine),
      undefined,
    );
  });

  it("treats rc-win as an alias of the default Windows image", () => {
    assert.equal(
      selectImageForMachine(["self-hosted", "rc-win"], previewWinMachine)?.image,
      selectImageForMachine(["self-hosted", "windows-2025"], previewWinMachine)?.image,
    );
  });
});

describe("preview gating", () => {
  // Windows has no supported onboarding path and an unvalidated provisioner, so
  // its labels must not resolve for a machine that has not opted in. If this
  // fails, the control plane is advertising capacity it cannot deliver.
  it("hides every preview image from a machine that has not opted in", () => {
    for (const [label, entry] of Object.entries(IMAGE_CATALOG)) {
      if (entry.preview !== true) continue;
      assert.equal(
        selectImageForMachine(["self-hosted", label], { os: entry.os, labels: [] }),
        undefined,
        `${label} matched a machine without ${PREVIEW_OPT_IN_LABEL}`,
      );
    }
  });

  it("hides the preview default from a machine that has not opted in", () => {
    assert.equal(selectImageForMachine(["self-hosted"], winMachine), undefined);
  });

  it("keeps every Windows label preview-gated until Windows is supported", () => {
    const windowsLabels = Object.entries(IMAGE_CATALOG).filter(([, entry]) => entry.os === "win");
    assert.ok(windowsLabels.length > 0);
    for (const [label, entry] of windowsLabels) {
      assert.equal(entry.preview, true, `${label} is not preview-gated`);
    }
  });

  it("leaves the supported platforms ungated", () => {
    for (const [label, entry] of Object.entries(IMAGE_CATALOG)) {
      if (entry.os === "linux" || entry.os === "mac") {
        assert.equal(entry.preview, undefined, `${label} became preview-gated`);
      }
    }
  });
});

describe("IMAGE_CATALOG", () => {
  it("covers every OS with a default that is reachable once opted in", () => {
    for (const os of ["linux", "mac", "win"] as const) {
      const entry = selectImageForMachine(["self-hosted"], {
        os,
        labels: [PREVIEW_OPT_IN_LABEL],
      });
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
