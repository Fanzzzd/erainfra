import { describe, expect, it } from "vitest";
import { findImageLabel, IMAGE_CATALOG, selectImageForMachine } from "../convex/catalog.ts";

const linuxMachine = { os: "linux", labels: [] } as const;
const macMachine = { os: "mac", labels: [] } as const;
const winMachine = { os: "win", labels: [] } as const;

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
    expect(selectImageForMachine(["self-hosted", "rc-win", "gpu"], gpuWin)).toBeDefined();
    expect(selectImageForMachine(["self-hosted", "rc-win", "gpu"], winMachine)).toBeUndefined();
  });

  it("treats rc-win as an alias of the default Windows image", () => {
    expect(selectImageForMachine(["self-hosted", "rc-win"], winMachine)?.image).toBe(
      selectImageForMachine(["self-hosted", "windows-2025"], winMachine)?.image,
    );
  });
});

describe("IMAGE_CATALOG", () => {
  it("covers every OS with a reachable default", () => {
    for (const os of ["linux", "mac", "win"] as const) {
      const entry = selectImageForMachine(["self-hosted"], { os, labels: [] });
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
