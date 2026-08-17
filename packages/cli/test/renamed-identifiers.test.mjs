// Stage 1 of retiring the "Portless" name (ADR 0004; CONTEXT.md rule 4) for the CLI.
//
// The CLI is a single zero-dependency file a dev machine downloads from `<hub>/cli/portless.mjs`
// and runs on its own, so it cannot import apps/hub/src/env.ts and carries its own copy of the
// idiom. That copy needs its own proof, which is what this file is.
//
// Nothing here mocks the helper: it drives the real CLI as a subprocess, because the property under
// test is what a dev machine with only PORTLESS_* set actually does.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "portless.mjs");

// `nodes` needs a hub and a token, and fails to CONNECT rather than failing to configure — which is
// exactly the signal: the error message names the hub it resolved, so it reports which value won
// without needing a server. HOME is redirected so a developer's real ~/.portless/config.json cannot
// supply either value and mask a broken read.
function run(env, home) {
  const clean = { ...process.env };
  for (const k of Object.keys(clean))
    if (k.startsWith("PORTLESS_") || k.startsWith("ERAINFRA_")) delete clean[k];
  const r = spawnSync(process.execPath, [CLI, "nodes"], {
    env: {
      ...clean,
      HOME: home ?? join(dirname(fileURLToPath(import.meta.url)), "no-such-home"),
      ...env,
    },
    encoding: "utf8",
  });
  return { out: r.stdout ?? "", err: r.stderr ?? "" };
}

test("the CLI reads the new hub/token names, silently", () => {
  const { err } = run({ ERAINFRA_HUB: "http://127.0.0.1:1/new", ERAINFRA_TOKEN: "t" });
  assert.match(err, /127\.0\.0\.1:1\/new/, "the new name's value must be the one used");
  assert.doesNotMatch(err, /retired name/, "the supported name must not warn");
});

test("THE property: the retired hub/token names alone are still sufficient", () => {
  // This is every dev machine in the field. If this test fails, the PR breaks all of them.
  const { err } = run({ PORTLESS_HUB: "http://127.0.0.1:1/old", PORTLESS_TOKEN: "t" });
  assert.match(err, /127\.0\.0\.1:1\/old/, "PORTLESS_HUB alone no longer reaches the transport");
  assert.match(err, /PORTLESS_HUB is a retired name/);
  assert.match(err, /ERAINFRA_HUB/, "the warning has to name the replacement to be actionable");
});

test("both set → the new name wins", () => {
  const { err } = run({
    ERAINFRA_HUB: "http://127.0.0.1:1/new",
    PORTLESS_HUB: "http://127.0.0.1:1/old",
    ERAINFRA_TOKEN: "t",
  });
  assert.match(err, /127\.0\.0\.1:1\/new/);
  assert.doesNotMatch(err, /\/old/);
});

test("neither set → the pre-existing 'not connected' error, not a crash", () => {
  // The silent-break case: with no config file and no environment, the CLI must still reach its own
  // guidance rather than dying on an undefined URL.
  const { err } = run({});
  assert.match(err, /not connected to a hub/);
  assert.doesNotMatch(err, /retired name/);
});

test("PORTLESS_HUB_URL still outranks PORTLESS_HUB, exactly as it did", () => {
  const { err } = run({
    PORTLESS_HUB_URL: "http://127.0.0.1:1/url",
    PORTLESS_HUB: "http://127.0.0.1:1/hub",
    PORTLESS_TOKEN: "t",
  });
  assert.match(
    err,
    /127\.0\.0\.1:1\/url/,
    "the precedence between the two old names must not move",
  );
});
