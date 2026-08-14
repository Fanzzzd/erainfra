import { describe, expect, it } from "vitest";
import {
  controllerAuthorization,
  parseCompleteRunnerCleanup,
  parseCreateAttempt,
  parseJobCompleted,
  parseJobStarted,
  parseRegisterProfile,
} from "../convex/controllerHttp";

describe("controllerAuthorization", () => {
  it("fails closed when the controller secret is absent", () => {
    expect(controllerAuthorization("Bearer anything", undefined)).toBe("not-configured");
  });

  it("requires an exact bearer token", () => {
    expect(controllerAuthorization("Bearer controller-token", "controller-token")).toBe("ok");
    expect(controllerAuthorization("Bearer controller-tokem", "controller-token")).toBe(
      "unauthorized",
    );
    expect(controllerAuthorization("controller-token", "controller-token")).toBe("unauthorized");
  });
});

describe("controller payloads", () => {
  it("accepts only immutable Profile contracts", () => {
    expect(
      parseRegisterProfile({
        name: "rc-linux-js",
        scaleSetName: "rc-linux-js",
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
        name: "rc-linux-warm",
        scaleSetName: "rc-linux-warm",
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
        name: "rc-linux-invalid-warm",
        scaleSetName: "rc-linux-invalid-warm",
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
        name: "rc-linux-cpu",
        scaleSetName: "rc-linux-cpu",
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
        name: "rc-linux-trusted",
        scaleSetName: "rc-linux-trusted",
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
        name: "rc-linux-js",
        scaleSetName: "rc-linux-js",
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
        name: "rc-linux-js",
        scaleSetName: "rc-linux-js",
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
        name: "rc-linux-js",
        scaleSetName: "rc-linux-js",
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
        profile: " rc-linux-js ",
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
      profile: "rc-linux-js",
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
        profile: "rc-linux-js",
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
        profile: "rc-linux-js",
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
        profile: "rc-linux-js",
        runnerName: "runner-a",
        runnerRequestId: "9007199254740993",
        jobId: "job-1",
        result: "succeeded",
        finishedAt: 1_786_300_000_000,
      }),
    ).not.toBeNull();
    expect(
      parseCompleteRunnerCleanup({
        profile: "rc-linux-js",
        runnerName: "runner-a",
        runnerId: 42,
      }),
    ).toEqual({ profile: "rc-linux-js", runnerName: "runner-a", runnerId: 42 });
  });

  it("keeps GitHub int64 request identifiers lossless", () => {
    const base = {
      profile: "rc-linux-js",
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
