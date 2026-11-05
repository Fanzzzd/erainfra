// The sh copy of the dual-name read. Each provisioner, and the Firecracker host
// provisioner that /install --role worker-host embeds, runs standalone on a
// Worker, so each carries its own copy of dual_env_resolve. These tests read the
// real function out of the real files and run it, rather than restating it.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  FAKE_JIT,
  Harness,
  PROVISION_DOCKER,
  PROVISION_LINUX,
  PROVISION_MAC,
} from "./helpers/harness.ts";

const REPO = fileURLToPath(new URL("../../../", import.meta.url));
const COPIES = [
  PROVISION_DOCKER,
  PROVISION_LINUX,
  PROVISION_MAC,
  join(REPO, "deploy", "provision-firecracker-host.sh"),
];

function extract(path: string) {
  const source = readFileSync(path, "utf8");
  const match = /^dual_env_resolve\(\) \{\n[\s\S]*?\n\}\n/m.exec(source);
  assert.ok(match, `${path} carries no dual_env_resolve`);
  return match[0];
}

const HELPER = extract(PROVISION_DOCKER);
// bash on macOS sources ~/.bashrc for some non-interactive invocations, and a
// developer's rc file has no business in these assertions.
const EMPTY_HOME = mkdtempSync(join(tmpdir(), "dual-env-sh-"));

