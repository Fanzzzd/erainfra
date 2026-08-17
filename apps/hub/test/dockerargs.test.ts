import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { validateDockerArgs } from "../src/runtime/dockerargs.ts";

// The same fixture is read by apps/infra-agent/internal/agent/dockerargs_conformance_test.go.
// It lives at the repository root rather than under either app because it belongs to neither:
// it is the definition of the boundary, and the two validators are implementations of it.
const FIXTURE = join(import.meta.dirname, "../../../testdata/dockerargs-cases.json");

type Case = {
  name: string;
  args: string[];
  expect: "accept" | "reject";
  provisional?: boolean;
  why: string;
};

const cases: Case[] = JSON.parse(readFileSync(FIXTURE, "utf8")).cases;

// A fixture that silently read as empty would turn this whole file into a test that
// passes by doing nothing, which is the one failure mode a table test has that a
// hand-written one does not.
test("the shared conformance fixture is loaded", () => {
  assert.ok(cases.length > 0, "no cases read from testdata/dockerargs-cases.json");
  assert.equal(new Set(cases.map((c) => c.name)).size, cases.length, "duplicate case names");
});

for (const testCase of cases) {
  test(`dockerargs conformance: ${testCase.name}`, () => {
    const error = validateDockerArgs(testCase.args);
    const verdict = error === null ? "accept" : "reject";
    assert.equal(
      verdict,
      testCase.expect,
      `${JSON.stringify(testCase.args)}\n  expected ${testCase.expect}, got ${verdict}` +
        `${error === null ? "" : ` (${error})`}\n  why: ${testCase.why}`,
    );
  });
}
