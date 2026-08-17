import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { FAKE_HOST_KEY, FAKE_JIT, Harness, PROVISION_MAC, waitFor } from "./helpers/harness.ts";

const SENTINEL = "RC-FAKE-JIT-SENTINEL-DO-NOT-LEAK";

// Read out of the script so the fixtures follow the pin rather than restating
// it: the image reference is also what the host key pin file is named after.
const DEFAULT_IMAGE = (() => {
  const match = /^RC_DEFAULT_IMAGE="([^"]+)"$/m.exec(readFileSync(PROVISION_MAC, "utf8"));
  assert.ok(match, "provision-mac.sh no longer declares RC_DEFAULT_IMAGE");
  return match[1] as string;
})();

const harnesses: Harness[] = [];
function newHarness(options?: { tarballContent?: string }) {
  const harness = new Harness(options);
  harnesses.push(harness);
  return harness;
}

after(() => {
  // The OS reaps TMPDIR; nothing here holds a handle open.
  harnesses.length = 0;
});

describe("provision-mac.sh preflight", () => {
  it("rejects an empty JIT configuration", async () => {
    const harness = newHarness();
    const result = await harness.run(PROVISION_MAC, { stdin: "" });

    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /empty JIT configuration/);
    assert.doesNotMatch(harness.argv(), /clone/);
  });

  it("rejects a JIT configuration that is not base64", async () => {
    const harness = newHarness();
    const result = await harness.run(PROVISION_MAC, { stdin: "not base64 !!!" });

    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /not base64/);
  });

  it("rejects a runner name that would not be a safe VM name", async () => {
    const harness = newHarness();
    const result = await harness.run(PROVISION_MAC, {
      env: { RUNNER_NAME: "rc; rm -rf /" },
    });

    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /RUNNER_NAME must match/);
  });

  it("names the install command when tart is missing", async () => {
    const harness = newHarness();
    const result = await harness.run(PROVISION_MAC, {
      env: { TART: join(harness.root, "nope", "tart") },
    });

    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /brew install cirruslabs\/cli\/tart/);
  });

  it("names the install command when sshpass is missing", async () => {
    const harness = newHarness();
    const result = await harness.run(PROVISION_MAC, {
      env: { SSHPASS: join(harness.root, "nope", "sshpass") },
    });

    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /brew install cirruslabs\/cli\/sshpass/);
  });

  it("refuses to reuse a VM that already exists", async () => {
    const harness = newHarness();
    const result = await harness.run(PROVISION_MAC, {
      env: { RC_FAKE_TART_NAMES: "some-other-vm\nrc-test-runner\n" },
    });

    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /already exists/);
    assert.match(result.stderr, /tart delete rc-test-runner/);
  });

  it("refuses to run on a host that is not Apple Silicon", async () => {
    const harness = newHarness();
    const result = await harness.run(PROVISION_MAC, {
      env: { RC_FAKE_UNAME_M: "x86_64" },
    });

    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /Apple Silicon/);
  });

  it("recognises a cached image whose reference contains slashes", async () => {
    const harness = newHarness();
    const result = await harness.run(PROVISION_MAC, {
      env: { RC_FAKE_TART_NAMES: `${DEFAULT_IMAGE}\n` },
    });

    assert.equal(result.code, 0);
    assert.doesNotMatch(result.stdout, /is not in the local Tart cache/);
    assert.ok(!harness.argv().includes("https://ghcr.io/v2/"));
  });

  it("treats ghcr's anonymous 401 as reachable", async () => {
    const harness = newHarness();
    const result = await harness.run(PROVISION_MAC);

    assert.equal(result.code, 0);
    assert.match(result.stdout, /is not in the local Tart cache/);
    assert.match(harness.argv(), /https:\/\/ghcr\.io\/v2\//);
  });

  it("explains how to pre-pull an image when ghcr is unreachable", async () => {
    const harness = newHarness();
    const result = await harness.run(PROVISION_MAC, {
      env: { RC_FAKE_CURL_FAIL: "1" },
    });

    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /ghcr\.io is unreachable/);
  });
});

