import { describe, expect, test } from "vitest";

import { runnerCause, runnerCauseValidator } from "../convex/runnerCauses";
import { strandedReason } from "../convex/strandedJobs";

const CASES = [
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
  [{ cancelReason: strandedReason("erainfra-4vcpu-ubuntu-2404", 5, "rerun") }, "stranded-rerun"],
  [
    { cancelReason: strandedReason("erainfra-4vcpu-ubuntu-2404", 5, "cancel") },
    "stranded-cancelled",
  ],
] as const;

describe("runnerCause", () => {
  test.each(CASES)("%o is %s", (attempt, code) => {
    const cause = runnerCause(attempt);
    expect(cause?.code).toBe(code);
    expect(cause?.docs.length).toBeGreaterThan(0);
    for (const doc of cause?.docs ?? []) expect(doc.url).toMatch(/^https:\/\//);
  });

  test("the validator accepts every cause code", () => {
    const accepted = runnerCauseValidator.fields.code.members.map((member) => member.value);
    expect(new Set(accepted)).toEqual(new Set([...CASES.map(([, code]) => code), "guest-oom"]));
  });

  test("a failed job whose guest saw an OOM kill names the kill", () => {
    const cause = runnerCause({ result: "Failed" }, { oomKills: 2 });
    expect(cause?.code).toBe("guest-oom");
    expect(cause?.summary).toContain("2 processes");
    expect(runnerCause({ result: "failed" }, { oomKills: 1 })?.summary).toContain("a process");
  });

  test("an OOM kill is no cause when the job passed or no kill was counted", () => {
    expect(runnerCause({ result: "succeeded" }, { oomKills: 3 })).toBeNull();
    expect(runnerCause({ result: "failed" }, { oomKills: 0 })).toBeNull();
    expect(runnerCause({ result: "failed" }, { oomKills: null })).toBeNull();
    expect(runnerCause({ result: "failed" }, null)).toBeNull();
  });

  test("a recorded runner error wins over the OOM count", () => {
    const cause = runnerCause(
      { result: "failed", lastError: "Executor exited with code 137" },
      { oomKills: 1 },
    );
    expect(cause?.code).toBe("executor-killed");
  });

  test("the stranded reason uses the wording operators see", () => {
    expect(strandedReason("erainfra-4vcpu-ubuntu-2404", 5, "rerun")).toBe(
      "No ready Worker for erainfra-4vcpu-ubuntu-2404 within 5 minutes; cancelled the run and asked GitHub to rerun it",
    );
    const cause = runnerCause({
      cancelReason: strandedReason("erainfra-4vcpu-ubuntu-2404", 5, "rerun"),
    });
    expect(cause?.docs.map((doc) => doc.url)).toEqual([
      "https://docs.github.com/en/actions/how-tos/manage-workflow-runs/re-run-workflows-and-jobs",
      "https://github.com/Fanzzzd/erainfra/blob/main/docs/workflows.md#fall-back-to-github-hosted-runners",
    ]);
  });

  test("a job that failed on its own has no runner cause", () => {
    expect(runnerCause({})).toBeNull();
    expect(runnerCause({ cancelReason: "Cancelled by operator" })).toBeNull();
  });

  test("an exit code other than 137 is named in the summary", () => {
    expect(runnerCause({ lastError: "Executor exited with code 2" })?.summary).toContain("code 2");
  });
});
