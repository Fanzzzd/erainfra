import { describe, expect, it } from "vitest";
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
    expect(findImageLabel(["self-hosted", "gpu", "windows-2025"])).toBe("windows-2025");
  });

  it("returns undefined when no label is a catalog image", () => {
    expect(findImageLabel(["self-hosted", "gpu"])).toBeUndefined();
  });
});

describe("selectImageForMachine", () => {
  it("matches an opted-in Windows machine to the requested Windows image", () => {
    const entry = selectImageForMachine(["self-hosted", "windows-2025"], previewWinMachine);
    expect(entry?.image).toBe(IMAGE_CATALOG["windows-2025"]?.image);
  });

  it("distinguishes the two Windows images", () => {
    const entry = selectImageForMachine(["self-hosted", "windows-2022"], previewWinMachine);
    expect(entry?.image).toBe(IMAGE_CATALOG["windows-2022"]?.image);
    expect(entry?.image).not.toBe(IMAGE_CATALOG["windows-2025"]?.image);
  });

  // Regression: a bare self-hosted job used to fall through to `undefined` on
  // Windows, so a registered Windows machine silently never got any work.
  it("falls back to the default image when the job names none", () => {
    expect(selectImageForMachine(["self-hosted"], previewWinMachine)?.image).toBe("rc-win2025");
    expect(selectImageForMachine(["self-hosted"], linuxMachine)).toBeDefined();
    expect(selectImageForMachine(["self-hosted"], macMachine)).toBeDefined();
  });

  it("refuses an image whose OS does not match the machine", () => {
    expect(
      selectImageForMachine(["self-hosted", "ubuntu-24.04"], previewWinMachine),
    ).toBeUndefined();
    expect(selectImageForMachine(["self-hosted", "windows-2025"], linuxMachine)).toBeUndefined();
    expect(selectImageForMachine(["self-hosted", "macos-15"], previewWinMachine)).toBeUndefined();
  });

  it("requires the machine to carry every non-image capability label", () => {
    const gpuWin = { os: "win", labels: [PREVIEW_OPT_IN_LABEL, "gpu"] } as const;
    expect(selectImageForMachine(["self-hosted", "rc-win", "gpu"], gpuWin)).toBeDefined();
    expect(
      selectImageForMachine(["self-hosted", "rc-win", "gpu"], previewWinMachine),
    ).toBeUndefined();
  });

  it("treats rc-win as an alias of the default Windows image", () => {
    expect(selectImageForMachine(["self-hosted", "rc-win"], previewWinMachine)?.image).toBe(
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
      expect(
        selectImageForMachine(["self-hosted", label], { os: entry.os, labels: [] }),
        `${label} matched a machine without ${PREVIEW_OPT_IN_LABEL}`,
      ).toBeUndefined();
    }
  });

  it("hides the preview default from a machine that has not opted in", () => {
    expect(selectImageForMachine(["self-hosted"], winMachine)).toBeUndefined();
  });

  it("keeps every Windows label preview-gated until Windows is supported", () => {
    const windowsLabels = Object.entries(IMAGE_CATALOG).filter(([, entry]) => entry.os === "win");
    expect(windowsLabels.length).toBeGreaterThan(0);
    for (const [label, entry] of windowsLabels) {
      expect(entry.preview, `${label} is not preview-gated`).toBe(true);
    }
  });

  it("leaves the supported platforms ungated", () => {
    for (const [label, entry] of Object.entries(IMAGE_CATALOG)) {
      if (entry.os === "linux" || entry.os === "mac") {
        expect(entry.preview, `${label} became preview-gated`).toBeUndefined();
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
      expect(entry, `${os} has no default image`).toBeDefined();
      expect(entry?.os).toBe(os);
    }
  });

  it("keeps every entry's os consistent with its label prefix", () => {
    const prefixes = { ubuntu: "linux", macos: "mac", windows: "win" } as const;
    for (const [label, entry] of Object.entries(IMAGE_CATALOG)) {
      const prefix = label.split("-")[0] as keyof typeof prefixes;
      if (prefix in prefixes) {
        expect(entry.os, `${label} is declared as ${entry.os}`).toBe(prefixes[prefix]);
      }
    }
  });
});
