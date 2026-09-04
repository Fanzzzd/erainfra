import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

/**
 * Docker's architecture name for this host, in the vocabulary
 * `docker image inspect` reports (GOARCH), not Node's.
 */
const NODE_TO_IMAGE_ARCH: Record<string, string> = {
  x64: "amd64",
  ia32: "386",
  arm64: "arm64",
  arm: "arm",
};

/**
 * Why this host must not run this image, or null when the architectures
 * match.
 *
 * `docker pull` of a wrong-architecture image succeeds with only a warning,
 * and the job then either crawls under qemu emulation or dies at run time —
 * long after the scheduler committed to this Worker. Readiness is where the
 * mismatch has to surface (#9).
 */
export function architectureMismatch(hostArch: string, imageArch: string): string | null {
  const wanted = NODE_TO_IMAGE_ARCH[hostArch] ?? hostArch;
  if (imageArch === wanted) return null;
  return `this Worker is ${wanted} but the Image Release is built for ${imageArch}; the job would run under emulation or not at all`;
}

async function prepareDocker(profile: ProfileSpec): Promise<ReadinessResult> {
  const checks: ReadinessCheck[] = [];
  const fail = (name: string, detail: string): ReadinessResult => {
    checks.push({ name, passed: false, detail });
    return { state: "failed", error: detail, ...dockerFacts(checks) };
  };
  try {
    const info = await execa("docker", ["info", "--format", "{{.ServerVersion}}"], {
      timeout: 30_000,
    });
    checks.push({ name: "docker-daemon", passed: true, detail: info.stdout.trim() });
  } catch (error) {
    return fail("docker-daemon", message(error));
  }
  // provision-docker.sh allocates its per-job scratch directory under
  // ${TMPDIR:-/tmp}, which os.tmpdir() resolves identically. Proving it
  // writable here moves that failure from job time to readiness (#9).
  try {
    const scratch = await mkdtemp(join(tmpdir(), "rc-preflight-"));
    await rm(scratch, { recursive: true, force: true });
    checks.push({ name: "scratch-directory", passed: true, detail: tmpdir() });
  } catch (error) {
    return fail(
      "scratch-directory",
      `cannot create a job scratch directory under ${tmpdir()}: ${message(error)}`,
    );
  }
  let imageArch = "";
  try {
    await execa("docker", ["pull", profile.imageRelease], { timeout: 60 * 60_000 });
    const inspected = await execa(
      "docker",
      ["image", "inspect", "--format", "{{.Architecture}}", profile.imageRelease],
      { timeout: 30_000 },
    );
    imageArch = inspected.stdout.trim();
    checks.push({ name: "image-release", passed: true, detail: profile.imageRelease });
  } catch (error) {
    return fail("image-release", message(error));
  }
  const mismatch = architectureMismatch(process.arch, imageArch);
  if (mismatch !== null) {
    return fail("image-architecture", mismatch);
  }
  checks.push({ name: "image-architecture", passed: true, detail: imageArch });
  return { state: "ready", ...dockerFacts(checks) };
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
  // Both Linux executors already refuse a mutable reference — the Firecracker
  // Spec and provision-docker.sh each reject one — so failing here only moves
  // that rejection from job time to readiness. Tart is deliberately excluded:
  // nothing in its path requires a digest today, and tightening it would take a
  // working macOS Profile offline as a side effect of this change.
  const requiresDigest = profile.executor === "docker" || profile.executor === "firecracker";
  if (requiresDigest && !IMAGE_DIGEST.test(profile.imageRelease)) {
    const detail = `Image Release ${profile.imageRelease} is not pinned by sha256 digest`;
    const check: ReadinessCheck = { name: "image-release", passed: false, detail };
    const facts =
      profile.executor === "docker"
        ? dockerFacts([check])
        : { ...runtimeFacts({}), checks: [check] };
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
    case "hyperv":
      return prepareHyperV(profile);
  }
}

/**
 * The exact prerequisites provision-win.ps1 dies on at job time, proven at
 * readiness instead: the Hyper-V module, the VM switch, the parent VHDX under
 * %RC_HOME%\images, and the machine-scope DPAPI credential its builder wrote.
 * The probe reads its inputs from the same environment variables the
 * provisioner honours, and the image name travels via the environment so a
 * hostile Profile name never reaches a PowerShell command line.
 */
const HYPERV_PROBE = `
$ErrorActionPreference = 'SilentlyContinue'
$checks = @()
$image = $env:RC_PROBE_IMAGE
$rcHome = if ($env:RC_HOME) { $env:RC_HOME } else { Join-Path $env:USERPROFILE '.runner-center' }
$switchName = if ($env:VM_SWITCH) { $env:VM_SWITCH } else { 'Default Switch' }
$module = [bool](Get-Command Get-VM -ErrorAction SilentlyContinue)
$moduleDetail = if ($module) { 'Hyper-V PowerShell module present' } else { 'Enable the Microsoft-Hyper-V-All feature and reboot' }
$checks += @{ name = 'hyperv-module'; passed = $module; detail = $moduleDetail }
if ($module) {
  $switch = [bool](Get-VMSwitch -Name $switchName -ErrorAction SilentlyContinue)
  $checks += @{ name = 'vm-switch'; passed = $switch; detail = $switchName }
}
$imageDir = Join-Path $rcHome 'images'
$parent = Join-Path $imageDir ($image + '.vhdx')
$checks += @{ name = 'parent-image'; passed = [bool](Test-Path -LiteralPath $parent); detail = $parent }
$cred = Join-Path $imageDir ($image + '.cred.json')
$credOk = (-not [string]::IsNullOrWhiteSpace($env:IMAGE_PASSWORD)) -or (Test-Path -LiteralPath $cred)
$checks += @{ name = 'guest-credential'; passed = $credOk; detail = $cred }
@{ checks = $checks } | ConvertTo-Json -Depth 4
`;

async function prepareHyperV(profile: ProfileSpec): Promise<ReadinessResult> {
  const facts = (checks: ReadinessCheck[]): ReadinessFacts => ({
    isolation: "hyperv-vm",
    boundary: "guest-kernel",
    checks,
    // The parent VHDX is never written to; every job runs on a differencing
    // child disk that is destroyed with the VM.
    cacheScope: "immutable-image",
    cacheSharedWritable: false,
  });
  const failed = (checks: ReadinessCheck[], error: string): ReadinessResult => ({
    state: "failed",
    error,
    ...facts(checks),
  });

  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/.test(profile.imageRelease)) {
    const detail = `Image Release '${profile.imageRelease}' is not a valid parent VHDX name`;
    return failed([{ name: "parent-image", passed: false, detail }], detail);
  }
  if (process.platform !== "win32") {
    const detail = "this Worker is not a Windows host";
    return failed([{ name: "hyperv-host", passed: false, detail }], detail);
  }

  let checks: ReadinessCheck[] = [];
  try {
    const probe = await execa(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", HYPERV_PROBE],
      {
        env: { ...process.env, RC_PROBE_IMAGE: profile.imageRelease },
        timeout: 60_000,
      },
    );
    const report = parseRuntimeReport(probe.stdout);
    checks = (report.checks ?? []).map((check) => ({
      name: check.name,
      passed: check.passed,
      detail: check.detail,
    }));
    if (checks.length === 0) {
      throw new Error("the Hyper-V probe returned no checks");
    }
  } catch (error) {
    const detail = message(error);
    return failed([{ name: "hyperv-probe", passed: false, detail }], detail);
  }

  if (checks.some((check) => !check.passed)) {
    return failed(checks, failureOf(facts(checks), ""));
  }
  return { state: "ready", ...facts(checks) };
}
