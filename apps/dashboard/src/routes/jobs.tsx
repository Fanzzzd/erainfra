import { Fragment, useMemo, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "convex/react";
import { Inbox, ListChecks, RotateCcw, ShieldAlert, ShieldCheck } from "lucide-react";
import { api } from "@erainfra/backend/api";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { LiveBadge, StatusDot } from "@/components/status";
import { TableRowsSkeleton } from "@/components/table-skeleton";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
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
      <PageHeader
        title="Legacy jobs"
        description="Workflow jobs delivered by webhook to per-repository runners — the path scale-set Profiles replace."
      >
        <LiveBadge />
      </PageHeader>

      <IntakeHealth now={now} />

      <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
        <Tabs value={filter} onValueChange={(value) => setFilter(value as JobFilter)}>
          <TabsList aria-label="Filter jobs by status">
            {filters.map((item) => (
              <TabsTrigger key={item.value} value={item.value}>
                {item.label}
                <span className="tabular-nums text-[10px] text-subtle-foreground">
                  {counts[item.value]}
                </span>
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        <span className="text-xs text-subtle-foreground">Newest first</span>
      </div>

      <Card className="overflow-hidden">
        <CardHeader className="border-b">
          <CardTitle className="flex items-center gap-2.5">
            Job history
            {visibleJobs !== undefined && (
              <span className="tabular-nums text-xs font-normal text-subtle-foreground">
                {visibleJobs.length}
                {filter !== "all" && ` of ${counts.all}`}
              </span>
            )}
          </CardTitle>
        </CardHeader>

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
              <TableRowsSkeleton columns={8} rows={4} />
            ) : visibleJobs.length === 0 ? (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={8} className="p-0">
                  <EmptyState
                    icon={ListChecks}
                    title={counts.all === 0 ? "No jobs received" : `No ${filter} jobs`}
                    description={
                      counts.all === 0
                        ? "Workflow jobs requesting self-hosted runners will appear here."
                        : "Every job is still there — try another status filter."
                    }
                  />
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
                          <div className="mt-1 text-[10px] text-subtle-foreground">
                            {job.conclusion}
                          </div>
                        )}
                      </TableCell>
                      <TableCell>
                        <div
                          className="max-w-[190px] truncate font-mono text-[12px] text-secondary-foreground"
                          title={job.repo}
                        >
                          {job.repo}
                        </div>
                        <div className="tabular-nums mt-0.5 font-mono text-[10px] text-subtle-foreground">
                          #{job.ghJobId}
                        </div>
                      </TableCell>
                      <TableCell>
                        <div
                          className="max-w-[180px] truncate text-secondary-foreground"
                          title={job.workflowName}
                        >
                          {job.workflowName}
                        </div>
                      </TableCell>
                      <TableCell>
                        {job.machineName ? (
                          <span
                            className="inline-block max-w-[160px] truncate align-middle text-secondary-foreground"
                            title={job.runnerName}
                          >
                            {job.machineName}
                          </span>
                        ) : (
                          <span className="text-subtle-foreground">Unassigned</span>
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
                      <TableCell className="tabular-nums whitespace-nowrap text-xs text-muted-foreground">
                        queued {formatDuration(queueEnd - job.queuedAt)}
                        {job.startedAt !== undefined && (
                          <>
                            <span className="px-1.5 text-subtle-foreground">·</span>
                            ran {formatDuration(runEnd - job.startedAt)}
                          </>
                        )}
                      </TableCell>
                      <TableCell>
                        <span
                          className="tabular-nums whitespace-nowrap text-xs text-muted-foreground"
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
                            className="max-w-4xl text-xs leading-5 text-destructive"
                            title={job.lastError}
                          >
                            <span className="sr-only">Last error: </span>
                            <span aria-hidden="true" className="pr-1.5 text-subtle-foreground">
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
      </Card>
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
  if (count === 0) return <span className="text-subtle-foreground">—</span>;

  const gaveUp = status === "failed" && conclusion === "provision-failed";
  const retryDue = status === "queued" && nextAttemptAt !== undefined && nextAttemptAt > now;

  return (
    <div className="space-y-1">
      <span className="tabular-nums whitespace-nowrap text-xs text-secondary-foreground">
        attempt {count}
      </span>
      {gaveUp && (
        <div className="whitespace-nowrap text-[10px] font-medium text-destructive">
          gave up after {count}
        </div>
      )}
      {retryDue && (
        <div
          className="tabular-nums whitespace-nowrap text-[10px] text-warning"
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
    <Card>
      <CardHeader className="border-b">
        <CardTitle>Intake health</CardTitle>
        <CardAction>
          {failures !== undefined && failures.length > 0 && (
            <span className="tabular-nums text-xs text-destructive">
              {failures.length} rejected
            </span>
          )}
        </CardAction>
      </CardHeader>

      <CardContent className="space-y-4 pt-4">
        <RepositoryPolicyCard policy={policy} />
        <DeliveryRecoveryCard recovery={recovery} source={app?.source} now={now} />
        <RejectedDeliveries failures={failures} now={now} />
      </CardContent>
    </Card>
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
  pending: { label: "starting", tone: "text-muted-foreground" },
  ok: { label: "healthy", tone: "text-success" },
  "skipped-no-app": { label: "unavailable", tone: "text-warning" },
  "skipped-backoff": { label: "backing off", tone: "text-warning" },
  error: { label: "failing", tone: "text-destructive" },
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
    return <Skeleton className="h-16 w-full" />;
  }

  // The /app/hook endpoints need a JWT signed by an App private key, so this is
  // one capability the legacy PAT structurally cannot have.
  if (source === "pat" || source === "none") {
    return (
      <Alert variant="warning">
        <RotateCcw />
        <AlertTitle>Lost deliveries are not being recovered</AlertTitle>
        <AlertDescription>
          <p>
            GitHub does not retry a webhook it failed to deliver, and asking it to redeliver one
            requires a GitHub App.{" "}
            <Link to="/" className="underline underline-offset-2 hover:text-warning-foreground">
              Connect an App
            </Link>{" "}
            to turn this on.
          </p>
        </AlertDescription>
      </Alert>
    );
  }

  const outcome = RECOVERY_OUTCOME[recovery?.lastOutcome ?? "pending"];
  const backingOff = recovery !== null && recovery.nextRunAt > now;

  return (
    <div className="rounded-md border border-border bg-muted p-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="inline-flex items-center gap-2 text-xs font-medium text-secondary-foreground">
          <RotateCcw className="size-4 text-subtle-foreground" aria-hidden="true" />
          Delivery recovery
        </span>
        <span className={cn("text-xs font-medium", outcome.tone)}>{outcome.label}</span>
        {recovery !== null && (
          <span
            className="tabular-nums text-xs text-subtle-foreground"
            title={formatAbsoluteTime(recovery.lastRunAt)}
          >
            last run {formatRelativeTime(recovery.lastRunAt, now)}
          </span>
        )}
      </div>

      {recovery === null ? (
        <p className="mt-2 text-xs leading-5 text-muted-foreground">
          The recovery scan has not run yet. It checks GitHub for failed deliveries every five
          minutes.
        </p>
      ) : (
        <>
          <p className="tabular-nums mt-2 text-xs leading-5 text-muted-foreground">
            Last scan saw {recovery.listed} deliveries, {recovery.missing} of them never received,
            and asked GitHub to redeliver {recovery.requested}.
          </p>
          <p className="tabular-nums mt-1 text-xs leading-5 text-muted-foreground">
            {recovery.outstanding} awaiting redelivery
            <span className="px-1.5 text-subtle-foreground">·</span>
            <span className="text-success">{recovery.recovered} recovered</span>
            <span className="px-1.5 text-subtle-foreground">·</span>
            <span className={recovery.abandoned > 0 ? "text-destructive" : undefined}>
              {recovery.abandoned} given up on
            </span>
          </p>
          {backingOff && (
            <p
              className="tabular-nums mt-1 text-xs text-warning"
              title={formatAbsoluteTime(recovery.nextRunAt)}
            >
              Backing off after {recovery.consecutiveFailures} failed{" "}
              {recovery.consecutiveFailures === 1 ? "run" : "runs"} — next attempt in{" "}
              {formatDuration(recovery.nextRunAt - now)}
            </p>
          )}
          {recovery.lastError !== undefined && (
            <p className="mt-1 text-xs leading-5 text-destructive">
              <span className="sr-only">Last error: </span>
              <span aria-hidden="true" className="pr-1.5 text-subtle-foreground">
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
    return <Skeleton className="h-16 w-full" />;
  }

  if (!policy.configured) {
    return (
      <Alert variant="destructive">
        <ShieldAlert />
        <AlertTitle>No repositories are allowed yet</AlertTitle>
        <AlertDescription>
          <p>
            <code>ALLOWED_REPOS</code> is unset, so every incoming workflow job is rejected and no
            job is created. Set it before installing the GitHub App:
          </p>
          <pre className="mt-1 w-full overflow-x-auto rounded border border-destructive/15 bg-black/30 p-2 font-mono text-[11px]">
            <code>pnpm convex env set ALLOWED_REPOS &apos;owner/repo&apos;</code>
          </pre>
        </AlertDescription>
      </Alert>
    );
  }

  return (
    <div className="rounded-md border border-border bg-muted p-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="inline-flex items-center gap-2 text-xs font-medium text-success">
          <ShieldCheck className="size-4" aria-hidden="true" />
          Accepting workflow jobs from
        </span>
        <div className="flex flex-wrap gap-1">
          {policy.allowedRepos.map((pattern) => (
            <Badge key={pattern} variant="secondary" className="font-mono">
              {pattern}
            </Badge>
          ))}
        </div>
      </div>
      <p className="mt-2 text-xs leading-5 text-muted-foreground">
        Public repositories are{" "}
        {policy.allowPublicRepos ? (
          <span className="text-warning">allowed</span>
        ) : (
          <span className="text-secondary-foreground">blocked</span>
        )}
        {policy.allowPublicRepos
          ? " — a fork can run untrusted code on your runner hosts."
          : ". Set ALLOW_PUBLIC_REPOS to opt in."}
        {policy.allowsAllRepos && (
          <>
            {" "}
            <span className="text-warning">
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
    return <Skeleton className="h-4 w-72 max-w-full" />;
  }

  if (failures.length === 0) {
    return (
      <p className="flex items-center gap-2 text-xs text-muted-foreground">
        <Inbox className="size-4 text-subtle-foreground" aria-hidden="true" />
        No webhook deliveries have been rejected or abandoned.
      </p>
    );
  }

  return (
    <div className="overflow-hidden rounded-md border border-border">
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
                <Badge variant={delivery.status === "rejected" ? "warning" : "destructive"}>
                  {delivery.status}
                </Badge>
              </TableCell>
              <TableCell>
                <span
                  className="inline-block max-w-[190px] truncate align-middle font-mono text-[12px] text-secondary-foreground"
                  title={delivery.repo}
                >
                  {delivery.repo ?? "—"}
                </span>
              </TableCell>
              <TableCell>
                <span
                  className="inline-block max-w-[150px] truncate align-middle font-mono text-[10px] text-subtle-foreground"
                  title={`${delivery.event} · ${delivery.deliveryId}`}
                >
                  {delivery.deliveryId}
                </span>
              </TableCell>
              <TableCell>
                <span
                  className="tabular-nums whitespace-nowrap text-xs text-muted-foreground"
                  title={formatAbsoluteTime(delivery.receivedAt)}
                >
                  {formatRelativeTime(delivery.receivedAt, now)}
                </span>
              </TableCell>
              <TableCell>
                <span
                  className="tabular-nums whitespace-nowrap text-xs text-muted-foreground"
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
              <TableCell className="tabular-nums text-xs text-muted-foreground">
                {delivery.attempts}
              </TableCell>
              <TableCell>
                <p
                  className="max-w-2xl text-xs leading-5 text-muted-foreground"
                  title={delivery.lastError}
                >
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

const JOB_STATUS_TONE: Record<JobStatus, { variant: "success" | "warning" | "destructive" }> = {
  queued: { variant: "warning" },
  assigned: { variant: "warning" },
  running: { variant: "success" },
  done: { variant: "success" },
  failed: { variant: "destructive" },
};

function JobStatusBadge({ status }: { status: JobStatus }) {
  const { variant } = JOB_STATUS_TONE[status];
  return (
    <Badge variant={variant} className="h-6 gap-2 px-2 capitalize">
      <StatusDot
        tone={variant === "success" ? "success" : variant === "warning" ? "warning" : "destructive"}
        live={status === "running"}
      />
      {status}
    </Badge>
  );
}

function LabelChips({ labels }: { labels: string[] }) {
  if (labels.length === 0) return <span className="text-subtle-foreground">—</span>;

  return (
    <div className="flex max-w-[220px] flex-wrap gap-1">
      {[...new Set(labels)].map((label) => (
        <Badge key={label} variant="outline" className="font-mono">
          {label}
        </Badge>
      ))}
    </div>
  );
}

function isActive(status: JobStatus) {
  return status === "queued" || status === "assigned" || status === "running";
}
