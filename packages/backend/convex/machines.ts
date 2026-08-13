import { v } from "convex/values";
import { isStoredBenchmark, storedBenchmarkValidator } from "./benchmark";
import { selectImageForMachine } from "./catalog";
import { requireDashboardAuth } from "./dashboardAuth";
import { internalMutation, internalQuery, mutation, query } from "./_generated/server";

const REGISTRATION_TOKEN_TTL_MS = 15 * 60 * 1_000;

const osValidator = v.union(v.literal("linux"), v.literal("mac"), v.literal("win"));

const machineListItemValidator = v.object({
  _id: v.id("machines"),
  _creationTime: v.number(),
  name: v.string(),
  os: osValidator,
  labels: v.array(v.string()),
  arch: v.optional(v.string()),
  cpus: v.optional(v.number()),
  memoryMiB: v.optional(v.number()),
  slotPolicy: v.optional(v.union(v.literal("auto"), v.literal("fixed"))),
  configuredSlots: v.optional(v.number()),
  resourceRecommendedSlots: v.optional(v.number()),
  recommendedSlots: v.optional(v.number()),
  benchmark: v.optional(storedBenchmarkValidator),
  maxSlots: v.number(),
  usedSlots: v.number(),
  lastSeen: v.number(),
  currentJobs: v.array(
    v.object({
      _id: v.id("jobs"),
      repo: v.string(),
      workflowName: v.string(),
      status: v.union(v.literal("assigned"), v.literal("running")),
    }),
  ),
  currentAttempts: v.array(
    v.object({
      _id: v.id("attempts"),
      profile: v.string(),
      state: v.union(
        v.literal("pending"),
        v.literal("preparing"),
        v.literal("ready"),
        v.literal("running"),
      ),
    }),
  ),
  currentExperiments: v.array(
    v.object({
      _id: v.id("experiments"),
      name: v.string(),
      state: v.union(v.literal("queued"), v.literal("preparing"), v.literal("running")),
    }),
  ),
  readiness: v.array(
    v.object({
      profile: v.string(),
      executor: v.union(
        v.literal("docker"),
        v.literal("firecracker"),
        v.literal("tart"),
        v.literal("hyperv"),
      ),
      imageRelease: v.string(),
      state: v.union(
        v.literal("preparing"),
        v.literal("ready"),
        v.literal("degraded"),
        v.literal("failed"),
      ),
      checkedAt: v.number(),
      preparedAt: v.optional(v.number()),
      statusDetail: v.optional(v.string()),
      lastError: v.optional(v.string()),
    }),
  ),
});

function randomHex(length: number) {
  const bytes = crypto.getRandomValues(new Uint8Array(Math.ceil(length / 2)));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, length);
}

function sanitizeMachineName(hostname: string) {
  const sanitized = hostname
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return sanitized.length > 0 ? sanitized : "runner";
}

export const list = query({
  args: {},
  returns: v.array(machineListItemValidator),
  handler: async (ctx) => {
    await requireDashboardAuth(ctx);
    const [
      machines,
      assignedJobs,
      runningJobs,
      attempts,
      experiments,
      readiness,
      readinessEvidence,
      benchmarkEvidence,
    ] = await Promise.all([
      ctx.db.query("machines").collect(),
      ctx.db
        .query("jobs")
        .withIndex("by_status", (q) => q.eq("status", "assigned"))
        .collect(),
      ctx.db
        .query("jobs")
        .withIndex("by_status", (q) => q.eq("status", "running"))
        .collect(),
      ctx.db.query("attempts").collect(),
      ctx.db.query("experiments").collect(),
      ctx.db.query("workerReadiness").collect(),
      ctx.db.query("readinessEvidence").collect(),
      ctx.db.query("benchmarkEvidence").collect(),
    ]);

    const activeJobs = [...assignedJobs, ...runningJobs];
    const readinessEvidenceByKey = new Map(
      readinessEvidence.map((evidence) => [`${evidence.machineId}:${evidence.profile}`, evidence]),
    );
    const benchmarkEvidenceByMachine = new Map(
      benchmarkEvidence.map((evidence) => [evidence.machineId, evidence.benchmark]),
    );
    return machines
      .toSorted((a, b) => a.name.localeCompare(b.name))
      .map(({ token: _token, ...machine }) => ({
        ...machine,
        benchmark:
          benchmarkEvidenceByMachine.get(machine._id) ??
          (isStoredBenchmark(machine.benchmark) ? machine.benchmark : undefined),
        currentJobs: activeJobs
          .filter((job) => job.machineId === machine._id)
          .map((job) => ({
            _id: job._id,
            repo: job.repo,
            workflowName: job.workflowName,
            status: job.status as "assigned" | "running",
          })),
        currentAttempts: attempts
          .filter(
            (attempt) =>
              attempt.machineId === machine._id &&
              (attempt.state === "pending" ||
                attempt.state === "preparing" ||
                attempt.state === "ready" ||
                attempt.state === "running"),
          )
          .map((attempt) => ({
            _id: attempt._id,
            profile: attempt.profile,
            state: attempt.state as "pending" | "preparing" | "ready" | "running",
          })),
        currentExperiments: experiments
          .filter(
            (experiment) =>
              experiment.machineId === machine._id &&
              (experiment.state === "queued" ||
                experiment.state === "preparing" ||
                experiment.state === "running"),
          )
          .map((experiment) => ({
            _id: experiment._id,
            name: experiment.name,
            state: experiment.state as "queued" | "preparing" | "running",
          })),
        readiness: readiness
          .filter((entry) => entry.machineId === machine._id)
          .toSorted((left, right) => left.profile.localeCompare(right.profile))
          .map((entry) => {
            const evidence = readinessEvidenceByKey.get(`${entry.machineId}:${entry.profile}`);
            const currentEvidence = evidence?.checkedAt === entry.checkedAt ? evidence : undefined;
            return {
              profile: entry.profile,
              executor: entry.executor,
              imageRelease: entry.imageRelease,
              state: entry.state,
              checkedAt: entry.checkedAt,
              preparedAt: entry.preparedAt,
              // Legacy hot rows are the one-cycle fallback until their next
              // readiness report creates a matching evidence document.
              statusDetail: currentEvidence?.statusDetail ?? entry.statusDetail,
              lastError: currentEvidence?.lastError ?? entry.lastError,
            };
          }),
      }));
  },
});

