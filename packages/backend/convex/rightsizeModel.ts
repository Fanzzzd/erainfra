/**
 * Right-sizing: which Profile each workflow job should run on, from the CPU and memory its own
 * Attempts used (the per-Attempt summaries in attemptMetricsModel.ts). Pure functions only, so the
 * policy is tested without a database; rightsize.ts reads the rows and calls `recommend`.
 *
 * The policy is deliberately one-sided towards leaving things alone. A recommendation to move costs
 * the user a workflow edit and, if wrong, a slower or OOM-killed job, while a missed saving costs
 * only money. So:
 *
 * - **Enough evidence.** A job needs MIN_ATTEMPTS qualifying Attempts in the window. An Attempt
 *   qualifies when its final snapshot arrived, it was measured for at least MIN_MEASURED_MS, and at
 *   most MAX_ERROR_RATIO of its readings failed. With five Attempts the nearest-rank p95 is the
 *   maximum, so a small sample is judged by its worst run.
 * - **Headroom on the way down.** A smaller Profile must carry the job's p95 CPU at no more than
 *   CPU_TARGET_UTILISATION of its vCPUs, and its memory must hold the peak times MEMORY_HEADROOM.
 *   70 % CPU and 30 % memory headroom are the margins Kubernetes' VPA and the cloud right-sizers
 *   (AWS Compute Optimizer, GCP's recommender) default to.
 * - **A gap between the two thresholds.** Upsizing on CPU needs the median run's p95 at
 *   CPU_SATURATED (90 %) of the Profile, while downsizing judges the p95 across runs against 70 %
 *   of the smaller one. A job between the two is left where it is, so a recommendation does not
 *   flip back on the next window, and one CPU-heavy run does not buy every run a bigger Profile.
 * - **OOM kills win.** Any OOM kill in the window rules out a smaller memory and asks for more.
 * - **Firecracker memory is not pressure.** The Firecracker number is the VMM's resident memory,
 *   which climbs towards the allotment as the guest fills its page cache and never comes down
 *   (README, Job metrics). It is a safe upper bound for "would a smaller Profile have held this",
 *   and no evidence at all that the job needs more, so on Firecracker only an OOM kill upsizes
 *   memory. Docker reports the working set, where a peak at 90 % of the limit is real pressure.
 */

export const MIN_ATTEMPTS = 5;
export const MIN_MEASURED_MS = 30_000;
export const MAX_ERROR_RATIO = 0.1;
export const CPU_TARGET_UTILISATION = 0.7;
export const CPU_SATURATED = 0.9;
export const MEMORY_HEADROOM = 1.3;
export const MEMORY_PRESSURE = 0.9;
/** The metrics retention (METRICS_RETENTION_MS): no window can reach further back than this. */
export const MAX_WINDOW_MS = 14 * 24 * 60 * 60_000;
export const DEFAULT_WINDOW_MS = MAX_WINDOW_MS;

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;
/** The vCPU sizes runner vendors sell (ADR 0010's table), and so the sizes a suggestion names. */
const STANDARD_VCPUS = [1, 2, 4, 8, 16, 32, 64] as const;
/** ADR 0010's default ratio: a name carries no memory suffix at 4 GiB per vCPU. */
const DEFAULT_GIB_PER_VCPU = 4;
const MAX_GIB = 256;

export type Executor = "docker" | "firecracker" | "tart" | "hyperv";

export type RightsizeProfile = {
  name: string;
  executor: Executor;
  imageRelease: string;
  vcpus: number;
  memoryMiB: number;
  state: "active" | "paused";
};

/** One measured Attempt: its summary, plus who ran it and on what. */
export type RightsizeSample = {
  repo: string;
  job: string;
  profile: string;
  executor: Executor;
  vcpus: number;
  memoryMiB: number;
  finishedAt: number;
  source: string;
  final: boolean;
  samples: number;
  errors: number;
  durationMs: number;
  cpuP95Vcpus: number;
  cpuMaxVcpus: number;
  memoryPeakBytes: number;
  oomKills: number | null;
};

export type Verdict = "upsize" | "downsize" | "keep" | "insufficient_data";

