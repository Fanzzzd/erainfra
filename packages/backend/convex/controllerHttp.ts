import { parseProfileEgress } from "./egress";

/** Which configured token a request presented. */
export type ControllerTokenSlot = "current" | "next";

type ControllerAuth =
  | { status: "ok"; slot: ControllerTokenSlot }
  | { status: "not-configured" }
  | { status: "unauthorized" };

/**
 * Compares without branching on where the strings first differ, and without returning early on a
 * length mismatch, so the time taken says nothing about how much of a guess was right.
 */
function constantTimeEqual(actual: string, expected: string) {
  let mismatch = actual.length ^ expected.length;
  for (let index = 0; index < expected.length; index += 1) {
    // charCodeAt past the end is NaN, which `| 0` turns into 0; the length term above has already
    // recorded the mismatch.
    mismatch |= (actual.charCodeAt(index) | 0) ^ expected.charCodeAt(index);
  }
  return mismatch === 0;
}

/**
 * Checks a controller's bearer token against CONTROLLER_TOKEN and the optional
 * CONTROLLER_TOKEN_NEXT. Both are valid at once so the token can be rotated without an outage:
 * set NEXT, move every controller to it, then promote it to CONTROLLER_TOKEN and clear NEXT
 * (docs/runbooks/operate-the-controller-host.md). Both candidates are always compared, so the
 * work does not reveal which one matched.
 */
export function controllerAuthorization(
  authorization: string | null,
  configuredToken: string | undefined,
  nextToken?: string | undefined,
): ControllerAuth {
  const candidates: Array<{ slot: ControllerTokenSlot; token: string }> = [];
  const current = configuredToken?.trim() ?? "";
  const next = nextToken?.trim() ?? "";
  if (current.length > 0) candidates.push({ slot: "current", token: current });
  if (next.length > 0) candidates.push({ slot: "next", token: next });
  if (candidates.length === 0) {
    return { status: "not-configured" };
  }
  const prefix = "Bearer ";
  if (authorization === null || !authorization.startsWith(prefix)) {
    return { status: "unauthorized" };
  }
  const actual = authorization.slice(prefix.length);
  let matched: ControllerTokenSlot | undefined;
  for (const candidate of candidates) {
    if (constantTimeEqual(actual, candidate.token) && matched === undefined) {
      matched = candidate.slot;
    }
  }
  return matched === undefined ? { status: "unauthorized" } : { status: "ok", slot: matched };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function optionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}

function safePositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

const maxSignedInt64 = "9223372036854775807";

function positiveInt64Decimal(value: unknown): value is string {
  if (typeof value !== "string" || !/^[1-9][0-9]{0,18}$/.test(value)) return false;
  return value.length < maxSignedInt64.length || value <= maxSignedInt64;
}

function optionalInt64Decimal(value: unknown): value is string | undefined {
  return value === undefined || positiveInt64Decimal(value);
}

function optionalTimestamp(value: unknown): value is number | undefined {
  return value === undefined || safePositiveInteger(value);
}

function optionalPositiveInteger(value: unknown): value is number | undefined {
  return value === undefined || safePositiveInteger(value);
}

function optionalNonnegativeInteger(value: unknown): value is number | undefined {
  return (
    value === undefined || (typeof value === "number" && Number.isSafeInteger(value) && value >= 0)
  );
}

const immutableImagePattern = /@sha256:[0-9a-f]{64}$/;

