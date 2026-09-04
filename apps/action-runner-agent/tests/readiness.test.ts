import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  architectureMismatch,
  CHECK_HOST_SYSCTLS,
  CHECK_JOB_RESOURCE_VISIBILITY,
  HOST_SYSCTLS,
  type HostSysctl,
  hostSysctlReadiness,
  jobResourceVisibility,
  probeInvocation,
  readHostSysctls,
  type CoreLease,
  HEALTHY_READINESS_REFRESH_MS,
  parseRuntimeReport,
  parseWarmPoolStatus,
  PIDS_LIMIT,
  prepareProfile,
  processBound,
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
    assert.match(joined, /--cpus 8 --cpuset-cpus 8-15 --memory 8192m --shm-size 4096m/);
    // The rlimits too (#96): a Docker that stops accepting one of these would
    // otherwise fail every Attempt at run time on a Profile already advertised
    // ready. The resolver flags are not here on purpose -- reaching a
    // nameserver is a network question, not a question about the job's size.
    assert.match(joined, /--pids-limit 4096/);
    assert.match(joined, /--ulimit core=0:0 --ulimit stack=16777216:-1/);
    assert.match(joined, /--ulimit nofile=65536:1048576 --ulimit memlock=8388608:8388608/);
    assert.match(joined, /--ulimit nproc=32768:32768/);
    assert.doesNotMatch(joined, /--dns/);
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

describe("the process bound", () => {
  // The kernel derives RLIMIT_NPROC as RAM/256 KiB, which is four per MiB; that
  // is where ubuntu-latest's 63838 comes from on a 16 GiB runner. Applying it to
  // the Profile is what makes the bound scale with what the job was sold.
  it("is four per MiB of the Profile, as the kernel derives its own", () => {
    assert.equal(processBound(16384), 65536);
    assert.equal(processBound(8192), 32768);
  });

  // A small Profile must not land under the per-Attempt cgroup bound it exists
  // to backstop: RLIMIT_NPROC is counted per uid and shared with the other
  // Attempts on the Worker, so one saturating its own cgroup should not be what
  // fails its neighbours.
  it("never falls below four Attempts' worth of the cgroup bound", () => {
    assert.equal(processBound(2048), PIDS_LIMIT * 4);
    assert.equal(processBound(512), PIDS_LIMIT * 4);
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

/** What a Worker holding exactly `ubuntu-latest`'s values would read. */
function hostedSysctls(overrides: Record<string, number | undefined> = {}) {
  const readings = new Map<string, number | undefined>();
  for (const sysctl of HOST_SYSCTLS) readings.set(sysctl.key, sysctl.hosted);
  for (const [key, value] of Object.entries(overrides)) readings.set(key, value);
  return readings;
}

describe("host sysctls", () => {
  // Docker refuses `--sysctl` for all six -- none is namespaced -- so this
  // check exists because the flag cannot. If one of them ever becomes settable
  // per container the fix belongs in provision-docker.sh, not here.
  it("covers exactly the keys #96 measured", () => {
    assert.deepEqual(HOST_SYSCTLS.map((sysctl) => sysctl.key).toSorted(), [
      "fs.inotify.max_user_instances",
      "fs.inotify.max_user_watches",
      "kernel.threads-max",
      "user.max_user_namespaces",
      "vm.max_map_count",
      "vm.swappiness",
    ]);
    for (const sysctl of HOST_SYSCTLS) {
      assert.match(sysctl.path, /^\/proc\/sys\//, sysctl.key);
      assert.ok(sysctl.because.length > 0, sysctl.key);
    }
  });

  it("passes with every measured number in the detail, not a boolean", () => {
    const check = hostSysctlReadiness(hostedSysctls());
    assert.equal(check.name, CHECK_HOST_SYSCTLS);
    assert.equal(check.passed, true);
    for (const sysctl of HOST_SYSCTLS) {
      assert.match(check.detail ?? "", new RegExp(`${sysctl.key.replace(/\./g, "\\.")}=`));
    }
  });

  // A Worker that is merely different keeps working and says how it differs.
  // Withdrawing capacity over a swap-latency gap would be the wish this check
  // exists to replace, pointing the other way.
  it("shows the gap against hosted without gating on it", () => {
    const check = hostSysctlReadiness(
      hostedSysctls({ "vm.swappiness": 100, "fs.inotify.max_user_watches": 524288 }),
    );
    assert.equal(check.passed, true);
    assert.match(check.detail ?? "", /vm\.swappiness=100 \(hosted 60\)/);
    assert.match(check.detail ?? "", /fs\.inotify\.max_user_watches=524288 \(hosted 655360\)/);
  });

  // The fleet's measured value. Elasticsearch and OpenSearch refuse to start
  // below 262144 and say so, so a workflow that brings one up as a service
  // fails here and passes on hosted -- which is a job breaking, not a job
  // being different.
  it("refuses a Worker whose vm.max_map_count would break a search container", () => {
    const check = hostSysctlReadiness(hostedSysctls({ "vm.max_map_count": 65530 }));
    assert.equal(check.passed, false);
    assert.match(check.detail ?? "", /vm\.max_map_count is 65530 but a job needs 262144/);
    assert.match(check.detail ?? "", /Elasticsearch/);
    // The way out is in the message, not only in the issue.
    assert.match(check.detail ?? "", /sysctl\.d/);
    // And the evidence survives the failure.
    assert.match(check.detail ?? "", /kernel\.threads-max=/);
  });

  it("refuses a Worker whose inotify instances would exhaust a watcher", () => {
    const check = hostSysctlReadiness(hostedSysctls({ "fs.inotify.max_user_instances": 128 }));
    assert.equal(check.passed, false);
    assert.match(check.detail ?? "", /fs\.inotify\.max_user_instances is 128 but a job needs 1280/);
    assert.match(check.detail ?? "", /ENOSPC/);
  });

  // Preflight does not stop at the first failure, and neither does this: an
  // operator fixing a host should see both lines of the sysctl.d file at once.
  it("names every broken key rather than the first", () => {
    const check = hostSysctlReadiness(
      hostedSysctls({ "vm.max_map_count": 65530, "fs.inotify.max_user_instances": 128 }),
    );
    assert.equal(check.passed, false);
    assert.match(check.detail ?? "", /vm\.max_map_count/);
    assert.match(check.detail ?? "", /fs\.inotify\.max_user_instances/);
  });

  // A host with no /proc/sys is not a Linux Worker, and refusing one is a
  // different problem than a job being broken by a kernel setting -- the same
  // tolerance the unreadable memory cgroup gets.
  it("tolerates a setting it cannot read", () => {
    const check = hostSysctlReadiness(hostedSysctls({ "vm.max_map_count": undefined }));
    assert.equal(check.passed, true);
    assert.match(check.detail ?? "", /vm\.max_map_count=unreadable/);
  });

  it("reads a value from /proc/sys and reports a missing one as unreadable", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rc-sysctl-"));
    try {
      const path = join(dir, "max_map_count");
      await writeFile(path, "262144\n");
      const table: HostSysctl[] = [
        { key: "vm.max_map_count", path, hosted: 262144, because: "test" },
        { key: "vm.swappiness", path: join(dir, "absent"), hosted: 60, because: "test" },
      ];
      const readings = await readHostSysctls(table);
      assert.equal(readings.get("vm.max_map_count"), 262144);
      assert.equal(readings.get("vm.swappiness"), undefined);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
