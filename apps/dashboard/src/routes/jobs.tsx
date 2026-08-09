import { Fragment, useMemo, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "convex/react";
import { Inbox, ListChecks, RotateCcw, ShieldAlert, ShieldCheck } from "lucide-react";
import { api } from "@runner-center/backend/api";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useNow } from "@/hooks/use-now";
import { formatAbsoluteTime, formatDuration, formatRelativeTime } from "@/lib/time";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/jobs")({ component: JobsPage });

type JobStatus = "queued" | "assigned" | "running" | "done" | "failed";
type JobFilter = "all" | "active" | "done" | "failed";

const filters: Array<{ value: JobFilter; label: string }> = [
  { value: "all", label: "All" },
  { value: "active", label: "Active" },
  { value: "done", label: "Done" },
  { value: "failed", label: "Failed" },
];

function JobsPage() {
  const jobs = useQuery(api.jobs.list);
  const now = useNow();
  const [filter, setFilter] = useState<JobFilter>("all");

  const orderedJobs = useMemo(() => {
    if (jobs === undefined) return undefined;
    return jobs.toSorted((a, b) => {
      const queuedDifference = b.queuedAt - a.queuedAt;
      if (queuedDifference !== 0) return queuedDifference;
      return String(b._id).localeCompare(String(a._id));
    });
  }, [jobs]);

  const counts = useMemo(() => {
    const list = orderedJobs ?? [];
    return {
      all: list.length,
      active: list.filter((job) => isActive(job.status)).length,
      done: list.filter((job) => job.status === "done").length,
      failed: list.filter((job) => job.status === "failed").length,
    };
  }, [orderedJobs]);

  const visibleJobs = useMemo(() => {
    if (orderedJobs === undefined) return undefined;
    if (filter === "active") return orderedJobs.filter((job) => isActive(job.status));
    if (filter === "done") return orderedJobs.filter((job) => job.status === "done");
    if (filter === "failed") return orderedJobs.filter((job) => job.status === "failed");
    return orderedJobs;
  }, [filter, orderedJobs]);

  return (
    <div className="space-y-6">
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-start">
        <div>
          <h1 className="text-2xl font-semibold tracking-[-0.025em] text-zinc-50">Jobs</h1>
          <p className="mt-1.5 text-sm text-[#8a8a93]">
            Track workflow queues, assignments, and runner outcomes in real time.
          </p>
        </div>
        <span className="flex h-8 shrink-0 items-center gap-2 rounded-md border border-white/[0.08] bg-white/[0.025] px-2.5 text-xs text-zinc-400">
          <span className="status-pulse size-1.5 rounded-full bg-emerald-400" />
          Live updates
        </span>
      </div>

      <IntakeHealth now={now} />

      <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
        <div
          className="flex w-fit items-center gap-1 rounded-lg border border-white/[0.08] bg-[#0d0d0f] p-1"
          aria-label="Filter jobs"
        >
          {filters.map((item) => (
            <button
              key={item.value}
              type="button"
              aria-pressed={filter === item.value}
              className={cn(
                "flex h-7 items-center gap-2 rounded-full px-2.5 text-xs font-medium text-[#8a8a93] outline-none transition-colors duration-150 hover:text-zinc-200 focus-visible:ring-2 focus-visible:ring-emerald-400/80",
                filter === item.value && "bg-white/[0.08] text-zinc-100",
              )}
              onClick={() => setFilter(item.value)}
            >
              {item.label}
              <span className="tabular-nums text-[10px] text-[#7c7c85]">{counts[item.value]}</span>
            </button>
          ))}
        </div>
        <span className="text-xs text-[#7c7c85]">Newest first</span>
      </div>

      <section
        className="overflow-hidden rounded-lg border border-white/[0.08] bg-[#0d0d0f]"
        aria-labelledby="jobs-heading"
      >
        <div className="flex h-12 items-center gap-2.5 border-b border-white/[0.08] px-4">
          <h2 id="jobs-heading" className="text-sm font-medium text-zinc-200">
            Job history
          </h2>
          {visibleJobs !== undefined && (
            <span className="tabular-nums text-xs text-[#7c7c85]">
              {visibleJobs.length}
              {filter !== "all" && ` of ${counts.all}`}
            </span>
          )}
        </div>

        <Table className="min-w-[1180px]">
          <TableHeader>
            <TableRow>
              <TableHead className="w-[118px]">Status</TableHead>
              <TableHead className="w-[190px]">Repository</TableHead>
              <TableHead className="w-[180px]">Workflow</TableHead>
              <TableHead className="w-[160px]">Machine</TableHead>
              <TableHead className="w-[132px]">Attempts</TableHead>
              <TableHead className="w-[220px]">Labels</TableHead>
              <TableHead className="w-[190px]">Timing</TableHead>
              <TableHead className="w-[112px]">Queued</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {visibleJobs === undefined ? (
              <TableRow>
                <TableCell colSpan={8} className="h-36 text-center text-[#8a8a93]">
                  Syncing jobs…
                </TableCell>
              </TableRow>
            ) : visibleJobs.length === 0 ? (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={8} className="h-64 text-center">
                  <div className="mx-auto flex max-w-sm flex-col items-center">
                    <div className="grid size-9 place-items-center rounded-md border border-white/[0.08] bg-white/[0.025] text-[#8a8a93]">
                      <ListChecks className="size-4" />
                    </div>
                    <p className="mt-4 text-sm font-medium text-zinc-200">
                      {counts.all === 0 ? "No jobs received" : `No ${filter} jobs`}
                    </p>
                    <p className="mt-1 text-xs leading-5 text-[#8a8a93]">
                      {counts.all === 0
                        ? "Workflow jobs requesting self-hosted runners will appear here."
                        : "Try another status filter."}
                    </p>
                  </div>
                </TableCell>
              </TableRow>
            ) : (
              visibleJobs.map((job) => {
                const queueEnd = job.startedAt ?? job.finishedAt ?? now;
                const runEnd = job.finishedAt ?? now;
                // Only worth showing while it still explains something: a job
                // that succeeded first try has no story to tell here.
                const showError =
                  job.lastError !== undefined && job.status !== "done" && job.status !== "running";

                return (
                  <Fragment key={job._id}>
                    <TableRow className={cn(showError && "border-b-0")}>
                      <TableCell>
                        <JobStatusBadge status={job.status} />
                        {job.conclusion && job.status === "failed" && (
                          <div className="mt-1 pl-2 text-[10px] text-[#7c7c85]">
                            {job.conclusion}
                          </div>
                        )}
                      </TableCell>
                      <TableCell>
                        <div
                          className="max-w-[190px] truncate font-mono text-[12px] text-zinc-200"
                          title={job.repo}
                        >
                          {job.repo}
                        </div>
                        <div className="tabular-nums mt-0.5 font-mono text-[10px] text-[#7c7c85]">
                          #{job.ghJobId}
                        </div>
                      </TableCell>
                      <TableCell>
                        <div
                          className="max-w-[180px] truncate text-zinc-300"
                          title={job.workflowName}
                        >
                          {job.workflowName}
                        </div>
                      </TableCell>
                      <TableCell>
                        {job.machineName ? (
                          <span
                            className="inline-block max-w-[160px] truncate align-middle text-zinc-300"
                            title={job.runnerName}
                          >
                            {job.machineName}
                          </span>
                        ) : (
                          <span className="text-[#7c7c85]">Unassigned</span>
                        )}
                      </TableCell>
                      <TableCell>
                        <AttemptCell
                          attempts={job.attempts}
                          status={job.status}
                          conclusion={job.conclusion}
                          nextAttemptAt={job.nextAttemptAt}
                          now={now}
                        />
                      </TableCell>
                      <TableCell>
                        <LabelChips labels={job.labels} />
                      </TableCell>
                      <TableCell className="tabular-nums whitespace-nowrap text-xs text-zinc-400">
                        queued {formatDuration(queueEnd - job.queuedAt)}
                        {job.startedAt !== undefined && (
                          <>
                            <span className="px-1.5 text-[#7c7c85]">·</span>
                            ran {formatDuration(runEnd - job.startedAt)}
                          </>
                        )}
                      </TableCell>
                      <TableCell>
                        <span
                          className="tabular-nums whitespace-nowrap text-xs text-[#8a8a93]"
                          title={formatAbsoluteTime(job.queuedAt)}
                        >
                          {formatRelativeTime(job.queuedAt, now)}
                        </span>
                      </TableCell>
                    </TableRow>
                    {showError && (
                      <TableRow className="hover:bg-transparent">
                        <TableCell colSpan={8} className="pt-0">
                          <p
                            className="max-w-4xl text-xs leading-5 text-red-300/80"
                            title={job.lastError}
                          >
                            <span className="sr-only">Last error: </span>
                            <span aria-hidden="true" className="pr-1.5 text-[#7c7c85]">
                              ↳
                            </span>
                            {job.lastError}
                          </p>
                        </TableCell>
                      </TableRow>
                    )}
                  </Fragment>
                );
              })
            )}
          </TableBody>
        </Table>
      </section>
    </div>
  );
}

