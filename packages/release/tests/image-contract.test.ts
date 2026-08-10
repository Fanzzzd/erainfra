import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

const repoRoot = path.resolve(import.meta.dirname, "..", "..", "..");
const dockerfile = readFileSync(
  path.join(repoRoot, "images", "ubuntu-24.04-js", "Dockerfile"),
  "utf8",
);

const cachedActions = [
  ["actions/checkout", "actions_checkout"],
  ["pnpm/action-setup", "pnpm_action-setup"],
  ["actions/setup-node", "actions_setup-node"],
  ["actions/setup-go", "actions_setup-go"],
] as const;

function workflowPins(relativePath: string) {
  const workflow = readFileSync(path.join(repoRoot, relativePath), "utf8");
  return new Map(
    [...workflow.matchAll(/uses:\s+([^@\s]+)@([a-f0-9]{40})/g)].map((match) => [
      match[1],
      match[2],
    ]),
  );
}

describe("Linux Image Release action cache", () => {
  it("seeds the exact immutable Actions used by CI", () => {
    const pins = workflowPins(".github/workflows/ci.yml");
    for (const [action, cacheDirectory] of cachedActions) {
      const commit = pins.get(action);
      assert.ok(commit, `${action} must remain pinned by commit SHA in CI`);
      assert.match(
        dockerfile,
        new RegExp(`/opt/action-cache/${cacheDirectory}/${commit}\\.tar\\.gz`),
        `${action}@${commit} is missing from the Image Release cache`,
      );
    }
  });

  it("enables the runner's supported archive-cache environment variable", () => {
    const guest = readFileSync(
      path.join(repoRoot, "apps", "runtime", "cmd", "runner-center-guest", "main_linux.go"),
      "utf8",
    );
    assert.match(guest, /ACTIONS_RUNNER_ACTION_ARCHIVE_CACHE=/);
  });

  it("puts pnpm in the Profile-local trusted cache mount", () => {
    assert.match(dockerfile, /storeDir: \/runner-cache\/pnpm/);
    assert.match(dockerfile, /verifyStoreIntegrity: true/);
  });
});
