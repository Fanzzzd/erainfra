import type { HttpRouter } from "convex/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { httpAction, type ActionCtx } from "./_generated/server";
import {
  type ApiTokenScope,
  bearerToken,
  hashApiToken,
  isWellFormedApiToken,
  scopeAllows,
  shouldTouchLastUsed,
} from "./apiTokenPolicy";
import { queueWaitMs, workflowRunUrl } from "./attempts";
import { resolveSiteUrl } from "./githubAppConfig";
import type { listMachines } from "./machines";
import type { OperatorAttempt } from "./operatorApi";
import type { listProfiles } from "./profiles";
import type { RightsizeReport } from "./rightsize";
import {
  CPU_SATURATED,
  CPU_TARGET_UTILISATION,
  MAX_ERROR_RATIO,
  MAX_WINDOW_MS,
  MEMORY_HEADROOM,
  MEMORY_PRESSURE,
  MIN_ATTEMPTS,
  MIN_MEASURED_MS,
  runsOnMap,
} from "./rightsizeModel";
import { WORKER_OFFLINE_AFTER_MS } from "./workerPolicy";

// The operator API: what the `erainfra` CLI and anyone's scripts read the fleet
// through. Versioned under /api/v1 so a breaking change ships as /api/v2 beside
// it rather than under clients already in the field.
//
// Every response is JSON. Absent values are `null` rather than missing keys,
// timestamps are RFC 3339 strings in UTC, and durations are integer
// milliseconds, so a script can rely on the shape of a row without knowing the
// Attempt's state.

export const API_PREFIX = "/api/v1";
export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 100;

export const ATTEMPT_STATES = [
  "pending",
  "preparing",
  "ready",
  "running",
  "completed",
  "cancelled",
  "failed",
] as const;
type AttemptState = (typeof ATTEMPT_STATES)[number];

type Profile = Awaited<ReturnType<typeof listProfiles>>[number];
type Machine = Awaited<ReturnType<typeof listMachines>>[number];

function iso(ms: number | undefined) {
  return ms === undefined ? null : new Date(ms).toISOString();
}

export function apiJson(body: unknown, status: number, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      // Fleet state is only true now, and the body may name private repositories.
      "Cache-Control": "no-store",
      ...headers,
    },
  });
}

export function apiError(status: number, code: string, message: string) {
  return apiJson(
    { error: { code, message } },
    status,
    status === 401 ? { "WWW-Authenticate": 'Bearer realm="erainfra"' } : {},
  );
}

// ---------------------------------------------------------------------------
// Query parameters

const PROFILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const REPO_NAME = /^[A-Za-z0-9_.-]{1,100}(\/[A-Za-z0-9_.-]{1,100})?$/;
const RELATIVE_SINCE = /^([1-9][0-9]{0,5})([mhd])$/;
const ABSOLUTE_SINCE = /^\d{4}-\d{2}-\d{2}([T ][0-9:.]+(Z|[+-]\d{2}:?\d{2})?)?$/;
const UNIT_MS = { m: 60_000, h: 3_600_000, d: 86_400_000 } as const;

/**
 * `since` is either a span back from now (`30m`, `24h`, `7d`, the spans
 * Blacksmith's `jobs list --since` takes) or an RFC 3339 date or timestamp.
 */
