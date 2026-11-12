import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { parseCpuset } from "../cpuset.ts";
import {
  attemptEnvironment,
  attemptInvocation,
  dockerProvisionerPath,
  experimentInvocation,
  provisionerPath,
  provisionInvocation,
  readEgressRecord,
  readRunnerExit,
  readTestReport,
  reportAttemptWithRunnerExit,
} from "../provision.ts";
import { PIDS_LIMIT, probeInvocation } from "../readiness.ts";
import { PROVISION_LINUX, PROVISION_MAC } from "./helpers/harness.ts";

const SHELL_PROVISIONERS = [PROVISION_MAC, PROVISION_LINUX, dockerProvisionerPath()];

/** The pin the macOS provisioner installs, read straight out of the script. */
function macRunnerPin() {
  const source = readFileSync(PROVISION_MAC, "utf8");
  const version = /^RC_RUNNER_VERSION_DEFAULT="([^"]+)"$/m.exec(source)?.[1];
  const sha256 = /^RC_RUNNER_SHA256_DEFAULT="([^"]+)"$/m.exec(source)?.[1];
  assert.ok(version, "provision-mac.sh no longer declares RC_RUNNER_VERSION_DEFAULT");
  assert.ok(sha256, "provision-mac.sh no longer declares RC_RUNNER_SHA256_DEFAULT");
  return { version, sha256 };
}