export function parseRegisterProfile(payload: unknown) {
  if (
    !isRecord(payload) ||
    !nonEmptyString(payload.name) ||
    !/^[A-Za-z0-9_.-]{1,64}$/.test(payload.name.trim()) ||
    !nonEmptyString(payload.scaleSetName) ||
    (payload.executor !== "firecracker" &&
      payload.executor !== "docker" &&
      payload.executor !== "tart" &&
      payload.executor !== "hyperv") ||
    !nonEmptyString(payload.imageRelease) ||
    !immutableImagePattern.test(payload.imageRelease.trim()) ||
    !safePositiveInteger(payload.vcpus) ||
    !safePositiveInteger(payload.memoryMiB) ||
    !optionalNonnegativeInteger(payload.warmPool) ||
    (typeof payload.warmPool === "number" && payload.warmPool > 16) ||
    (typeof payload.warmPool === "number" &&
      payload.warmPool > 0 &&
      payload.executor !== "firecracker") ||
    (payload.fitPolicy !== undefined &&
      payload.fitPolicy !== "balanced" &&
      payload.fitPolicy !== "cpu" &&
      payload.fitPolicy !== "network" &&
      payload.fitPolicy !== "io") ||
    typeof payload.minRunners !== "number" ||
    !Number.isSafeInteger(payload.minRunners) ||
    payload.minRunners < 0 ||
    !safePositiveInteger(payload.maxRunners) ||
    payload.minRunners > payload.maxRunners ||
    (typeof payload.warmPool === "number" && payload.warmPool > payload.maxRunners)
  ) {
    return null;
  }
  const egress = parseProfileEgress(payload.egress);
  // Only the Firecracker runtime renders and verifies a per-guest egress
  // policy; a Profile on any other executor claiming one would advertise a
  // boundary no Worker enforces.
  if (!egress.ok || (egress.egress.mode !== "public" && payload.executor !== "firecracker")) {
    return null;
  }
  return {
    egress: egress.egress,
    name: payload.name.trim(),
    scaleSetName: payload.scaleSetName.trim(),
    executor: payload.executor as "docker" | "firecracker" | "tart" | "hyperv",
    imageRelease: payload.imageRelease.trim(),
    vcpus: payload.vcpus,
    memoryMiB: payload.memoryMiB,
    warmPool: payload.warmPool ?? 0,
    fitPolicy: (payload.fitPolicy ?? "balanced") as "balanced" | "cpu" | "network" | "io",
    minRunners: payload.minRunners,
    maxRunners: payload.maxRunners,
  };
}

export function parseCreateAttempt(payload: unknown) {
  if (
    !isRecord(payload) ||
    !nonEmptyString(payload.profile) ||
    (payload.executor !== "firecracker" &&
      payload.executor !== "docker" &&
      payload.executor !== "tart" &&
      payload.executor !== "hyperv") ||
    !nonEmptyString(payload.imageRelease) ||
    !safePositiveInteger(payload.vcpus) ||
    !safePositiveInteger(payload.memoryMiB) ||
    !nonEmptyString(payload.runnerName) ||
    !safePositiveInteger(payload.runnerId) ||
    !nonEmptyString(payload.encodedJITConfig)
  ) {
    return null;
  }
  return {
    profile: payload.profile.trim(),
    executor: payload.executor as "docker" | "firecracker" | "tart" | "hyperv",
    imageRelease: payload.imageRelease.trim(),
    vcpus: payload.vcpus,
    memoryMiB: payload.memoryMiB,
    runnerName: payload.runnerName.trim(),
    runnerId: payload.runnerId,
    encodedJITConfig: payload.encodedJITConfig,
  };
}

export function parseCancelAttempt(payload: unknown) {
  if (
    !isRecord(payload) ||
    !nonEmptyString(payload.profile) ||
    !nonEmptyString(payload.runnerName) ||
    !nonEmptyString(payload.reason)
  ) {
    return null;
  }
  return {
    profile: payload.profile.trim(),
    runnerName: payload.runnerName.trim(),
    reason: payload.reason.trim(),
  };
}

export function parseCompleteRunnerCleanup(payload: unknown) {
  if (
    !isRecord(payload) ||
    !nonEmptyString(payload.profile) ||
    !nonEmptyString(payload.runnerName) ||
    !safePositiveInteger(payload.runnerId)
  ) {
    return null;
  }
  return {
    profile: payload.profile.trim(),
    runnerName: payload.runnerName.trim(),
    runnerId: payload.runnerId,
  };
}