/**
 * Why a job is where it is: which attempt it is on, when the next one is due,
 * and whether the attempt budget is spent.
 */
function AttemptCell({
  attempts,
  status,
  conclusion,
  nextAttemptAt,
  now,
}: {
  attempts?: number;
  status: JobStatus;
  conclusion?: string;
  nextAttemptAt?: number;
  now: number;
}) {
  const count = attempts ?? 0;
  if (count === 0) return <span className="text-[#7c7c85]">—</span>;

  const gaveUp = status === "failed" && conclusion === "provision-failed";
  const retryDue = status === "queued" && nextAttemptAt !== undefined && nextAttemptAt > now;

  return (
    <div className="space-y-1">
      <span className="tabular-nums whitespace-nowrap text-xs text-zinc-300">attempt {count}</span>
      {gaveUp && (
        <div className="whitespace-nowrap text-[10px] font-medium text-red-300">
          gave up after {count}
        </div>
      )}
      {retryDue && (
        <div
          className="tabular-nums whitespace-nowrap text-[10px] text-amber-300"
          title={formatAbsoluteTime(nextAttemptAt)}
        >
          retry in {formatDuration(nextAttemptAt - now)}
        </div>
      )}
    </div>
  );
}

/**
 * Everything that can stop a workflow job from ever becoming a row above:
 * a closed allowlist, a delivery that was refused or gave up, or a delivery
 * that never arrived at all.
 */