export const createRegistrationToken = mutation({
  args: {},
  returns: v.object({
    token: v.string(),
    expiresAt: v.number(),
  }),
  handler: async (ctx) => {
    await requireDashboardAuth(ctx);

    let token = "";
    do {
      token = `rcreg_${randomHex(24)}`;
    } while (
      (await ctx.db
        .query("registrationTokens")
        .withIndex("by_token", (q) => q.eq("token", token))
        .unique()) !== null
    );

    const createdAt = Date.now();
    await ctx.db.insert("registrationTokens", { token, createdAt });
    return { token, expiresAt: createdAt + REGISTRATION_TOKEN_TTL_MS };
  },
});

export const registerAgent = internalMutation({
  args: {
    registrationToken: v.string(),
    name: v.string(),
    os: osValidator,
    arch: v.string(),
    cpus: v.number(),
    memoryMiB: v.optional(v.number()),
    labels: v.optional(v.array(v.string())),
    maxSlots: v.optional(v.number()),
  },
  returns: v.union(
    v.object({
      ok: v.literal(true),
      machineToken: v.string(),
    }),
    v.object({
      ok: v.literal(false),
      status: v.number(),
      error: v.string(),
    }),
  ),
  handler: async (ctx, args) => {
    const registration = await ctx.db
      .query("registrationTokens")
      .withIndex("by_token", (q) => q.eq("token", args.registrationToken))
      .unique();
    if (registration === null) {
      return { ok: false as const, status: 401, error: "Invalid registration token" };
    }
    if (registration.usedAt !== undefined) {
      return {
        ok: false as const,
        status: 409,
        error: "Registration token has already been used",
      };
    }

    const now = Date.now();
    if (now - registration.createdAt >= REGISTRATION_TOKEN_TTL_MS) {
      return { ok: false as const, status: 410, error: "Registration token has expired" };
    }

    const existingNames = new Set(
      (await ctx.db.query("machines").collect()).map((machine) => machine.name),
    );
    const baseName = sanitizeMachineName(args.name);
    let name = baseName;
    let suffix = 2;
    while (existingNames.has(name)) {
      name = `${baseName}-${suffix}`;
      suffix += 1;
    }

    const cpuSlots = Math.max(1, Math.floor(args.cpus / 4));
    const memorySlots =
      args.memoryMiB === undefined ? cpuSlots : Math.max(1, Math.floor(args.memoryMiB / 8_192));
    const defaultSlots =
      args.os === "linux"
        ? Math.min(16, cpuSlots, memorySlots)
        : args.os === "mac"
          ? Math.min(2, cpuSlots, memorySlots)
          : 1;
    const maxSlots = args.maxSlots ?? defaultSlots;
    const labels = [...new Set((args.labels ?? []).map((label) => label.trim()).filter(Boolean))];

    let machineToken = "";
    do {
      machineToken = randomHex(32);
    } while (
      (await ctx.db
        .query("machines")
        .withIndex("by_token", (q) => q.eq("token", machineToken))
        .unique()) !== null
    );

    await ctx.db.patch(registration._id, { usedAt: now });
    await ctx.db.insert("machines", {
      name,
      os: args.os,
      labels,
      arch: args.arch,
      cpus: args.cpus,
      memoryMiB: args.memoryMiB,
      slotPolicy: args.maxSlots === undefined ? "auto" : "fixed",
      configuredSlots: args.maxSlots,
      resourceRecommendedSlots: defaultSlots,
      recommendedSlots: defaultSlots,
      maxSlots,
      usedSlots: 0,
      lastSeen: 0,
      token: machineToken,
    });
    return { ok: true as const, machineToken };
  },
});

// Availability probe for the runs-on fallback endpoint: will a slot actually
// be free for this job? Counts free slots on matching online machines minus
// the queued jobs already competing for them, so callers are not routed onto
// a backlog they would wait behind.
export const hasCapacity = internalQuery({
  args: { labels: v.array(v.string()) },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const now = Date.now();
    const [machines, queuedJobs] = await Promise.all([
      ctx.db.query("machines").collect(),
      ctx.db
        .query("jobs")
        .withIndex("by_status", (q) => q.eq("status", "queued"))
        .collect(),
    ]);

    const eligibleMachines = machines.filter(
      (machine) =>
        now - machine.lastSeen < 120_000 &&
        selectImageForMachine(args.labels, machine) !== undefined,
    );
    const freeSlots = eligibleMachines.reduce(
      (total, machine) => total + Math.max(0, machine.maxSlots - machine.usedSlots),
      0,
    );
    const backlog = queuedJobs.filter((job) =>
      eligibleMachines.some((machine) => selectImageForMachine(job.labels, machine) !== undefined),
    ).length;
    return freeSlots > backlog;
  },
});