export type Recommendation = {
  repo: string;
  job: string;
  profile: string;
  verdict: Verdict;
  /** A registered, active Profile to move to, or null. */
  recommendedProfile: string | null;
  /**
   * When no registered Profile fits, the ADR 0010 name one that fits would have, or null when the
   * current Profile's name does not follow ADR 0010 and so says nothing about OS and architecture.
   */
  suggestedProfile: string | null;
  current: { vcpus: number; memoryMiB: number };
  /** The size of recommendedProfile, or of suggestedProfile, or null. */
  target: { vcpus: number; memoryMiB: number } | null;
  attempts: number;
  excludedAttempts: number;
  lastSeenAt: number;
  cpu: { p95Vcpus: number; maxVcpus: number; saturatedAttempts: number };
  memory: {
    peakBytes: number;
    /** working-set (Docker) or host-resident (Firecracker VMM); see the module comment. */
    measure: "working-set" | "host-resident";
    oomAttempts: number;
  };
  explanation: string;
};

/** Nearest-rank quantile: the smallest value at least `quantile` of the values are at or below. */
export function nearestRank(values: readonly number[], quantile: number) {
  if (values.length === 0) return 0;
  const sorted = values.toSorted((left, right) => left - right);
  const rank = Math.max(1, Math.ceil(quantile * sorted.length));
  return sorted[rank - 1]!;
}

export function qualifies(sample: RightsizeSample) {
  if (!sample.final) return false;
  if (sample.durationMs < MIN_MEASURED_MS) return false;
  const readings = sample.samples + sample.errors;
  return readings > 0 && sample.errors <= MAX_ERROR_RATIO * readings;
}

/** The working set is a pressure signal; the VMM's resident memory is only an upper bound. */
export function memoryMeasure(source: string): "working-set" | "host-resident" {
  return source.startsWith("cgroup") ? "working-set" : "host-resident";
}

// ---------------------------------------------------------------------------
// Profile families and ADR 0010 names

export type ParsedProfileName = {
  canary: boolean;
  vcpus: number;
  os: string;
  arm: boolean;
  memoryGiB: number | null;
  flavour: string | null;
};

const ADR_0010_NAME =
  /^erainfra-(canary-)?([1-9][0-9]*)vcpu-([a-z]+-[0-9]+)(-arm)?(?:-([1-9][0-9]*)gb)?(?:-([a-z][a-z0-9-]*))?$/;

export function parseProfileName(name: string): ParsedProfileName | null {
  const match = ADR_0010_NAME.exec(name);
  if (match === null) return null;
  return {
    canary: match[1] !== undefined,
    vcpus: Number(match[2]),
    os: match[3]!,
    arm: match[4] !== undefined,
    memoryGiB: match[5] === undefined ? null : Number(match[5]),
    flavour: match[6] ?? null,
  };
}

/** ADR 0010: `erainfra-<N>vcpu-<os><version>[-arm][-<M>gb][-<flavour>]`. */
export function profileName(
  family: Pick<ParsedProfileName, "canary" | "os" | "arm" | "flavour">,
  vcpus: number,
  memoryGiB: number,
) {
  const parts = ["erainfra"];
  if (family.canary) parts.push("canary");
  parts.push(`${vcpus}vcpu`, family.os);
  if (family.arm) parts.push("arm");
  if (memoryGiB !== vcpus * DEFAULT_GIB_PER_VCPU) parts.push(`${memoryGiB}gb`);
  if (family.flavour !== null) parts.push(family.flavour);
  return parts.join("-");
}

/** The image repository without tag or digest: what two Profiles share when they boot alike. */
function imageRepository(imageRelease: string) {
  const withoutDigest = imageRelease.split("@")[0]!;
  const slash = withoutDigest.lastIndexOf("/");
  const colon = withoutDigest.lastIndexOf(":");
  return colon > slash ? withoutDigest.slice(0, colon) : withoutDigest;
}

/**
 * Whether a job could move between the two Profiles by changing `runs-on` and nothing else: the
 * same executor, and the same OS, architecture, flavour and canary-ness when both names follow ADR
 * 0010, or the same image repository when either does not.
 */
export function sameFamily(left: RightsizeProfile, right: RightsizeProfile) {
  if (left.executor !== right.executor) return false;
  const parsedLeft = parseProfileName(left.name);
  const parsedRight = parseProfileName(right.name);
  if (parsedLeft !== null && parsedRight !== null) {
    return (
      parsedLeft.canary === parsedRight.canary &&
      parsedLeft.os === parsedRight.os &&
      parsedLeft.arm === parsedRight.arm &&
      parsedLeft.flavour === parsedRight.flavour
    );
  }
  return imageRepository(left.imageRelease) === imageRepository(right.imageRelease);
}

