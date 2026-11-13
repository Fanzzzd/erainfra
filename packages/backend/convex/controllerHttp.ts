import { parseProfileEgress } from "./egress";
import { normalizeHostLabels } from "./hostLabels";

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
  nextToken?: string,
): ControllerAuth {
  return sharedSecretAuthorization(authorization, configuredToken, nextToken);
}

/**
 * The check behind controllerAuthorization, for any route that a shared secret with a current and
 * a next value guards, such as the fleet relay's access check (infra/relayAccess.ts).
 */
export function sharedSecretAuthorization(
  authorization: string | null,
  configuredToken: string | undefined,
  nextToken?: string,
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

export type RegistrationScope =
  | { kind: "repository"; host: string; owner: string; repository: string }
  | { kind: "organization"; host: string; organization: string }
  | { kind: "enterprise"; host: string; enterprise: string };

const githubNamePattern = /^[A-Za-z0-9_.-]{1,100}$/;

/**
 * Classifies a GitHub config URL by the rules the controller applies
 * (apps/controller/internal/config RegistrationScope): one path segment is an organization,
 * `enterprises/<slug>` an enterprise, any other two segments a repository. Anything else, or a URL
 * with credentials, a query or a fragment, is refused.
 */
export function parseRegistrationScope(raw: unknown): RegistrationScope | null {
  if (typeof raw !== "string" || raw.length > 512) return null;
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    url.host.length === 0 ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    return null;
  }
  const segments = url.pathname.replace(/^\/+|\/+$/g, "").split("/");
  if (!segments.every((segment) => githubNamePattern.test(segment))) return null;
  if (segments.length === 1) {
    return { kind: "organization", host: url.host, organization: segments[0] };
  }
  if (segments.length === 2 && segments[0].toLowerCase() === "enterprises") {
    return { kind: "enterprise", host: url.host, enterprise: segments[1] };
  }
  if (segments.length === 2) {
    return { kind: "repository", host: url.host, owner: segments[0], repository: segments[1] };
  }
  return null;
}

const MAX_LABELS = 32;

function parseRegistration(payload: Record<string, unknown>) {
  const { githubConfigUrl, githubCacheFacts, runnerGroup, labels } = payload;
  if (githubCacheFacts !== undefined && typeof githubCacheFacts !== "boolean") return null;
  if (githubConfigUrl === undefined) {
    return runnerGroup === undefined && labels === undefined ? {} : null;
  }
  if (typeof githubConfigUrl !== "string" || parseRegistrationScope(githubConfigUrl) === null) {
    return null;
  }
  if (
    runnerGroup !== undefined &&
    (typeof runnerGroup !== "string" || runnerGroup.trim().length === 0 || runnerGroup.length > 128)
  ) {
    return null;
  }
  if (
    labels !== undefined &&
    (!Array.isArray(labels) ||
      labels.length > MAX_LABELS ||
      !labels.every(
        (label) =>
          typeof label === "string" &&
          label.trim().length > 0 &&
          label.length <= 256 &&
          !/\p{Cc}/u.test(label),
      ))
  ) {
    return null;
  }
  return {
    githubConfigUrl: githubConfigUrl.trim(),
    ...(githubCacheFacts === undefined ? {} : { githubCacheFacts: githubCacheFacts }),
    ...(runnerGroup === undefined ? {} : { runnerGroup: runnerGroup.trim() }),
    ...(labels === undefined ? {} : { labels: (labels as string[]).map((label) => label.trim()) }),
  };
}

/** The header every controller request carries its lease epoch in, once it holds the lease. */
export const LEASE_EPOCH_HEADER = "X-EraInfra-Lease-Epoch";

/**
 * The epoch a request carries: undefined when the header is absent, null when it is malformed (a
 * malformed epoch is refused, never read as "no epoch", which would be the legacy path).
 */
export function parseLeaseEpoch(header: string | null): number | undefined | null {
  if (header === null) return undefined;
  const trimmed = header.trim();
  if (!/^[1-9][0-9]{0,14}$/.test(trimmed)) return null;
  return Number(trimmed);
}

/** A controller process names itself with a random instance id; any printable token will do. */
function instanceId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{8,128}$/.test(value);
}

export function parseLeaseRequest(payload: unknown) {
  if (
    !isRecord(payload) ||
    !nonEmptyString(payload.profile) ||
    !/^[A-Za-z0-9_.-]{1,64}$/.test(payload.profile.trim()) ||
    !instanceId(payload.instance) ||
    (payload.activate !== undefined && typeof payload.activate !== "boolean") ||
    (payload.canPublishCacheFacts !== undefined &&
      typeof payload.canPublishCacheFacts !== "boolean") ||
    !token(payload.hostname, 255)
  ) {
    return null;
  }
  return {
    profile: payload.profile.trim(),
    instance: payload.instance,
    hostname: payload.hostname.trim(),
    activate: payload.activate === true,
    canPublishCacheFacts: payload.canPublishCacheFacts === true,
  };
}

