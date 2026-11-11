// Why an Attempt failed when the runner, not the job's own steps, is to blame. GitHub shows such a
// failure as a job that queued forever, lost its runner, or never started. This names the cause
// and links the upstream page that describes the same behaviour on GitHub-hosted or Blacksmith
// runners, so an operator can tell a fleet problem from a known GitHub one.
//
// It classifies what the control plane already records (`lastError`, `cancelReason`), and the
// guest's out-of-memory kill count when the caller has the Attempt's metrics. It returns null for
// an Attempt whose job ran and failed on its own: that is the workflow's failure.

import { v } from "convex/values";

export type RunnerCauseCode =
  | "no-worker"
  | "worker-lost"
  | "executor-not-ready"
  | "runner-refused"
  | "executor-killed"
  | "executor-failed"
  | "guest-oom"
  | "stranded-rerun"
  | "stranded-cancelled";

export type RunnerCause = {
  code: RunnerCauseCode;
  /** One sentence: what happened, in the runner's terms. */
  summary: string;
  /** Upstream pages first, then EraInfra's own. */
  docs: { title: string; url: string }[];
};

const REPO_DOCS = "https://github.com/Fanzzzd/erainfra/blob/main/docs";

const DOCS = {
  githubLimits: {
    title: "GitHub Actions limits: job queue time",
    url: "https://docs.github.com/en/actions/reference/limits",
  },
  githubConnectivity: {
    title: "GitHub: troubleshooting self-hosted runner network connectivity",
    url: "https://docs.github.com/en/actions/how-tos/manage-runners/self-hosted-runners/monitor-and-troubleshoot#troubleshooting-network-connectivity",
  },
  githubRunnerLogs: {
    title: "GitHub: reviewing the self-hosted runner application log files",
    url: "https://docs.github.com/en/actions/how-tos/manage-runners/self-hosted-runners/monitor-and-troubleshoot#reviewing-the-self-hosted-runner-application-log-files",
  },
  githubHostedSpecs: {
    title: "GitHub-hosted runners: machine specifications",
    url: "https://docs.github.com/en/actions/reference/runners/github-hosted-runners",
  },
  blacksmithMetrics: {
    title: "Blacksmith: machine metrics",
    url: "https://docs.blacksmith.sh/blacksmith-observability/metrics",
  },
  githubRerun: {
    title: "GitHub: re-running workflows and jobs",
    url: "https://docs.github.com/en/actions/how-tos/manage-workflow-runs/re-run-workflows-and-jobs",
  },
  routerFallback: {
    title: "EraInfra: fall back to GitHub-hosted runners",
    url: `${REPO_DOCS}/workflows.md#fall-back-to-github-hosted-runners`,
  },
  workers: { title: "EraInfra: Workers", url: `${REPO_DOCS}/workers.md` },
  images: { title: "EraInfra: Image Releases", url: `${REPO_DOCS}/images.md` },
  onlyWorker: {
    title: "EraInfra runbook: take the only Worker away",
    url: `${REPO_DOCS}/runbooks/take-the-only-worker-away.md`,
  },
} as const;