// ---------------------------------------------------------------------------
// The decision

type Need = {
  /** The smallest vCPU count that carries the job. */
  vcpus: number;
  /** When set, the vCPU count must also exceed this (the job saturated it). */
  vcpusAbove: number | null;
  memoryBytes: number;
  memoryAbove: number | null;
};

function fits(profile: { vcpus: number; memoryMiB: number }, need: Need) {
  const memoryBytes = profile.memoryMiB * MIB;
  return (
    profile.vcpus >= need.vcpus &&
    (need.vcpusAbove === null || profile.vcpus > need.vcpusAbove) &&
    memoryBytes >= need.memoryBytes &&
    (need.memoryAbove === null || memoryBytes > need.memoryAbove)
  );
}

function bySize(left: RightsizeProfile, right: RightsizeProfile) {
  return left.vcpus - right.vcpus || left.memoryMiB - right.memoryMiB;
}

/** The standard size ADR 0010 would name for a need: a vendor vCPU step, 4 GiB per vCPU or more. */
export function standardSize(need: Need): { vcpus: number; memoryMiB: number } | null {
  const vcpus = STANDARD_VCPUS.find(
    (step) => step >= need.vcpus && (need.vcpusAbove === null || step > need.vcpusAbove),
  );
  if (vcpus === undefined) return null;
  let memoryGiB = vcpus * DEFAULT_GIB_PER_VCPU;
  while (
    memoryGiB * GIB < need.memoryBytes ||
    (need.memoryAbove !== null && memoryGiB * GIB <= need.memoryAbove)
  ) {
    memoryGiB *= 2;
    if (memoryGiB > MAX_GIB) return null;
  }
  return { vcpus, memoryMiB: memoryGiB * 1024 };
}

function cores(value: number) {
  return value >= 10 ? value.toFixed(0) : value.toFixed(1);
}

function gib(bytes: number) {
  const value = bytes / GIB;
  return value >= 10 ? value.toFixed(0) : value.toFixed(1);
}

function size(profile: { vcpus: number; memoryMiB: number }) {
  return `${profile.vcpus} vCPU, ${gib(profile.memoryMiB * MIB)} GiB`;
}