function IntakeHealth({ now }: { now: number }) {
  const policy = useQuery(api.settings.repositoryPolicy);
  const failures = useQuery(api.webhooks.recentFailures);
  const recovery = useQuery(api.webhooks.recoveryStatus);
  const app = useQuery(api.githubApp.status);

  return (
    <section
      className="overflow-hidden rounded-lg border border-white/[0.08] bg-[#0d0d0f]"
      aria-labelledby="intake-health-heading"
    >
      <div className="flex h-12 items-center gap-2.5 border-b border-white/[0.08] px-4">
        <h2 id="intake-health-heading" className="text-sm font-medium text-zinc-200">
          Intake health
        </h2>
        {failures !== undefined && failures.length > 0 && (
          <span className="tabular-nums text-xs text-red-300">{failures.length} rejected</span>
        )}
      </div>

      <div className="space-y-4 px-4 py-3.5">
        <RepositoryPolicyCard policy={policy} />
        <DeliveryRecoveryCard recovery={recovery} source={app?.source} now={now} />
        <RejectedDeliveries failures={failures} now={now} />
      </div>
    </section>
  );
}

type RecoveryStatus = {
  lastRunAt: number;
  lastSuccessAt?: number;
  nextRunAt: number;
  lastOutcome: "pending" | "ok" | "skipped-no-app" | "skipped-backoff" | "error";
  lastError?: string;
  consecutiveFailures: number;
  listed: number;
  missing: number;
  requested: number;
  outstanding: number;
  recovered: number;
  abandoned: number;
};

