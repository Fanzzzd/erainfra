import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { parseAdmissionState, readAdmissionState } from "../admission.ts";

// Written by the runtime's Go test (apps/runtime/internal/admission), so a field renamed there
// fails here.
const golden = readFileSync(
  new URL("../../../testdata/admission-state.golden.json", import.meta.url),
  "utf8",
);

test("parses the state the runtime prints", () => {
  assert.deepEqual(parseAdmissionState(golden), JSON.parse(golden));
});

test("rejects output that is not the state", () => {
  const state = JSON.parse(golden) as Record<string, unknown>;
  for (const broken of [
    "",
    "not json",
    "[]",
    JSON.stringify({ ...state, held: "1" }),
    JSON.stringify({ ...state, starting: -1 }),
    JSON.stringify({ ...state, overBudget: undefined }),
  ]) {
    assert.equal(parseAdmissionState(broken), undefined, broken);
  }
});

test("a failed or missing runtime yields no state", async () => {
  assert.equal(await readAdmissionState(async () => ({ exitCode: 1, stdout: golden })), undefined);
  assert.equal(
    await readAdmissionState(async () => {
      throw new Error("ENOENT");
    }),
    undefined,
  );
  assert.deepEqual(
    await readAdmissionState(async () => ({ exitCode: 0, stdout: golden })),
    JSON.parse(golden),
  );
});
