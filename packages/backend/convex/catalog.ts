export type CatalogOs = "linux" | "mac" | "win";

type ImageCatalogEntry = {
  os: CatalogOs;
  image: string;
  description: string;
  /**
   * A preview image is inert: it matches nothing until the machine carries
   * PREVIEW_OPT_IN_LABEL. Use it for platforms whose provisioner exists but has
   * no supported onboarding path yet, so a label can never promise capacity the
   * project cannot actually deliver.
   */
  preview?: true;
};

/**
 * Operators add this label to a machine to accept that its platform or image is
 * a preview: unvalidated provisioner or image, manual installation, no support
 * promise.
 */
export const PREVIEW_OPT_IN_LABEL = "rc-preview";

const ACTIONS_RUNNER_IMAGE = "ghcr.io/actions/actions-runner:2.336.0";

// Pinned by digest, not by `:latest`, because `:latest` is mutable and moves
// without notice: this digest is the one four end-to-end Tart runs were executed
// against, and by the time it was pinned the upstream tag had already advanced
// to a different image. A tag would have silently swapped the tested OS out from
// under the fleet. Tart resolves an `@sha256:` reference for both `clone` and
// `pull`, and the digest remains pullable from ghcr independently of the tag.
//
// To refresh: pull the new digest, run a job against it end to end, then move
// this constant. Bumping it is a deliberate act, not a side effect of a machine
// happening to re-pull.
const MACOS_SEQUOIA_IMAGE =
  "ghcr.io/cirruslabs/macos-sequoia-base@sha256:fdd8b72a6ee46fc8ad35dc1b9f3b1f162b6607b82a584947d20bb28d3dcb99ed";

// Tahoe is deliberately still a floating tag: nothing pins a build that was
// never pulled, booted or run a job on. Its label is preview-gated to match.
const MACOS_TAHOE_IMAGE = "ghcr.io/cirruslabs/macos-tahoe-base:latest";
// Windows has no OCI-style VM image registry, so a Windows image is the bare
// name of a parent VHDX the machine keeps under %RC_HOME%\images\<name>.vhdx.
// provision-win.ps1 clones it into a differencing disk per job.
//
// Every Windows entry is preview-gated, and stays that way. #49 shipped the
// onboarding half — /install.ps1 -Role worker installs a Windows Worker from the
// same pinned archive as every other platform — so the first of the two reasons
// is gone. The second is not: neither the Hyper-V provisioner nor the image
// builder has ever run against a real Windows host, and readiness.ts refuses to
// report a `hyperv` Profile ready for exactly that reason. A label dropped here
// would promise capacity the control plane still declines to advertise. Drop
// `preview` when a Windows Worker has run a job end to end and that refusal is
// lifted with it, not before.
const WINDOWS_2025_IMAGE = "rc-win2025";
const WINDOWS_2022_IMAGE = "rc-win2022";

export const IMAGE_CATALOG: Record<string, ImageCatalogEntry> = {
  "ubuntu-22.04": {
    os: "linux",
    image: ACTIONS_RUNNER_IMAGE,
    description:
      "Compatibility label using GitHub's minimal runner image, which is currently Ubuntu 24.04-based.",
  },
  "ubuntu-24.04": {
    os: "linux",
    image: ACTIONS_RUNNER_IMAGE,
    description: "Ubuntu 24.04-based minimal GitHub Actions runner image.",
  },
  "rc-linux": {
    os: "linux",
    image: ACTIONS_RUNNER_IMAGE,
    description: "Alias for the default Linux runner image.",
  },
  "macos-15": {
    os: "mac",
    image: MACOS_SEQUOIA_IMAGE,
    description: "macOS Sequoia base image for Tart, pinned to the digest jobs were verified on.",
  },
  "macos-26": {
    os: "mac",
    image: MACOS_TAHOE_IMAGE,
    description:
      "Preview: macOS Tahoe base image for Tart. No Tahoe image has been pulled, booted or run a job on.",
    preview: true,
  },
  "rc-mac": {
    os: "mac",
    image: MACOS_SEQUOIA_IMAGE,
    description: "Alias for the default macOS runner image.",
  },
  "windows-2022": {
    os: "win",
    image: WINDOWS_2022_IMAGE,
    description: "Preview: Windows Server 2022 parent VHDX for Hyper-V.",
    preview: true,
  },
  "windows-2025": {
    os: "win",
    image: WINDOWS_2025_IMAGE,
    description: "Preview: Windows Server 2025 parent VHDX for Hyper-V.",
    preview: true,
  },
  "rc-win": {
    os: "win",
    image: WINDOWS_2025_IMAGE,
    description: "Preview: alias for the default Windows runner image.",
    preview: true,
  },
};

const DEFAULT_IMAGE_LABEL_BY_OS: Record<CatalogOs, string> = {
  linux: "rc-linux",
  mac: "rc-mac",
  win: "rc-win",
};

export function findImageLabel(labels: readonly string[]) {
  return labels.find((label) => Object.prototype.hasOwnProperty.call(IMAGE_CATALOG, label));
}

export function selectImageForMachine(
  jobLabels: readonly string[],
  machine: {
    os: CatalogOs;
    labels: readonly string[];
  },
) {
  const imageLabel = findImageLabel(jobLabels);
  const catalogEntry = IMAGE_CATALOG[imageLabel ?? DEFAULT_IMAGE_LABEL_BY_OS[machine.os]];

  if (catalogEntry === undefined || catalogEntry.os !== machine.os) {
    return undefined;
  }

  const machineLabels = new Set(machine.labels);
  if (catalogEntry.preview === true && !machineLabels.has(PREVIEW_OPT_IN_LABEL)) {
    return undefined;
  }

  const hasRequiredLabels = jobLabels.every(
    (label) => label === "self-hosted" || label === imageLabel || machineLabels.has(label),
  );

  return hasRequiredLabels ? catalogEntry : undefined;
}
