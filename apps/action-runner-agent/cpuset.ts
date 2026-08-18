import { availableParallelism } from "node:os";
import { execa } from "execa";

/**
 * Per-Attempt CPU affinity for the Docker executor.
 *
 * `--cpus` sets the CFS bandwidth quota and nothing else: the container's
 * affinity mask still covers every host CPU. `nproc(1)`,
 * `os.availableParallelism()` (via uv_available_parallelism), `runtime.NumCPU()`,
 * CPython's `os.cpu_count()` and `Runtime.availableProcessors()` all go through
 * `sched_getaffinity(2)` and never the quota, so an 8-vCPU job on a 64-core
 * Worker tells every autosizing build tool it owns 64 cores. `--cpuset-cpus`
 * sets the mask those calls read, and is what makes them honest.
 *
 * Measured, so the limits are written down rather than assumed: a cpuset does
 * NOT filter `/proc/cpuinfo`, which still lists every host CPU, so anything
 * counting processor lines there — Node's own `os.cpus().length` included —
 * stays wrong. Only the affinity-based interfaces above are fixed by this.
 *
 * A cpuset is only an improvement if it is *this* Attempt's cores. Pinning
 * every Attempt to `0-7` would put every concurrent job on the same eight CPUs
 * and make contention strictly worse than the quota-only status quo while
 * looking like a fix, so the Agent allocates disjoint ranges and releases them
 * on every teardown path.
 */

/** The label provision-docker.sh puts on every container it starts. */
export const PROFILE_LABEL = "runner-center.profile";

/**
 * Reported for an Attempt this Worker could not give cores to. 75 is sysexits'
 * EX_TEMPFAIL: the request was well formed and the Worker is simply full, which
 * is what the control plane's bounded retry policy is for. It is deliberately
 * distinct from 1 (the job failed) and 124 (the job outlived its budget) so an
 * operator reading agent logs can tell the three apart.
 */
export const CPUSET_EXHAUSTED_EXIT = 75;

/**
 * How often adopted reservations are re-checked against the Docker daemon. The
 * timer only runs while something is adopted, so a Worker that started clean
 * never issues either command.
 */
export const RECONCILE_INTERVAL_MS = 30_000;

const DOCKER_TIMEOUT_MS = 30_000;

/** CPU ids this Worker may hand to jobs, assumed to be 0..N-1 as on Linux. */
export function hostCores() {
  return Math.max(1, availableParallelism());
}

export type CoreReservation = {
  /** Work key, unique per Attempt or Experiment: `attempt:<id>` and so on. */
  readonly key: string;
  readonly cores: readonly number[];
  /** The same cores as Docker's `--cpuset-cpus` argument, e.g. `0-3`. */
  readonly spec: string;
  /** The container holding these cores, when one exists. */
  readonly containerName?: string;
  /** True when this range was recovered from a container the Agent did not start. */
  readonly adopted: boolean;
};

/** Renders sorted CPU ids the way Docker, cgroups and `taskset -c` write them. */
export function formatCpuset(cores: Iterable<number>): string {
  // False positive: the spread has already produced a fresh array, so sort() mutates
  // nothing. toSorted() is ES2023 and this package's tsconfig targets ES2022.
  // oxlint-disable-next-line unicorn/no-array-sort
  const sorted = [...new Set(cores)].sort((left, right) => left - right);
  const parts: string[] = [];
  let index = 0;
  while (index < sorted.length) {
    const first = sorted[index] as number;
    let last = first;
    while (index + 1 < sorted.length && sorted[index + 1] === last + 1) {
      index += 1;
      last += 1;
    }
    parts.push(first === last ? String(first) : `${first}-${last}`);
    index += 1;
  }
  return parts.join(",");
}

/**
 * The CPU ids a cpuset covers, or undefined when the string is not one. Used
 * both to check the Agent's own output and to read what a surviving container
 * actually holds, which is why it refuses anything it does not fully
 * understand rather than guessing a width.
 */
export function parseCpuset(spec: string): number[] | undefined {
  const trimmed = spec.trim();
  if (trimmed === "") return undefined;
  const cores = new Set<number>();
  for (const part of trimmed.split(",")) {
    const range = /^(\d+)(?:-(\d+))?$/.exec(part);
    if (range === null) return undefined;
    const first = Number(range[1]);
    const last = range[2] === undefined ? first : Number(range[2]);
    if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last) || last < first) {
      return undefined;
    }
    for (let core = first; core <= last; core += 1) cores.add(core);
  }
  // False positive: the spread has already produced a fresh array, so sort() mutates
  // nothing. toSorted() is ES2023 and this package's tsconfig targets ES2022.
  // oxlint-disable-next-line unicorn/no-array-sort
  return [...cores].sort((left, right) => left - right);
}