const RECOVERY_OUTCOME: Record<RecoveryStatus["lastOutcome"], { label: string; tone: string }> = {
  pending: { label: "starting", tone: "text-[#8a8a93]" },
  ok: { label: "healthy", tone: "text-emerald-300" },
  "skipped-no-app": { label: "unavailable", tone: "text-amber-300" },
  "skipped-backoff": { label: "backing off", tone: "text-amber-300" },
  error: { label: "failing", tone: "text-red-300" },
};

/**
 * GitHub never retries a webhook it failed to deliver, so an outage silently
 * drops queued jobs. This is where an operator sees that the repair loop is
 * running — and, on the legacy PAT, that it cannot run at all.
 */
function DeliveryRecoveryCard({
  recovery,
  source,
  now,
}: {
  recovery: RecoveryStatus | null | undefined;
  source: string | undefined;
  now: number;
}) {
  if (recovery === undefined || source === undefined) {
    return <p className="text-xs text-[#8a8a93]">Checking delivery recovery…</p>;
  }

  // The /app/hook endpoints need a JWT signed by an App private key, so this is
  // one capability the legacy PAT structurally cannot have.
  if (source === "pat" || source === "none") {
    return (
      <div className="flex gap-3 rounded-md border border-amber-400/20 bg-amber-400/[0.06] p-3">
        <RotateCcw className="mt-0.5 size-4 shrink-0 text-amber-300" aria-hidden="true" />
        <p className="text-xs leading-5 text-amber-200">
          <span className="font-medium">Lost deliveries are not being recovered.</span> GitHub does
          not retry a webhook it failed to deliver, and asking it to redeliver one requires a GitHub
          App.{" "}
          <Link to="/" className="underline underline-offset-2 hover:text-amber-100">
            Connect an App
          </Link>{" "}
          to turn this on.
        </p>
      </div>
    );
  }

  const outcome = RECOVERY_OUTCOME[recovery?.lastOutcome ?? "pending"];
  const backingOff = recovery !== null && recovery.nextRunAt > now;

  return (
    <div className="rounded-md border border-white/[0.08] bg-white/[0.02] p-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="inline-flex items-center gap-2 text-xs font-medium text-zinc-300">
          <RotateCcw className="size-4 text-[#7c7c85]" aria-hidden="true" />
          Delivery recovery
        </span>
        <span className={cn("text-xs font-medium", outcome.tone)}>{outcome.label}</span>
        {recovery !== null && (
          <span
            className="tabular-nums text-xs text-[#7c7c85]"
            title={formatAbsoluteTime(recovery.lastRunAt)}
          >
            last run {formatRelativeTime(recovery.lastRunAt, now)}
          </span>
        )}
      </div>

      {recovery === null ? (
        <p className="mt-2 text-xs leading-5 text-[#8a8a93]">
          The recovery scan has not run yet. It checks GitHub for failed deliveries every five
          minutes.
        </p>
      ) : (
        <>
          <p className="tabular-nums mt-2 text-xs leading-5 text-[#8a8a93]">
            Last scan saw {recovery.listed} deliveries, {recovery.missing} of them never received,
            and asked GitHub to redeliver {recovery.requested}.
          </p>
          <p className="tabular-nums mt-1 text-xs leading-5 text-[#8a8a93]">
            {recovery.outstanding} awaiting redelivery
            <span className="px-1.5 text-[#7c7c85]">·</span>
            <span className="text-emerald-300">{recovery.recovered} recovered</span>
            <span className="px-1.5 text-[#7c7c85]">·</span>
            <span className={recovery.abandoned > 0 ? "text-red-300" : undefined}>
              {recovery.abandoned} given up on
            </span>
          </p>
          {backingOff && (
            <p
              className="tabular-nums mt-1 text-xs text-amber-300"
              title={formatAbsoluteTime(recovery.nextRunAt)}
            >
              Backing off after {recovery.consecutiveFailures} failed{" "}
              {recovery.consecutiveFailures === 1 ? "run" : "runs"} — next attempt in{" "}
              {formatDuration(recovery.nextRunAt - now)}
            </p>
          )}
          {recovery.lastError !== undefined && (
            <p className="mt-1 text-xs leading-5 text-red-300/80">
              <span className="sr-only">Last error: </span>
              <span aria-hidden="true" className="pr-1.5 text-[#7c7c85]">
                ↳
              </span>
              {recovery.lastError}
            </p>
          )}
        </>
      )}
    </div>
  );
}

