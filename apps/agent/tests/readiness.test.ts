import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { architectureMismatch, parseRuntimeReport, prepareProfile } from "../readiness.ts";

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

  it("does not require a digest where nothing else does", async () => {
    // Tightening Tart here would take a working macOS Profile offline as a
    // side effect of a Linux isolation change. TART points at a binary that
    // cannot exist so the check fails on the binary, not on the reference,
    // without this test ever pulling a real image.
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
      assert.doesNotMatch(result.state === "failed" ? result.error : "", /sha256 digest/);
      assert.ok(result.checks.some((check) => check.name === "tart-binary" && !check.passed));
    } finally {
      delete process.env.TART;
    }
  });

  it("fails Hyper-V readiness on a non-Windows host with a named check", async () => {
    // On a real Windows host the probe checks the Hyper-V module, the VM
    // switch, the parent VHDX and the machine-scope credential; this suite
    // runs on macOS/Linux CI, where readiness must still fail loudly instead
    // of pretending a Hyper-V Profile could run here.
    const result = await prepareProfile({
      profile: "rc-win",
      executor: "hyperv",
      imageRelease: "rc-win2025",
      vcpus: 2,
      memoryMiB: 4096,
    });
    assert.equal(result.state, "failed");
    assert.equal(result.isolation, "hyperv-vm");
    assert.equal(result.boundary, "guest-kernel");
    assert.ok(result.checks.some((check) => check.name === "hyperv-host" && !check.passed));
  });

  it("rejects a Hyper-V Image Release that is not a safe VHDX name", async () => {
    // The image name becomes %RC_HOME%\images\<name>.vhdx on the Worker; a
    // path-traversal name must die at readiness, not at provision time.
    const result = await prepareProfile({
      profile: "rc-win",
      executor: "hyperv",
      imageRelease: "..\\..\\evil",
      vcpus: 2,
      memoryMiB: 4096,
    });
    assert.equal(result.state, "failed");
    assert.ok(result.checks.some((check) => check.name === "parent-image" && !check.passed));
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
