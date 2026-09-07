import { v } from "convex/values";
import { requireDashboardAuth } from "./dashboardAuth";
import {
  boundaryValidator,
  EXECUTOR_BOUNDARY,
  isTrustedOnly,
  readinessAdmissionError,
  readinessCheckValidator,
} from "./isolation";
import { query } from "./_generated/server";
import { fitPolicyValidator } from "./benchmark";
import { WORKER_OFFLINE_AFTER_MS } from "./workerPolicy";

const executorValidator = v.union(
  v.literal("docker"),
  v.literal("firecracker"),
  v.literal("tart"),
  v.literal("hyperv"),
);

export const list = query({
  args: {},
  returns: v.array(
    v.object({
      _id: v.id("profiles"),
      name: v.string(),
      scaleSetName: v.string(),
      executor: executorValidator,
      imageRelease: v.string(),
      vcpus: v.number(),
      memoryMiB: v.number(),
      warmPool: v.number(),
      fitPolicy: fitPolicyValidator,
      minRunners: v.number(),
      maxRunners: v.number(),
      state: v.union(v.literal("active"), v.literal("paused")),
      updatedAt: v.number(),
      readyWorkers: v.number(),
      readySlots: v.number(),
      freeSlots: v.number(),
      // What this Profile's executor can actually promise, and what its Workers
      // proved. A workflow author choosing `runs-on` needs to see the real
      // boundary, not infer it from the Profile name.
      boundary: boundaryValidator,
      trustedOnly: v.boolean(),
      workers: v.array(
        v.object({
          machineId: v.id("machines"),
          machineName: v.string(),
          state: v.union(
            v.literal("preparing"),
            v.literal("ready"),
            v.literal("degraded"),
            v.literal("failed"),
          ),
          checkedAt: v.number(),
          preparedAt: v.optional(v.number()),
          statusDetail: v.optional(v.string()),
          online: v.boolean(),
          maxSlots: v.number(),
          usedSlots: v.number(),
          isolation: v.optional(v.string()),
          boundary: v.optional(boundaryValidator),
          cacheScope: v.optional(v.string()),
          cacheSharedWritable: v.optional(v.boolean()),
          checks: v.optional(v.array(readinessCheckValidator)),
          hardware: v.optional(
            v.object({
              arch: v.optional(v.string()),
              cpus: v.optional(v.number()),
              memoryMiB: v.optional(v.number()),
              cpuModel: v.optional(v.string()),
              virtualization: v.optional(v.string()),
              kvm: v.optional(v.boolean()),
            }),
          ),
          storage: v.optional(
            v.object({
              snapshotter: v.optional(v.string()),
              poolName: v.optional(v.string()),
              poolTotalMiB: v.optional(v.number()),
              poolFreeMiB: v.optional(v.number()),
            }),
          ),
          network: v.optional(
            v.object({
              policyName: v.optional(v.string()),
              policyHash: v.optional(v.string()),
              subnet: v.optional(v.string()),
              egressMode: v.optional(v.string()),
            }),
          ),
          lastError: v.optional(v.string()),
        }),
      ),
    }),
  ),
  handler: async (ctx) => {
    await requireDashboardAuth(ctx);
    const now = Date.now();
    const [profiles, readiness, evidenceRows, machines] = await Promise.all([
      ctx.db.query("profiles").collect(),
      ctx.db.query("workerReadiness").collect(),
      ctx.db.query("readinessEvidence").collect(),
      ctx.db.query("machines").collect(),
    ]);
    const machineById = new Map(machines.map((machine) => [machine._id, machine]));
    const evidenceByKey = new Map(
      evidenceRows.map((evidence) => [`${evidence.machineId}:${evidence.profile}`, evidence]),
    );
    return profiles
      .toSorted((left, right) => left.name.localeCompare(right.name))
      .map((profile) => {
        const rows = readiness.filter(
          (row) =>
            row.profile === profile.name &&
            row.executor === profile.executor &&
            row.imageRelease === profile.imageRelease,
        );
        const workers = rows
          .filter(
            (row) =>
              row.state === "ready" &&
              profile.state === "active" &&
              now - row.checkedAt < 12 * 60 * 60_000 &&
              readinessAdmissionError(row, evidenceByKey.get(`${row.machineId}:${row.profile}`)) ===
                undefined,
          )
          .map((row) => machineById.get(row.machineId))
          .filter(
            (machine): machine is NonNullable<typeof machine> =>
              machine !== undefined && now - machine.lastSeen < WORKER_OFFLINE_AFTER_MS,
          );
        const workerDetail = rows.flatMap((row) => {
          const machine = machineById.get(row.machineId);
          if (machine === undefined) return [];
          const evidence = evidenceByKey.get(`${row.machineId}:${row.profile}`);
          // Evidence must describe this exact hot report. Until the next Agent
          // refresh creates it, fall back to the legacy inline fields.
          const currentEvidence = evidence?.checkedAt === row.checkedAt ? evidence : undefined;
          const admissionError = readinessAdmissionError(row, evidence);
          return [
            {
              machineId: row.machineId,
              machineName: machine.name,
              state:
                row.state === "ready" && admissionError !== undefined
                  ? row.preparedAt === undefined
                    ? ("failed" as const)
                    : ("degraded" as const)
                  : row.state,
              checkedAt: row.checkedAt,
              preparedAt: row.preparedAt,
              statusDetail: currentEvidence?.statusDetail ?? row.statusDetail,
              online: now - machine.lastSeen < WORKER_OFFLINE_AFTER_MS,
              maxSlots: machine.maxSlots,
              usedSlots: machine.usedSlots,
              isolation: currentEvidence?.isolation ?? row.isolation,
              boundary: currentEvidence?.boundary ?? row.boundary,
              cacheScope: currentEvidence?.cacheScope ?? row.cacheScope,
              cacheSharedWritable: currentEvidence?.cacheSharedWritable ?? row.cacheSharedWritable,
              checks: currentEvidence?.checks ?? row.checks,
              hardware: currentEvidence?.hardware ?? row.hardware,
              storage: currentEvidence?.storage ?? row.storage,
              network: currentEvidence?.network ?? row.network,
              lastError: currentEvidence?.lastError ?? row.lastError ?? admissionError,
            },
          ];
        });
        return {
          boundary: EXECUTOR_BOUNDARY[profile.executor],
          trustedOnly: isTrustedOnly(profile.executor),
          workers: workerDetail.toSorted((left, right) =>
            left.machineName.localeCompare(right.machineName),
          ),
          _id: profile._id,
          name: profile.name,
          scaleSetName: profile.scaleSetName,
          executor: profile.executor,
          imageRelease: profile.imageRelease,
          vcpus: profile.vcpus,
          memoryMiB: profile.memoryMiB,
          warmPool: profile.warmPool ?? 0,
          fitPolicy: profile.fitPolicy ?? "balanced",
          minRunners: profile.minRunners,
          maxRunners: profile.maxRunners,
          state: profile.state,
          updatedAt: profile.updatedAt,
          readyWorkers: workers.length,
          readySlots: workers.reduce((total, machine) => total + machine.maxSlots, 0),
          freeSlots: workers.reduce(
            (total, machine) => total + Math.max(0, machine.maxSlots - machine.usedSlots),
            0,
          ),
        };
      });
  },
});

