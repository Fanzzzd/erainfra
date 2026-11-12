import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { usableHostCapacity } from "../convex/workerPolicy";

type HostEnvelopeCase = { name: string; hostTotal: number; guestSize: number; usable: number };

// The Action Runner Agent's warm-pool check runs the same file
// (apps/action-runner-agent/tests/readiness.test.ts), so a change to the envelope on one side
// alone turns one suite red.
const shared = JSON.parse(
  readFileSync(new URL("../../../testdata/host-envelope-cases.json", import.meta.url), "utf8"),
) as { cases: HostEnvelopeCase[] };

describe("usableHostCapacity", () => {
  it.each(shared.cases)("$name", ({ hostTotal, guestSize, usable }) => {
    expect(usableHostCapacity(hostTotal, guestSize)).toBe(usable);
  });
});