describe("provisioner scripts", () => {
  for (const script of SHELL_PROVISIONERS) {
    it(`${script.split("/").pop()} parses and is executable`, () => {
      assert.ok(statSync(script).mode & 0o111, "the provisioner is not executable");
      execFileSync("bash", ["-n", script]);
    });

    it(`${script.split("/").pop()} passes shellcheck`, (t) => {
      const version = spawnSync("shellcheck", ["--version"], { encoding: "utf8" });
      if (version.error !== undefined) {
        t.skip("shellcheck is not installed");
        return;
      }
      const result = spawnSync("shellcheck", ["-s", "bash", script], { encoding: "utf8" });
      assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    });

    it(`${script.split("/").pop()} takes the JIT configuration on stdin only`, () => {
      const source = readFileSync(script, "utf8");
      assert.ok(
        !/\bJIT_CONFIG\b/.test(source),
        "the provisioner still mentions the JIT_CONFIG environment variable",
      );
      assert.ok(
        !/--jitconfig[\s"']*\$/.test(source),
        "the provisioner still passes the JIT configuration as a command line argument",
      );
      assert.match(source, /stdin/);
    });

    it(`${script.split("/").pop()} honours the shared RC_JOB_TIMEOUT_S`, () => {
      const source = readFileSync(script, "utf8");
      assert.match(source, /RC_JOB_TIMEOUT_S/);
      // Every provisioner uses 124 so agent logs identify a timeout consistently;
      // the backend applies the normal bounded retry policy.
      assert.match(source, /exit 124/);
    });
  }

  // The readiness probe's own comment claims it runs "the exact limit flags an
  // Attempt is given". Two sources for one rule drift, so the drift is what is
  // asserted: every resource limit the probe emits has to be a literal in the
  // provisioner, and the one that is derived has its derivation asserted
  // instead (#96).
  it("probes with the same resource limits provision-docker.sh passes", () => {
    const source = readFileSync(dockerProvisionerPath(), "utf8");
    const args = probeInvocation(
      {
        profile: "erainfra-4vcpu-ubuntu-2404",
        executor: "docker",
        imageRelease: `ghcr.io/fanzzzd/runner@sha256:${"a".repeat(64)}`,
        vcpus: 4,
        memoryMiB: 8192,
      },
      "0-3",
    );
    const ulimits = args.filter((_, index) => args[index - 1] === "--ulimit");
    assert.equal(ulimits.length, 5, "the probe stopped passing the Attempt's rlimits");
    for (const limit of ulimits) {
      if (limit.startsWith("nproc=")) {
        assert.match(source, /RC_NPROC_MAX=\$\(\(RC_MEMORY_MIB \* 4\)\)/);
        assert.match(source, /RC_NPROC_MAX" -lt \$\(\(RC_PIDS_LIMIT \* 4\)\)/);
        continue;
      }
      assert.ok(source.includes(`--ulimit ${limit}`), limit);
    }
    assert.ok(source.includes('--pids-limit "$RC_PIDS_LIMIT"'));
    assert.match(source, new RegExp(`RC_PIDS_LIMIT=${PIDS_LIMIT}\\b`));
  });

  it("delivers the JIT configuration to every provisioner on stdin", () => {
    const source = readFileSync(fileURLToPath(new URL("../provision.ts", import.meta.url)), "utf8");
    assert.match(source, /input: attempt\.jitConfig/);
    assert.ok(
      !/\bJIT_CONFIG\b/.test(source),
      "the agent still puts the JIT configuration in the child's environment",
    );
  });
});

function runnerImageRef(file: string) {
  return /ghcr\.io\/actions\/actions-runner:[0-9.]+@sha256:[0-9a-f]{64}/.exec(
    readFileSync(file, "utf8"),
  )?.[0];
}

describe("pinned actions/runner release", () => {
  it("is a well formed version and SHA-256", () => {
    const { version, sha256 } = macRunnerPin();
    assert.match(version, /^\d+\.\d+\.\d+$/);
    assert.match(sha256, /^[0-9a-f]{64}$/);
  });

  it("is the same version everywhere it is written down", (t) => {
    const catalog = fileURLToPath(
      new URL("../../../packages/backend/convex/catalog.ts", import.meta.url),
    );
    if (!existsSync(catalog)) {
      // apps/action-runner-agent is also distributed on its own, without the
      // backend.
      t.skip("the backend catalog is not present in this checkout");
      return;
    }

    const pinned = macRunnerPin().version;
    for (const [name, file] of [
      ["the backend image catalog", catalog],
      ["provision-linux.sh", PROVISION_LINUX],
    ] as const) {
      const version = /actions-runner:(\d+\.\d+\.\d+)/.exec(readFileSync(file, "utf8"))?.[1];
      assert.equal(version, pinned, `${name} has drifted from the macOS runner pin`);
    }
  });

  it("pulls the Docker executor's runner image by the same digest everywhere", (t) => {
    const catalog = fileURLToPath(
      new URL("../../../packages/backend/convex/catalog.ts", import.meta.url),
    );
    if (!existsSync(catalog)) {
      t.skip("the backend catalog is not present in this checkout");
      return;
    }
    const linux = runnerImageRef(PROVISION_LINUX);
    assert.ok(linux, "provision-linux.sh does not pin the runner image by digest");
    assert.equal(
      runnerImageRef(catalog),
      linux,
      "the catalog and provision-linux.sh pin different images",
    );
  });

  it("matches the checksum GitHub publishes for that release", async (t) => {
    if (process.env.RC_TEST_NETWORK !== "1") {
      t.skip("set RC_TEST_NETWORK=1 to verify the pin against github.com");
      return;
    }

    const { version, sha256 } = macRunnerPin();
    const response = await fetch(
      `https://api.github.com/repos/actions/runner/releases/tags/v${version}`,
    );
    assert.ok(response.ok, `GitHub returned ${response.status}`);

    const release = (await response.json()) as {
      assets: { name: string; digest: string | null }[];
    };
    const asset = release.assets.find(
      (a) => a.name === `actions-runner-osx-arm64-${version}.tar.gz`,
    );

    assert.ok(asset, "the release has no osx-arm64 asset");
    assert.equal(asset.digest, `sha256:${sha256}`);
  });
});

describe("provisionInvocation", () => {
  it("resolves a provisioner that actually exists for every OS", () => {
    for (const os of ["linux", "mac", "win"] as const) {
      assert.ok(existsSync(provisionerPath(os)));
    }
  });

  it("never puts the JIT configuration in argv or the environment", () => {
    for (const os of ["linux", "mac", "win"] as const) {
      const { args, env } = provisionInvocation(os, "rc-machine-42", "some-image");
      assert.deepEqual(env, { RUNNER_NAME: "rc-machine-42", IMAGE: "some-image" });
      assert.doesNotMatch(
        args.join("\0"),
        /--jit-?config|ACTIONS_RUNNER_INPUT_JITCONFIG|JIT_CONFIG=/i,
      );
    }
  });

  it("omits IMAGE when the scheduler did not choose one", () => {
    assert.deepEqual(provisionInvocation("mac", "rc-machine-42").env, {
      RUNNER_NAME: "rc-machine-42",
    });
  });

  it("runs the Windows provisioner through powershell", () => {
    const { file, args } = provisionInvocation("win", "rc-machine-42");
    assert.equal(file, "powershell.exe");
    assert.deepEqual(args, [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      provisionerPath("win"),
    ]);
  });
});

describe("scale-set Attempt invocation", () => {
  it("runs the trusted Docker fallback with exact Profile resources", () => {
    const invocation = attemptInvocation({
      attemptId: "attempt-docker",
      runnerName: "runner-docker",
      profile: "erainfra-4vcpu-ubuntu-2404",
      executor: "docker",
      imageRelease: `ghcr.io/fanzzzd/runner@sha256:${"a".repeat(64)}`,
      vcpus: 4,
      memoryMiB: 8192,
      cpuset: "0-3",
    });
    assert.equal(invocation.file, dockerProvisionerPath());
    assert.deepEqual(invocation.args, []);
    assert.deepEqual(invocation.env, {
      RUNNER_NAME: "runner-docker",
      RC_PROFILE: "erainfra-4vcpu-ubuntu-2404",
      IMAGE: `ghcr.io/fanzzzd/runner@sha256:${"a".repeat(64)}`,
      RC_VCPUS: "4",
      RC_MEMORY_MIB: "8192",
      RC_CPUSET_CPUS: "0-3",
    });
  });

  // The T0 tier, and after probe run 32109974600 the only candidate left: the
  // runner overwrites all four cache variables from the job message in every
  // ACTION step, which is what every cache client is, so a workflow `env:`
  // block and $GITHUB_ENV both lose. The container environment is the only
  // place a value can already be present when the runner starts.
  const DOCKER_ATTEMPT = {
    attemptId: "attempt-docker",
    runnerName: "runner-docker",
    profile: "erainfra-4vcpu-ubuntu-2404",
    executor: "docker" as const,
    imageRelease: `ghcr.io/fanzzzd/runner@sha256:${"a".repeat(64)}`,
    vcpus: 4,
    memoryMiB: 8192,
    cpuset: "0-3",
  };

  it("adds nothing to the environment when no cache endpoint is configured", () => {
    for (const cache of [undefined, {}]) {
      const { env } = attemptInvocation({ ...DOCKER_ATTEMPT, cache });
      // Absent, not empty: a Worker without a cache hands the provisioner
      // exactly what it handed before this seam existed.
      assert.equal(
        Object.keys(env).some((name) => name.startsWith("ERAINFRA_")),
        false,
      );
    }
  });

  it("names the cache endpoint rather than letting it arrive from the agent's own env", () => {
    const { env } = attemptInvocation({
      ...DOCKER_ATTEMPT,
      cache: { url: "https://cache.lan/erainfra/", serviceV2: "false" },
    });
    assert.equal(env.ERAINFRA_CACHE_URL, "https://cache.lan/erainfra/");
    assert.equal(env.ERAINFRA_CACHE_SERVICE_V2, "false");
  });

  // Independent, because they carry different risk: the flag alone moves no
  // traffic anywhere -- GitHub serves both generations -- so it is the free way
  // to ask whether an EraInfra-set value survives the runner's injection.
  it("carries the generation flag on its own", () => {
    const { env } = attemptInvocation({ ...DOCKER_ATTEMPT, cache: { serviceV2: "true" } });
    assert.equal(env.ERAINFRA_CACHE_SERVICE_V2, "true");
    assert.equal("ERAINFRA_CACHE_URL" in env, false);
  });

  // --cpus is a CFS quota and leaves the affinity mask covering the host, so a
  // cpuset narrower or wider than RC_VCPUS tells the job a different wrong
  // number than the one #80 reported. The width is the contract, not the flag.
  it("gives the container a core range exactly RC_VCPUS wide", () => {
    for (const [vcpus, cpuset] of [
      [1, "5"],
      [2, "6-7"],
      [4, "0-3"],
      [4, "0-1,8-9"],
      [8, "8-15"],
    ] as const) {
      const { env } = attemptInvocation({
        attemptId: "attempt-docker",
        runnerName: "runner-docker",
        profile: "erainfra-4vcpu-ubuntu-2404",
        executor: "docker",
        imageRelease: `ghcr.io/fanzzzd/runner@sha256:${"a".repeat(64)}`,
        vcpus,
        memoryMiB: 8192,
        cpuset,
      });
      assert.equal(env.RC_CPUSET_CPUS, cpuset);
      assert.equal(parseCpuset(env.RC_CPUSET_CPUS ?? "")?.length, Number(env.RC_VCPUS));
    }
  });

  it("refuses to start a container with no CPU reservation at all", () => {
    assert.throws(
      () =>
        attemptInvocation({
          attemptId: "attempt-docker",
          runnerName: "runner-docker",
          profile: "erainfra-4vcpu-ubuntu-2404",
          executor: "docker",
          imageRelease: `ghcr.io/fanzzzd/runner@sha256:${"a".repeat(64)}`,
          vcpus: 4,
          memoryMiB: 8192,
        }),
      /no CPU reservation/,
    );
  });

  it("runs Firecracker by Profile without exposing JIT", () => {
    const invocation = attemptInvocation({
      attemptId: "attempt-1",
      runnerName: "runner-a",
      profile: "erainfra-4vcpu-ubuntu-2404",
      executor: "firecracker",
      imageRelease:
        "ghcr.io/fanzzzd/runner@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      vcpus: 4,
      memoryMiB: 8192,
    });
    assert.equal(invocation.file, "runner-center-runtime");
    assert.deepEqual(invocation.args, ["run"]);
    // A microVM guest has real vCPUs, so its nproc is honest without a cpuset.
    assert.equal(invocation.env.RC_CPUSET_CPUS, undefined);
    assert.deepEqual(invocation.env, {
      RC_ATTEMPT_ID: "attempt-1",
      RC_RUNNER_NAME: "runner-a",
      RC_PROFILE: "erainfra-4vcpu-ubuntu-2404",
      RC_IMAGE_RELEASE:
        "ghcr.io/fanzzzd/runner@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      RC_VCPUS: "4",
      RC_MEMORY_MIB: "8192",
      // Public, stated explicitly so the Agent's own environment cannot fill it.
      RC_PROFILE_EGRESS: "",
    });
    assert.doesNotMatch(JSON.stringify(invocation), /jit|secret/i);
  });

  it("hands the Profile's egress and the record path to the runtime", () => {
    const egress = {
      mode: "allowlist" as const,
      presets: ["github"],
      domains: ["registry.npmjs.org"],
      cidrs: [],
    };
    const { env } = attemptInvocation({
      attemptId: "attempt-1",
      runnerName: "runner-a",
      profile: "erainfra-4vcpu-ubuntu-2404-locked",
      executor: "firecracker",
      imageRelease: `ghcr.io/fanzzzd/runner@sha256:${"a".repeat(64)}`,
      vcpus: 4,
      memoryMiB: 8192,
      egress,
      egressRecordFile: "/tmp/rc-egress-abc/record.json",
    });
    assert.deepEqual(JSON.parse(env.RC_PROFILE_EGRESS ?? ""), egress);
    assert.equal(env.RC_EGRESS_RECORD_FILE, "/tmp/rc-egress-abc/record.json");
    // The host operator's override lives in the runtime's own environment and
    // is never something an Attempt sets.
    assert.equal("RC_EGRESS_MODE" in env, false);

    const experiment = experimentInvocation({
      experimentId: "experiment-1",
      name: "benchmark",
      profile: "erainfra-4vcpu-ubuntu-2404-locked",
      executor: "firecracker",
      imageRelease: `ghcr.io/fanzzzd/runner@sha256:${"a".repeat(64)}`,
      vcpus: 4,
      memoryMiB: 8192,
      timeoutSeconds: 900,
      egress,
    });
    assert.deepEqual(JSON.parse(experiment.env.RC_PROFILE_EGRESS ?? ""), egress);
  });

  it("refuses egress variables the agent's own environment happened to hold", () => {
    const saved = [process.env.RC_PROFILE_EGRESS, process.env.RC_EGRESS_RECORD_FILE];
    process.env.RC_PROFILE_EGRESS = '{"mode":"public"}';
    process.env.RC_EGRESS_RECORD_FILE = "/tmp/stale.json";
    try {
      const inherited = attemptEnvironment({});
      assert.equal("RC_PROFILE_EGRESS" in inherited, false);
      assert.equal("RC_EGRESS_RECORD_FILE" in inherited, false);
    } finally {
      if (saved[0] === undefined) delete process.env.RC_PROFILE_EGRESS;
      else process.env.RC_PROFILE_EGRESS = saved[0];
      if (saved[1] === undefined) delete process.env.RC_EGRESS_RECORD_FILE;
      else process.env.RC_EGRESS_RECORD_FILE = saved[1];
    }
  });

  it("hands the runtime a test report path only when the Agent made one", () => {
    const base = {
      attemptId: "attempt-1",
      runnerName: "runner-a",
      profile: "erainfra-4vcpu-ubuntu-2404",
      executor: "firecracker" as const,
      imageRelease: `ghcr.io/fanzzzd/runner@sha256:${"a".repeat(64)}`,
      vcpus: 4,
      memoryMiB: 16384,
    };
    const withReport = attemptInvocation({
      ...base,
      testReportFile: "/tmp/rc-egress-abc/tests.json",
    });
    assert.equal(withReport.env.RC_TEST_REPORT_FILE, "/tmp/rc-egress-abc/tests.json");
    assert.equal("RC_TEST_REPORT_FILE" in attemptInvocation(base).env, false);

    const saved = [process.env.RC_TEST_REPORT_FILE, process.env.ERAINFRA_TEST_REPORT_FILE];
    process.env.RC_TEST_REPORT_FILE = "/tmp/stale-tests.json";
    process.env.ERAINFRA_TEST_REPORT_FILE = "/tmp/stale-tests.json";
    try {
      const inherited = attemptEnvironment({});
      assert.equal("RC_TEST_REPORT_FILE" in inherited, false);
      assert.equal("ERAINFRA_TEST_REPORT_FILE" in inherited, false);
    } finally {
      if (saved[0] === undefined) delete process.env.RC_TEST_REPORT_FILE;
      else process.env.RC_TEST_REPORT_FILE = saved[0];
      if (saved[1] === undefined) delete process.env.ERAINFRA_TEST_REPORT_FILE;
      else process.env.ERAINFRA_TEST_REPORT_FILE = saved[1];
    }
  });

  it("reads the runtime's test report and ignores anything that is not one", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rc-tests-test-"));
    try {
      const path = join(directory, "tests.json");
      assert.equal(await readTestReport(undefined), undefined);
      assert.equal(await readTestReport(path), undefined);
      await writeFile(path, JSON.stringify({ version: 1, totals: { tests: 0 } }));
      assert.deepEqual(await readTestReport(path), { version: 1, totals: { tests: 0 } });
      await writeFile(path, "null");
      assert.equal(await readTestReport(path), undefined);
      await writeFile(path, " ".repeat(2 * 1024 * 1024 + 1));
      assert.equal(await readTestReport(path), undefined);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("hands the runtime a fresh runner exit path and never an inherited one", () => {
    const base = {
      attemptId: "attempt-1",
      runnerName: "runner-a",
      profile: "erainfra-4vcpu-ubuntu-2404",
      executor: "firecracker" as const,
      imageRelease: `ghcr.io/fanzzzd/runner@sha256:${"a".repeat(64)}`,
      vcpus: 4,
      memoryMiB: 16384,
    };
    const withFile = attemptInvocation({
      ...base,
      runnerExitFile: "/tmp/rc-egress-abc/runner-exit.json",
    });
    assert.equal(withFile.env.RC_RUNNER_EXIT_FILE, "/tmp/rc-egress-abc/runner-exit.json");
    assert.equal("RC_RUNNER_EXIT_FILE" in attemptInvocation(base).env, false);

    const saved = [process.env.RC_RUNNER_EXIT_FILE, process.env.ERAINFRA_RUNNER_EXIT_FILE];
    process.env.RC_RUNNER_EXIT_FILE = "/tmp/stale-runner-exit.json";
    process.env.ERAINFRA_RUNNER_EXIT_FILE = "/tmp/stale-runner-exit.json";
    try {
      const inherited = attemptEnvironment({});
      assert.equal("RC_RUNNER_EXIT_FILE" in inherited, false);
      assert.equal("ERAINFRA_RUNNER_EXIT_FILE" in inherited, false);
    } finally {
      if (saved[0] === undefined) delete process.env.RC_RUNNER_EXIT_FILE;
      else process.env.RC_RUNNER_EXIT_FILE = saved[0];
      if (saved[1] === undefined) delete process.env.ERAINFRA_RUNNER_EXIT_FILE;
      else process.env.ERAINFRA_RUNNER_EXIT_FILE = saved[1];
    }
  });

  it("reads the runner exit the runtime wrote, keeping only what the control plane accepts", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rc-runner-exit-test-"));
    try {
      const path = join(directory, "runner-exit.json");
      assert.equal(await readRunnerExit(undefined), undefined);
      // An older runtime or guest writes no file: the Attempt is reported as before.
      assert.equal(await readRunnerExit(path), undefined);
      await writeFile(
        path,
        JSON.stringify({ exitCode: 1, ranJob: false, diagnostic: "deprecated", later: true }),
      );
      assert.deepEqual(await readRunnerExit(path), {
        exitCode: 1,
        ranJob: false,
        diagnostic: "deprecated",
      });
      await writeFile(path, JSON.stringify({ exitCode: 0, ranJob: true }));
      assert.deepEqual(await readRunnerExit(path), { exitCode: 0, ranJob: true });
      await writeFile(path, JSON.stringify({ exitCode: "1", ranJob: false }));
      assert.equal(await readRunnerExit(path), undefined);
      await writeFile(path, JSON.stringify({ exitCode: 1.5, ranJob: false }));
      assert.equal(await readRunnerExit(path), undefined);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("reports an Attempt without its runner exit when the control plane refuses the field", async () => {
    const runnerExit = { exitCode: 1, ranJob: false, diagnostic: "deprecated" };
    const sent: unknown[] = [];
    await reportAttemptWithRunnerExit(
      async (args) => {
        sent.push(args);
        if ("runnerExit" in args) {
          throw new Error("ArgumentValidationError: Object contains extra field `runnerExit`");
        }
      },
      { attemptId: "a", exitCode: 0 },
      runnerExit,
    );
    assert.deepEqual(sent, [
      { attemptId: "a", exitCode: 0, runnerExit },
      { attemptId: "a", exitCode: 0 },
    ]);

    const accepted: unknown[] = [];
    await reportAttemptWithRunnerExit(
      async (args) => void accepted.push(args),
      { attemptId: "a", exitCode: 0 },
      runnerExit,
    );
    assert.deepEqual(accepted, [{ attemptId: "a", exitCode: 0, runnerExit }]);

    await assert.rejects(
      reportAttemptWithRunnerExit(
        async () => {
          throw new Error("network down");
        },
        { attemptId: "a", exitCode: 0 },
        runnerExit,
      ),
      /network down/,
    );
  });

  it("reads the runtime's egress record and ignores anything that is not one", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rc-egress-test-"));
    try {
      const path = join(directory, "record.json");
      assert.equal(await readEgressRecord(undefined), undefined);
      assert.equal(await readEgressRecord(path), undefined);
      await writeFile(path, JSON.stringify({ mode: "audit", names: [] }));
      assert.deepEqual(await readEgressRecord(path), { mode: "audit", names: [] });
      await writeFile(path, "[1,2,3]");
      assert.equal(await readEgressRecord(path), undefined);
      await writeFile(path, "{truncated");
      assert.equal(await readEgressRecord(path), undefined);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  // The microVM half of the T0 seam: the same CacheEndpoint the Docker branch
  // renames for provision-docker.sh becomes RC_CACHE_URL / RC_CACHE_SERVICE_V2
  // for runner-center-runtime, which validates them against the same rules and
  // carries them over MMDS into the runner's environment (#81, #110).
  it("forwards the cache endpoint to the runtime, and only when configured", () => {
    const base = {
      attemptId: "attempt-1",
      runnerName: "runner-a",
      profile: "erainfra-4vcpu-ubuntu-2404",
      executor: "firecracker" as const,
      imageRelease:
        "ghcr.io/fanzzzd/runner@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      vcpus: 4,
      memoryMiB: 8192,
    };
    for (const cache of [undefined, {}]) {
      const { env } = attemptInvocation({ ...base, cache });
      assert.equal(
        Object.keys(env).some((name) => name.startsWith("RC_CACHE")),
        false,
      );
    }
    const { env } = attemptInvocation({
      ...base,
      cache: { url: "https://cache.lan/erainfra/", serviceV2: "false" },
    });
    assert.equal(env.RC_CACHE_URL, "https://cache.lan/erainfra/");
    assert.equal(env.RC_CACHE_SERVICE_V2, "false");
    const flagOnly = attemptInvocation({ ...base, cache: { serviceV2: "true" } });
    assert.equal(flagOnly.env.RC_CACHE_SERVICE_V2, "true");
    assert.equal("RC_CACHE_URL" in flagOnly.env, false);
  });

  // attemptInvocation deciding the variables is only half the seam: spawnAttempt
  // merges the agent's own environment into the child's, so a stale value the
  // agent process was started with would ride that merge into an attempt that
  // configured no cache. attemptEnvironment strips all four names before the
  // attempt's own decisions apply.
  it("refuses cache variables the agent's own environment happened to hold", () => {
    const names = [
      "RC_CACHE_URL",
      "RC_CACHE_SERVICE_V2",
      "ERAINFRA_CACHE_URL",
      "ERAINFRA_CACHE_SERVICE_V2",
    ] as const;
    const saved = names.map((name) => [name, process.env[name]] as const);
    for (const name of names) process.env[name] = "https://stale.example/from-the-agent";
    try {
      // Unconfigured attempt: nothing inherited survives.
      for (const name of names) assert.equal(name in attemptEnvironment({}), false);
      // Partially configured attempt: only the configured half is present.
      const partial = attemptEnvironment({ RC_CACHE_SERVICE_V2: "true" });
      assert.equal(partial.RC_CACHE_SERVICE_V2, "true");
      assert.equal("RC_CACHE_URL" in partial, false);
      // Configured attempt: the attempt's decision wins, not the agent's env.
      const configured = attemptEnvironment({ RC_CACHE_URL: "https://cache.lan/erainfra/" });
      assert.equal(configured.RC_CACHE_URL, "https://cache.lan/erainfra/");
      // Everything else still inherits.
      assert.equal(attemptEnvironment({}).PATH, process.env.PATH);
    } finally {
      for (const [name, value] of saved) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  it("reuses the validated Tart path for macOS Profiles", () => {
    const invocation = attemptInvocation({
      attemptId: "attempt-2",
      runnerName: "runner-b",
      profile: "erainfra-4vcpu-macos-15",
      executor: "tart",
      imageRelease:
        "ghcr.io/cirruslabs/macos-sequoia-base@sha256:fdd8b72a6ee46fc8ad35dc1b9f3b1f162b6607b82a584947d20bb28d3dcb99ed",
      vcpus: 4,
      memoryMiB: 8192,
    });
    assert.equal(invocation.file, provisionerPath("mac"));
    assert.deepEqual(invocation.env, {
      RUNNER_NAME: "runner-b",
      IMAGE:
        "ghcr.io/cirruslabs/macos-sequoia-base@sha256:fdd8b72a6ee46fc8ad35dc1b9f3b1f162b6607b82a584947d20bb28d3dcb99ed",
    });
  });
});

describe("Experiment invocation", () => {
  it("uses the isolated runtime and keeps the command off argv and env", () => {
    const invocation = experimentInvocation({
      experimentId: "experiment-1",
      name: "benchmark",
      profile: "erainfra-4vcpu-ubuntu-2404",
      executor: "firecracker",
      imageRelease:
        "ghcr.io/fanzzzd/runner@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      vcpus: 4,
      memoryMiB: 8192,
      timeoutSeconds: 900,
    });
    assert.equal(invocation.file, "runner-center-runtime");
    assert.deepEqual(invocation.args, ["experiment"]);
    assert.equal(invocation.env.RC_JOB_TIMEOUT_S, "900");
    assert.doesNotMatch(JSON.stringify(invocation), /pnpm test|bash -lc/);
  });
});
