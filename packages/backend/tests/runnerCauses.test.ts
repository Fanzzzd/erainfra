import { describe, expect, test } from "vitest";

import { runnerCause } from "../convex/runnerCauses";

describe("runnerCause", () => {
  test.each([
    [{ cancelReason: "No compatible Worker became ready within 24 hours" }, "no-worker"],
    [{ lastError: "Worker stopped reporting during the GitHub job" }, "worker-lost"],
    [{ lastError: "Worker stopped reporting while preparing the runner" }, "worker-lost"],
    [{ lastError: "Executor did not become usable within 45 minutes" }, "executor-not-ready"],
    [
      { lastError: "GitHub runner exited with code 1 without taking a job: Invalid configuration" },
      "runner-refused",
    ],
    [{ lastError: "Executor exited with code 137" }, "executor-killed"],
    [{ lastError: "Executor exited with code 2" }, "executor-failed"],
  ] as const)("%o is %s", (attempt, code) => {
    const cause = runnerCause(attempt);
    expect(cause?.code).toBe(code);
    expect(cause?.docs.length).toBeGreaterThan(0);
    for (const doc of cause?.docs ?? []) expect(doc.url).toMatch(/^https:\/\//);
  });

  test("a job that failed on its own has no runner cause", () => {
    expect(runnerCause({})).toBeNull();
    expect(runnerCause({ cancelReason: "Cancelled by operator" })).toBeNull();
  });

  test("an exit code other than 137 is named in the summary", () => {
    expect(runnerCause({ lastError: "Executor exited with code 2" })?.summary).toContain("code 2");
  });
});
