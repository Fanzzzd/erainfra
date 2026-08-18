import { mkdtemp, readFile, rm } from "node:fs/promises";
import { availableParallelism, tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";

export type ProfileSpec = {
  profile: string;
  executor: "docker" | "firecracker" | "tart" | "hyperv";
  imageRelease: string;
  vcpus: number;
  memoryMiB: number;
  warmPool?: number;
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
  storage?: {
    snapshotter?: string;
    poolName?: string;
    poolTotalMiB?: number;
    poolFreeMiB?: number;
  };
  network?: { policyName?: string; policyHash?: string; subnet?: string; egressMode?: string };
  warmPool?: { target: number; parked: number; claimed: number };
};

export type ReadinessResult = ({ state: "ready" } | { state: "failed"; error: string }) &
  ReadinessFacts;

/**
 * A core range borrowed for the resource-visibility probe. The Agent hands
 * this in rather than readiness importing the allocator, so the range the
 * probe pins to is produced by the very code that pins a real Attempt.
 */
export type CoreLease = {
  /** The range, as `--cpuset-cpus` writes it. */
  spec: string;
  /** False when the Worker was too busy to hold it and the probe shares cores. */
  exclusive: boolean;
  release: () => void;
};

export type ProbeResult = { exitCode: number; stdout: string; stderr: string };

export type PrepareProfileOptions = {
  hostCores?: number;
  leaseCores?: (vcpus: number) => CoreLease;
  runProbe?: (args: string[]) => Promise<ProbeResult>;
};

export type PublishedReadinessState = "preparing" | "ready" | "degraded" | "failed";

/** Healthy images are refreshed sparingly; broken capacity retries promptly. */
export const HEALTHY_READINESS_REFRESH_MS = 6 * 60 * 60_000;
export const UNHEALTHY_READINESS_REFRESH_MS = 5 * 60_000;
export const WARM_POOL_READINESS_REFRESH_MS = 60_000;

/**
 * The Worker retries every failed/degraded Profile on a materially shorter
 * cadence. Missing Profiles use the healthy cadence rather than spinning.
 */
export function readinessRefreshDelay(
  states: Iterable<PublishedReadinessState>,
  hasWarmPool = false,
) {
  for (const state of states) {
    if (state === "failed" || state === "degraded") return UNHEALTHY_READINESS_REFRESH_MS;
  }
  return hasWarmPool ? WARM_POOL_READINESS_REFRESH_MS : HEALTHY_READINESS_REFRESH_MS;
}

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

/**
 * A stable identifier. The dashboard groups by these names and the operator
 * runbook refers to them, so this follows the same rule the runtime's own
 * check names do: renaming it is a product change.
 */
export const CHECK_JOB_RESOURCE_VISIBILITY = "job-resource-visibility";

/**
 * What the probe container is asked to report about itself. `nproc` is the
 * affinity-derived count — the one `uv_available_parallelism` and
 * `runtime.NumCPU()` also read, and the one a cpuset actually corrects.
 * /proc/cpuinfo is deliberately not asserted on: a cpuset does not filter it,
 * it still lists every host CPU, and a check against it would fail forever.
 *
 * The cgroup limit is read v1-first because the production Workers are cgroup
 * v1 hybrid and Docker uses the v1 paths there; v2 is the alternative, not the
 * other way round. `unknown` is tolerated rather than failed: a host without a
 * readable memory cgroup is a different problem than a job being lied to.
 */
const PROBE_COMMAND =
  'printf "%s\n%s\n%s\n%s\n" ' +
  '"$(nproc)" "${RC_VCPUS:-unset}" "${RC_MEMORY_MIB:-unset}" ' +
  '"$(cat /sys/fs/cgroup/memory/memory.limit_in_bytes 2>/dev/null || ' +
  'cat /sys/fs/cgroup/memory.max 2>/dev/null || printf unknown)"';

/**
 * The number of processes an Attempt of this size may create, and the per-job
 * cgroup bound it backstops. Both are read from provision-docker.sh, which
 * carries the reasoning: --pids-limit is the precise per-Attempt bound because
 * the cgroup pids controller counts per cgroup, and RLIMIT_NPROC is a second
 * finite ceiling derived the way the kernel derives its own — four per MiB —
 * from the Profile's memory rather than the Worker's (#96).
 */
export const PIDS_LIMIT = 4096;

export function processBound(memoryMiB: number) {
  return Math.max(memoryMiB * 4, PIDS_LIMIT * 4);
}

/**
 * The exact limit flags an Attempt is given, in the same order
 * provision-docker.sh writes them. `--user` and `--workdir` are left off on
 * purpose: they are not limits, and an image without that account would fail
 * this check for a reason that has nothing to do with what a job can see.
 *
 * The `--ulimit` flags are here because a Docker that refuses one of them —
 * a future release that stops accepting `-1` for an unlimited hard limit, say —
 * would otherwise fail every Attempt at run time with the Profile already
 * advertised ready, which is the class of failure #9 moves to readiness. The
 * resolver flags are deliberately NOT here: which nameservers a Worker has is
 * derived per host in the provisioner, and reaching one is a network question
 * rather than a question about what a job can see about itself.
 */
export function probeInvocation(profile: ProfileSpec, cpuset: string): string[] {
  return [
    "run",
    "--rm",
    "--pull=never",
    "--cpus",
    String(profile.vcpus),
    "--cpuset-cpus",
    cpuset,
    "--memory",
    `${profile.memoryMiB}m`,
    "--shm-size",
    `${Math.floor(profile.memoryMiB / 2)}m`,
    "--pids-limit",
    String(PIDS_LIMIT),
    "--ulimit",
    "core=0:0",
    "--ulimit",
    "stack=16777216:-1",
    "--ulimit",
    "nofile=65536:1048576",
    "--ulimit",
    "memlock=8388608:8388608",
    "--ulimit",
    `nproc=${processBound(profile.memoryMiB)}:${processBound(profile.memoryMiB)}`,
    "--env",
    `RC_VCPUS=${profile.vcpus}`,
    "--env",
    `RC_MEMORY_MIB=${profile.memoryMiB}`,
    profile.imageRelease,
    "sh",
    "-c",
    PROBE_COMMAND,
  ];
}

/**
 * Turns what the probe container said about itself into the check.
 *
 * A cpuset allocator that is correct today regresses silently the next time
 * provision-docker.sh is edited, because nothing else in the tree asserts what
 * a job can actually see — which is the same shape as the bug this exists to
 * prevent. The detail carries the measured numbers even when it passes:
 * evidence, not a boolean.
 */
export function jobResourceVisibility(
  profile: ProfileSpec,
  lease: CoreLease,
  probe: ProbeResult,
): ReadinessCheck {
  const fail = (detail: string): ReadinessCheck => ({
    name: CHECK_JOB_RESOURCE_VISIBILITY,
    passed: false,
    detail,
  });
  if (probe.exitCode !== 0) {
    return fail(
      `the probe container exited ${probe.exitCode}: ${probe.stderr.trim().slice(0, 300) || "no output"}`,
    );
  }
  const [nproc, envVcpus, envMemory, cgroupBytes] = probe.stdout
    .trim()
    .split("\n")
    .map((line) => line.trim());
  if (nproc === undefined || envVcpus === undefined || envMemory === undefined) {
    return fail(`the probe container printed ${JSON.stringify(probe.stdout.slice(0, 200))}`);
  }
  if (Number(nproc) !== profile.vcpus) {
    return fail(
      `the container reports ${nproc} CPUs but the Profile grants ${profile.vcpus}; ` +
        `a job here would autosize against the wrong number`,
    );
  }
  if (Number(envVcpus) !== profile.vcpus || Number(envMemory) !== profile.memoryMiB) {
    return fail(
      `the container's own limits read RC_VCPUS=${envVcpus} RC_MEMORY_MIB=${envMemory}, ` +
        `not ${profile.vcpus} and ${profile.memoryMiB}`,
    );
  }
  // free(1) and /proc/meminfo stay the host's without LXCFS, so RC_MEMORY_MIB
  // is the number a job has to trust. It is only worth trusting if it is the
  // limit the kernel is actually enforcing.
  const enforcedMiB = cgroupBytes === undefined ? NaN : Number(cgroupBytes) / 1024 / 1024;
  if (Number.isFinite(enforcedMiB) && Math.round(enforcedMiB) !== profile.memoryMiB) {
    return fail(
      `RC_MEMORY_MIB says ${profile.memoryMiB} but the memory cgroup enforces ` +
        `${Math.round(enforcedMiB)} MiB`,
    );
  }
  const enforced = Number.isFinite(enforcedMiB)
    ? `${Math.round(enforcedMiB)} MiB enforced`
    : "cgroup limit unreadable";
  return {
    name: CHECK_JOB_RESOURCE_VISIBILITY,
    passed: true,
    detail:
      `nproc=${nproc} on ${lease.spec}${lease.exclusive ? "" : " (shared: the Worker was busy)"}, ` +
      `RC_VCPUS=${envVcpus}, RC_MEMORY_MIB=${envMemory}, ${enforced}`,
  };
}

/**
 * A stable identifier, on the same rule as CHECK_JOB_RESOURCE_VISIBILITY above:
 * the dashboard groups by it and README's sysctl.d section names it, so
 * renaming it is a product change.
 */
export const CHECK_HOST_SYSCTLS = "host-sysctls";

/**
 * One kernel setting a Docker Attempt inherits from the Worker it lands on.
 *
 * Not one of the six #96 measured is namespaced, so not one of them can be
 * chosen per container: `docker run --sysctl vm.max_map_count=262144` is
 * refused by the daemon outright — `sysctl 'vm.max_map_count' is not allowed` —
 * and so are the other five, verified against Docker 27.5 and 28.1. Docker
 * admits only the IPC keys, `fs.mqueue.*` and `net.*`. What a job reads is
 * therefore whatever the Worker's kernel holds, which makes these a Worker
 * prerequisite; and a prerequisite nothing proves is a wish, which is the gap
 * #91 closed for the resource limits.
 *
 * `minimum` is set only where a job breaks below it, because a failing check
 * withdraws the Profile from scheduling and a Worker should not refuse work
 * over a latency difference. The rest carry `hosted` so an operator can see the
 * gap in the evidence without the check having an opinion about it.
 */
export type HostSysctl = {
  key: string;
  path: string;
  /** `ubuntu-latest`'s value, from conformance run 32092987570 (#96). */
  hosted: number;
  /** Below this a job fails outright. Absent means recorded, not gated. */
  minimum?: number;
  /** What breaks below `minimum`, or why the gap is recorded rather than gated. */
  because: string;
};

export const HOST_SYSCTLS: HostSysctl[] = [
  {
    key: "vm.max_map_count",
    path: "/proc/sys/vm/max_map_count",
    hosted: 262144,
    minimum: 262144,
    because:
      "Elasticsearch and OpenSearch refuse to start below 262144 and say so in a startup error; " +
      "the JVM and mmap-heavy builds degrade more quietly",
  },
  {
    key: "fs.inotify.max_user_instances",
    path: "/proc/sys/fs/inotify/max_user_instances",
    hosted: 1280,
    minimum: 1280,
    because:
      "a bundler, a test watcher or a file-watching dev server exhausts the instances and reports " +
      "an opaque ENOSPC that has nothing to do with disk space",
  },
  {
    key: "fs.inotify.max_user_watches",
    path: "/proc/sys/fs/inotify/max_user_watches",
    hosted: 655360,
    because:
      "the same subsystem one level up, and no measured workflow has exhausted the kernel's own " +
      "524288 default; recorded so the gap is visible rather than gated",
  },
  {
    key: "vm.swappiness",
    path: "/proc/sys/vm/swappiness",
    hosted: 60,
    because: "a host readier to swap a job out costs it latency rather than failing it",
  },
  {
    key: "kernel.threads-max",
    path: "/proc/sys/kernel/threads-max",
    hosted: 127677,
    because:
      "a Worker is bigger than a hosted runner so this is bigger too; the bound a job actually " +
      "meets first is --pids-limit and RLIMIT_NPROC, which provision-docker.sh sets per Attempt",
  },
  {
    key: "user.max_user_namespaces",
    path: "/proc/sys/user/max_user_namespaces",
    hosted: 63838,
    because: "larger here for the same reason, and nothing a job does is bounded by it first",
  },
];

/**
 * Reads the settings on this host. An unreadable one is `undefined` rather than
 * an error: a Worker with no /proc/sys is not a Linux host and a job being
 * refused there is a different problem than a job being broken by a kernel
 * setting — the same tolerance the cgroup limit gets above.
 */
export async function readHostSysctls(
  sysctls: HostSysctl[] = HOST_SYSCTLS,
): Promise<Map<string, number | undefined>> {
  const readings = new Map<string, number | undefined>();
  await Promise.all(
    sysctls.map(async (sysctl) => {
      try {
        const value = Number((await readFile(sysctl.path, "utf8")).trim().split(/\s+/)[0]);
        readings.set(sysctl.key, Number.isFinite(value) ? value : undefined);
      } catch {
        readings.set(sysctl.key, undefined);
      }
    }),
  );
  return readings;
}

/**
 * Turns those readings into the check. The detail carries every measured number
 * whether or not it passed — evidence, not a boolean (ADR 0002) — so the
 * dashboard shows the gap on a Worker that is merely different and names the
 * exact key and threshold on one that would break a job.
 */
export function hostSysctlReadiness(
  readings: ReadonlyMap<string, number | undefined>,
  sysctls: HostSysctl[] = HOST_SYSCTLS,
): ReadinessCheck {
  const evidence = sysctls
    .map((sysctl) => {
      const value = readings.get(sysctl.key);
      if (value === undefined) return `${sysctl.key}=unreadable`;
      return value === sysctl.hosted
        ? `${sysctl.key}=${value}`
        : `${sysctl.key}=${value} (hosted ${sysctl.hosted})`;
    })
    .join(", ");
  const broken = sysctls.filter((sysctl) => {
    const value = readings.get(sysctl.key);
    return sysctl.minimum !== undefined && value !== undefined && value < sysctl.minimum;
  });
  if (broken.length > 0) {
    return {
      name: CHECK_HOST_SYSCTLS,
      passed: false,
      detail:
        broken
          .map(
            (sysctl) =>
              `${sysctl.key} is ${readings.get(sysctl.key)} but a job needs ${sysctl.minimum}: ` +
              sysctl.because,
          )
          .join("; ") +
        `. These are host settings that no --sysctl flag can override per container; ` +
        `set them in /etc/sysctl.d (README, Linux Worker prerequisites). Measured: ${evidence}`,
    };
  }
  return { name: CHECK_HOST_SYSCTLS, passed: true, detail: evidence };
}

async function prepareDocker(
  profile: ProfileSpec,
  cores: number,
  options: PrepareProfileOptions = {},
): Promise<ReadinessResult> {
  const checks: ReadinessCheck[] = [];
  const fail = (name: string, detail: string): ReadinessResult => {
    checks.push({ name, passed: false, detail });
    return { state: "failed", error: detail, ...dockerFacts(checks) };
  };
  // Every Attempt is pinned to its own disjoint range of this Worker's CPUs, so
  // a Profile wider than the Worker can never be given one and every Attempt
  // placed here would be refused at run time forever. Readiness is where a
  // static mismatch belongs, and it is proved first because it is the one check
  // no daemon, pull or retry can change (#9, #80).
  if (profile.vcpus > cores) {
    return fail(
      "cpu-capacity",
      `this Worker has ${cores} CPUs but the Profile asks for ${profile.vcpus}; ` +
        `no Attempt could be given a core range of that width`,
    );
  }
  checks.push({ name: "cpu-capacity", passed: true, detail: `${profile.vcpus} of ${cores} CPUs` });
  // The other half of #96, and the half no flag can reach: a shared kernel means
  // the job reads the Worker's sysctls, and Docker refuses to set any of the six
  // that matter per container because none is namespaced. That makes them a
  // Worker prerequisite, so they are proved here beside cpu-capacity — both are
  // static host facts that no pull, retry or Docker version can change.
  const sysctls = hostSysctlReadiness(await readHostSysctls());
  checks.push(sysctls);
  if (!sysctls.passed) {
    return {
      state: "failed",
      error: sysctls.detail ?? "the Worker's kernel settings would break a job",
      ...dockerFacts(checks),
    };
  }
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

  // The last thing readiness proves is the thing the job depends on and nothing
  // else measures: that a container started with this Profile's limit flags
  // agrees about its own size. The scratch-directory check above moves a job
  // failure to readiness (#9); this does the same for the resource lie (#80).
  const lease = (options.leaseCores ?? defaultLease)(profile.vcpus);
  let visibility: ReadinessCheck;
  try {
    const run = options.runProbe ?? runDockerProbe;
    visibility = jobResourceVisibility(
      profile,
      lease,
      await run(probeInvocation(profile, lease.spec)),
    );
  } catch (error) {
    visibility = {
      name: CHECK_JOB_RESOURCE_VISIBILITY,
      passed: false,
      detail: `the probe container could not be run: ${message(error)}`,
    };
  } finally {
    lease.release();
  }
  checks.push(visibility);
  if (!visibility.passed) {
    // A Worker that cannot give a job an honest view of its own size has no
    // business accepting work, which is the rule the network policy already
    // follows.
    return {
      state: "failed",
      error: visibility.detail ?? "resource visibility failed",
      ...dockerFacts(checks),
    };
  }
  return { state: "ready", ...dockerFacts(checks) };
}

/**
 * When the Agent did not hand in an allocator — only a direct caller does
 * that — the probe still pins to a real range of the right width. `cpu-capacity`
 * has already proved the Worker has that many CPUs.
 */
function defaultLease(vcpus: number): CoreLease {
  return {
    spec: vcpus === 1 ? "0" : `0-${vcpus - 1}`,
    exclusive: false,
    release: () => {},
  };
}

async function runDockerProbe(args: string[]): Promise<ProbeResult> {
  const result = await execa("docker", args, { timeout: 120_000, reject: false });
  return {
    exitCode: result.exitCode ?? 1,
    stdout: result.stdout,
    stderr: result.stderr,
  };
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
    const prepared = await execa(binary, ["prepare"], {
      env: {
        ...process.env,
        RC_PROFILE: profile.profile,
        RC_IMAGE_RELEASE: profile.imageRelease,
        RC_VCPUS: String(profile.vcpus),
        RC_MEMORY_MIB: String(profile.memoryMiB),
        RC_WARM_POOL: String(profile.warmPool ?? 0),
      },
      timeout: 60 * 60_000,
      reject: false,
    });
    const facts = runtimeFacts(report);
    facts.checks.push({ name: "image-release", passed: true, detail: profile.imageRelease });
    const warmPool = parseWarmPoolStatus(prepared.stdout);
    if (
      prepared.exitCode !== 0 ||
      warmPool === undefined ||
      warmPool.target !== (profile.warmPool ?? 0) ||
      warmPool.parked + warmPool.claimed !== warmPool.target
    ) {
      const detail =
        prepared.stderr.trim() ||
        `warm pool owns ${warmPool === undefined ? "an unknown number" : warmPool.parked + warmPool.claimed} of ${profile.warmPool ?? 0} microVMs`;
      facts.checks.push({ name: "warm-pool", passed: false, detail });
      if (warmPool !== undefined) facts.warmPool = warmPool;
      return { state: "failed", error: detail, ...facts };
    }
    facts.warmPool = warmPool;
    facts.checks.push({
      name: "warm-pool",
      passed: true,
      detail: `${warmPool.parked} parked and ${warmPool.claimed} claimed of ${warmPool.target}`,
    });
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

export function parseWarmPoolStatus(
  stdout: string,
): { target: number; parked: number; claimed: number } | undefined {
  try {
    const parsed: unknown = JSON.parse(stdout.trim());
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !("target" in parsed) ||
      !("parked" in parsed) ||
      !("claimed" in parsed)
    )
      return undefined;
    const { target, parked, claimed } = parsed as Record<string, unknown>;
    if (
      ![target, parked, claimed].every(
        (value) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0,
      )
    ) {
      return undefined;
    }
    return { target: target as number, parked: parked as number, claimed: claimed as number };
  } catch {
    return undefined;
  }
}

export function warmPoolCapacityError(
  profiles: ProfileSpec[],
  maxSlots: number,
  hostCPUs: number,
  hostMemoryMiB: number,
): string | undefined {
  const warm = profiles.filter(
    (profile) => profile.executor === "firecracker" && (profile.warmPool ?? 0) > 0,
  );
  const slots = warm.reduce((total, profile) => total + (profile.warmPool ?? 0), 0);
  const vcpus = warm.reduce((total, profile) => total + (profile.warmPool ?? 0) * profile.vcpus, 0);
  const memoryMiB = warm.reduce(
    (total, profile) => total + (profile.warmPool ?? 0) * profile.memoryMiB,
    0,
  );
  const usableCPUs = Math.max(1, Math.floor(hostCPUs * 0.9));
  const usableMemoryMiB = Math.max(512, Math.floor(hostMemoryMiB * 0.9));
  if (slots > maxSlots)
    return `warm pools require ${slots} slots but this Worker admits ${maxSlots}`;
  if (vcpus > usableCPUs)
    return `warm pools require ${vcpus} vCPUs but this Worker reserves ${usableCPUs}`;
  if (memoryMiB > usableMemoryMiB)
    return `warm pools require ${memoryMiB} MiB but this Worker reserves ${usableMemoryMiB} MiB`;
  return undefined;
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

export async function prepareProfile(
  profile: ProfileSpec,
  options: PrepareProfileOptions = {},
): Promise<ReadinessResult> {
  // Both Linux executors already refuse a mutable reference at job time, so
  // failing here moves that rejection to readiness. Tart performs the same
  // check in its branch so it can still report the independent binary check.
  const requiresDigest = profile.executor === "docker" || profile.executor === "firecracker";
  if (requiresDigest && !IMAGE_DIGEST.test(profile.imageRelease)) {
    const detail = `Image Release ${profile.imageRelease} is not pinned by sha256 digest`;
    const check: ReadinessCheck = { name: "image-release", passed: false, detail };
    const facts =
      profile.executor === "docker"
        ? dockerFacts([check])
        : profile.executor === "tart"
          ? {
              isolation: "tart-vm",
              boundary: "guest-kernel" as const,
              checks: [check],
              cacheScope: "immutable-image",
              cacheSharedWritable: false,
            }
          : { ...runtimeFacts({}), checks: [check] };
    return { state: "failed", error: detail, ...facts };
  }
  switch (profile.executor) {
    case "docker":
      return prepareDocker(profile, options.hostCores ?? availableParallelism(), options);
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
      const digestError = IMAGE_DIGEST.test(profile.imageRelease)
        ? undefined
        : `Image Release ${profile.imageRelease} is not pinned by sha256 digest`;
      try {
        const version = await execa(binary, ["--version"], { timeout: 30_000 });
        checks.push({ name: "tart-binary", passed: true, detail: version.stdout.trim() });
      } catch (error) {
        const detail = message(error);
        checks.push({ name: "tart-binary", passed: false, detail });
      }
      if (digestError !== undefined) {
        checks.push({ name: "image-release", passed: false, detail: digestError });
      }
      if (checks.some((check) => !check.passed)) {
        const currentFacts = facts();
        return { state: "failed", error: failureOf(currentFacts, ""), ...currentFacts };
      }
      try {
        // A digest reference makes this an idempotent prewarm, not an update.
        await execa(binary, ["pull", profile.imageRelease], { timeout: 2 * 60 * 60_000 });
        checks.push({ name: "image-release", passed: true, detail: profile.imageRelease });
        return { state: "ready", ...facts() };
      } catch (error) {
        const detail = message(error);
        checks.push({ name: "image-release", passed: false, detail });
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

export async function removePreparedFirecrackerProfile(profile: string) {
  const binary = process.env.RC_RUNTIME_BINARY?.trim() || "runner-center-runtime";
  await execa(binary, ["remove-profile"], {
    env: { ...process.env, RC_PROFILE: profile },
    timeout: 60_000,
  });
}
