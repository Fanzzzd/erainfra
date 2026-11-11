// The controller lease (ADR 0014): which controller may serve a Profile, and the fencing that
// keeps any other one from acting on it.
//
// Every number the lease runs on is here. The controller does not carry its own copies: the
// acquire and renew answers tell it how often to renew and how long a grant lasts, so changing a
// constant here changes every controller at its next acquire.

import { ConvexError, v, type Infer } from "convex/values";

import type { Doc, Id } from "./_generated/dataModel";
import {
  internalMutation,
  internalQuery,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { benchmarkScore } from "./benchmark";
import { profileEgressValidator } from "./egress";
import { WORKER_OFFLINE_AFTER_MS } from "./workerPolicy";

/** How often the holder renews. Three renewals fit in one expiry, so one lost request is harmless. */
export const LEASE_RENEW_INTERVAL_MS = 10_000;
/** How long a grant or renewal lasts without another renewal. */
export const LEASE_TTL_MS = 30_000;
/**
 * A Worker whose fresh benchmark rates its network to GitHub below this score is a poor candidate.
 * Scores run from 0 to 100 and an unmeasured or stale benchmark counts as 50 (benchmark.ts), so
 * only a measured, recent, clearly bad uplink is penalised. ubuntu0's SYN stalls (#149) are the
 * case this exists for.
 */
export const POOR_NETWORK_SCORE_BELOW = 40;
/**
 * How long a free lease is reserved for better-connected candidates before a poor one may take it.
 * A standby asks again when the lease it saw expires, so one and a half renew intervals is enough
 * for every healthy standby to have asked first. A lone poor Worker still gets the lease, this much
 * later.
 */
export const POOR_NETWORK_HEAD_START_MS = 15_000;
/** The soonest a refused candidate is told to ask again, so a refusal cannot become a busy loop. */
export const LEASE_MIN_RETRY_MS = 1_000;

/** The response status a refused stale epoch gets on every controller route. */
export const LEASE_LOST_STATUS = 412;

export const controllerCallerValidator = v.union(
  v.object({
    kind: v.literal("controllerToken"),
    slot: v.union(v.literal("current"), v.literal("next")),
    epoch: v.optional(v.number()),
  }),
  v.object({
    kind: v.literal("machine"),
    token: v.string(),
    epoch: v.optional(v.number()),
  }),
);

/**
 * Who is calling a controller route: a controller with the shared CONTROLLER_TOKEN (or its _NEXT
 * rotation partner), or one on a Worker with that Worker's machine token. `epoch` is the lease
 * epoch the request carries, absent when it carries none.
 */
export type ControllerCaller = Infer<typeof controllerCallerValidator>;

/**
 * Why a controller request was refused. The HTTP layer maps each to a status:
 * `lease` → 412 (the controller stops serving), `unauthorized` → 401, `forbidden` → 403.
 */
export type ControllerRefusal = "lease" | "unauthorized" | "forbidden";

export function refuse(code: ControllerRefusal, message: string): never {
  throw new ConvexError({ code, message });
}

/** The refusal code of an error a lease check threw, or undefined for any other error. */
export function refusalOf(error: unknown): ControllerRefusal | undefined {
  if (!(error instanceof ConvexError)) return undefined;
  const data = error.data as unknown;
  if (typeof data !== "object" || data === null) return undefined;
  const code = (data as { code?: unknown }).code;
  return code === "lease" || code === "unauthorized" || code === "forbidden" ? code : undefined;
}

type Ctx = QueryCtx | MutationCtx;

async function leaseFor(ctx: Ctx, profile: string) {
  return await ctx.db
    .query("controllerLeases")
    .withIndex("by_profile", (q) => q.eq("profile", profile))
    .unique();
}

async function machineFor(ctx: Ctx, token: string) {
  if (token.length === 0) return null;
  return await ctx.db
    .query("machines")
    .withIndex("by_token", (q) => q.eq("token", token))
    .unique();
}

async function profileFor(ctx: Ctx, name: string) {
  return await ctx.db
    .query("profiles")
    .withIndex("by_name", (q) => q.eq("name", name))
    .unique();
}

async function readinessFor(ctx: Ctx, machineId: Id<"machines">, profile: string) {
  return await ctx.db
    .query("workerReadiness")
    .withIndex("by_machine_profile", (q) => q.eq("machineId", machineId).eq("profile", profile))
    .unique();
}

function holderMatches(
  holder: NonNullable<Doc<"controllerLeases">["holder"]>,
  caller: { credential: "controllerToken" } | { credential: "machine"; machineId: Id<"machines"> },
) {
  if (holder.credential !== caller.credential) return false;
  return caller.credential === "controllerToken" || holder.machineId === caller.machineId;
}

/**
 * The single check every controller route makes before it reads or writes a Profile's state.
 *
 * - A machine token must name a registered Worker, and that Worker must hold the Profile's
 *   unexpired lease under exactly the epoch the request carries. A Worker's credential is a
 *   controller credential only while it holds the lease.
 * - A controller-token request that carries an epoch must carry the current one, and the lease
 *   must be held by a controller-token holder and unexpired. A dedicated controller host is
 *   fenced exactly like a Worker.
 * - A controller-token request with no epoch is refused too. Upgrade the dedicated controller
 *   hosts before enabling Worker standbys; there is no unfenced compatibility path.
 *
 * It runs inside the same mutation as the write it guards, so the check and the write commit
 * together: a holder that loses the lease between the two cannot slip a write in.
 */
export async function authorizeController(ctx: Ctx, profile: string, caller: ControllerCaller) {
  const now = Date.now();
  if (caller.kind === "machine") {
    const machine = await machineFor(ctx, caller.token);
    if (machine === null) refuse("unauthorized", "Unknown machine token");
    const lease = await leaseFor(ctx, profile);
    if (
      caller.epoch === undefined ||
      lease === null ||
      lease.holder === undefined ||
      !holderMatches(lease.holder, { credential: "machine", machineId: machine._id }) ||
      lease.epoch !== caller.epoch ||
      lease.expiresAt <= now
    ) {
      refuse("lease", "This Worker does not hold the Profile's controller lease");
    }
    return { credential: "machine" as const, machineId: machine._id };
  }
  if (caller.epoch === undefined) {
    refuse("lease", "Controllers must hold the Profile's lease and send its epoch");
  }
  const lease = await leaseFor(ctx, profile);
  if (
    lease === null ||
    lease.holder === undefined ||
    lease.holder.credential !== "controllerToken" ||
    lease.epoch !== caller.epoch ||
    lease.expiresAt <= now
  ) {
    refuse("lease", "The lease epoch is stale: another controller holds this Profile");
  }
  return { credential: "controllerToken" as const };
}

/** A machine-token caller resolved for a route that never accepts one (registering a Profile). */
export function requireControllerToken(caller: ControllerCaller) {
  if (caller.kind === "machine") {
    refuse("forbidden", "A Worker's controller cannot change a Profile; use the controller token");
  }
}

/** Whether the Worker's fresh benchmark rates its network to GitHub as poor. */
export function networkIsPoor(machine: Pick<Doc<"machines">, "benchmark">, now: number) {
  const network = benchmarkScore(machine.benchmark, "network", now);
  return network.source === "fresh" && network.score < POOR_NETWORK_SCORE_BELOW;
}

const profileSettingsValidator = v.object({
  name: v.string(),
  scaleSetName: v.string(),
  executor: v.union(
    v.literal("docker"),
    v.literal("firecracker"),
    v.literal("tart"),
    v.literal("hyperv"),
  ),
  imageRelease: v.string(),
  vcpus: v.number(),
  memoryMiB: v.number(),
  warmPool: v.number(),
  fitPolicy: v.string(),
  minRunners: v.number(),
  maxRunners: v.number(),
  githubConfigUrl: v.string(),
  githubCacheFacts: v.optional(v.boolean()),
  egress: v.optional(profileEgressValidator),
  runnerGroup: v.optional(v.string()),
  labels: v.optional(v.array(v.string())),
  workerLabels: v.optional(v.array(v.string())),
});

function profileSettings(profile: Doc<"profiles">) {
  if (profile.githubConfigUrl === undefined) return undefined;
  return {
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
    githubConfigUrl: profile.githubConfigUrl,
    ...(profile.githubCacheFacts === undefined
      ? {}
      : { githubCacheFacts: profile.githubCacheFacts }),
    ...(profile.egress === undefined ? {} : { egress: profile.egress }),
    ...(profile.runnerGroup === undefined ? {} : { runnerGroup: profile.runnerGroup }),
    ...(profile.labels === undefined ? {} : { labels: profile.labels }),
    ...(profile.workerLabels === undefined ? {} : { workerLabels: profile.workerLabels }),
  };
}

const acquireResultValidator = v.union(
  v.object({
    granted: v.literal(true),
    epoch: v.number(),
    ttlMs: v.number(),
    renewIntervalMs: v.number(),
    networkPoor: v.boolean(),
    profile: v.optional(profileSettingsValidator),
  }),
  v.object({
    granted: v.literal(false),
    reason: v.union(
      v.literal("held"),
      v.literal("headStart"),
      v.literal("profileUnknown"),
      v.literal("profilePaused"),
      v.literal("profileIncomplete"),
      v.literal("notReady"),
      v.literal("incapable"),
    ),
    holder: v.optional(v.string()),
    retryAfterMs: v.number(),
    networkPoor: v.boolean(),
  }),
);

export type AcquireResult = Infer<typeof acquireResultValidator>;

/**
 * Asks for a Profile's lease. Granted when the lease is free or expired, or already held by this
 * same process (which then keeps its epoch). A change of holder increases the epoch.
 *
 * A Worker may ask only for a Profile that is active, fully described (a standby has no settings
 * of its own) and that it is ready to serve. A Worker with a poor network waits out a head start
 * after the lease frees, so a better-connected Worker wins when there is one. A controller-token
 * caller is a permanent candidate: it needs none of that, because it publishes the Profile itself.
 *
 * A refusal says when to ask again: when the current grant runs out, plus the head start for a
 * poor candidate.
 */
export const acquire = internalMutation({
  args: {
    profile: v.string(),
    hostname: v.string(),
    instance: v.string(),
    activate: v.optional(v.boolean()),
    canPublishCacheFacts: v.optional(v.boolean()),
    caller: controllerCallerValidator,
  },
  returns: acquireResultValidator,
  handler: async (ctx, args): Promise<AcquireResult> => {
    const now = Date.now();
    const profile = await profileFor(ctx, args.profile);
    let identity:
      | { credential: "controllerToken" }
      | { credential: "machine"; machineId: Id<"machines"> } = { credential: "controllerToken" };
    let networkPoor = false;
    const refusal = (reason: Exclude<AcquireResult, { granted: true }>["reason"]) => ({
      granted: false as const,
      reason,
      retryAfterMs: LEASE_TTL_MS,
      networkPoor,
    });

    if (args.caller.kind === "machine") {
      const machine = await machineFor(ctx, args.caller.token);
      if (machine === null) refuse("unauthorized", "Unknown machine token");
      identity = { credential: "machine", machineId: machine._id };
      networkPoor = networkIsPoor(machine, now);
      if (profile === null) return refusal("profileUnknown");
      if (profile.state !== "active") return refusal("profilePaused");
      if (profile.githubConfigUrl === undefined) return refusal("profileIncomplete");
      const readiness = await readinessFor(ctx, machine._id, args.profile);
      if (
        readiness === null ||
        readiness.state !== "ready" ||
        now - machine.lastSeen >= WORKER_OFFLINE_AFTER_MS ||
        readiness.executor !== profile.executor ||
        readiness.imageRelease !== profile.imageRelease ||
        readiness.vcpus !== profile.vcpus ||
        readiness.memoryMiB !== profile.memoryMiB
      )
        return refusal("notReady");
      // A Profile that publishes cache facts needs a holder that can. Leasing it to one that cannot
      // would leave its runners with no facts, so every cache request would be refused with 401.
      if (profile.githubCacheFacts === true && args.canPublishCacheFacts !== true)
        return refusal("incapable");
    } else if (profile?.state === "paused" && !args.activate) {
      return refusal("profilePaused");
    }

    const lease = await leaseFor(ctx, args.profile);
    const holder = lease?.holder;
    const ownLease =
      lease !== null &&
      holder !== undefined &&
      holder.instance === args.instance &&
      holderMatches(holder, identity) &&
      lease.expiresAt > now;
    if (!ownLease && lease !== null && holder !== undefined && lease.expiresAt > now) {
      return {
        granted: false,
        reason: "held",
        holder: holder.hostname,
        retryAfterMs: Math.max(
          LEASE_MIN_RETRY_MS,
          lease.expiresAt - now + (networkPoor ? POOR_NETWORK_HEAD_START_MS : 0),
        ),
        networkPoor,
      };
    }
    if (!ownLease && networkPoor) {
      // The head start counts from when the lease became free. A lease nobody has held yet starts
      // its clock now, with a row that has no holder.
      const freeSince = lease === null ? now : Math.min(lease.expiresAt, now);
      if (lease === null) {
        await ctx.db.insert("controllerLeases", {
          profile: args.profile,
          epoch: 0,
          expiresAt: now,
        });
      }
      if (now - freeSince < POOR_NETWORK_HEAD_START_MS) {
        return {
          granted: false,
          reason: "headStart",
          retryAfterMs: Math.max(LEASE_MIN_RETRY_MS, freeSince + POOR_NETWORK_HEAD_START_MS - now),
          networkPoor,
        };
      }
    }

    const current = lease ?? (await leaseFor(ctx, args.profile));
    const epoch = ownLease && current !== null ? current.epoch : (current?.epoch ?? 0) + 1;
    const grant = {
      epoch,
      holder: {
        credential: identity.credential,
        ...(identity.credential === "machine" ? { machineId: identity.machineId } : {}),
        hostname: args.hostname,
        instance: args.instance,
      },
      acquiredAt: ownLease && current?.acquiredAt !== undefined ? current.acquiredAt : now,
      renewedAt: now,
      expiresAt: now + LEASE_TTL_MS,
    };
    if (current === null) {
      await ctx.db.insert("controllerLeases", { profile: args.profile, ...grant });
    } else {
      await ctx.db.patch(current._id, grant);
    }
    const settings = profile === null ? undefined : profileSettings(profile);
    return {
      granted: true,
      epoch,
      ttlMs: LEASE_TTL_MS,
      renewIntervalMs: LEASE_RENEW_INTERVAL_MS,
      networkPoor,
      ...(settings === undefined ? {} : { profile: settings }),
    };
  },
});

/**
 * Extends the holder's grant. Refused (with the `lease` refusal) unless the same process holds the
 * unexpired lease under the epoch it names. Once the grant runs out, even the old holder must
 * acquire again under a new epoch.
 */
export const renew = internalMutation({
  args: {
    profile: v.string(),
    instance: v.string(),
    caller: controllerCallerValidator,
  },
  returns: v.object({ epoch: v.number(), ttlMs: v.number(), renewIntervalMs: v.number() }),
  handler: async (ctx, args) => {
    const now = Date.now();
    let identity:
      | { credential: "controllerToken" }
      | { credential: "machine"; machineId: Id<"machines"> } = { credential: "controllerToken" };
    if (args.caller.kind === "machine") {
      const machine = await machineFor(ctx, args.caller.token);
      if (machine === null) refuse("unauthorized", "Unknown machine token");
      identity = { credential: "machine", machineId: machine._id };
    }
    const lease = await leaseFor(ctx, args.profile);
    if (
      lease === null ||
      lease.holder === undefined ||
      lease.holder.instance !== args.instance ||
      lease.expiresAt <= now ||
      !holderMatches(lease.holder, identity) ||
      lease.epoch !== args.caller.epoch
    ) {
      refuse("lease", "The lease is held by another controller");
    }
    await ctx.db.patch(lease._id, { renewedAt: now, expiresAt: now + LEASE_TTL_MS });
    return { epoch: lease.epoch, ttlMs: LEASE_TTL_MS, renewIntervalMs: LEASE_RENEW_INTERVAL_MS };
  },
});

/**
 * Gives the lease up at once, so a standby need not wait for it to expire. Releasing a lease this
 * process no longer holds does nothing.
 */
export const release = internalMutation({
  args: {
    profile: v.string(),
    instance: v.string(),
    caller: controllerCallerValidator,
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const now = Date.now();
    const lease = await leaseFor(ctx, args.profile);
    if (
      lease === null ||
      lease.holder === undefined ||
      lease.holder.instance !== args.instance ||
      lease.epoch !== args.caller.epoch
    ) {
      return null;
    }
    const identity =
      args.caller.kind === "machine"
        ? await machineFor(ctx, args.caller.token).then((machine) =>
            machine === null ? null : { credential: "machine" as const, machineId: machine._id },
          )
        : { credential: "controllerToken" as const };
    if (identity === null || !holderMatches(lease.holder, identity)) return null;
    await ctx.db.patch(lease._id, {
      epoch: lease.epoch + 1,
      holder: undefined,
      acquiredAt: undefined,
      renewedAt: undefined,
      expiresAt: Math.min(lease.expiresAt, now),
    });
    return null;
  },
});

/**
 * The Profile's GitHub registration URL, for minting the holder an installation token. Only the
 * current holder gets it: the same check as a write, run here so the HTTP action never mints for a
 * caller that does not hold the lease.
 */
export const githubTokenTarget = internalQuery({
  args: { profile: v.string(), caller: controllerCallerValidator },
  returns: v.union(v.null(), v.object({ githubConfigUrl: v.string(), cacheFacts: v.boolean() })),
  handler: async (ctx, args) => {
    // Minting needs the lease even from the controller token: the token is a GitHub credential
    // and only the controller serving the Profile needs one.
    await authorizeController(ctx, args.profile, args.caller);
    const profile = await profileFor(ctx, args.profile);
    if (profile === null || profile.githubConfigUrl === undefined) return null;
    return {
      githubConfigUrl: profile.githubConfigUrl,
      cacheFacts: profile.githubCacheFacts === true,
    };
  },
});

/**
 * Whether a standby may report a heartbeat for this Profile: any controller-token caller, or a
 * Worker that serves the Profile. A standby's report writes only its own row and claims nothing,
 * so it needs no lease; a holder's report is checked like any other write.
 */
export async function authorizeStandbyReport(
  ctx: MutationCtx,
  profile: string,
  caller: ControllerCaller,
) {
  if (caller.kind === "controllerToken") return;
  const machine = await machineFor(ctx, caller.token);
  if (machine === null) refuse("unauthorized", "Unknown machine token");
  const readiness = await readinessFor(ctx, machine._id, profile);
  if (readiness === null) refuse("forbidden", "This Worker does not serve the Profile");
}
