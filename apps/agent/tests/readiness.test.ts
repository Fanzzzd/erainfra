import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseRuntimeReport, prepareProfile } from "../readiness.ts";

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