/** The cause for an Attempt's recorded failure, or null when the runner is not to blame. */
export function runnerCause(
  attempt: { lastError?: string; cancelReason?: string; result?: string },
  metrics?: { oomKills: number | null } | null,
): RunnerCause | null {
  const text = attempt.lastError ?? attempt.cancelReason;
  if (text === undefined) return oomCause(attempt, metrics);

  if (text.startsWith("No compatible Worker became ready")) {
    return {
      code: "no-worker",
      summary:
        "No Worker that serves this Profile was ready, so the job queued until GitHub's 24-hour limit. " +
        "A router job with a GitHub-hosted fallback avoids the wait.",
      docs: [DOCS.githubLimits, DOCS.routerFallback, DOCS.workers],
    };
  }
  // strandedJobs.ts writes this reason when stranded job recovery acts on the job's run.
  if (text.startsWith("No ready Worker for ")) {
    return text.endsWith("asked GitHub to rerun it")
      ? {
          code: "stranded-rerun",
          summary:
            "Every Worker for this Profile dropped after the router chose it, so the control plane " +
            "cancelled the workflow run and asked GitHub to rerun it. The rerun repeats the whole " +
            "workflow, and its router job falls back to a GitHub-hosted runner.",
          docs: [DOCS.githubRerun, DOCS.routerFallback],
        }
      : {
          code: "stranded-cancelled",
          summary:
            "Every Worker for this Profile dropped after the router chose it, so the control plane " +
            "cancelled the workflow run instead of letting it queue for 24 hours. Rerun it once a " +
            "Worker is back, or let the router fall back.",
          docs: [DOCS.githubRerun, DOCS.routerFallback],
        };
  }
  if (text.startsWith("Worker stopped reporting")) {
    return {
      code: "worker-lost",
      summary:
        "The Worker stopped sending heartbeats, so the control plane gave up on the runner. GitHub " +
        "shows this as a runner that lost communication with the server.",
      docs: [DOCS.githubConnectivity, DOCS.onlyWorker],
    };
  }
  if (text.startsWith("Executor did not become usable")) {
    return {
      code: "executor-not-ready",
      summary:
        "The VM or container never became ready to start the runner. The usual causes are an image " +
        "pull that stalled or a guest that did not boot.",
      docs: [DOCS.images, DOCS.workers],
    };
  }
  if (text.startsWith("GitHub runner exited with code")) {
    return {
      code: "runner-refused",
      summary:
        "The GitHub runner registered but exited without taking a job, so GitHub kept the job queued. " +
        "The runner's own last log line follows the exit code.",
      docs: [DOCS.githubRunnerLogs, DOCS.images],
    };
  }
  const exit = /^Executor exited with code (\d+)/.exec(text);
  if (exit) {
    // 137 is 128 + SIGKILL: the kernel's out-of-memory killer, or a forced stop.
    if (exit[1] === "137") {
      return {
        code: "executor-killed",
        summary:
          "The executor was killed (exit code 137, SIGKILL), most often for running out of memory. " +
          "Compare the job's peak memory with the Profile's size, as on GitHub-hosted or Blacksmith runners.",
        docs: [DOCS.githubHostedSpecs, DOCS.blacksmithMetrics],
      };
    }
    return {
      code: "executor-failed",
      summary: `The executor ended with exit code ${exit[1]} before the job finished. The Worker's journal has the reason.`,
      docs: [DOCS.githubRunnerLogs, DOCS.workers],
    };
  }
  return oomCause(attempt, metrics);
}

/**
 * A job that failed while the guest kernel killed a process for lack of memory. The job's own
 * step reports the failure, often as a tool that exits with a bare or truncated error, so the
 * workflow log alone does not show that the runner ran out of memory.
 */
function oomCause(
  attempt: { result?: string },
  metrics: { oomKills: number | null } | null | undefined,
): RunnerCause | null {
  const kills = metrics?.oomKills ?? 0;
  if (kills === 0 || attempt.result?.toLowerCase() !== "failed") return null;
  return {
    code: "guest-oom",
    summary:
      `The guest's out-of-memory killer ended ${kills === 1 ? "a process" : `${kills} processes`} ` +
      "during the job, and the job failed. A step that died this way can exit with a short or empty " +
      "error. Compare the job's peak memory with the Profile's size, or pick a larger Profile.",
    docs: [DOCS.githubHostedSpecs, DOCS.blacksmithMetrics],
  };
}

export const runnerCauseValidator = v.object({
  code: v.union(
    v.literal("no-worker"),
    v.literal("worker-lost"),
    v.literal("executor-not-ready"),
    v.literal("runner-refused"),
    v.literal("executor-killed"),
    v.literal("executor-failed"),
    v.literal("guest-oom"),
    v.literal("stranded-rerun"),
    v.literal("stranded-cancelled"),
  ),
  summary: v.string(),
  docs: v.array(v.object({ title: v.string(), url: v.string() })),
});