describe("provision-mac.sh pinned runner", () => {
  it("downloads the pinned osx-arm64 release and caches it", async () => {
    const harness = newHarness();
    const result = await harness.run(PROVISION_MAC);

    assert.equal(result.code, 0);
    assert.match(
      harness.argv(),
      /https:\/\/github\.com\/actions\/runner\/releases\/download\/v2\.336\.0\/actions-runner-osx-arm64-2\.336\.0\.tar\.gz/,
    );
    assert.ok(
      existsSync(
        join(harness.home, ".runner-center", "cache", "actions-runner-osx-arm64-2.336.0.tar.gz"),
      ),
    );
  });

  it("refuses a tarball whose checksum does not match the pin", async () => {
    const harness = newHarness();
    const result = await harness.run(PROVISION_MAC, {
      env: { RC_MAC_RUNNER_SHA256: "0".repeat(64) },
    });

    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /Checksum mismatch/);
    assert.match(result.stderr, /Refusing to run an unverified runner/);
    assert.doesNotMatch(harness.argv(), /\tclone\t/);
  });

  it("discards a cached tarball that no longer matches the pin", async () => {
    const harness = newHarness();
    const cache = join(harness.home, ".runner-center", "cache");
    mkdirSync(cache, { recursive: true });
    writeFileSync(join(cache, "actions-runner-osx-arm64-2.336.0.tar.gz"), "tampered");

    const result = await harness.run(PROVISION_MAC);

    assert.equal(result.code, 0);
    assert.match(result.stderr, /failed its checksum; re-downloading/);
    assert.equal(
      readFileSync(join(cache, "actions-runner-osx-arm64-2.336.0.tar.gz"), "utf8"),
      harness.tarballContent,
    );
  });

  it("reuses a verified cache instead of downloading again", async () => {
    const harness = newHarness();

    assert.equal((await harness.run(PROVISION_MAC)).code, 0);
    const downloadsAfterFirst = countDownloads(harness.argv());
    assert.equal((await harness.run(PROVISION_MAC)).code, 0);

    assert.equal(countDownloads(harness.argv()), downloadsAfterFirst);
  });

  it("makes the guest verify the same digest before unpacking", async () => {
    const harness = newHarness();
    assert.equal((await harness.run(PROVISION_MAC)).code, 0);

    const captures = harness.stdinCaptures();
    assert.match(captures, /shasum -a 256/);
    assert.ok(captures.includes(harness.tarballSha256));
    assert.match(captures, /does not match the pinned/);
  });
});

describe("provision-mac.sh secret handling", () => {
  it("never puts the JIT configuration in any process argument", async () => {
    const harness = newHarness();
    const result = await harness.run(PROVISION_MAC);

    assert.equal(result.code, 0);
    const argv = harness.argv();
    assert.ok(!argv.includes(FAKE_JIT), "the JIT configuration leaked into argv");
    assert.ok(!argv.includes(SENTINEL), "the decoded JIT marker leaked into argv");
  });

  it("never prints the JIT configuration", async () => {
    const harness = newHarness();
    const result = await harness.run(PROVISION_MAC);

    assert.ok(!result.stdout.includes(FAKE_JIT));
    assert.ok(!result.stderr.includes(FAKE_JIT));
  });

  it("delivers the JIT configuration over the SSH channel's stdin", async () => {
    const harness = newHarness();
    assert.equal((await harness.run(PROVISION_MAC)).code, 0);

    assert.ok(
      harness.stdinCaptures().includes(FAKE_JIT),
      "the JIT configuration never reached the guest",
    );
  });

  it("hands the runner ACTIONS_RUNNER_INPUT_JITCONFIG rather than --jitconfig", async () => {
    const harness = newHarness();
    assert.equal((await harness.run(PROVISION_MAC)).code, 0);

    const captures = harness.stdinCaptures();
    assert.match(captures, /export ACTIONS_RUNNER_INPUT_JITCONFIG/);
    assert.ok(!captures.includes("--jitconfig"), "the runner was still invoked with --jitconfig");
    assert.ok(!harness.argv().includes("--jitconfig"));
  });

  it("removes the staged JIT file in the guest before the runner starts", async () => {
    const harness = newHarness();
    assert.equal((await harness.run(PROVISION_MAC)).code, 0);

    const runScript = harness
      .stdinCaptures()
      .split("\n---\n")
      .find((capture) => capture.includes("ACTIONS_RUNNER_INPUT_JITCONFIG"));

    assert.ok(runScript);
    const removal = runScript.indexOf('rm -f "$jit_file"');
    const exec = runScript.indexOf("exec ./bin/Runner.Listener run");
    assert.ok(removal > -1 && exec > -1 && removal < exec);
  });

  it("does not pass the guest password on the sshpass command line", async () => {
    const harness = newHarness();
    assert.equal((await harness.run(PROVISION_MAC)).code, 0);

    for (const line of harness.argv().split("\n")) {
      if (!line.startsWith("sshpass\t")) {
        continue;
      }
      assert.ok(!line.split("\t").includes("-p"), "sshpass -p exposes the password in ps");
      assert.ok(line.split("\t").includes("-f"));
      assert.ok(!line.includes("admin\t"), "the password appeared verbatim in argv");
    }
  });
});

