import { execa } from "execa";

export type ProfileSpec = {
  profile: string;
  executor: "docker" | "firecracker" | "tart" | "hyperv";
  imageRelease: string;
  vcpus: number;
  memoryMiB: number;
};

/** One named prerequisite the Worker proved, or failed to prove, locally. */
export type ReadinessCheck = {
  name: string;
  passed: boolean;
  detail?: string;
};

/**
 * What the Worker publishes about an executor beyond "ready". The control plane
 * and dashboard show the real isolation boundary and the exact broken check, so
 * neither has to infer either from a Profile name.
 */
export type ReadinessFacts = {
  isolation: string;
  boundary: "guest-kernel" | "shared-kernel";
  checks: ReadinessCheck[];
  cacheScope: string;
  cacheSharedWritable: boolean;
  hardware?: {
    arch?: string;
    cpus?: number;
    memoryMiB?: number;
    cpuModel?: string;
    virtualization?: string;
    kvm?: boolean;
  };
  storage?: { snapshotter?: string; poolTotalMiB?: number; poolFreeMiB?: number };
  network?: { policyName?: string; subnet?: string; egressMode?: string };
};

export type ReadinessResult = ({ state: "ready" } | { state: "failed"; error: string }) &
  ReadinessFacts;

/**
 * The privileged runtime's readiness document. It is produced by the same build
 * that enforces the boundary, so the Worker only transports it.
 */
type RuntimeReport = {
  isolation?: string;
  boundary?: string;
  checks?: { name: string; passed: boolean; detail?: string }[];
  hardware?: ReadinessFacts["hardware"];
  storage?: ReadinessFacts["storage"];
  network?: ReadinessFacts["network"];
  cache?: { scope?: string; sharedWritable?: boolean; detail?: string };
};

const IMAGE_DIGEST = /@sha256:[0-9a-f]{64}$/;

function message(error: unknown) {
  return (error instanceof Error ? error.message : String(error)).slice(0, 1_000);
}

/**
 * Docker shares the host kernel and the Docker daemon with every other job on
 * the machine, so its facts say so plainly. A Profile that runs untrusted code
 * must not use this executor, and the dashboard needs to be able to show why.
 */
function dockerFacts(checks: ReadinessCheck[]): ReadinessFacts {
  return {
    isolation: "docker-container",
    boundary: "shared-kernel",
    checks,
    // The container's writable layer is created and destroyed per job, and no
    // host path, named volume or socket is mounted. Warm state comes only from
    // the immutable Image Release.
    cacheScope: "immutable-image",
    cacheSharedWritable: false,
  };
}

function runtimeFacts(report: RuntimeReport, fallbackError?: string): ReadinessFacts {
  const checks = (report.checks ?? []).map((check) => ({
    name: check.name,
    passed: check.passed,
    detail: check.detail,
  }));
  if (checks.length === 0 && fallbackError !== undefined) {
    checks.push({ name: "privileged-runtime", passed: false, detail: fallbackError });
  }
  return {
    isolation: report.isolation ?? "firecracker-microvm",
    boundary: report.boundary === "shared-kernel" ? "shared-kernel" : "guest-kernel",
    checks,
    cacheScope: report.cache?.scope ?? "immutable-image",
    cacheSharedWritable: report.cache?.sharedWritable === true,
    hardware: report.hardware,
    storage: report.storage,
    network: report.network,
  };
}

/**
 * Parses the readiness document the runtime writes to stdout. `preflight` emits
 * it whether or not every check passed, so a non-zero exit still carries the
 * per-check detail an operator needs.
 */
export function parseRuntimeReport(stdout: string): RuntimeReport {
  const trimmed = stdout.trim();
  if (trimmed === "") return {};
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return typeof parsed === "object" && parsed !== null ? (parsed as RuntimeReport) : {};
  } catch {
    return {};
  }
}

