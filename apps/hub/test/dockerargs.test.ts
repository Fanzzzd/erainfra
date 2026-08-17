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

// The shared fixture cannot carry this case, so it is pinned natively on each side instead.
// Measured: JSON.parse keeps an unpaired surrogate escape, so `"a\\ud800b"` in the fixture would
// reach this validator as a three-unit string with a lone surrogate in it — while Go's
// encoding/json rewrites the same escape to U+FFFD and hands its validator five well-formed
// bytes. A row spelled that way would look shared and would in fact be testing two different
// inputs on the two sides, which is worse than not testing it.
// dockerargs_conformance_test.go pins the Go half of this.
//
// What both sides must do is agree in KIND: the control check is an ASCII predicate and is
// deliberately blind to whether the surrounding text is well-formed, so ill-formed text with no
// control character in it is accepted rather than being a second, unstated rule.
test("validation is blind to ill-formed text", () => {
  const illFormed = "a\u{D800}b";
  // `isWellFormed()` would say this more directly, but it is ES2024 and the shared base is
  // ES2023; a lone surrogate at index 1 IS the ill-formedness, so assert that instead of
  // widening `lib` for one line.
  assert.equal(illFormed.charCodeAt(1), 0xd800, "the probe must hold a lone surrogate");
  assert.equal(validateDockerArgs(["-e", `MOTD=${illFormed}`]), null);
  assert.notEqual(
    validateDockerArgs(["-e", `MOTD=${illFormed}\u001b`]),
    null,
    "ESC alongside ill-formed text must still be refused",
  );
});