export function parseSince(value: string, now: number): number | null {
  const relative = RELATIVE_SINCE.exec(value);
  if (relative !== null) {
    return now - Number(relative[1]) * UNIT_MS[relative[2] as keyof typeof UNIT_MS];
  }
  if (!ABSOLUTE_SINCE.test(value)) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export type AttemptQuery = {
  profile?: string;
  state?: AttemptState;
  repo?: string;
  since?: number;
  limit: number;
  cursor: string | null;
};

export function parseAttemptQuery(
  params: URLSearchParams,
  now: number,
): { ok: true; query: AttemptQuery } | { ok: false; error: string } {
  const known = new Set(["profile", "state", "repo", "since", "limit", "cursor"]);
  for (const key of params.keys()) {
    if (!known.has(key)) return { ok: false, error: `unknown parameter ${key}` };
  }
  const query: AttemptQuery = { limit: DEFAULT_PAGE_SIZE, cursor: null };

  const profile = params.get("profile");
  if (profile !== null) {
    if (!PROFILE_NAME.test(profile)) return { ok: false, error: "profile is not a Profile name" };
    query.profile = profile;
  }
  const state = params.get("state");
  if (state !== null) {
    if (!(ATTEMPT_STATES as readonly string[]).includes(state)) {
      return { ok: false, error: `state must be one of ${ATTEMPT_STATES.join(", ")}` };
    }
    query.state = state as AttemptState;
  }
  const repo = params.get("repo");
  if (repo !== null) {
    if (!REPO_NAME.test(repo)) return { ok: false, error: "repo must be owner/name or name" };
    query.repo = repo;
  }
  const since = params.get("since");
  if (since !== null) {
    const parsed = parseSince(since, now);
    if (parsed === null) {
      return { ok: false, error: "since must be a span such as 24h or 7d, or an RFC 3339 time" };
    }
    query.since = parsed;
  }
  const limit = params.get("limit");
  if (limit !== null) {
    const parsed = /^[0-9]{1,3}$/.test(limit) ? Number(limit) : NaN;
    if (!(parsed >= 1 && parsed <= MAX_PAGE_SIZE)) {
      return { ok: false, error: `limit must be an integer from 1 to ${MAX_PAGE_SIZE}` };
    }
    query.limit = parsed;
  }
  const cursor = params.get("cursor");
  if (cursor !== null) {
    if (cursor.length === 0 || cursor.length > 4096) {
      return { ok: false, error: "cursor is not valid" };
    }
    query.cursor = cursor;
  }
  return { ok: true, query };
}

export type RightsizeQuery = { since?: number; repo?: string };

export function parseRightsizeQuery(
  params: URLSearchParams,
  now: number,
): { ok: true; query: RightsizeQuery } | { ok: false; error: string } {
  const known = new Set(["since", "repo"]);
  for (const key of params.keys()) {
    if (!known.has(key)) return { ok: false, error: `unknown parameter ${key}` };
  }
  const query: RightsizeQuery = {};
  const repo = params.get("repo");
  if (repo !== null) {
    if (!REPO_NAME.test(repo)) return { ok: false, error: "repo must be owner/name or name" };
    query.repo = repo;
  }
  const since = params.get("since");
  if (since !== null) {
    const parsed = parseSince(since, now);
    if (parsed === null) {
      return { ok: false, error: "since must be a span such as 24h or 7d, or an RFC 3339 time" };
    }
    query.since = parsed;
  }
  return { ok: true, query };
}

// ---------------------------------------------------------------------------
// Response bodies

export function profileJson(profile: Profile) {
  const readiness = { ready: 0, preparing: 0, degraded: 0, failed: 0 };
  for (const worker of profile.workers) readiness[worker.state] += 1;
  return {
    name: profile.name,
    state: profile.state,
    executor: profile.executor,
    boundary: profile.boundary,
    trustedOnly: profile.trustedOnly,
    imageRelease: profile.imageRelease,
    vcpus: profile.vcpus,
    memoryMiB: profile.memoryMiB,
    warmPool: profile.warmPool,
    fitPolicy: profile.fitPolicy,
    minRunners: profile.minRunners,
    maxRunners: profile.maxRunners,
    // Workers that can take a job now: ready, admitted, online, Profile active.
    readyWorkers: profile.readyWorkers,
    readySlots: profile.readySlots,
    freeSlots: profile.freeSlots,
    // Every Worker that reported for this exact contract, by reported state.
    readiness,
    workers: profile.workers.map((worker) => ({
      name: worker.machineName,
      state: worker.state,
      online: worker.online,
      checkedAt: iso(worker.checkedAt),
      statusDetail: worker.statusDetail ?? null,
      lastError: worker.lastError ?? null,
    })),
    updatedAt: iso(profile.updatedAt),
  };
}

export function workerJson(machine: Machine, now: number) {
  return {
    id: machine._id,
    name: machine.name,
    os: machine.os,
    arch: machine.arch ?? null,
    cpus: machine.cpus ?? null,
    memoryMiB: machine.memoryMiB ?? null,
    online: machine.lastSeen > 0 && now - machine.lastSeen < WORKER_OFFLINE_AFTER_MS,
    lastHeartbeatAt: machine.lastSeen > 0 ? iso(machine.lastSeen) : null,
    registeredAt: iso(machine._creationTime),
    slots: {
      max: machine.maxSlots,
      used: machine.usedSlots,
      policy: machine.slotPolicy ?? "auto",
      recommended: machine.recommendedSlots ?? null,
    },
    readiness: machine.readiness.map((entry) => ({
      profile: entry.profile,
      state: entry.state,
      executor: entry.executor,
      imageRelease: entry.imageRelease,
      checkedAt: iso(entry.checkedAt),
      preparedAt: iso(entry.preparedAt),
      statusDetail: entry.statusDetail ?? null,
      lastError: entry.lastError ?? null,
    })),
    activeAttempts: machine.currentAttempts.map((attempt) => ({
      id: attempt._id,
      profile: attempt.profile,
      state: attempt.state,
    })),
  };
}

function fullRepositoryName(attempt: OperatorAttempt) {
  if (attempt.repo === undefined) return null;
  if (attempt.repo.includes("/") || attempt.owner === undefined) return attempt.repo;
  return `${attempt.owner}/${attempt.repo}`;
}

// Queue wait and the run URL come from the same functions as the dashboard's
// Runs page, so the two cannot disagree.
export function attemptJson(attempt: OperatorAttempt) {
  const repo = fullRepositoryName(attempt);
  const runUrl = workflowRunUrl(attempt) ?? null;
  return {
    id: attempt._id,
    profile: attempt.profile,
    state: attempt.state,
    result: attempt.result ?? null,
    worker: attempt.workerName ?? null,
    repo,
    job: attempt.displayName ?? null,
    workflowRunId: attempt.workflowRunId ?? null,
    workflowRunUrl: runUrl,
    createdAt: iso(attempt.createdAt),
    queuedAt: iso(attempt.queueTime),
    startedAt: iso(attempt.startedAt),
    finishedAt: iso(attempt.finishedAt),
    queueWaitMs: queueWaitMs(attempt),
    durationMs:
      attempt.startedAt !== undefined && attempt.finishedAt !== undefined
        ? Math.max(0, attempt.finishedAt - attempt.startedAt)
        : null,
    error: attempt.lastError ?? attempt.cancelReason ?? null,
  };
}

/** Everything attemptJson carries, plus the fields an operator debugs with. */
export function attemptDetailJson(attempt: OperatorAttempt) {
  return {
    ...attemptJson(attempt),
    executor: attempt.executor,
    imageRelease: attempt.imageRelease,
    vcpus: attempt.vcpus,
    memoryMiB: attempt.memoryMiB,
    runnerName: attempt.runnerName,
    runnerId: attempt.runnerId,
    selectionReason: attempt.selectionReason ?? null,
    eventName: attempt.eventName ?? null,
    workflowRef: attempt.workflowRef ?? null,
    githubJobId: attempt.jobId ?? null,
    claimedAt: iso(attempt.claimedAt),
    readyAt: iso(attempt.readyAt),
    runnerAssignedAt: iso(attempt.runnerAssignedAt),
    executorFinishedAt: iso(attempt.executorFinishedAt),
    executorExitCode: attempt.executorExitCode ?? null,
    lastError: attempt.lastError ?? null,
    cancelReason: attempt.cancelReason ?? null,
    runnerCleanupPending: attempt.runnerCleanupPending === true,
  };
}

function round(value: number, places: number) {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

/**
 * The right-sizing report. `map` holds the same recommendations as a `runs-on` rewrite: repository,
 * then job name, then the current Profile, mapped to the registered Profile to use instead.
 */
export function rightsizeJson(report: RightsizeReport) {
  return {
    window: { start: iso(report.windowStart), end: iso(report.windowEnd) },
    scanned: report.scanned,
    truncated: report.truncated,
    policy: {
      minAttempts: MIN_ATTEMPTS,
      minMeasuredMs: MIN_MEASURED_MS,
      maxErrorRatio: MAX_ERROR_RATIO,
      cpuTargetUtilisation: CPU_TARGET_UTILISATION,
      cpuSaturated: CPU_SATURATED,
      memoryHeadroom: MEMORY_HEADROOM,
      memoryPressure: MEMORY_PRESSURE,
      maxWindowMs: MAX_WINDOW_MS,
    },
    recommendations: report.recommendations.map((recommendation) => ({
      repo: recommendation.repo,
      job: recommendation.job,
      profile: recommendation.profile,
      verdict: recommendation.verdict,
      recommendedProfile: recommendation.recommendedProfile,
      suggestedProfile: recommendation.suggestedProfile,
      current: recommendation.current,
      target: recommendation.target,
      attempts: recommendation.attempts,
      excludedAttempts: recommendation.excludedAttempts,
      lastSeenAt: recommendation.lastSeenAt > 0 ? iso(recommendation.lastSeenAt) : null,
      cpu: {
        p95Vcpus: round(recommendation.cpu.p95Vcpus, 2),
        maxVcpus: round(recommendation.cpu.maxVcpus, 2),
        saturatedAttempts: recommendation.cpu.saturatedAttempts,
      },
      memory: {
        peakBytes: Math.round(recommendation.memory.peakBytes),
        measure: recommendation.memory.measure,
        oomAttempts: recommendation.memory.oomAttempts,
      },
      explanation: recommendation.explanation,
    })),
    map: runsOnMap(report.recommendations),
  };
}

// ---------------------------------------------------------------------------
// Routes

export type Caller = { tokenId: Id<"apiTokens">; name: string; scope: ApiTokenScope };

/**
 * Resolve a request's bearer token, for /api/v1 and /metrics alike.
 *
 * `missing` and `invalid` are separate only so /api/v1 can say how to send a
 * token; an unknown, malformed and revoked token are all `invalid`, so the
 * answer never tells the holder of an old token whether it was revoked or never
 * existed. `lastUsedAt` is refreshed at most every LAST_USED_RESOLUTION_MS.
 */
export async function authenticateBearer(
  ctx: ActionCtx,
  request: Request,
  needed: ApiTokenScope,
): Promise<
  { ok: true; caller: Caller } | { ok: false; reason: "missing" | "invalid" | "forbidden" }
> {
  const token = bearerToken(request.headers.get("Authorization"));
  if (token === null) return { ok: false, reason: "missing" };
  const found = isWellFormedApiToken(token)
    ? await ctx.runQuery(internal.apiTokens.lookup, { tokenHash: await hashApiToken(token) })
    : null;
  if (found === null) return { ok: false, reason: "invalid" };
  if (!scopeAllows(found.scope, needed)) return { ok: false, reason: "forbidden" };
  const now = Date.now();
  if (shouldTouchLastUsed(found.lastUsedAt, now)) {
    await ctx.runMutation(internal.apiTokens.recordUse, { tokenId: found.tokenId, at: now });
  }
  return { ok: true, caller: { tokenId: found.tokenId, name: found.name, scope: found.scope } };
}

/**
 * Wraps a handler in bearer authentication: 401 without a valid token, 403 for
 * a valid token without the scope the route needs.
 */
export function operatorRoute(
  needed: ApiTokenScope,
  handler: (ctx: ActionCtx, request: Request, caller: Caller) => Promise<Response>,
) {
  return httpAction(async (ctx, request) => await authorized(ctx, request, needed, handler));
}

/** operatorRoute's check, for a route that picks its scope after reading the path. */
export async function authorized(
  ctx: ActionCtx,
  request: Request,
  needed: ApiTokenScope,
  handler: (ctx: ActionCtx, request: Request, caller: Caller) => Promise<Response>,
) {
  const auth = await authenticateBearer(ctx, request, needed);
  if (!auth.ok) {
    switch (auth.reason) {
      case "missing":
        return apiError(401, "unauthorized", "Send an API token as Authorization: Bearer <token>");
      case "invalid":
        return apiError(401, "unauthorized", "The API token is not valid or has been revoked");
      case "forbidden":
        return apiError(
          403,
          "forbidden",
          needed === "admin"
            ? "This route needs an admin token"
            : "This route needs a read or admin token",
        );
    }
  }
  return await handler(ctx, request, auth.caller);
}

export function registerOperatorRoutes(http: HttpRouter) {
  http.route({
    path: `${API_PREFIX}/token`,
    method: "GET",
    handler: operatorRoute("read", async (_ctx, _request, caller) =>
      apiJson({ token: { name: caller.name, scope: caller.scope } }, 200),
    ),
  });

  http.route({
    path: `${API_PREFIX}/profiles`,
    method: "GET",
    handler: operatorRoute("read", async (ctx) => {
      const profiles = await ctx.runQuery(internal.operatorApi.profiles, {});
      return apiJson({ profiles: profiles.map(profileJson) }, 200);
    }),
  });

  http.route({
    path: `${API_PREFIX}/workers`,
    method: "GET",
    handler: operatorRoute("read", async (ctx) => {
      const machines = await ctx.runQuery(internal.operatorApi.workers, {});
      const now = Date.now();
      return apiJson({ workers: machines.map((machine) => workerJson(machine, now)) }, 200);
    }),
  });

  http.route({
    path: `${API_PREFIX}/attempts`,
    method: "GET",
    handler: operatorRoute("read", async (ctx, request) => {
      const parsed = parseAttemptQuery(new URL(request.url).searchParams, Date.now());
      if (!parsed.ok) return apiError(400, "invalid_request", parsed.error);
      const { limit, cursor, ...filters } = parsed.query;
      let result;
      try {
        result = await ctx.runQuery(internal.operatorApi.attempts, {
          ...filters,
          paginationOpts: { numItems: limit, cursor },
        });
      } catch (error) {
        // A cursor is opaque and bound to the filters that produced it; Convex
        // refuses one that is malformed or was issued for another query.
        if (cursor !== null) {
          return apiError(400, "invalid_cursor", "cursor is not valid for these filters");
        }
        throw error;
      }
      return apiJson(
        {
          attempts: result.page.map(attemptJson),
          nextCursor: result.isDone ? null : result.continueCursor,
        },
        200,
      );
    }),
  });

  http.route({
    pathPrefix: `${API_PREFIX}/attempts/`,
    method: "GET",
    handler: operatorRoute("read", async (ctx, request) => {
      const id = decodeURIComponent(
        new URL(request.url).pathname.slice(`${API_PREFIX}/attempts/`.length),
      );
      const attempt =
        id.length === 0 || id.includes("/")
          ? null
          : await ctx.runQuery(internal.operatorApi.attempt, { id });
      if (attempt === null || attempt === undefined) {
        return apiError(404, "not_found", "No Attempt has that id");
      }
      return apiJson({ attempt: attemptDetailJson(attempt) }, 200);
    }),
  });

  http.route({
    path: `${API_PREFIX}/rightsize`,
    method: "GET",
    handler: operatorRoute("read", async (ctx, request) => {
      const parsed = parseRightsizeQuery(new URL(request.url).searchParams, Date.now());
      if (!parsed.ok) return apiError(400, "invalid_request", parsed.error);
      const report = await ctx.runQuery(internal.rightsize.operatorReport, parsed.query);
      return apiJson(rightsizeJson(report), 200);
    }),
  });

  // The dashboard's Add Worker action. The registration token is single-use and
  // expires in fifteen minutes, exactly as when the dashboard mints it.
  http.route({
    path: `${API_PREFIX}/workers/registration-tokens`,
    method: "POST",
    handler: operatorRoute("admin", async (ctx) => {
      const site = resolveSiteUrl(process.env.CONVEX_SITE_URL);
      if (!site.ok) {
        console.error(`Refusing to mint a registration token: ${site.error}`);
        return apiError(503, "not_configured", "This deployment has no canonical site URL");
      }
      const { token, expiresAt } = await ctx.runMutation(
        internal.operatorApi.createRegistrationToken,
        {},
      );
      return apiJson(
        {
          registrationToken: token,
          expiresAt: iso(expiresAt),
          installCommands: {
            posix: `curl -fsSL ${site.siteUrl}/install | bash -s -- --token ${token}`,
            windows: `& ([scriptblock]::Create((irm ${site.siteUrl}/install.ps1))) -Role worker -Token ${token}`,
          },
        },
        201,
      );
    }),
  });

  // Anything else under /api answers in JSON rather than falling through to the
  // dashboard's static files.
  for (const method of ["GET", "POST", "PUT", "DELETE"] as const) {
    http.route({
      pathPrefix: "/api/",
      method,
      handler: httpAction(async () => apiError(404, "not_found", "No such API route")),
    });
  }
}