/** Runs the helper on RC_PROFILE under `shell` and reports what it resolved. */
function resolve(shell: string, env: Record<string, string>) {
  const result = spawnSync(
    shell,
    ["-c", `set -eu\n${HELPER}\ndual_env_resolve RC_PROFILE\nprintf '%s' "\${RC_PROFILE-<unset>}"`],
    { env: { PATH: process.env.PATH ?? "", HOME: EMPTY_HOME, ...env }, encoding: "utf8" },
  );
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe("dual_env_resolve", () => {
  it("is the same function in every script that carries it", () => {
    for (const path of COPIES) {
      assert.equal(extract(path), HELPER, `${path} has drifted from provision-docker.sh`);
    }
  });

  const cases: { name: string; env: Record<string, string>; want?: string; conflict?: true }[] = [
    // Every Worker in the field today.
    { name: "only the legacy name", env: { RC_PROFILE: "old" }, want: "old" },
    { name: "only the new name", env: { ERAINFRA_PROFILE: "new" }, want: "new" },
    { name: "both, equal", env: { ERAINFRA_PROFILE: "same", RC_PROFILE: "same" }, want: "same" },
    {
      name: "both, different",
      env: { ERAINFRA_PROFILE: "value-under-new", RC_PROFILE: "value-under-old" },
      conflict: true,
    },
    { name: "neither", env: {}, want: "<unset>" },
    // `${RC_X:-default}` already treated empty as unset; so does the new name.
    {
      name: "new empty, legacy set",
      env: { ERAINFRA_PROFILE: "", RC_PROFILE: "old" },
      want: "old",
    },
    {
      name: "legacy empty, new set",
      env: { ERAINFRA_PROFILE: "new", RC_PROFILE: "" },
      want: "new",
    },
    { name: "both empty", env: { ERAINFRA_PROFILE: "", RC_PROFILE: "" }, want: "" },
  ];
  for (const shell of ["sh", "bash"]) {
    for (const testCase of cases) {
      it(`${shell}: ${testCase.name}`, () => {
        const result = resolve(shell, testCase.env);
        if (testCase.conflict) {
          assert.equal(result.code, 2);
          assert.match(result.stderr, /ERAINFRA_PROFILE and RC_PROFILE are both set/);
          assert.doesNotMatch(result.stderr, /value-under/);
          assert.equal(result.stdout, "");
          return;
        }
        assert.equal(result.code, 0, result.stderr);
        assert.equal(result.stdout, testCase.want);
        assert.equal(result.stderr, "");
      });
    }
  }
});

const IMAGE = `ghcr.io/fanzzzd/runner-center-ubuntu-js@sha256:${"a".repeat(64)}`;
const DOCKER_SETTINGS = {
  PROFILE: "linux-js",
  VCPUS: "4",
  MEMORY_MIB: "8192",
  CPUSET_CPUS: "4-7",
  JOB_TIMEOUT_S: "60",
  DNS_SERVERS: "10.0.0.53",
};

function dockerEnv(prefix: string) {
  return {
    IMAGE,
    ...Object.fromEntries(
      Object.entries(DOCKER_SETTINGS).map(([suffix, value]) => [prefix + suffix, value]),
    ),
  };
}

describe("provisioners read both names", () => {
  it("provision-docker.sh runs a job configured with only ERAINFRA_ names", async () => {
    const harness = new Harness();
    // The harness sets RC_JOB_TIMEOUT_S for every run; empty is unset.
    const result = await harness.run(PROVISION_DOCKER, {
      env: { ...dockerEnv("ERAINFRA_"), RC_JOB_TIMEOUT_S: "" },
    });
    assert.equal(result.code, 0, result.stderr);
    const argv = harness.argv();
    assert.match(argv, /--cpus\t4\t--cpuset-cpus\t4-7\t/);
    assert.match(argv, /--label\trunner-center\.profile=linux-js/);
    // What the job itself is told keeps its frozen name.
    assert.match(argv, /--env\tRC_VCPUS=4\t/);
    assert.match(argv, /--dns\t10\.0\.0\.53\t/);
  });

  it("provision-docker.sh refuses names that disagree before starting Docker", async () => {
    const harness = new Harness();
    const result = await harness.run(PROVISION_DOCKER, {
      env: { ...dockerEnv("RC_"), ERAINFRA_VCPUS: "2" },
    });
    assert.equal(result.code, 2);
    assert.match(result.stderr, /ERAINFRA_VCPUS and RC_VCPUS are both set/);
    assert.doesNotMatch(harness.argv(), /^docker\t/m);
  });

  it("provision-linux.sh refuses names that disagree before starting Docker", async () => {
    const harness = new Harness();
    const result = await harness.run(PROVISION_LINUX, {
      env: { RC_JOB_TIMEOUT_S: "60", ERAINFRA_JOB_TIMEOUT_S: "120" },
      stdin: FAKE_JIT,
    });
    assert.equal(result.code, 2);
    assert.match(result.stderr, /ERAINFRA_JOB_TIMEOUT_S and RC_JOB_TIMEOUT_S are both set/);
    assert.doesNotMatch(harness.argv(), /^docker\t/m);
  });

  it("provision-mac.sh refuses names that disagree before starting Tart", async () => {
    const harness = new Harness();
    // The harness sets RC_JOB_TIMEOUT_S=0 for every run.
    const result = await harness.run(PROVISION_MAC, { env: { ERAINFRA_JOB_TIMEOUT_S: "120" } });
    assert.equal(result.code, 2);
    assert.match(result.stderr, /ERAINFRA_JOB_TIMEOUT_S and RC_JOB_TIMEOUT_S are both set/);
    assert.doesNotMatch(harness.argv(), /^tart\t/m);
  });

  it("provision-mac.sh takes its state directory from ERAINFRA_HOME", async () => {
    const harness = new Harness();
    const lib = spawnSync(
      "bash",
      ["-c", `. "${PROVISION_MAC}"; dual_env_resolve RC_HOME; printf '%s' "$RC_HOME"`],
      {
        env: {
          ...harness.env({ RC_PROVISION_MAC_LIB_ONLY: "1" }),
          RC_HOME: "",
          ERAINFRA_HOME: "/srv/worker-state",
        },
        encoding: "utf8",
      },
    );
    assert.equal(lib.status, 0, lib.stderr);
    assert.equal(lib.stdout, "/srv/worker-state");
  });
});
