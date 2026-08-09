import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { provisionerPath, provisionInvocation } from "../provision.ts";
import { PROVISION_LINUX, PROVISION_MAC } from "./helpers/harness.ts";

const SHELL_PROVISIONERS = [PROVISION_MAC, PROVISION_LINUX];

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

  it("delivers the JIT configuration to every provisioner on stdin", () => {
    const source = readFileSync(fileURLToPath(new URL("../provision.ts", import.meta.url)), "utf8");
    assert.match(source, /input: jitConfig/);
    assert.ok(
      !/\bJIT_CONFIG\b/.test(source),
      "the agent still puts the JIT configuration in the child's environment",
    );
  });
});

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
      // apps/agent is also distributed on its own, without the backend.
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
