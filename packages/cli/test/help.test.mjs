// `portless` stays the Hub's CLI while the Hub is retired (ADR 0016 phase 3c); its help points an
// operator whose Nodes run connect-convex at `erainfra`, which talks to Convex.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "portless.mjs");

test("help names the erainfra CLI for Convex and keeps every Hub command", () => {
  const r = spawnSync(process.execPath, [CLI, "help"], {
    env: { ...process.env, NO_COLOR: "1" },
    encoding: "utf8",
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /use the erainfra CLI: erainfra --help/);
  for (const command of ["deploy [dir]", "logs <app>", "env <app>", "link <node>", "remove <app>"])
    assert.ok(r.stdout.includes(command), `help lost ${command}`);
});