function plural(count: number, noun: string) {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/**
 * One job's recommendation. `samples` are that job's Attempts on one Profile; `profiles` is every
 * registered Profile, of which only active ones in the same family are candidates.
 */
export function recommend(
  key: { repo: string; job: string; profile: string },
  samples: readonly RightsizeSample[],
  profiles: readonly RightsizeProfile[],
): Recommendation {
  const used = samples.filter(qualifies);
  const newest = samples.reduce<RightsizeSample | undefined>(
    (latest, sample) =>
      latest === undefined || sample.finishedAt > latest.finishedAt ? sample : latest,
    undefined,
  );
  const registered = profiles.find((profile) => profile.name === key.profile);
  const current: RightsizeProfile = registered ?? {
    name: key.profile,
    executor: newest?.executor ?? "docker",
    imageRelease: "",
    vcpus: newest?.vcpus ?? 0,
    memoryMiB: newest?.memoryMiB ?? 0,
    state: "paused",
  };
  const currentMemoryBytes = current.memoryMiB * MIB;

  const cpuP95 = nearestRank(
    used.map((sample) => sample.cpuP95Vcpus),
    0.95,
  );
  const cpuMax = Math.max(0, ...used.map((sample) => sample.cpuMaxVcpus));
  const saturatedAttempts = used.filter(
    (sample) => sample.vcpus > 0 && sample.cpuP95Vcpus >= CPU_SATURATED * sample.vcpus,
  ).length;
  // The median run, not the worst: one CPU-heavy run should not buy every run a bigger Profile.
  const saturationRatio = nearestRank(
    used.map((sample) => (sample.vcpus > 0 ? sample.cpuP95Vcpus / sample.vcpus : 0)),
    0.5,
  );
  const memoryPeak = Math.max(0, ...used.map((sample) => sample.memoryPeakBytes));
  const oomAttempts = used.filter((sample) => (sample.oomKills ?? 0) > 0).length;
  const measure = used.some((sample) => memoryMeasure(sample.source) === "host-resident")
    ? "host-resident"
    : "working-set";
  const pressureAttempts =
    measure === "working-set"
      ? used.filter(
          (sample) =>
            sample.memoryMiB > 0 &&
            sample.memoryPeakBytes >= MEMORY_PRESSURE * sample.memoryMiB * MIB,
        ).length
      : 0;

  const base = {
    repo: key.repo,
    job: key.job,
    profile: key.profile,
    current: { vcpus: current.vcpus, memoryMiB: current.memoryMiB },
    attempts: used.length,
    excludedAttempts: samples.length - used.length,
    lastSeenAt: newest?.finishedAt ?? 0,
    cpu: { p95Vcpus: cpuP95, maxVcpus: cpuMax, saturatedAttempts },
    memory: { peakBytes: memoryPeak, measure, oomAttempts },
  } as const;
  const observed =
    `Over ${plural(used.length, "measured run")}, CPU p95 was ${cores(cpuP95)} of ` +
    `${current.vcpus} vCPUs and memory peaked at ${gib(memoryPeak)} of ${gib(currentMemoryBytes)} GiB` +
    (measure === "host-resident" ? " (host-resident, an upper bound)" : "") +
    ".";

  if (used.length < MIN_ATTEMPTS) {
    const excluded =
      samples.length > used.length
        ? ` ${plural(samples.length - used.length, "more run")} had no final snapshot, ran under ${MIN_MEASURED_MS / 1000} seconds or lost too many readings.`
        : "";
    const oom =
      oomAttempts > 0
        ? ` ${plural(oomAttempts, "of those run")} ${oomAttempts === 1 ? "was" : "were"} OOM-killed, so watch this job.`
        : "";
    return {
      ...base,
      verdict: "insufficient_data",
      recommendedProfile: null,
      suggestedProfile: null,
      target: null,
      explanation:
        `Only ${plural(used.length, "measured run")} in the window; a recommendation needs at ` +
        `least ${MIN_ATTEMPTS}.${excluded}${oom}`,
    };
  }

  const cpuSaturated = saturationRatio >= CPU_SATURATED;
  const memoryShort = oomAttempts > 0 || pressureAttempts > 0;
  const need: Need = {
    vcpus: Math.max(1, cpuP95 / CPU_TARGET_UTILISATION),
    vcpusAbove: cpuSaturated ? current.vcpus : null,
    // With no OOM kill and no pressure the current memory is proven enough, whatever the peak
    // times the headroom says: on Firecracker the peak is page cache that grew into the allotment.
    memoryBytes: memoryShort
      ? memoryPeak * MEMORY_HEADROOM
      : Math.min(memoryPeak * MEMORY_HEADROOM, currentMemoryBytes),
    memoryAbove: memoryShort ? currentMemoryBytes : null,
  };
  const family = profiles.filter(
    (profile) =>
      profile.state === "active" && profile.name !== current.name && sameFamily(profile, current),
  );
  const parsed = parseProfileName(current.name);
  const suggestion = (target: { vcpus: number; memoryMiB: number } | null) =>
    target === null || parsed === null
      ? null
      : profileName(parsed, target.vcpus, target.memoryMiB / 1024);

  if (cpuSaturated || memoryShort) {
    // The job outgrew its Profile on at least one axis. The other axis must not shrink, and
    // whatever is chosen must still cover the measured need on both.
    const upNeed: Need = {
      ...need,
      vcpus: Math.max(need.vcpus, cpuSaturated ? 0 : current.vcpus),
      memoryBytes: Math.max(need.memoryBytes, memoryShort ? 0 : currentMemoryBytes),
    };
    const why: string[] = [];
    if (cpuSaturated) {
      why.push(
        `${saturatedAttempts} of ${used.length} runs held CPU at ${Math.round(CPU_SATURATED * 100)}% ` +
          `or more of the Profile at p95, so the job is usually waiting on CPU`,
      );
    }
    if (oomAttempts > 0) {
      why.push(`${plural(oomAttempts, "run")} ${oomAttempts === 1 ? "was" : "were"} OOM-killed`);
    } else if (pressureAttempts > 0) {
      why.push(
        `${plural(pressureAttempts, "run")} used ${Math.round(MEMORY_PRESSURE * 100)}% or more of ` +
          `its memory`,
      );
    }
    const choice = family.filter((profile) => fits(profile, upNeed)).toSorted(bySize)[0];
    const reason = `${observed} ${why.join(", and ")}.`;
    if (choice !== undefined) {
      return {
        ...base,
        verdict: "upsize",
        recommendedProfile: choice.name,
        suggestedProfile: null,
        target: { vcpus: choice.vcpus, memoryMiB: choice.memoryMiB },
        explanation: `${reason} Move it to ${choice.name} (${size(choice)}).`,
      };
    }
    const ideal = standardSize(upNeed);
    const name = suggestion(ideal);
    return {
      ...base,
      verdict: "upsize",
      recommendedProfile: null,
      suggestedProfile: name,
      target: ideal,
      explanation:
        `${reason} No registered Profile in this family is larger on that axis` +
        (ideal === null
          ? "."
          : name === null
            ? `; register one with ${size(ideal)}.`
            : `; register ${name} (${size(ideal)}).`),
    };
  }

  // Neither axis is short. A move down must be smaller on one axis, no larger on the other, and
  // still leave the headroom on both.
  const smaller = family.filter(
    (profile) =>
      profile.vcpus <= current.vcpus &&
      profile.memoryMiB <= current.memoryMiB &&
      (profile.vcpus < current.vcpus || profile.memoryMiB < current.memoryMiB) &&
      fits(profile, need),
  );
  const choice = smaller.toSorted(bySize)[0];
  const headroom =
    `${Math.round(CPU_TARGET_UTILISATION * 100)}% CPU utilisation at p95 and ` +
    `${Math.round((MEMORY_HEADROOM - 1) * 100)}% memory headroom over the peak`;
  if (choice !== undefined) {
    return {
      ...base,
      verdict: "downsize",
      recommendedProfile: choice.name,
      suggestedProfile: null,
      target: { vcpus: choice.vcpus, memoryMiB: choice.memoryMiB },
      explanation: `${observed} ${choice.name} (${size(choice)}) still allows ${headroom}, so the job can move to it.`,
    };
  }
  const ideal = standardSize(need);
  const smallerIdeal =
    ideal !== null &&
    ideal.vcpus <= current.vcpus &&
    ideal.memoryMiB <= current.memoryMiB &&
    (ideal.vcpus < current.vcpus || ideal.memoryMiB < current.memoryMiB);
  if (smallerIdeal) {
    const name = suggestion(ideal);
    return {
      ...base,
      verdict: "downsize",
      recommendedProfile: null,
      suggestedProfile: name,
      target: ideal,
      explanation:
        `${observed} A ${size(ideal)} Profile would still allow ${headroom}, but none is ` +
        `registered in this family` +
        (name === null ? "." : `; register ${name} to move the job to it.`),
    };
  }
  return {
    ...base,
    verdict: "keep",
    recommendedProfile: null,
    suggestedProfile: null,
    target: null,
    explanation: `${observed} That fits the current Profile, and nothing smaller would allow ${headroom}.`,
  };
}

/** Groups samples by repository, job and Profile and recommends for each, worst first. */
export function recommendAll(
  samples: readonly RightsizeSample[],
  profiles: readonly RightsizeProfile[],
): Recommendation[] {
  const groups = new Map<string, RightsizeSample[]>();
  for (const sample of samples) {
    const key = JSON.stringify([sample.repo, sample.job, sample.profile]);
    const group = groups.get(key);
    if (group === undefined) groups.set(key, [sample]);
    else group.push(sample);
  }
  const order: Record<Verdict, number> = { upsize: 0, downsize: 1, keep: 2, insufficient_data: 3 };
  return [...groups.entries()]
    .map(([key, group]) => {
      const [repo, job, profile] = JSON.parse(key) as [string, string, string];
      return recommend({ repo, job, profile }, group, profiles);
    })
    .toSorted(
      (left, right) =>
        order[left.verdict] - order[right.verdict] ||
        left.repo.localeCompare(right.repo) ||
        left.job.localeCompare(right.job) ||
        left.profile.localeCompare(right.profile),
    );
}

/**
 * The `runs-on` rewrite a migration tool can apply: repository, then job, then the current Profile
 * name, mapped to the registered Profile to use instead. Only recommendations that name a
 * registered Profile appear; a suggestion has to be registered before anything can run on it.
 */
export function runsOnMap(recommendations: readonly Recommendation[]) {
  const map: Record<string, Record<string, Record<string, string>>> = {};
  for (const recommendation of recommendations) {
    if (recommendation.recommendedProfile === null) continue;
    const repo = (map[recommendation.repo] ??= {});
    const job = (repo[recommendation.job] ??= {});
    job[recommendation.profile] = recommendation.recommendedProfile;
  }
  return map;
}
