import { describe, expect, it } from "vitest";

import {
  findImageLabel,
  IMAGE_CATALOG,
  PREVIEW_OPT_IN_LABEL,
  selectImageForMachine,
} from "../convex/catalog.ts";

const linuxMachine = { os: "linux", labels: [] } as const;
const macMachine = { os: "mac", labels: [] } as const;
const winMachine = { os: "win", labels: [] } as const;

// Labels a workflow may rely on: a validated provisioner and an image a job has
// actually been run on. Everything else belongs behind PREVIEW_OPT_IN_LABEL.
// Windows graduated when /install.ps1 shipped and the Hyper-V provisioner and
// image builder passed live validation on a physical host.
const PRODUCTION_LABELS = [
  "ubuntu-22.04",
  "ubuntu-24.04",
  "macos-15",
  "windows-2022",
  "windows-2025",
] as const;

// The Sequoia digest the end-to-end Tart runs were executed against.
const TESTED_SEQUOIA_DIGEST =
  "sha256:fdd8b72a6ee46fc8ad35dc1b9f3b1f162b6607b82a584947d20bb28d3dcb99ed";

describe("findImageLabel", () => {
  it("returns the first label that is in the catalog", () => {
    expect(findImageLabel(["self-hosted", "gpu", "windows-2025"])).toBe("windows-2025");
  });

  it("returns undefined when no label is a catalog image", () => {
    expect(findImageLabel(["self-hosted", "gpu"])).toBeUndefined();
  });
});

describe("selectImageForMachine", () => {
  it("matches a Windows machine to the requested Windows image", () => {
    const entry = selectImageForMachine(["self-hosted", "windows-2025"], winMachine);
    expect(entry?.image).toBe(IMAGE_CATALOG["windows-2025"]?.image);
  });

  it("distinguishes the two Windows images", () => {
    const entry = selectImageForMachine(["self-hosted", "windows-2022"], winMachine);
    expect(entry?.image).toBe(IMAGE_CATALOG["windows-2022"]?.image);
    expect(entry?.image).not.toBe(IMAGE_CATALOG["windows-2025"]?.image);
  });

  // Regression: a bare self-hosted job used to fall through to `undefined` on
  // Windows, so a registered Windows machine silently never got any work.
  it("falls back to the default image when the job names none", () => {
    expect(selectImageForMachine(["self-hosted"], winMachine)?.image).toBe("rc-win2025");
    expect(selectImageForMachine(["self-hosted"], linuxMachine)).toBeDefined();
    expect(selectImageForMachine(["self-hosted"], macMachine)).toBeDefined();
  });

  it("refuses an image whose OS does not match the machine", () => {
    expect(selectImageForMachine(["self-hosted", "ubuntu-24.04"], winMachine)).toBeUndefined();
    expect(selectImageForMachine(["self-hosted", "windows-2025"], linuxMachine)).toBeUndefined();
    expect(selectImageForMachine(["self-hosted", "macos-15"], winMachine)).toBeUndefined();
  });

  it("requires the machine to carry every non-image capability label", () => {
    const gpuWin = { os: "win", labels: ["gpu"] } as const;
    expect(selectImageForMachine(["self-hosted", "windows-2025", "gpu"], gpuWin)).toBeDefined();
    expect(
      selectImageForMachine(["self-hosted", "windows-2025", "gpu"], winMachine),
    ).toBeUndefined();
  });

  it("gives a job that names no image the newest production image of the machine's OS", () => {
    const defaults = [
      [linuxMachine, "ubuntu-24.04"],
      [macMachine, "macos-15"],
      [winMachine, "windows-2025"],
    ] as const;
    for (const [machine, label] of defaults) {
      expect(selectImageForMachine(["self-hosted"], machine), machine.os).toBe(
        IMAGE_CATALOG[label],
      );
    }
  });

  // The pre-Profile aliases are gone. A job that still asks for one gets the default image, and
  // the old name counts as a host label like any other, so only a Worker carrying it matches.
  it("treats a removed alias as a host label, not an image", () => {
    for (const label of ["rc-linux", "rc-mac", "rc-win"]) {
      expect(findImageLabel(["self-hosted", label]), label).toBeUndefined();
      expect(IMAGE_CATALOG[label], label).toBeUndefined();
    }
    expect(selectImageForMachine(["self-hosted", "rc-linux"], linuxMachine)).toBeUndefined();
    expect(
      selectImageForMachine(["self-hosted", "rc-linux"], { os: "linux", labels: ["rc-linux"] }),
    ).toBe(IMAGE_CATALOG["ubuntu-24.04"]);
  });
});