export function parseGitHubTokenRequest(payload: unknown) {
  if (
    !isRecord(payload) ||
    !nonEmptyString(payload.profile) ||
    !/^[A-Za-z0-9_.-]{1,64}$/.test(payload.profile.trim()) ||
    (payload.cacheFacts !== undefined && typeof payload.cacheFacts !== "boolean")
  ) {
    return null;
  }
  return { profile: payload.profile.trim(), cacheFacts: payload.cacheFacts === true };
}

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
  // Where the scale set is registered. Optional so a controller built before standbys existed
  // still registers; a standby cannot serve such a Profile until one that sends them does.
  const registration = parseRegistration(payload);
  if (registration === null) return null;
  let workerLabels: string[] | undefined;
  if (payload.workerLabels !== undefined) {
    if (!Array.isArray(payload.workerLabels)) return null;
    const normalized = normalizeHostLabels(payload.workerLabels);
    if (!normalized.ok) return null;
    workerLabels = normalized.labels;
  }
  return {
    ...registration,
    ...(workerLabels === undefined ? {} : { workerLabels }),
    egress: egress.egress,
    name: payload.name.trim(),
    scaleSetName: payload.scaleSetName.trim(),
    // oxlint-disable-next-line typescript/no-unnecessary-type-assertion -- without it the object literal widens the narrowed literal to string
    executor: payload.executor as "docker" | "firecracker" | "tart" | "hyperv",
    imageRelease: payload.imageRelease.trim(),
    vcpus: payload.vcpus,
    memoryMiB: payload.memoryMiB,
    warmPool: payload.warmPool ?? 0,
    // oxlint-disable-next-line typescript/no-unnecessary-type-assertion -- without it the object literal widens the narrowed literal to string
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
    // oxlint-disable-next-line typescript/no-unnecessary-type-assertion -- without it the object literal widens the narrowed literal to string
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
    !optionalString(payload.headBranch) ||
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
    headBranch: payload.headBranch?.trim() || undefined,
    displayName: payload.displayName?.trim() || undefined,
    workflowRunId: payload.workflowRunId,
    eventName: payload.eventName?.trim() || undefined,
    queueTime: payload.queueTime,
    assignedAt: payload.assignedAt,
    runnerAssignedAt: payload.runnerAssignedAt,
  };
}

const SESSION_STATES = ["starting", "standby", "listening", "conflict", "stopped"] as const;
const LEASE_ROLES = ["holder", "standby"] as const;
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

function parseHeartbeatLease(
  value: unknown,
): { leaseRole?: "holder" | "standby"; leaseEpoch?: number } | null {
  if (value === undefined) return {};
  if (!isRecord(value) || !LEASE_ROLES.includes(value.role as "holder" | "standby")) return null;
  if (value.role === "standby") {
    return value.epoch === undefined ? { leaseRole: "standby" } : null;
  }
  return safePositiveInteger(value.epoch) ? { leaseRole: "holder", leaseEpoch: value.epoch } : null;
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
  const lease = parseHeartbeatLease(payload.lease);
  // A standby holds no session, so it cannot be listening; a holder names the epoch it holds.
  if (
    lease === null ||
    (lease.leaseRole === "standby" && payload.sessionState === "listening") ||
    (lease.leaseRole !== "standby" && payload.sessionState === "standby")
  ) {
    return null;
  }
  return {
    ...lease,
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

/**
 * GitHub sends JobCompleted for a job cancelled before any Runner took it, with an empty runner
 * name. No Attempt can match it, so the controller's call has nothing to record. Recognising it
 * apart from a malformed event keeps a cancelled queue from answering 400, which a controller
 * treats as fatal and restarts on.
 */
export function parseRunnerlessJobCompleted(payload: unknown) {
  if (
    !isRecord(payload) ||
    !nonEmptyString(payload.profile) ||
    (payload.runnerName !== undefined &&
      (typeof payload.runnerName !== "string" || payload.runnerName.trim() !== "")) ||
    !optionalInt64Decimal(payload.runnerRequestId)
  ) {
    return null;
  }
  return { profile: payload.profile.trim(), runnerRequestId: payload.runnerRequestId };
}

/** Most jobs one acquired report may carry. A scale set acquires at most its maxRunners at once. */
export const ACQUIRED_JOBS_MAX = 100;

/** The controller's report of jobs it acquired (POST /controller/jobs/acquired). */
export function parseJobsAcquired(payload: unknown) {
  if (
    !isRecord(payload) ||
    !nonEmptyString(payload.profile) ||
    !Array.isArray(payload.jobs) ||
    payload.jobs.length > ACQUIRED_JOBS_MAX
  ) {
    return null;
  }
  const jobs = [];
  for (const job of payload.jobs as unknown[]) {
    if (
      !isRecord(job) ||
      !nonEmptyString(job.runnerRequestId) ||
      !optionalInt64Decimal(job.runnerRequestId) ||
      !optionalString(job.repository) ||
      !optionalString(job.owner) ||
      !optionalString(job.jobId) ||
      !optionalString(job.displayName) ||
      !optionalPositiveInteger(job.workflowRunId) ||
      !optionalTimestamp(job.queueTime)
    ) {
      return null;
    }
    jobs.push({
      runnerRequestId: job.runnerRequestId,
      repository: job.repository?.trim() || undefined,
      owner: job.owner?.trim() || undefined,
      jobId: job.jobId?.trim() || undefined,
      displayName: job.displayName?.trim() || undefined,
      workflowRunId: job.workflowRunId,
      queueTime: job.queueTime,
    });
  }
  return { profile: payload.profile.trim(), jobs };
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
