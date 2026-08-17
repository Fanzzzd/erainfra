import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { FAKE_JIT, Harness, PROVISION_LINUX, waitFor } from "./helpers/harness.ts";

const SENTINEL = "RC-FAKE-JIT-SENTINEL-DO-NOT-LEAK";

describe("provision-linux.sh", () => {
  it("rejects an empty JIT configuration", async () => {
    const harness = new Harness();
    const result = await harness.run(PROVISION_LINUX, { stdin: "" });

    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /empty JIT configuration/);
  });

  it("never puts the JIT configuration in the docker command line", async () => {
    const harness = new Harness();
    const result = await harness.run(PROVISION_LINUX);

    assert.equal(result.code, 0);
    const argv = harness.argv();
    assert.match(argv, /^docker\trun\t/m);
    assert.ok(!argv.includes(FAKE_JIT), "the JIT configuration leaked into docker's argv");
    assert.ok(!argv.includes(SENTINEL));
    assert.ok(!argv.includes("--jitconfig"));
  });

  it("forwards the value through the environment instead", async () => {
    const harness = new Harness();
    assert.equal((await harness.run(PROVISION_LINUX)).code, 0);

    const argv =
      harness
        .argv()
        .split("\n")
        .find((line) => line.startsWith("docker\t")) ?? "";
    const args = argv.split("\t");
    const envFlag = args.indexOf("--env");
    assert.notEqual(envFlag, -1);
    assert.equal(args[envFlag + 1], "ACTIONS_RUNNER_INPUT_JITCONFIG");
    assert.deepEqual(args.slice(-2), ["./bin/Runner.Listener", "run"]);
  });

  it("propagates the container exit code", async () => {
    const harness = new Harness();
    const result = await harness.run(PROVISION_LINUX, { env: { RC_FAKE_DOCKER_EXIT: "17" } });

    assert.equal(result.code, 17);
  });

  it("honours the image the scheduler selected", async () => {
    const harness = new Harness();
    assert.equal(
      (
        await harness.run(PROVISION_LINUX, {
          env: { IMAGE: "ghcr.io/actions/actions-runner:9.9.9" },
        })
      ).code,
      0,
    );

    assert.match(harness.argv(), /ghcr\.io\/actions\/actions-runner:9\.9\.9/);
  });

  it("removes the container and exits 124 when the job outlives its timeout", async () => {
    const harness = new Harness();
    const result = await harness.run(PROVISION_LINUX, {
      env: { RC_FAKE_DOCKER_SLEEP: "60", RC_JOB_TIMEOUT_S: "2" },
    });

    assert.equal(result.code, 124);
    assert.match(result.stderr, /exceeded RC_JOB_TIMEOUT_S/);
    assert.match(harness.argv(), /^docker\tstop\t--time\t30\trc-test-runner$/m);
    assert.match(harness.argv(), /^docker\trm\t-f\trc-test-runner$/m);
  });

  it("still honours JOB_TIMEOUT_S as a compatibility fallback", async () => {
    const harness = new Harness();
    const result = await harness.run(PROVISION_LINUX, {
      env: { RC_FAKE_DOCKER_SLEEP: "60", JOB_TIMEOUT_S: "2", RC_JOB_TIMEOUT_S: "" },
    });

    assert.equal(result.code, 124);
  });

  it("removes the container when the provisioner is terminated", async () => {
    const harness = new Harness();
    const running = harness.start(PROVISION_LINUX, {
      env: { RC_FAKE_DOCKER_SLEEP: "60" },
    });

    await waitFor(() => harness.argv().includes("docker\trun"));
    running.kill("SIGTERM");
    const result = await running.done;

    assert.equal(result.code, 143);
    assert.match(harness.argv(), /^docker\trm\t-f\trc-test-runner$/m);
  });
});