describe("preview gating", () => {
  // A preview label must not resolve for a machine that has not opted in. If
  // this fails, the control plane is advertising capacity it cannot deliver.
  it("hides every preview image from a machine that has not opted in", () => {
    for (const [label, entry] of Object.entries(IMAGE_CATALOG)) {
      if (entry.preview !== true) continue;
      expect(
        selectImageForMachine(["self-hosted", label], { os: entry.os, labels: [] }),
        `${label} matched a machine without ${PREVIEW_OPT_IN_LABEL}`,
      ).toBeUndefined();
    }
  });

  // Named one by one rather than derived from `os`, so that gating a single
  // unvalidated image (macos-26) can never quietly take a validated one with it.
  it("leaves every validated production label ungated", () => {
    for (const label of PRODUCTION_LABELS) {
      const entry = IMAGE_CATALOG[label];
      expect(entry, `${label} left the catalog`).toBeDefined();
      expect(entry?.preview, `${label} became preview-gated`).toBeUndefined();
      expect(
        selectImageForMachine(["self-hosted", label], { os: entry.os, labels: [] }),
        `${label} stopped scheduling without an opt-in`,
      ).toBeDefined();
    }
  });

  // Tahoe has never been pulled, booted, or given a job. Until it has, its label
  // must not look like capacity a workflow can rely on.
  it("gates the macOS release that has never been run", () => {
    expect(IMAGE_CATALOG["macos-26"]?.preview).toBe(true);
    expect(selectImageForMachine(["self-hosted", "macos-26"], macMachine)).toBeUndefined();
    expect(
      selectImageForMachine(["self-hosted", "macos-26"], {
        os: "mac",
        labels: [PREVIEW_OPT_IN_LABEL],
      }),
    ).toBeDefined();
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

  // Regression: macos-15 pointed at `:latest`, which had already
  // moved to a different image than the one the end-to-end runs verified. A
  // machine re-pulling the tag would have swapped the OS out silently.
  it("pins the production macOS image to the digest jobs were verified on", () => {
    for (const label of ["macos-15"] as const) {
      expect(IMAGE_CATALOG[label]?.image, `${label} is not pinned by digest`).toBe(
        `ghcr.io/cirruslabs/macos-sequoia-base@${TESTED_SEQUOIA_DIGEST}`,
      );
    }
  });

  // A ghcr.io tag can be re-pushed, so a tag alone lets the image under every
  // Docker Worker change without a commit here. The tag stays for the reader.
  it("pins the Docker executor's runner image by release and digest", () => {
    for (const label of ["ubuntu-22.04", "ubuntu-24.04"] as const) {
      expect(IMAGE_CATALOG[label]?.image, `${label} is not pinned by digest`).toMatch(
        /^ghcr\.io\/actions\/actions-runner:\d+\.\d+\.\d+@sha256:[0-9a-f]{64}$/,
      );
    }
  });

  it("never points a production label at a floating tag", () => {
    for (const label of PRODUCTION_LABELS) {
      const image = IMAGE_CATALOG[label]?.image ?? "";
      expect(image, `${label} floats on :latest`).not.toMatch(/:latest$/);
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
