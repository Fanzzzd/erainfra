type ControllerAuth = "ok" | "not-configured" | "unauthorized";

export function controllerAuthorization(
  authorization: string | null,
  configuredToken: string | undefined,
): ControllerAuth {
  const expected = configuredToken?.trim() ?? "";
  if (expected.length === 0) {
    return "not-configured";
  }
  const prefix = "Bearer ";
  if (authorization === null || !authorization.startsWith(prefix)) {
    return "unauthorized";
  }
  const actual = authorization.slice(prefix.length);
  if (actual.length !== expected.length) {
    return "unauthorized";
  }
  let mismatch = 0;
  for (let index = 0; index < expected.length; index += 1) {
    mismatch |= actual.charCodeAt(index) ^ expected.charCodeAt(index);
  }
  return mismatch === 0 ? "ok" : "unauthorized";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function safePositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function optionalTimestamp(value: unknown): value is number | undefined {
  return value === undefined || safePositiveInteger(value);
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
    typeof payload.minRunners !== "number" ||
    !Number.isSafeInteger(payload.minRunners) ||
    payload.minRunners < 0 ||
    !safePositiveInteger(payload.maxRunners) ||
    payload.minRunners > payload.maxRunners
  ) {
    return null;
  }
  return {
    name: payload.name.trim(),
    scaleSetName: payload.scaleSetName.trim(),
    executor: payload.executor as "docker" | "firecracker" | "tart" | "hyperv",
    imageRelease: payload.imageRelease.trim(),
    vcpus: payload.vcpus,
    memoryMiB: payload.memoryMiB,
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
    !safePositiveInteger(payload.runnerRequestId) ||
    !nonEmptyString(payload.repository) ||
    !nonEmptyString(payload.owner) ||
    !nonEmptyString(payload.jobId) ||
    typeof payload.workflowRef !== "string" ||
    !nonEmptyString(payload.displayName) ||
    !safePositiveInteger(payload.workflowRunId) ||
    !nonEmptyString(payload.eventName) ||
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
    repository: payload.repository,
    owner: payload.owner,
    jobId: payload.jobId,
    workflowRef: payload.workflowRef,
    displayName: payload.displayName,
    workflowRunId: payload.workflowRunId,
    eventName: payload.eventName,
    queueTime: payload.queueTime,
    assignedAt: payload.assignedAt,
    runnerAssignedAt: payload.runnerAssignedAt,
  };
}

export function parseJobCompleted(payload: unknown) {
  if (
    !isRecord(payload) ||
    !nonEmptyString(payload.profile) ||
    !nonEmptyString(payload.runnerName) ||
    !safePositiveInteger(payload.runnerRequestId) ||
    !nonEmptyString(payload.jobId) ||
    !nonEmptyString(payload.result) ||
    !safePositiveInteger(payload.finishedAt)
  ) {
    return null;
  }
  return {
    profile: payload.profile.trim(),
    runnerName: payload.runnerName.trim(),
    runnerRequestId: payload.runnerRequestId,
    jobId: payload.jobId,
    result: payload.result,
    finishedAt: payload.finishedAt,
  };
}
