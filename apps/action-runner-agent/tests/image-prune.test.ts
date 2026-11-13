import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  IMAGE_PRUNE_INTERVAL_MS,
  imageReleasesToKeep,
  pruneImageReleases,
} from "../image-prune.ts";
import type { ProfileSpec } from "../readiness.ts";

const current = `ghcr.io/fanzzzd/runner-center-ubuntu-24.04-full@sha256:${"7".repeat(64)}`;
const canary = `ghcr.io/fanzzzd/runner-center-ubuntu-24.04-full@sha256:${"8".repeat(64)}`;

function profile(name: string, imageRelease: string, executor = "firecracker") {
  return { profile: name, executor, imageRelease, vcpus: 4, memoryMiB: 16_384 } as ProfileSpec;
}

const profiles = [
  profile("erainfra-4vcpu-ubuntu-2404", current),
  profile("erainfra-16vcpu-ubuntu-2404", current),
  profile("erainfra-canary-4vcpu-ubuntu-2404", canary),
  profile("docker-linux", "ghcr.io/example/docker@sha256:" + "9".repeat(64), "docker"),
];

test("keeps every Firecracker Profile's Image Release once", () => {
  assert.deepEqual(imageReleasesToKeep(profiles), [current, canary]);
});

test("sends the Image Releases to keep and remembers when it ran", async () => {
  const sent: string[][] = [];
  const at = await pruneImageReleases(profiles, Number.NEGATIVE_INFINITY, 1_000, async (keep) => {
    sent.push(keep);
    return { exitCode: 0, stdout: JSON.stringify({ kept: keep, deleted: ["old"] }), stderr: "" };
  });
  assert.equal(at, 1_000);
  assert.deepEqual(sent, [[current, canary]]);
});

test("prunes at most once an hour", async () => {
  let runs = 0;
  const run = async () => {
    runs += 1;
    return { exitCode: 0, stdout: '{"kept":[],"deleted":[]}', stderr: "" };
  };
  assert.equal(await pruneImageReleases(profiles, 0, IMAGE_PRUNE_INTERVAL_MS - 1, run), 0);
  assert.equal(runs, 0);
  assert.equal(
    await pruneImageReleases(profiles, 0, IMAGE_PRUNE_INTERVAL_MS, run),
    IMAGE_PRUNE_INTERVAL_MS,
  );
  assert.equal(runs, 1);
});

test("never prunes without a Firecracker Profile", async () => {
  let runs = 0;
  const at = await pruneImageReleases([profiles[3]!], Number.NEGATIVE_INFINITY, 5, async () => {
    runs += 1;
    return { exitCode: 0, stdout: "{}", stderr: "" };
  });
  assert.equal(runs, 0);
  assert.equal(at, Number.NEGATIVE_INFINITY);
});

test("a failed prune waits for the next interval instead of retrying every pass", async () => {
  const at = await pruneImageReleases(profiles, Number.NEGATIVE_INFINITY, 42, async () => ({
    exitCode: 1,
    stdout: "",
    stderr: "containerd unavailable",
  }));
  assert.equal(at, 42);
});

// The runtime writes what `prune-images` prints (apps/runtime/internal/runtimeapi/stdout_golden_test.go).
test("reports the Image Releases the runtime's prune result says it deleted", async (t) => {
  const stdout = readFileSync(
    new URL("../../runtime/internal/runtimeapi/testdata/prune-images.golden.json", import.meta.url),
    "utf8",
  );
  const { deleted } = JSON.parse(stdout) as { deleted: string[] };
  assert.ok(deleted.length > 0);
  const log = t.mock.method(console, "log", () => {});
  await pruneImageReleases(profiles, Number.NEGATIVE_INFINITY, 1, async () => ({
    exitCode: 0,
    stdout,
    stderr: "",
  }));
  assert.deepEqual(
    log.mock.calls.map((call) => call.arguments[0]),
    [`Deleted ${deleted.length} Image Release(s) no Profile uses: ${deleted.join(", ")}`],
  );
});
