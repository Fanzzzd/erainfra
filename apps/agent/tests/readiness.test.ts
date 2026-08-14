import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  architectureMismatch,
  HEALTHY_READINESS_REFRESH_MS,
  parseRuntimeReport,
  prepareProfile,
  readinessRefreshDelay,
  UNHEALTHY_READINESS_REFRESH_MS,
} from "../readiness.ts";

const DIGEST = `@sha256:${"a".repeat(64)}`;

describe("parseRuntimeReport", () => {
  it("reads the readiness document the privileged runtime writes", () => {
    const report = parseRuntimeReport(
      JSON.stringify({
        isolation: "firecracker-microvm",
        boundary: "guest-kernel",
        checks: [{ name: "kvm-device", passed: true, detail: "/dev/kvm" }],
        cache: { scope: "immutable-image", sharedWritable: false },
      }),
    );
    assert.equal(report.boundary, "guest-kernel");
    assert.equal(report.checks?.[0]?.name, "kvm-device");
    assert.equal(report.cache?.sharedWritable, false);
  });

  it("survives a runtime that printed nothing usable", () => {
    // A crashed or truncated runtime must not take the Worker down with it; the
    // caller reports a failed check instead.
    assert.deepEqual(parseRuntimeReport(""), {});
    assert.deepEqual(parseRuntimeReport("panic: runtime error"), {});
    assert.deepEqual(parseRuntimeReport("null"), {});
  });
});

describe("prepareProfile", () => {
  it("refuses a Profile whose image is not pinned by digest", async () => {
    const result = await prepareProfile({
      profile: "rc-linux-js",
      executor: "firecracker",
      imageRelease: "ghcr.io/fanzzzd/runner:latest",
      vcpus: 2,
      memoryMiB: 4096,
    });
    assert.equal(result.state, "failed");
    assert.match(result.state === "failed" ? result.error : "", /sha256 digest/);
    assert.ok(result.checks.some((check) => !check.passed));
  });

  it("never reports a guest-kernel boundary for the Docker executor", async () => {
    const result = await prepareProfile({
      profile: "rc-linux-docker",
      executor: "docker",
      // A digest that cannot be pulled: the point is the reported boundary, not
      // whether this host happens to have Docker.
      imageRelease: `ghcr.io/fanzzzd/does-not-exist${DIGEST}`,
      vcpus: 2,
      memoryMiB: 4096,
    });
    assert.equal(result.boundary, "shared-kernel");
    assert.equal(result.isolation, "docker-container");
    // Removing the Profile-wide pnpm volume is what makes this claim true.
    assert.equal(result.cacheSharedWritable, false);
    assert.equal(result.cacheScope, "immutable-image");
  });

  it("reports an unpinned Tart image as a failed readiness check", async () => {
    // The digest contract is checked before Tart can pull a mutable tag.
    process.env.TART = "/nonexistent/tart";
    try {
      const result = await prepareProfile({
        profile: "rc-mac",
        executor: "tart",
        imageRelease: "ghcr.io/cirruslabs/macos-tahoe-base:latest",
        vcpus: 2,
        memoryMiB: 4096,
      });
      assert.equal(result.state, "failed");
      assert.match(result.state === "failed" ? result.error : "", /sha256 digest/);
      assert.deepEqual(result.checks, [
        {
          name: "image-release",
          passed: false,
          detail:
            "Image Release ghcr.io/cirruslabs/macos-tahoe-base:latest is not pinned by sha256 digest",
        },
      ]);
      assert.equal(result.isolation, "tart-vm");
      assert.equal(result.boundary, "guest-kernel");
    } finally {
      delete process.env.TART;
    }
  });

  it("lets a digest-pinned Tart image continue to host preflight", async () => {
    process.env.TART = "/nonexistent/tart";
    try {
      const result = await prepareProfile({
        profile: "rc-mac",
        executor: "tart",
        imageRelease: `ghcr.io/cirruslabs/macos-sequoia-base${DIGEST}`,
        vcpus: 2,
        memoryMiB: 4096,
      });
      assert.equal(result.state, "failed");
      assert.doesNotMatch(result.state === "failed" ? result.error : "", /sha256 digest/);
      assert.ok(result.checks.some((check) => check.name === "tart-binary" && !check.passed));
    } finally {
      delete process.env.TART;
    }
  });

  it("keeps Hyper-V unready and says why", async () => {
    const result = await prepareProfile({
      profile: "rc-win",
      executor: "hyperv",
      imageRelease: "rc-win2025",
      vcpus: 2,
      memoryMiB: 4096,
    });
    assert.equal(result.state, "failed");
    assert.ok(result.checks.some((check) => check.name === "hyperv-validation" && !check.passed));
  });
});

describe("architectureMismatch", () => {
  it("accepts a matching architecture in either vocabulary", () => {
    // Node says x64/arm64; docker image inspect says amd64/arm64.
    assert.equal(architectureMismatch("x64", "amd64"), null);
    assert.equal(architectureMismatch("arm64", "arm64"), null);
    // An architecture Node has no alias for still matches itself.
    assert.equal(architectureMismatch("riscv64", "riscv64"), null);
  });

  it("names both sides of a mismatch", () => {
    // docker pull of a wrong-architecture image succeeds with a warning and
    // the job fails at run time; readiness is where this must surface.
    const mismatch = architectureMismatch("arm64", "amd64");
    assert.ok(mismatch !== null);
    assert.match(mismatch, /arm64/);
    assert.match(mismatch, /amd64/);
  });
});

describe("readiness refresh cadence", () => {
  it("keeps ready Profiles on the low-frequency refresh", () => {
    assert.equal(readinessRefreshDelay([]), HEALTHY_READINESS_REFRESH_MS);
    assert.equal(readinessRefreshDelay(["ready", "preparing"]), HEALTHY_READINESS_REFRESH_MS);
  });

  it("rechecks failed and degraded capacity within five minutes", () => {
    assert.equal(readinessRefreshDelay(["ready", "failed"]), UNHEALTHY_READINESS_REFRESH_MS);
    assert.equal(readinessRefreshDelay(["degraded"]), UNHEALTHY_READINESS_REFRESH_MS);
    assert.ok(UNHEALTHY_READINESS_REFRESH_MS < HEALTHY_READINESS_REFRESH_MS);
  });
});