describe("provision-mac.sh host key handling", () => {
  it("never disables host key checking", async () => {
    const harness = newHarness();
    assert.equal((await harness.run(PROVISION_MAC)).code, 0);

    const argv = harness.argv();
    assert.ok(!argv.includes("StrictHostKeyChecking=no"));
    assert.ok(!argv.includes("UserKnownHostsFile=/dev/null"));
  });

  it("pins a key attested over the guest agent and checks strictly", async () => {
    const harness = newHarness();
    const result = await harness.run(PROVISION_MAC);

    assert.equal(result.code, 0);
    assert.match(result.stdout, /Pinned the SSH host key/);
    assert.match(harness.argv(), /StrictHostKeyChecking=yes/);

    const pins = join(harness.home, ".runner-center", "known_hosts.d");
    assert.ok(existsSync(pins));
  });

  it("warns about first-use trust when the guest agent is unavailable", async () => {
    const harness = newHarness();
    const result = await harness.run(PROVISION_MAC, {
      env: { RC_FAKE_TART_NO_GUEST_AGENT: "1", RC_MAC_ATTEST_TIMEOUT_S: "2" },
    });

    assert.equal(result.code, 0);
    assert.match(result.stderr, /trusts the key presented on first contact/);
    assert.match(harness.argv(), /StrictHostKeyChecking=accept-new/);
  });

  it("aborts when the attested key contradicts the pinned key", async () => {
    const harness = newHarness();
    const pins = join(harness.home, ".runner-center", "known_hosts.d");
    mkdirSync(pins, { recursive: true });
    // The pin file name is the sanitised image reference.
    writeFileSync(
      join(pins, `${DEFAULT_IMAGE.replace(/[^A-Za-z0-9._-]/g, "_")}.pub`),
      `${FAKE_HOST_KEY.replace(/Fa$/, "Zz")}\n`,
    );

    const result = await harness.run(PROVISION_MAC);

    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /SSH host key of .* changed/);
    assert.match(result.stderr, /tampered image/);
    assert.match(harness.argv(), /\tdelete\trc-test-runner/);
  });
});

describe("provision-mac.sh VM lifecycle", () => {
  it("deletes the VM after a successful run", async () => {
    const harness = newHarness();
    const result = await harness.run(PROVISION_MAC);

    assert.equal(result.code, 0);
    assert.match(harness.argv(), /\tdelete\trc-test-runner/);
  });

  it("propagates the runner exit code and still deletes the VM", async () => {
    const harness = newHarness();
    const result = await harness.run(PROVISION_MAC, {
      env: { RC_FAKE_RUNNER_EXIT: "3" },
    });

    assert.equal(result.code, 3);
    assert.match(harness.argv(), /\tdelete\trc-test-runner/);
  });

  it("deletes the VM when the guest never gets an IP address", async () => {
    const harness = newHarness();
    const result = await harness.run(PROVISION_MAC, {
      env: { RC_FAKE_TART_NO_IP: "1", RC_BOOT_TIMEOUT_S: "4" },
    });

    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /Timed out after 4s waiting for rc-test-runner/);
    assert.match(harness.argv(), /\tdelete\trc-test-runner/);
  });

  it("deletes the VM when the install step fails", async () => {
    const harness = newHarness();
    const result = await harness.run(PROVISION_MAC, {
      env: { RC_FAKE_INSTALL_EXIT: "1" },
    });

    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /Failed to install actions\/runner/);
    assert.match(harness.argv(), /\tdelete\trc-test-runner/);
  });

  it("deletes the VM when the provisioner is terminated", async () => {
    const harness = newHarness();
    const running = harness.start(PROVISION_MAC, {
      env: { RC_FAKE_RUNNER_SLEEP: "60" },
    });

    await waitFor(() => running.output().includes("Starting ephemeral runner"));
    running.kill("SIGTERM");
    const result = await running.done;

    assert.equal(result.code, 143);
    assert.match(harness.argv(), /\tdelete\trc-test-runner/);
  });

  it("deletes the VM and exits 124 when the job outlives its timeout", async () => {
    const harness = newHarness();
    const result = await harness.run(PROVISION_MAC, {
      env: { RC_FAKE_RUNNER_SLEEP: "60", RC_JOB_TIMEOUT_S: "2" },
    });

    assert.equal(result.code, 124);
    assert.match(result.stderr, /exceeded RC_JOB_TIMEOUT_S/);
    assert.match(harness.argv(), /\tdelete\trc-test-runner/);
  });

  it("still honours the per-OS timeout name as a compatibility fallback", async () => {
    const harness = newHarness();
    const result = await harness.run(PROVISION_MAC, {
      // This case tests precedence, not prompt process-group teardown (covered
      // above). Keep the fake job bounded so a loaded CI host cannot turn a
      // missed TERM scheduling window into the harness's 60-second kill path.
      env: { RC_FAKE_RUNNER_SLEEP: "5", RC_MAC_JOB_TIMEOUT_S: "1", RC_JOB_TIMEOUT_S: "" },
    });

    assert.equal(result.code, 124);
  });

  it("stops the VM before deleting it", async () => {
    const harness = newHarness();
    assert.equal((await harness.run(PROVISION_MAC)).code, 0);

    const argv = harness.argv();
    assert.ok(argv.indexOf("\tstop\trc-test-runner") < argv.indexOf("\tdelete\trc-test-runner"));
  });
});

function countDownloads(argv: string) {
  return argv.split("\n").filter((line) => line.includes("actions-runner-osx-arm64")).length;
}
