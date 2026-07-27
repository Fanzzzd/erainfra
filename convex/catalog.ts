export type CatalogOs = "linux" | "mac";

type ImageCatalogEntry = {
  os: CatalogOs;
  image: string;
  description: string;
};

const ACTIONS_RUNNER_IMAGE = "ghcr.io/actions/actions-runner:2.336.0";
const MACOS_SEQUOIA_IMAGE =
  "ghcr.io/cirruslabs/macos-sequoia-base:latest";
const MACOS_TAHOE_IMAGE = "ghcr.io/cirruslabs/macos-tahoe-base:latest";

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
    description: "macOS Sequoia base image for Tart.",
  },
  "macos-26": {
    os: "mac",
    image: MACOS_TAHOE_IMAGE,
    description: "macOS Tahoe base image for Tart.",
  },
  "rc-mac": {
    os: "mac",
    image: MACOS_SEQUOIA_IMAGE,
    description: "Alias for the default macOS runner image.",
  },
};

const DEFAULT_IMAGE_LABEL_BY_OS: Record<CatalogOs, string> = {
  linux: "rc-linux",
  mac: "rc-mac",
};

export function findImageLabel(labels: readonly string[]) {
  return labels.find((label) =>
    Object.prototype.hasOwnProperty.call(IMAGE_CATALOG, label),
  );
}

export function selectImageForMachine(
  jobLabels: readonly string[],
  machine: {
    os: CatalogOs | "win";
    labels: readonly string[];
  },
) {
  const imageLabel = findImageLabel(jobLabels);
  const fallbackLabel =
    machine.os === "win" ? undefined : DEFAULT_IMAGE_LABEL_BY_OS[machine.os];
  const catalogEntry = IMAGE_CATALOG[imageLabel ?? fallbackLabel ?? ""];

  if (catalogEntry === undefined || catalogEntry.os !== machine.os) {
    return undefined;
  }

  const machineLabels = new Set(machine.labels);
  const hasRequiredLabels = jobLabels.every(
    (label) =>
      label === "self-hosted" ||
      label === imageLabel ||
      machineLabels.has(label),
  );

  return hasRequiredLabels ? catalogEntry : undefined;
}