type RepositoryPolicy = {
  configured: boolean;
  allowedRepos: string[];
  allowsAllRepos: boolean;
  allowPublicRepos: boolean;
};

function RepositoryPolicyCard({ policy }: { policy: RepositoryPolicy | undefined }) {
  if (policy === undefined) {
    return <p className="text-xs text-[#8a8a93]">Checking repository policy…</p>;
  }

  if (!policy.configured) {
    return (
      <div
        role="alert"
        className="flex gap-3 rounded-md border border-red-400/20 bg-red-400/[0.07] p-3"
      >
        <ShieldAlert className="mt-0.5 size-4 shrink-0 text-red-300" aria-hidden="true" />
        <div className="text-xs leading-5 text-red-200">
          <p className="font-medium">No repositories are allowed yet</p>
          <p className="mt-1 text-red-200/80">
            <code className="text-red-100">ALLOWED_REPOS</code> is unset, so every incoming workflow
            job is rejected and no job is created. Set it before installing the GitHub App:
          </p>
          <pre className="mt-2 overflow-x-auto rounded border border-red-400/15 bg-black/30 p-2 font-mono text-[11px] text-red-100">
            <code>pnpm convex env set ALLOWED_REPOS &apos;owner/repo&apos;</code>
          </pre>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-md border border-white/[0.08] bg-white/[0.02] p-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="inline-flex items-center gap-2 text-xs font-medium text-emerald-300">
          <ShieldCheck className="size-4" aria-hidden="true" />
          Accepting workflow jobs from
        </span>
        <div className="flex flex-wrap gap-1">
          {policy.allowedRepos.map((pattern) => (
            <Badge key={pattern} variant="outline" className="font-mono text-zinc-300">
              {pattern}
            </Badge>
          ))}
        </div>
      </div>
      <p className="mt-2 text-xs leading-5 text-[#8a8a93]">
        Public repositories are{" "}
        {policy.allowPublicRepos ? (
          <span className="text-amber-300">allowed</span>
        ) : (
          <span className="text-zinc-300">blocked</span>
        )}
        {policy.allowPublicRepos
          ? " — a fork can run untrusted code on your runner hosts."
          : ". Set ALLOW_PUBLIC_REPOS to opt in."}
        {policy.allowsAllRepos && (
          <>
            {" "}
            <span className="text-amber-300">
              The <code>*</code> pattern accepts every repository the App is installed on.
            </span>
          </>
        )}
      </p>
    </div>
  );
}

type FailedDelivery = {
  _id: string;
  deliveryId: string;
  event: string;
  repo?: string;
  status: "rejected" | "failed";
  receivedAt: number;
  settledAt?: number;
  attempts: number;
  lastError?: string;
};

function RejectedDeliveries({
  failures,
  now,
}: {
  failures: FailedDelivery[] | undefined;
  now: number;
}) {
  if (failures === undefined) {
    return <p className="text-xs text-[#8a8a93]">Checking webhook deliveries…</p>;
  }

  if (failures.length === 0) {
    return (
      <p className="flex items-center gap-2 text-xs text-[#8a8a93]">
        <Inbox className="size-4 text-[#7c7c85]" aria-hidden="true" />
        No webhook deliveries have been rejected or abandoned.
      </p>
    );
  }

  return (
    <div className="overflow-hidden rounded-md border border-white/[0.08]">
      <Table className="min-w-[900px]">
        <TableHeader>
          <TableRow>
            <TableHead className="w-[96px]">Result</TableHead>
            <TableHead className="w-[190px]">Repository</TableHead>
            <TableHead className="w-[150px]">Delivery</TableHead>
            <TableHead className="w-[104px]">Received</TableHead>
            <TableHead className="w-[104px]">Settled</TableHead>
            <TableHead className="w-[84px]">Attempts</TableHead>
            <TableHead>Reason</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {failures.map((delivery) => (
            <TableRow key={delivery._id}>
              <TableCell>
                <Badge
                  variant="outline"
                  className={cn(
                    "font-medium",
                    delivery.status === "rejected"
                      ? "border-amber-400/20 bg-amber-400/[0.08] text-amber-300"
                      : "border-red-400/20 bg-red-400/[0.08] text-red-300",
                  )}
                >
                  {delivery.status}
                </Badge>
              </TableCell>
              <TableCell>
                <span
                  className="inline-block max-w-[190px] truncate align-middle font-mono text-[12px] text-zinc-200"
                  title={delivery.repo}
                >
                  {delivery.repo ?? "—"}
                </span>
              </TableCell>
              <TableCell>
                <span
                  className="inline-block max-w-[150px] truncate align-middle font-mono text-[10px] text-[#7c7c85]"
                  title={`${delivery.event} · ${delivery.deliveryId}`}
                >
                  {delivery.deliveryId}
                </span>
              </TableCell>
              <TableCell>
                <span
                  className="tabular-nums whitespace-nowrap text-xs text-[#8a8a93]"
                  title={formatAbsoluteTime(delivery.receivedAt)}
                >
                  {formatRelativeTime(delivery.receivedAt, now)}
                </span>
              </TableCell>
              <TableCell>
                <span
                  className="tabular-nums whitespace-nowrap text-xs text-[#8a8a93]"
                  title={
                    delivery.settledAt === undefined
                      ? "Not settled"
                      : formatAbsoluteTime(delivery.settledAt)
                  }
                >
                  {delivery.settledAt === undefined
                    ? "—"
                    : formatRelativeTime(delivery.settledAt, now)}
                </span>
              </TableCell>
              <TableCell className="tabular-nums text-xs text-zinc-400">
                {delivery.attempts}
              </TableCell>
              <TableCell>
                <p className="max-w-2xl text-xs leading-5 text-zinc-400" title={delivery.lastError}>
                  {delivery.lastError ?? "—"}
                </p>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function JobStatusBadge({ status }: { status: JobStatus }) {
  const styles: Record<JobStatus, string> = {
    queued: "border-amber-400/20 bg-amber-400/[0.08] text-amber-300",
    assigned: "border-amber-400/20 bg-amber-400/[0.08] text-amber-300",
    running: "border-emerald-400/20 bg-emerald-400/[0.08] text-emerald-300",
    done: "border-emerald-400/20 bg-emerald-400/[0.08] text-emerald-300",
    failed: "border-red-400/20 bg-red-400/[0.08] text-red-300",
  };
  const dotStyles: Record<JobStatus, string> = {
    queued: "bg-amber-400",
    assigned: "bg-amber-400",
    running: "status-pulse bg-emerald-400",
    done: "bg-emerald-400",
    failed: "bg-red-400",
  };

  return (
    <span
      className={cn(
        "inline-flex h-6 items-center gap-2 rounded-md border px-2 text-xs font-medium capitalize",
        styles[status],
      )}
    >
      <span className={cn("size-1.5 rounded-full", dotStyles[status])} aria-hidden="true" />
      {status}
    </span>
  );
}

function LabelChips({ labels }: { labels: string[] }) {
  if (labels.length === 0) return <span className="text-[#7c7c85]">—</span>;

  return (
    <div className="flex max-w-[220px] flex-wrap gap-1">
      {[...new Set(labels)].map((label) => (
        <Badge key={label} variant="outline" className="font-mono text-zinc-400">
          {label}
        </Badge>
      ))}
    </div>
  );
}

function isActive(status: JobStatus) {
  return status === "queued" || status === "assigned" || status === "running";
}