// How far back the activity query looks, and how many Attempts it reads per
// Profile to get there. The window is read newest-first through the
// by_profile index, so a Profile's whole history never enters the read set;
// a Profile that ran more than this many Attempts in seven days reports the
// sample size instead of a count.
export const ACTIVITY_WINDOW_MS = 7 * 24 * 60 * 60_000;
export const ACTIVITY_SAMPLE = 100;

/**
 * What each Profile has actually served: the last job GitHub started on it,
 * and how many in the last seven days. This is the signal that was missing
 * when a consumer moved to `ubuntu-latest` during a rollout and nobody set it
 * back for two weeks (#138). Only Attempts a job started on count; an Attempt
 * without a repository was capacity that GitHub never used.
 */
export const activity = query({
  args: {},
  returns: v.array(
    v.object({
      name: v.string(),
      lastJob: v.optional(
        v.object({
          repo: v.string(),
          at: v.number(),
          displayName: v.optional(v.string()),
        }),
      ),
      // Jobs started in the window, or the sample size when every sampled
      // Attempt fell inside it.
      jobsInWindow: v.number(),
      sampleExhausted: v.boolean(),
    }),
  ),
  handler: async (ctx) => {
    await requireDashboardAuth(ctx);
    const since = Date.now() - ACTIVITY_WINDOW_MS;
    const profiles = await ctx.db.query("profiles").collect();
    return Promise.all(
      profiles
        .toSorted((left, right) => left.name.localeCompare(right.name))
        .map(async (profile) => {
          const recent = await ctx.db
            .query("attempts")
            .withIndex("by_profile", (q) => q.eq("profile", profile.name))
            .order("desc")
            .take(ACTIVITY_SAMPLE);
          const jobs = recent.filter((attempt) => attempt.repo !== undefined);
          const last = jobs[0];
          const oldestSampled = recent.at(-1);
          return {
            name: profile.name,
            lastJob:
              last === undefined || last.repo === undefined
                ? undefined
                : { repo: last.repo, at: last.createdAt, displayName: last.displayName },
            jobsInWindow: jobs.filter((attempt) => attempt.createdAt >= since).length,
            sampleExhausted:
              recent.length === ACTIVITY_SAMPLE &&
              oldestSampled !== undefined &&
              oldestSampled.createdAt >= since,
          };
        }),
    );
  },
});