export function parseJobStarted(payload: unknown) {
  if (
    !isRecord(payload) ||
    !nonEmptyString(payload.profile) ||
    !nonEmptyString(payload.runnerName) ||
    !optionalInt64Decimal(payload.runnerRequestId) ||
    !optionalString(payload.repository) ||
    !optionalString(payload.owner) ||
    !optionalString(payload.jobId) ||
    !optionalString(payload.workflowRef) ||
    !optionalString(payload.displayName) ||
    !optionalPositiveInteger(payload.workflowRunId) ||
    !optionalString(payload.eventName) ||
    !optionalTimestamp(payload.queueTime) ||
    !optionalTimestamp(payload.assignedAt) ||
    !optionalTimestamp(payload.runnerAssignedAt)
  ) {
    return null;
  }
  return {
    profile: payload.profile.trim(),
    runnerName: payload.runnerName.trim(),
    runnerRequestId: payload.runnerRequestId,
    repository: payload.repository?.trim() || undefined,
    owner: payload.owner?.trim() || undefined,
    jobId: payload.jobId?.trim() || undefined,
    workflowRef: payload.workflowRef?.trim() || undefined,
    displayName: payload.displayName?.trim() || undefined,
    workflowRunId: payload.workflowRunId,
    eventName: payload.eventName?.trim() || undefined,
    queueTime: payload.queueTime,
    assignedAt: payload.assignedAt,
    runnerAssignedAt: payload.runnerAssignedAt,
  };
}

const SESSION_STATES = ["starting", "listening", "conflict", "stopped"] as const;
export type ControllerSessionState = (typeof SESSION_STATES)[number];

/** Longest `lastError` accepted. The controller caps its own at 500 characters. */
export const HEARTBEAT_ERROR_MAX_LENGTH = 1_000;

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** Printable ASCII without spaces: a hostname or a version string, never free text. */
function token(value: unknown, maxLength: number): value is string {
  return (
    typeof value === "string" && value.length <= maxLength && /^[\x21-\x7e]+$/.test(value.trim())
  );
}

export function parseControllerHeartbeat(payload: unknown) {
  if (
    !isRecord(payload) ||
    !nonEmptyString(payload.profile) ||
    !/^[A-Za-z0-9_.-]{1,64}$/.test(payload.profile.trim()) ||
    !token(payload.hostname, 255) ||
    !token(payload.version, 64) ||
    !optionalPositiveInteger(payload.scaleSetId) ||
    !SESSION_STATES.includes(payload.sessionState as ControllerSessionState) ||
    !optionalTimestamp(payload.lastMessageAt) ||
    !optionalTimestamp(payload.startedAt) ||
    !nonNegativeInteger(payload.assignedJobs) ||
    !nonNegativeInteger(payload.runningJobs) ||
    !optionalString(payload.lastError) ||
    (typeof payload.lastError === "string" && payload.lastError.length > HEARTBEAT_ERROR_MAX_LENGTH)
  ) {
    return null;
  }
  return {
    profile: payload.profile.trim(),
    hostname: payload.hostname.trim(),
    version: payload.version.trim(),
    scaleSetId: payload.scaleSetId,
    sessionState: payload.sessionState as ControllerSessionState,
    lastMessageAt: payload.lastMessageAt,
    startedAt: payload.startedAt,
    assignedJobs: payload.assignedJobs,
    runningJobs: payload.runningJobs,
    lastError: payload.lastError?.trim() || undefined,
  };
}

export function parseJobCompleted(payload: unknown) {
  if (
    !isRecord(payload) ||
    !nonEmptyString(payload.profile) ||
    !nonEmptyString(payload.runnerName) ||
    !optionalInt64Decimal(payload.runnerRequestId) ||
    !optionalString(payload.jobId) ||
    !optionalString(payload.result) ||
    !safePositiveInteger(payload.finishedAt)
  ) {
    return null;
  }
  return {
    profile: payload.profile.trim(),
    runnerName: payload.runnerName.trim(),
    runnerRequestId: payload.runnerRequestId,
    jobId: payload.jobId?.trim() || undefined,
    result: payload.result?.trim() || undefined,
    finishedAt: payload.finishedAt,
  };
}
