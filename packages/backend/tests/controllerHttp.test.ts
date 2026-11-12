import { describe, expect, it } from "vitest";

import {
  controllerAuthorization,
  parseCompleteRunnerCleanup,
  parseControllerHeartbeat,
  parseCreateAttempt,
  parseJobCompleted,
  parseRunnerlessJobCompleted,
  parseJobStarted,
  parseRegisterProfile,
} from "../convex/controllerHttp";

describe("controllerAuthorization", () => {
  it("fails closed when the controller secret is absent", () => {
    expect(controllerAuthorization("Bearer anything", undefined)).toEqual({
      status: "not-configured",
    });
    expect(controllerAuthorization("Bearer anything", "  ", "")).toEqual({
      status: "not-configured",
    });
  });

  it("requires an exact bearer token", () => {
    expect(controllerAuthorization("Bearer controller-token", "controller-token")).toEqual({
      status: "ok",
      slot: "current",
    });
    for (const header of [
      "Bearer controller-tokem",
      "Bearer controller-token-and-more",
      "Bearer controller-toke",
      "Bearer ",
      "controller-token",
      null,
    ]) {
      expect(controllerAuthorization(header, "controller-token"), String(header)).toEqual({
        status: "unauthorized",
      });
    }
  });

  it("accepts CONTROLLER_TOKEN_NEXT beside CONTROLLER_TOKEN and says which one matched", () => {
    expect(controllerAuthorization("Bearer old-token", "old-token", "new-token")).toEqual({
      status: "ok",
      slot: "current",
    });
    expect(controllerAuthorization("Bearer new-token", "old-token", "new-token")).toEqual({
      status: "ok",
      slot: "next",
    });
    expect(controllerAuthorization("Bearer other", "old-token", "new-token")).toEqual({
      status: "unauthorized",
    });
    expect(controllerAuthorization("Bearer new-token", undefined, "new-token")).toEqual({
      status: "ok",
      slot: "next",
    });
  });
});

describe("parseControllerHeartbeat", () => {
  const valid = {
    profile: "erainfra-4vcpu-ubuntu-2404",
    hostname: "oracle-singapore-1",
    version: "0.2.0-rc.11",
    scaleSetId: 3,
    sessionState: "listening",
    lastMessageAt: 1_786_300_000_000,
    startedAt: 1_786_200_000_000,
    assignedJobs: 2,
    runningJobs: 1,
  };

  it("accepts a full report and a minimal one", () => {
    expect(parseControllerHeartbeat(valid)).toEqual({ ...valid, lastError: undefined });
    expect(
      parseControllerHeartbeat({
        profile: "erainfra-4vcpu-ubuntu-2404",
        hostname: "h",
        version: "dev",
        sessionState: "starting",
        assignedJobs: 0,
        runningJobs: 0,
      }),
    ).toMatchObject({ profile: "erainfra-4vcpu-ubuntu-2404", sessionState: "starting" });
  });

  it("refuses anything outside the contract", () => {
    for (const change of [
      { profile: "a b" },
      { hostname: "two words" },
      { hostname: "x".repeat(256) },
      { version: "" },
      { sessionState: "listening " },
      { sessionState: "idle" },
      { assignedJobs: -1 },
      { runningJobs: "1" },
      { scaleSetId: 0 },
      { lastMessageAt: 0 },
      { startedAt: 1.5 },
      { lastError: 7 },
      { lastError: "e".repeat(1_001) },
    ]) {
      expect(parseControllerHeartbeat({ ...valid, ...change }), JSON.stringify(change)).toBeNull();
    }
    expect(parseControllerHeartbeat(null)).toBeNull();
  });
});

