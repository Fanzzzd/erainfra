import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  architectureMismatch,
  CHECK_JOB_RESOURCE_VISIBILITY,
  jobResourceVisibility,
  probeInvocation,
  type CoreLease,
  HEALTHY_READINESS_REFRESH_MS,
  parseRuntimeReport,
  parseWarmPoolStatus,
  prepareProfile,
  readinessRefreshDelay,
  UNHEALTHY_READINESS_REFRESH_MS,
  WARM_POOL_READINESS_REFRESH_MS,
  warmPoolCapacityError,
} from "../readiness.ts";

const DIGEST = `@sha256:${"a".repeat(64)}`;

describe("parseRuntimeReport", () => {
  it("reads the readiness document the privileged runtime writes", () => {
    const report = parseRuntimeReport(
      JSON.stringify({
        isolation: "firecracker-microvm",
        boundary: "guest-kernel",
        checks: [{ name: "kvm-device", passed: true, detail: "/dev/kvm" }],
        storage: { snapshotter: "devmapper", poolName: "runner-center-thinpool" },
        network: {
          policyName: "runner-center",
          policyHash: `sha256:${"b".repeat(64)}`,
        },
        cache: { scope: "immutable-image", sharedWritable: false },
      }),
    );
    assert.equal(report.boundary, "guest-kernel");
    assert.equal(report.checks?.[0]?.name, "kvm-device");
    assert.equal(report.storage?.poolName, "runner-center-thinpool");
    assert.equal(report.network?.policyHash, `sha256:${"b".repeat(64)}`);
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

  // Every Docker Attempt is pinned to its own disjoint core range, so a Profile
  // wider than the Worker is one no Attempt placed here could ever be given.
  // Refusing at run time forever is the alternative, and it is worse (#80).
  it("refuses a Docker Profile wider than the Worker's CPUs", async () => {
    const result = await prepareProfile(
      {
        profile: "rc-linux-js",
        executor: "docker",
        imageRelease: `ghcr.io/fanzzzd/runner${DIGEST}`,
        vcpus: 64,
        memoryMiB: 8192,
      },
      { hostCores: 8 },
    );

    assert.equal(result.state, "failed");
    assert.match(
      result.state === "failed" ? result.error : "",
      /8 CPUs but the Profile asks for 64/,
    );
    const check = result.checks.find((entry) => entry.name === "cpu-capacity");
    assert.equal(check?.passed, false);
    // Proved before the daemon and the image, neither of which can change it.
    assert.equal(result.checks.length, 1);
  });

  it("records the Profile fitting the Worker as a check of its own", async () => {
    const result = await prepareProfile(
      {
        profile: "rc-linux-js",
        executor: "docker",
        imageRelease: `ghcr.io/fanzzzd/does-not-exist${DIGEST}`,
        vcpus: 2,
        memoryMiB: 4096,
      },
      { hostCores: 8 },
    );

    const check = result.checks.find((entry) => entry.name === "cpu-capacity");
    assert.equal(check?.passed, true);
    assert.equal(check?.detail, "2 of 8 CPUs");
  });

  it("reports an unpinned Tart image as a failed readiness check", async () => {
    // The binary check still runs, but the mutable tag is never pulled.
    const previousTart = process.env.TART;
    process.env.TART = process.execPath;
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
        { name: "tart-binary", passed: true, detail: process.version },
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
      if (previousTart === undefined) delete process.env.TART;
      else process.env.TART = previousTart;
    }
  });

  it("lets a digest-pinned Tart image continue to host preflight", async () => {
    const previousTart = process.env.TART;
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
      if (previousTart === undefined) delete process.env.TART;
      else process.env.TART = previousTart;
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

const probe = (stdout: string, exitCode = 0, stderr = "") => ({ exitCode, stdout, stderr });

describe("job resource visibility", () => {
  const PROFILE = {
    profile: "rc-linux-js",
    executor: "docker" as const,
    imageRelease: `ghcr.io/fanzzzd/runner${DIGEST}`,
    vcpus: 8,
    memoryMiB: 8192,
  };
  const LEASE: CoreLease = { spec: "0-7", exclusive: true, release: () => {} };
  const GIB8 = String(8192 * 1024 * 1024);

  // The probe runs the limit flags a real Attempt gets, in the order
  // provision-docker.sh writes them, against the Profile's own image.
  it("starts the probe with the Attempt's own limit flags", () => {
    const args = probeInvocation(PROFILE, "8-15");
    const joined = args.join(" ");
    assert.match(joined, /--cpus 8 --cpuset-cpus 8-15 --memory 8192m/);
    assert.match(joined, /--env RC_VCPUS=8 --env RC_MEMORY_MIB=8192/);
    assert.match(joined, /--rm --pull=never/);
    assert.ok(args.includes(PROFILE.imageRelease));
    // A cpuset does not filter /proc/cpuinfo, so asserting on it would fail
    // forever; nproc is the affinity-derived count a cpuset actually corrects.
    assert.match(joined, /\$\(nproc\)/);
    assert.doesNotMatch(joined, /cpuinfo/);
    // cgroup v1 first: the production Workers are v1 hybrid and Docker uses
    // the v1 paths there.
    const v1 = joined.indexOf("/sys/fs/cgroup/memory/memory.limit_in_bytes");
    const v2 = joined.indexOf("/sys/fs/cgroup/memory.max");
    assert.ok(v1 > 0 && v2 > v1, "cgroup v2 is consulted before v1");
  });

  it("passes with the measured numbers in the detail, not a boolean", () => {
    const check = jobResourceVisibility(PROFILE, LEASE, probe(`8\n8\n8192\n${GIB8}\n`));
    assert.equal(check.name, CHECK_JOB_RESOURCE_VISIBILITY);
    assert.equal(check.passed, true);
    assert.match(check.detail ?? "", /nproc=8 on 0-7/);
    assert.match(check.detail ?? "", /RC_VCPUS=8, RC_MEMORY_MIB=8192, 8192 MiB enforced/);
  });

  // The regression this exists to catch: someone drops --cpuset-cpus and the
  // container goes back to reporting the Worker.
  it("fails when the container reports the host's core count", () => {
    const check = jobResourceVisibility(PROFILE, LEASE, probe(`64\n8\n8192\n${GIB8}\n`));
    assert.equal(check.passed, false);
    assert.match(check.detail ?? "", /reports 64 CPUs but the Profile grants 8/);
  });

  it("fails when the job's own limits are missing or wrong", () => {
    for (const stdout of [`8\nunset\nunset\n${GIB8}\n`, `8\n8\n4096\n${GIB8}\n`]) {
      const check = jobResourceVisibility(PROFILE, LEASE, probe(stdout));
      assert.equal(check.passed, false, stdout);
      assert.match(check.detail ?? "", /RC_VCPUS=|RC_MEMORY_MIB=/);
    }
  });

  // RC_MEMORY_MIB is the number a job has to trust, because free(1) will not
  // tell it. It is only worth trusting if the kernel enforces that number.
  it("fails when RC_MEMORY_MIB is not the limit the cgroup enforces", () => {
    const check = jobResourceVisibility(
      PROFILE,
      LEASE,
      probe(`8\n8\n8192\n${512 * 1024 * 1024}\n`),
    );
    assert.equal(check.passed, false);
    assert.match(check.detail ?? "", /enforces 512 MiB/);
  });

  it("tolerates a host whose memory cgroup cannot be read", () => {
    const check = jobResourceVisibility(PROFILE, LEASE, probe("8\n8\n8192\nunknown\n"));
    assert.equal(check.passed, true);
    assert.match(check.detail ?? "", /cgroup limit unreadable/);
  });

  it("reports a probe that could not run at all", () => {
    const check = jobResourceVisibility(PROFILE, LEASE, probe("", 125, "no such image"));
    assert.equal(check.passed, false);
    assert.match(check.detail ?? "", /exited 125: no such image/);
  });

  it("says so when the Worker was too busy to lend the probe a range", () => {
    const shared: CoreLease = { spec: "0-7", exclusive: false, release: () => {} };
    const check = jobResourceVisibility(PROFILE, shared, probe(`8\n8\n8192\n${GIB8}\n`));
    assert.match(check.detail ?? "", /shared: the Worker was busy/);
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

describe("warm pool readiness", () => {
  it("parses only non-negative integral pool accounting", () => {
    assert.deepEqual(parseWarmPoolStatus('{"target":2,"parked":1,"claimed":1,"healthy":true}'), {
      target: 2,
      parked: 1,
      claimed: 1,
    });
    assert.equal(parseWarmPoolStatus('{"target":2,"parked":-1,"claimed":3}'), undefined);
    assert.equal(parseWarmPoolStatus("not JSON"), undefined);
  });

  it("rejects aggregate slot, CPU, and memory overcommit", () => {
    const profile = {
      profile: "warm",
      executor: "firecracker" as const,
      imageRelease: `ghcr.io/example/image${DIGEST}`,
      vcpus: 2,
      memoryMiB: 4096,
      warmPool: 2,
    };
    assert.match(warmPoolCapacityError([profile], 1, 8, 32_768) ?? "", /slots/);
    assert.match(warmPoolCapacityError([profile], 2, 2, 32_768) ?? "", /vCPUs/);
    assert.match(warmPoolCapacityError([profile], 2, 8, 4_096) ?? "", /MiB/);
    assert.equal(warmPoolCapacityError([profile], 2, 8, 32_768), undefined);
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

  it("polls healthy warm pools every minute", () => {
    assert.equal(readinessRefreshDelay(["ready"], true), WARM_POOL_READINESS_REFRESH_MS);
  });
});
