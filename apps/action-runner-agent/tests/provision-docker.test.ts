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
    // Pinned so the argv assertions do not depend on the resolvers of whichever
    // machine runs the suite. The unset case is its own test below.
    RC_DNS_SERVERS: "10.0.0.53,10.0.0.54",
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
    // Docker's /dev/shm default is 64 MiB regardless of --memory, and a
    // GitHub-hosted runner gives a job half its RAM there. Chromium puts
    // renderer shared memory in /dev/shm, so an unset size kills browser
    // tests with SIGBUS inside a limit sized to allow them (#87).
    assert.match(argv, /--shm-size\t4096m\t/);
    // #96: every rlimit a container gets is the Docker daemon's, which is the
    // host's. Each of these is a decision with its reason in the provisioner --
    // no core dump into a writable layer the Worker's other Attempts share,
    // hosted's 16 MiB stack, hosted's 65536 soft descriptor limit with the
    // daemon's million left as the ceiling a job may raise itself to, and
    // hosted's 8 MiB lock bound.
    assert.match(argv, /--ulimit\tcore=0:0\t/);
    assert.match(argv, /--ulimit\tstack=16777216:-1\t/);
    assert.match(argv, /--ulimit\tnofile=65536:1048576\t/);
    assert.match(argv, /--ulimit\tmemlock=8388608:8388608\t/);
    // Four processes per MiB is the kernel's own RLIMIT_NPROC rule applied to
    // the Profile's memory instead of the Worker's, so the bound scales with
    // what the job was sold rather than staying `unlimited`.
    assert.match(argv, /--ulimit\tnproc=32768:32768\t/);
    // The resolver is named rather than inherited, edns0 is asked for and no
    // search domain is: a bare name must not resolve through whatever suffix
    // the Worker's network happens to supply (#96).
    assert.match(argv, /--dns\t10\.0\.0\.53\t--dns\t10\.0\.0\.54\t/);
    assert.match(argv, /--dns-option\tedns0\t--dns-search\t\.\t/);
    assert.doesNotMatch(argv, /trust-ad/);
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

  // Overlapping ranges sum to the right width while covering fewer CPUs, so a
  // width check alone would pass `0-1,1-2` for four vCPUs and Docker would hand
  // the job three.
  it("refuses overlapping ranges that add up to the right width", async () => {
    for (const cpuset of ["0-1,1-2", "0,0,1,1", "0-3,2-3"]) {
      const harness = new Harness();
      const result = await harness.run(PROVISION_DOCKER, { env: env({ RC_CPUSET_CPUS: cpuset }) });

      assert.equal(result.code, 2, cpuset);
      assert.match(result.stderr, /RC_CPUSET_CPUS/);
      assert.doesNotMatch(harness.argv(), /^docker\trun/m);
    }
  });

  it("accepts a range list that is discontiguous but disjoint", async () => {
    const harness = new Harness();
    const result = await harness.run(PROVISION_DOCKER, { env: env({ RC_CPUSET_CPUS: "0-1,8-9" }) });

    assert.equal(result.code, 0);
    assert.match(harness.argv(), /--cpus\t4\t--cpuset-cpus\t0-1,8-9\t/);
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

  // The bound is the kernel's own rule -- RAM/256 KiB, four per MiB -- applied
  // to the Profile rather than to the Worker's 251 GiB, with a floor so a small
  // Profile never lands under the --pids-limit it is supposed to backstop.
  it("scales the process bound with the Profile and floors it", async () => {
    const big = new Harness();
    assert.equal(
      (await big.run(PROVISION_DOCKER, { env: env({ RC_MEMORY_MIB: "16384" }) })).code,
      0,
    );
    assert.match(big.argv(), /--ulimit\tnproc=65536:65536\t/);

    const small = new Harness();
    assert.equal(
      (await small.run(PROVISION_DOCKER, { env: env({ RC_MEMORY_MIB: "2048" }) })).code,
      0,
    );
    assert.match(small.argv(), /--ulimit\tnproc=16384:16384\t/);
  });

  // Whatever the daemon inherited is the thing #96 is about, so it may not
  // reach a job either way: the servers are named on the command line, or the
  // Attempt refuses to start and says which variable names them.
  it("never lets a job inherit the daemon's resolver", async () => {
    const harness = new Harness();
    const withoutOverride: Record<string, string> = { ...env() };
    delete withoutOverride.RC_DNS_SERVERS;
    const result = await harness.run(PROVISION_DOCKER, { env: withoutOverride });

    if (result.code === 0) {
      assert.match(harness.argv(), /--dns\t[0-9a-fA-F.:]+\t/);
      assert.match(harness.argv(), /--dns-option\tedns0\t--dns-search\t\.\t/);
    } else {
      assert.equal(result.code, 2);
      assert.match(result.stderr, /set RC_DNS_SERVERS/);
      assert.doesNotMatch(harness.argv(), /^docker\trun/m);
    }
  });

  // A hostname cannot be resolved by the resolver being configured, a loopback
  // address inside the container's own network namespace is the container's
  // empty loopback, and neither a shell metacharacter nor an octet over 255 is
  // an address at all.
  it("refuses a resolver a container could not reach", async () => {
    for (const servers of [
      "dns.example.com",
      "127.0.0.53",
      "10.0.0.53,::1",
      "10.0.0.999",
      "10.0.0.53;rm -rf /",
      "$(id)",
      "10.0.0.53,,10.0.0.54",
      ",",
    ]) {
      const harness = new Harness();
      const result = await harness.run(PROVISION_DOCKER, { env: env({ RC_DNS_SERVERS: servers }) });

      assert.equal(result.code, 2, servers);
      assert.match(result.stderr, /RC_DNS_SERVERS/);
      assert.doesNotMatch(harness.argv(), /^docker\trun/m);
    }
  });

  // glibc reads at most MAXNS nameservers, so a fourth would be a line in the
  // container's resolv.conf that no lookup ever uses.
  it("passes at most three nameservers", async () => {
    const harness = new Harness();
    const result = await harness.run(PROVISION_DOCKER, {
      env: env({ RC_DNS_SERVERS: "10.0.0.1,10.0.0.2,2001:db8::1,10.0.0.4" }),
    });

    assert.equal(result.code, 0);
    assert.match(harness.argv(), /--dns\t10\.0\.0\.1\t--dns\t10\.0\.0\.2\t--dns\t2001:db8::1\t/);
    assert.doesNotMatch(harness.argv(), /10\.0\.0\.4/);
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