/**
 * Hands out disjoint CPU ranges to the work running on one Worker.
 *
 * Every mutation is synchronous, so two Attempts admitted in the same tick
 * cannot observe the same free core: there is no await between reading the
 * free set and claiming from it, which is what makes disjointness a property
 * of the type rather than of its callers' ordering.
 */
export class CoreAllocator {
  readonly totalCores: number;
  readonly #free: Set<number>;
  readonly #held = new Map<string, CoreReservation>();

  constructor(totalCores: number = hostCores()) {
    if (!Number.isSafeInteger(totalCores) || totalCores < 1) {
      throw new Error(`A Worker must have at least one core, not ${totalCores}`);
    }
    this.totalCores = totalCores;
    this.#free = new Set(Array.from({ length: totalCores }, (_, core) => core));
  }

  get freeCores() {
    return this.#free.size;
  }

  has(key: string) {
    return this.#held.has(key);
  }

  reservations(): CoreReservation[] {
    return [...this.#held.values()];
  }

  /**
   * Claims the `vcpus` lowest free cores, or undefined when this Worker cannot
   * cover them. Lowest-first keeps a range contiguous on an unfragmented
   * Worker and never fails for fragmentation when the cores exist at all.
   */
  reserve(key: string, vcpus: number, containerName?: string): CoreReservation | undefined {
    if (!Number.isSafeInteger(vcpus) || vcpus < 1) {
      throw new Error(`${key} asked for ${vcpus} vCPUs, which is not a core count`);
    }
    if (vcpus > this.#free.size) return undefined;
    // False positive: the spread has already produced a fresh array, so sort() mutates
    // nothing. toSorted() is ES2023 and this package's tsconfig targets ES2022.
    // oxlint-disable-next-line unicorn/no-array-sort
    const cores = [...this.#free].sort((left, right) => left - right).slice(0, vcpus);
    return this.#record(key, cores, containerName, false);
  }

  /**
   * Claims exactly these cores, for a container that already owns them. Fails
   * rather than overlapping: a double-booked core is the contention this whole
   * module exists to prevent, so it is reported, never rounded off.
   */
  hold(key: string, cores: readonly number[], containerName?: string): CoreReservation | undefined {
    if (cores.length === 0) return undefined;
    for (const core of cores) {
      if (!this.#free.has(core)) return undefined;
    }
    return this.#record(key, [...cores], containerName, true);
  }

  release(key: string) {
    const reservation = this.#held.get(key);
    if (reservation === undefined) return false;
    for (const core of reservation.cores) this.#free.add(core);
    this.#held.delete(key);
    return true;
  }

  #record(
    key: string,
    cores: number[],
    containerName: string | undefined,
    adopted: boolean,
  ): CoreReservation {
    if (this.#held.has(key)) {
      throw new Error(`${key} already holds a core reservation on this Worker`);
    }
    for (const core of cores) this.#free.delete(core);
    const reservation: CoreReservation = {
      key,
      cores,
      spec: formatCpuset(cores),
      containerName,
      adopted,
    };
    this.#held.set(key, reservation);
    return reservation;
  }
}

/** Thrown when a Worker has no cores left for work it has already claimed. */
export class CoreExhaustedError extends Error {
  constructor(key: string, vcpus: number, freeCores: number, totalCores: number) {
    super(
      `${key} needs ${vcpus} of this Worker's ${totalCores} CPUs but only ${freeCores} are free; ` +
        `refusing rather than running it over-subscribed`,
    );
    this.name = "CoreExhaustedError";
  }
}

export type CoreRequest = {
  key: string;
  /** Undefined for work that does not run on this Worker's own cores. */
  vcpus?: number;
  containerName?: string;
};

/**
 * Runs `body` while holding a reservation and releases it on the way out —
 * return, throw, cancellation, timeout, and the rejection an Agent shutdown
 * turns a killed child into. Every reservation the Agent makes goes through
 * here, so "released on every teardown path" is one function's property rather
 * than five call sites' discipline. Only an Agent that dies without unwinding
 * can leak, and reconcileDockerReservations recovers that at startup.
 */
export async function withCores<T>(
  allocator: CoreAllocator,
  request: CoreRequest,
  body: (reservation: CoreReservation | undefined) => Promise<T>,
): Promise<T> {
  if (request.vcpus === undefined) return body(undefined);
  const reservation = allocator.reserve(request.key, request.vcpus, request.containerName);
  if (reservation === undefined) {
    throw new CoreExhaustedError(
      request.key,
      request.vcpus,
      allocator.freeCores,
      allocator.totalCores,
    );
  }
  try {
    return await body(reservation);
  } finally {
    allocator.release(request.key);
  }
}

export type DockerRunner = (args: readonly string[]) => Promise<{
  exitCode: number;
  stdout: string;
}>;

const runDocker: DockerRunner = async (args) => {
  const result = await execa("docker", [...args], {
    timeout: DOCKER_TIMEOUT_MS,
    reject: false,
  });
  return { exitCode: result.exitCode ?? 1, stdout: result.stdout };
};

export type ReconcileResult = {
  /** Containers whose cores this Agent did not hand out and now accounts for. */
  adopted: string[];
  /** Adopted containers that have since exited, whose cores are free again. */
  released: string[];
  /** Live containers with no cpuset at all, which nothing can account for. */
  unpinned: string[];
};

/**
 * Reconciles the allocator against the containers Docker is actually running.
 *
 * Reservations are in-memory and do not survive the Agent, but the containers
 * do: a SIGKILLed Agent leaves its `docker run` clients dead and their
 * containers alive, holding cores a fresh allocator believes are free. This is
 * the same seam startup recovery already uses for the privileged Firecracker
 * runtime — reconcile against the ground truth before advertising readiness or
 * accepting work — and the ground truth here is HostConfig.CpusetCpus rather
 * than a label, because believing a label over the kernel is the shape of the
 * bug this module fixes.
 *
 * Adopted ranges are re-checked on a timer so the cores come back when the
 * orphan finally exits. Without that, one crash costs the Worker capacity until
 * somebody restarts it, which is the leak worth guarding hardest.
 */
export async function reconcileDockerReservations(
  allocator: CoreAllocator,
  options: { runDocker?: DockerRunner } = {},
): Promise<ReconcileResult> {
  const run = options.runDocker ?? runDocker;
  const listed = await run(["ps", "--filter", `label=${PROFILE_LABEL}`, "--format", "{{.Names}}"]);
  if (listed.exitCode !== 0) {
    // Releasing on an unreadable daemon would free cores that are still in use,
    // so an error changes nothing and the caller retries.
    throw new Error(`docker ps exited ${listed.exitCode} while reconciling core reservations`);
  }
  const names = listed.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");

  const live = new Map<string, number[]>();
  const unpinned: string[] = [];
  if (names.length > 0) {
    // A container can exit between the two commands; `docker inspect` then
    // exits non-zero having still printed every container that did resolve.
    // That is the answer we want, so the exit code is not consulted here.
    const inspected = await run([
      "inspect",
      "--format",
      "{{.Name}}\t{{.HostConfig.CpusetCpus}}",
      ...names,
    ]);
    for (const line of inspected.stdout.split("\n")) {
      const [rawName, rawCpuset] = line.split("\t");
      if (rawName === undefined || rawCpuset === undefined) continue;
      const name = rawName.trim().replace(/^\//, "");
      if (name === "") continue;
      const cores = parseCpuset(rawCpuset);
      if (cores === undefined) unpinned.push(name);
      else live.set(name, cores);
    }
  }

  const released: string[] = [];
  for (const reservation of allocator.reservations()) {
    if (!reservation.adopted) continue;
    const name = reservation.containerName;
    if (name !== undefined && live.has(name)) continue;
    allocator.release(reservation.key);
    if (name !== undefined) released.push(name);
  }

  const accounted = new Set(
    allocator
      .reservations()
      .map((reservation) => reservation.containerName)
      .filter((name) => name !== undefined),
  );
  const adopted: string[] = [];
  for (const [name, cores] of live) {
    if (accounted.has(name)) continue;
    if (allocator.hold(`container:${name}`, cores, name) === undefined) {
      // Only reachable if a container holds a core the Agent has already given
      // to something else, which means the two really are contending. Say so.
      console.error(
        `Container ${name} holds CPUs ${formatCpuset(cores)}, which this Worker has already ` +
          `allocated; its job and another are sharing cores`,
      );
      continue;
    }
    adopted.push(name);
  }
  return { adopted, released, unpinned };
}