describe("controller payloads", () => {
  it("accepts only immutable Profile contracts", () => {
    expect(
      parseRegisterProfile({
        name: "erainfra-4vcpu-ubuntu-2404",
        scaleSetName: "erainfra-4vcpu-ubuntu-2404",
        executor: "firecracker",
        imageRelease: `ghcr.io/fanzzzd/runner@sha256:${"a".repeat(64)}`,
        vcpus: 2,
        memoryMiB: 4096,
        minRunners: 0,
        maxRunners: 4,
      }),
    ).toMatchObject({ fitPolicy: "balanced", warmPool: 0 });
    expect(
      parseRegisterProfile({
        name: "erainfra-2vcpu-ubuntu-2404-warm",
        scaleSetName: "erainfra-2vcpu-ubuntu-2404-warm",
        executor: "firecracker",
        imageRelease: `ghcr.io/fanzzzd/runner@sha256:${"a".repeat(64)}`,
        vcpus: 2,
        memoryMiB: 4096,
        warmPool: 2,
        minRunners: 0,
        maxRunners: 4,
      }),
    ).toMatchObject({ warmPool: 2 });
    expect(
      parseRegisterProfile({
        name: "erainfra-2vcpu-ubuntu-2404-docker",
        scaleSetName: "erainfra-2vcpu-ubuntu-2404-docker",
        executor: "docker",
        imageRelease: `ghcr.io/fanzzzd/runner@sha256:${"a".repeat(64)}`,
        vcpus: 2,
        memoryMiB: 4096,
        warmPool: 2,
        minRunners: 0,
        maxRunners: 4,
      }),
    ).toBeNull();
    expect(
      parseRegisterProfile({
        name: "erainfra-8vcpu-ubuntu-2404-8gb",
        scaleSetName: "erainfra-8vcpu-ubuntu-2404-8gb",
        executor: "firecracker",
        imageRelease: `ghcr.io/fanzzzd/runner@sha256:${"a".repeat(64)}`,
        vcpus: 8,
        memoryMiB: 8192,
        fitPolicy: "cpu",
        minRunners: 0,
        maxRunners: 4,
      }),
    ).toMatchObject({ fitPolicy: "cpu" });
    expect(
      parseRegisterProfile({
        name: "erainfra-4vcpu-ubuntu-2404-trusted",
        scaleSetName: "erainfra-4vcpu-ubuntu-2404-trusted",
        executor: "docker",
        imageRelease: `ghcr.io/fanzzzd/runner@sha256:${"b".repeat(64)}`,
        vcpus: 4,
        memoryMiB: 8192,
        minRunners: 0,
        maxRunners: 16,
      }),
    ).toMatchObject({ executor: "docker", imageRelease: expect.stringContaining("@sha256:") });
    expect(
      parseRegisterProfile({
        name: "erainfra-4vcpu-ubuntu-2404",
        scaleSetName: "erainfra-4vcpu-ubuntu-2404",
        executor: "firecracker",
        imageRelease: "ghcr.io/fanzzzd/runner:latest",
        vcpus: 2,
        memoryMiB: 4096,
        minRunners: 0,
        maxRunners: 4,
      }),
    ).toBeNull();
    expect(
      parseRegisterProfile({
        name: "erainfra-4vcpu-ubuntu-2404",
        scaleSetName: "erainfra-4vcpu-ubuntu-2404",
        executor: "firecracker",
        imageRelease: `ghcr.io/fanzzzd/runner@sha256:${"a".repeat(64)}`,
        vcpus: 2,
        memoryMiB: 4096,
        fitPolicy: "fastest",
        minRunners: 0,
        maxRunners: 4,
      }),
    ).toBeNull();
    expect(
      parseRegisterProfile({
        name: "erainfra-4vcpu-ubuntu-2404",
        scaleSetName: "erainfra-4vcpu-ubuntu-2404",
        executor: "firecracker",
        imageRelease: `ghcr.io/fanzzzd/runner@sha256:${"A".repeat(64)}`,
        vcpus: 2,
        memoryMiB: 4096,
        minRunners: 0,
        maxRunners: 4,
      }),
    ).toBeNull();
  });

  it("accepts one complete Attempt without changing its JIT bytes", () => {
    expect(
      parseCreateAttempt({
        profile: " erainfra-4vcpu-ubuntu-2404 ",
        executor: "firecracker",
        imageRelease:
          "ghcr.io/fanzzzd/runner@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        vcpus: 2,
        memoryMiB: 4096,
        runnerName: " runner-a ",
        runnerId: 42,
        encodedJITConfig: " base64-is-opaque ",
      }),
    ).toEqual({
      profile: "erainfra-4vcpu-ubuntu-2404",
      executor: "firecracker",
      imageRelease:
        "ghcr.io/fanzzzd/runner@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      vcpus: 2,
      memoryMiB: 4096,
      runnerName: "runner-a",
      runnerId: 42,
      encodedJITConfig: " base64-is-opaque ",
    });
  });

  it("rejects lossy or unsafe numeric identifiers", () => {
    expect(
      parseCreateAttempt({
        profile: "erainfra-4vcpu-ubuntu-2404",
        executor: "firecracker",
        imageRelease:
          "image@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        vcpus: 2,
        memoryMiB: 4096,
        runnerName: "runner-a",
        runnerId: Number.MAX_VALUE,
        encodedJITConfig: "secret",
      }),
    ).toBeNull();
  });

  it("accepts scale-set lifecycle payloads", () => {
    expect(
      parseJobStarted({
        profile: "erainfra-4vcpu-ubuntu-2404",
        runnerName: "runner-a",
        runnerRequestId: "9007199254740993",
        repository: "runner-center",
        owner: "Fanzzzd",
        jobId: "job-1",
        workflowRef: "",
        displayName: "check",
        workflowRunId: 99,
        eventName: "pull_request",
      }),
    ).not.toBeNull();
    expect(
      parseJobCompleted({
        profile: "erainfra-4vcpu-ubuntu-2404",
        runnerName: "runner-a",
        runnerRequestId: "9007199254740993",
        jobId: "job-1",
        result: "succeeded",
        finishedAt: 1_786_300_000_000,
      }),
    ).not.toBeNull();
    expect(
      parseCompleteRunnerCleanup({
        profile: "erainfra-4vcpu-ubuntu-2404",
        runnerName: "runner-a",
        runnerId: 42,
      }),
    ).toEqual({ profile: "erainfra-4vcpu-ubuntu-2404", runnerName: "runner-a", runnerId: 42 });
  });

  it("takes the run's head branch when a controller sends it, and does without it", () => {
    const base = {
      profile: "erainfra-4vcpu-ubuntu-2404",
      runnerName: "runner-a",
      eventName: "push",
    };
    expect(parseJobStarted({ ...base, headBranch: " feature/x " })).toMatchObject({
      headBranch: "feature/x",
    });
    expect(parseJobStarted(base)?.headBranch).toBeUndefined();
    expect(parseJobStarted({ ...base, headBranch: "" })?.headBranch).toBeUndefined();
    expect(parseJobStarted({ ...base, headBranch: 7 })).toBeNull();
  });

  it("tells a job no Runner took apart from a malformed JobCompleted", () => {
    const cancelled = {
      profile: "erainfra-canary-4vcpu-ubuntu-2404",
      result: "canceled",
      finishedAt: 1_786_300_000_000,
    };
    expect(parseRunnerlessJobCompleted({ ...cancelled, runnerName: "" })).toEqual({
      profile: "erainfra-canary-4vcpu-ubuntu-2404",
    });
    expect(parseRunnerlessJobCompleted({ ...cancelled, runnerName: "  " })).not.toBeNull();
    expect(parseRunnerlessJobCompleted(cancelled)).not.toBeNull();
    expect(parseRunnerlessJobCompleted({ ...cancelled, runnerName: "runner-a" })).toBeNull();
    expect(parseRunnerlessJobCompleted({ ...cancelled, runnerName: 7 })).toBeNull();
    expect(parseRunnerlessJobCompleted({ ...cancelled, profile: "" })).toBeNull();
    expect(parseJobCompleted({ ...cancelled, runnerName: "" })).toBeNull();
  });

  it("keeps GitHub int64 request identifiers lossless", () => {
    const base = {
      profile: "erainfra-4vcpu-ubuntu-2404",
      runnerName: "runner-a",
      runnerRequestId: "9223372036854775807",
      jobId: "job-1",
    };
    expect(
      parseJobStarted({
        ...base,
        repository: "runner-center",
        owner: "Fanzzzd",
        workflowRef: "",
        displayName: "check",
        workflowRunId: 99,
        eventName: "pull_request",
      }),
    ).not.toBeNull();
    expect(
      parseJobCompleted({
        ...base,
        result: "succeeded",
        finishedAt: 1_786_300_000_000,
      }),
    ).not.toBeNull();
    expect(parseJobStarted({ ...base, runnerRequestId: undefined })).not.toBeNull();
    expect(
      parseJobCompleted({
        ...base,
        runnerRequestId: undefined,
        result: "succeeded",
        finishedAt: 1_786_300_000_000,
      }),
    ).not.toBeNull();
    expect(parseJobCompleted({ ...base, runnerRequestId: Number.MAX_SAFE_INTEGER + 2 })).toBeNull();
    expect(parseJobCompleted({ ...base, runnerRequestId: "9223372036854775808" })).toBeNull();
  });
});
