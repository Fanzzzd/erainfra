import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { FAKE_JIT, Harness, PROVISION_DOCKER, waitFor } from "./helpers/harness.ts";

const IMAGE = `ghcr.io/fanzzzd/runner-center-ubuntu-js@sha256:${"a".repeat(64)}`;

function env(overrides: Record<string, string> = {}) {
  return {
    IMAGE,
    RC_PROFILE: "rc-linux-js",
    RC_VCPUS: "4",
    RC_MEMORY_MIB: "8192",
    RC_CPUSET_CPUS: "4-7",
    RC_JOB_TIMEOUT_S: "60",
    ...overrides,
  };
}

describe("provision-docker.sh", () => {
  it("rejects a mutable image reference before starting Docker", async () => {
    const harness = new Harness();
    const result = await harness.run(PROVISION_DOCKER, {
      env: env({ IMAGE: "ghcr.io/fanzzzd/runner-center-ubuntu-js:latest" }),
    });

    assert.equal(result.code, 2);
    assert.match(result.stderr, /pinned by sha256 digest/);
    assert.doesNotMatch(harness.argv(), /^docker\t/m);
  });

  it("runs the exact prewarmed image and streams JIT through the FIFO", async () => {
    const harness = new Harness();
    const result = await harness.run(PROVISION_DOCKER, { env: env() });

    assert.equal(result.code, 0);
    const argv = harness.argv();
    assert.match(argv, /^docker\trun\t--rm\t--pull=never\t--init/m);
    assert.doesNotMatch(argv, /--mount|--volume|runner-cache/);
    assert.match(argv, /--label\trunner-center\.profile=rc-linux-js/);
    // The whole point of #80: --cpus is a quota, --cpuset-cpus is what nproc,
    // os.availableParallelism() and runtime.NumCPU() actually read.
    assert.match(argv, /--cpus\t4\t--cpuset-cpus\t4-7\t/);
    assert.match(argv, /--env\tRC_VCPUS=4\t/);
    assert.match(argv, /--env\tRC_MEMORY_MIB=8192\t/);
    assert.match(
      argv,
      new RegExp(
        `\\t${IMAGE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\t\\./bin/Runner\\.Listener\\trun$`,
        "m",
      ),
    );
    assert.doesNotMatch(argv, new RegExp(FAKE_JIT));
    assert.match(harness.stdinCaptures(), new RegExp(`ACTIONS_RUNNER_INPUT_JITCONFIG=${FAKE_JIT}`));
  });

  it("propagates runner failure and deletes the container", async () => {
    const harness = new Harness();
    const result = await harness.run(PROVISION_DOCKER, {
      env: env({ RC_FAKE_DOCKER_EXIT: "17" }),
    });

    assert.equal(result.code, 17);
    assert.match(harness.argv(), /^docker\trm\t-f\trc-test-runner$/m);
  });

  it("destroys an over-time container and exits 124", async () => {
    const harness = new Harness();
    const result = await harness.run(PROVISION_DOCKER, {
      env: env({ RC_FAKE_DOCKER_SLEEP: "60", RC_JOB_TIMEOUT_S: "2" }),
    });

    assert.equal(result.code, 124);
    assert.match(result.stderr, /exceeded RC_JOB_TIMEOUT_S/);
    assert.match(harness.argv(), /^docker\tstop\t--time\t30\trc-test-runner$/m);
    assert.match(harness.argv(), /^docker\trm\t-f\trc-test-runner$/m);
  });

  // A cpuset the Agent did not size to the Profile is the same lie in a new
  // place: a job on eight CPUs that believes it has four is as wrong as one on
  // four that believes it has sixty-four.
  it("refuses a core range whose width is not RC_VCPUS", async () => {
    const harness = new Harness();
    const result = await harness.run(PROVISION_DOCKER, {
      env: env({ RC_CPUSET_CPUS: "0-7" }),
    });

    assert.equal(result.code, 2);
    assert.match(result.stderr, /covers 8 CPUs but RC_VCPUS is 4/);
    assert.doesNotMatch(harness.argv(), /^docker\trun/m);
  });

  it("refuses a core range that is not a CPU list", async () => {
    for (const cpuset of ["all", "0-", "0,,1", "-1", "7-4"]) {
      const harness = new Harness();
      const result = await harness.run(PROVISION_DOCKER, { env: env({ RC_CPUSET_CPUS: cpuset }) });

      assert.equal(result.code, 2, cpuset);
      assert.match(result.stderr, /RC_CPUSET_CPUS/);
      assert.doesNotMatch(harness.argv(), /^docker\trun/m);
    }
  });

  // There is no quota-only fallback. A container that quietly reads the host's
  // core count is the defect, so its absence stops the job instead.
  it("refuses to start at all without a core range", async () => {
    const harness = new Harness();
    const result = await harness.run(PROVISION_DOCKER, {
      env: { ...env(), RC_CPUSET_CPUS: "" },
    });

    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /RC_CPUSET_CPUS is required/);
    assert.doesNotMatch(harness.argv(), /^docker\trun/m);
  });

  it("deletes the container when the Agent terminates it", async () => {
    const harness = new Harness();
    const running = harness.start(PROVISION_DOCKER, {
      env: env({ RC_FAKE_DOCKER_SLEEP: "60" }),
    });

    await waitFor(() => harness.argv().includes("docker\trun"));
    running.kill("SIGTERM");
    const result = await running.done;

    assert.equal(result.code, 143);
    assert.match(harness.argv(), /^docker\trm\t-f\trc-test-runner$/m);
  });
});