async function prepareDocker(profile: ProfileSpec): Promise<ReadinessResult> {
  const checks: ReadinessCheck[] = [];
  try {
    const info = await execa("docker", ["info", "--format", "{{.ServerVersion}}"], {
      timeout: 30_000,
    });
    checks.push({ name: "docker-daemon", passed: true, detail: info.stdout.trim() });
    await execa("docker", ["pull", profile.imageRelease], { timeout: 60 * 60_000 });
    await execa("docker", ["image", "inspect", profile.imageRelease], { timeout: 30_000 });
    checks.push({ name: "image-release", passed: true, detail: profile.imageRelease });
    return { state: "ready", ...dockerFacts(checks) };
  } catch (error) {
    const detail = message(error);
    checks.push({
      name: checks.length === 0 ? "docker-daemon" : "image-release",
      passed: false,
      detail,
    });
    return { state: "failed", error: detail, ...dockerFacts(checks) };
  }
}

async function prepareFirecracker(profile: ProfileSpec): Promise<ReadinessResult> {
  const binary = process.env.RC_RUNTIME_BINARY?.trim() || "runner-center-runtime";
  let report: RuntimeReport = {};
  try {
    const preflight = await execa(binary, ["preflight"], { timeout: 60_000, reject: false });
    report = parseRuntimeReport(preflight.stdout);
    if (preflight.exitCode !== 0) {
      const facts = runtimeFacts(report, preflight.stderr.trim() || "preflight failed");
      return { state: "failed", error: failureOf(facts, preflight.stderr), ...facts };
    }
    await execa(binary, ["prepare"], {
      env: { ...process.env, RC_IMAGE_RELEASE: profile.imageRelease },
      timeout: 60 * 60_000,
    });
    const facts = runtimeFacts(report);
    facts.checks.push({ name: "image-release", passed: true, detail: profile.imageRelease });
    return { state: "ready", ...facts };
  } catch (error) {
    const detail = message(error);
    const facts = runtimeFacts(report, detail);
    if (facts.checks.every((check) => check.passed)) {
      facts.checks.push({ name: "image-release", passed: false, detail });
    }
    return { state: "failed", error: detail, ...facts };
  }
}

function failureOf(facts: ReadinessFacts, stderr: string) {
  const failed = facts.checks
    .filter((check) => !check.passed)
    .map((check) => (check.detail === undefined ? check.name : `${check.name}: ${check.detail}`));
  return (failed.length > 0 ? failed.join("; ") : stderr.trim() || "preflight failed").slice(
    0,
    1_000,
  );
}

export async function prepareProfile(profile: ProfileSpec): Promise<ReadinessResult> {
  if (!IMAGE_DIGEST.test(profile.imageRelease) && profile.executor !== "hyperv") {
    const detail = `Image Release ${profile.imageRelease} is not pinned by sha256 digest`;
    const facts =
      profile.executor === "docker"
        ? dockerFacts([{ name: "image-release", passed: false, detail }])
        : runtimeFacts({}, detail);
    return { state: "failed", error: detail, ...facts };
  }
  switch (profile.executor) {
    case "docker":
      return prepareDocker(profile);
    case "firecracker":
      return prepareFirecracker(profile);
    case "tart": {
      const binary = process.env.TART?.trim() || "/opt/homebrew/bin/tart";
      const checks: ReadinessCheck[] = [];
      const facts = (): ReadinessFacts => ({
        isolation: "tart-vm",
        boundary: "guest-kernel",
        checks,
        cacheScope: "immutable-image",
        cacheSharedWritable: false,
      });
      try {
        const version = await execa(binary, ["--version"], { timeout: 30_000 });
        checks.push({ name: "tart-binary", passed: true, detail: version.stdout.trim() });
        // A digest reference makes this an idempotent prewarm, not an update.
        await execa(binary, ["pull", profile.imageRelease], { timeout: 2 * 60 * 60_000 });
        checks.push({ name: "image-release", passed: true, detail: profile.imageRelease });
        return { state: "ready", ...facts() };
      } catch (error) {
        const detail = message(error);
        checks.push({
          name: checks.length === 0 ? "tart-binary" : "image-release",
          passed: false,
          detail,
        });
        return { state: "failed", error: detail, ...facts() };
      }
    }
    case "hyperv": {
      const detail = "Hyper-V remains preview-only until a Windows Worker passes live validation";
      return {
        state: "failed",
        error: detail,
        isolation: "hyperv-vm",
        boundary: "guest-kernel",
        checks: [{ name: "hyperv-validation", passed: false, detail }],
        cacheScope: "immutable-image",
        cacheSharedWritable: false,
      };
    }
  }
}
