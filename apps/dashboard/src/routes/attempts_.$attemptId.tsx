import { api } from "@erainfra/backend/api";
import type { Id } from "@erainfra/backend/dataModel";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "convex/react";
import { ArrowLeftIcon, GaugeIcon, OctagonAlertIcon, TestTubeDiagonalIcon } from "lucide-react";

import {
  DescriptionDetails,
  DescriptionList,
  DescriptionListItem,
  DescriptionTerm,
} from "@/components/description-list";
import {
  EmptyState,
  EmptyStateDescription,
  EmptyStateMedia,
  EmptyStateTitle,
} from "@/components/empty-state";
import { MetricChart } from "@/components/metric-chart";
import {
  PageHeader,
  PageHeaderActions,
  PageHeaderDescription,
  PageHeaderTitle,
} from "@/components/page-header";
import { RunnerCauseNote } from "@/components/runner-cause";
import { Stat, StatGroup, StatHint, StatLabel, StatUnit, StatValue } from "@/components/stat";
import { StatusBadge } from "@/components/status";
import { TestCaseList, totalsLine } from "@/components/test-results";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  formatBytes,
  formatElapsed,
  formatRate,
  formatVcpus,
  metricsRows,
  sourceLabel,
  type MetricsRow,
  type MetricsSummary,
} from "@/lib/metrics";
import { attemptView } from "@/lib/states";
import { formatAbsoluteTime, formatDuration } from "@/lib/time";

export const Route = createFileRoute("/attempts_/$attemptId")({ component: AttemptPage });

const GIB = 1024 ** 3;

function BackLink() {
  return (
    <Button
      variant="ghost"
      size="sm"
      className="-ml-2 w-fit text-muted-foreground"
      render={<Link to="/attempts" />}
      nativeButton={false}
    >
      <ArrowLeftIcon data-icon="inline-start" />
      Runs
    </Button>
  );
}

function AttemptPage() {
  const { attemptId } = Route.useParams();
  const page = useQuery(api.attemptMetrics.get, { attemptId: attemptId as Id<"attempts"> });

  if (page === undefined) {
    return (
      <>
        <BackLink />
        <Skeleton className="h-8 w-64" />
        <div className="grid gap-4 lg:grid-cols-2">
          {[0, 1, 2, 3].map((index) => (
            <Skeleton key={index} className="h-56" />
          ))}
        </div>
      </>
    );
  }
  if (page === null) {
    return (
      <>
        <BackLink />
        <EmptyState variant="outline">
          <EmptyStateMedia>
            <GaugeIcon />
          </EmptyStateMedia>
          <EmptyStateTitle>No such run</EmptyStateTitle>
          <EmptyStateDescription>
            Finished runs are kept for 30 days, and their resource metrics for 14.
          </EmptyStateDescription>
        </EmptyState>
      </>
    );
  }

  const { attempt, summary, series } = page;
  const repository =
    attempt.repo === undefined
      ? undefined
      : attempt.owner === undefined || attempt.repo.includes("/")
        ? attempt.repo
        : `${attempt.owner}/${attempt.repo}`;
  const end = attempt.finishedAt;
  const rows = series === null ? [] : metricsRows(series);
  const view = attemptView(attempt.state);

  return (
    <>
      <BackLink />
      <PageHeader>
        <PageHeaderTitle className="break-words">
          {attempt.displayName ?? attempt.runnerName}
        </PageHeaderTitle>
        <PageHeaderDescription className="break-words">
          {[repository, attempt.profile, attempt.machineName].filter(Boolean).join(" · ")}
        </PageHeaderDescription>
        <PageHeaderActions>
          <Badge variant="outline" className="font-mono">
            {attempt.executor}
          </Badge>
          <StatusBadge state={view.state}>{view.label}</StatusBadge>
        </PageHeaderActions>
      </PageHeader>

      <Card size="sm" className="@container">
        <DescriptionList layout="grid" className="px-(--card-spacing)">
          <DescriptionListItem>
            <DescriptionTerm>Allotted</DescriptionTerm>
            <DescriptionDetails>
              {attempt.vcpus} vCPU and {formatBytes(attempt.memoryMiB * 1024 * 1024)}
            </DescriptionDetails>
          </DescriptionListItem>
          {attempt.startedAt !== undefined && (
            <DescriptionListItem>
              <DescriptionTerm>Started</DescriptionTerm>
              <DescriptionDetails>{formatAbsoluteTime(attempt.startedAt)}</DescriptionDetails>
            </DescriptionListItem>
          )}
          {attempt.startedAt !== undefined && end !== undefined && (
            <DescriptionListItem>
              <DescriptionTerm>Ran</DescriptionTerm>
              <DescriptionDetails>{formatDuration(end - attempt.startedAt)}</DescriptionDetails>
            </DescriptionListItem>
          )}
          {attempt.lastError !== undefined && (
            <DescriptionListItem>
              <DescriptionTerm>Last error</DescriptionTerm>
              <DescriptionDetails className="text-danger">{attempt.lastError}</DescriptionDetails>
            </DescriptionListItem>
          )}
        </DescriptionList>
      </Card>
      {attempt.cause !== undefined && <RunnerCauseNote cause={attempt.cause} />}

      {summary === null || series === null ? (
        <Card>
          <EmptyState>
            <EmptyStateMedia>
              <GaugeIcon />
            </EmptyStateMedia>
            <EmptyStateTitle>No resource metrics for this run</EmptyStateTitle>
            <EmptyStateDescription>
              {attempt.executor === "tart" || attempt.executor === "hyperv"
                ? "Only Linux executors are measured. Tart and Hyper-V runs have no resource chart."
                : "The Worker sends the first snapshot about 30 seconds into the job. Runs on a Worker older than this release, or finished more than 14 days ago, have none."}
            </EmptyStateDescription>
          </EmptyState>
        </Card>
      ) : (
        <>
          <OomNotice summary={summary} executor={attempt.executor} />
          <SummaryTiles summary={summary} />
          <div className="grid gap-4 lg:grid-cols-2">
            <MetricChart
              title="CPU (vCPUs)"
              seconds={rows.map((row) => row.seconds)}
              series={[
                { name: "average", values: rows.map((row) => row.cpuAvg) },
                { name: "busiest sample", values: rows.map((row) => row.cpuMax) },
              ]}
              reference={{ label: `${summary.vcpus} allotted`, value: summary.vcpus }}
              format={formatVcpus}
            />
            <MetricChart
              title="Memory"
              seconds={rows.map((row) => row.seconds)}
              series={[{ name: "memory", values: rows.map((row) => row.memory) }]}
              reference={{
                label: `${formatBytes(summary.memoryLimitBytes)} limit`,
                value: summary.memoryLimitBytes,
              }}
              format={formatBytes}
              binary
            />
            {series.points.netRxBytes !== undefined && (
              <MetricChart
                title="Network"
                seconds={rows.map((row) => row.seconds)}
                series={[
                  { name: "received", values: rows.map((row) => row.netRx) },
                  { name: "sent", values: rows.map((row) => row.netTx) },
                ]}
                format={formatRate}
                binary
              />
            )}
            {series.points.diskReadBytes !== undefined && (
              <MetricChart
                title="Disk"
                seconds={rows.map((row) => row.seconds)}
                series={[
                  { name: "read", values: rows.map((row) => row.diskRead) },
                  { name: "written", values: rows.map((row) => row.diskWrite) },
                ]}
                format={formatRate}
                binary
              />
            )}
          </div>
          <p className="text-xs leading-5 text-muted-foreground">
            Measured on the Worker from the {sourceLabel(series.source)}, every{" "}
            {series.sampleSeconds} s; each point covers {series.bucketSeconds} s.
            {series.source === "firecracker-vmm" &&
              " Memory is what the host has backed for the guest, which does not shrink when the guest frees it."}
            {!summary.final && " The run is still reporting."}
            {series.errors > 0 &&
              ` ${series.errors} reading(s) failed${series.lastError ? `: ${series.lastError}` : ""}.`}
          </p>
          <PointsTable rows={rows} />
        </>
      )}

      <AttemptTests attemptId={attempt._id} executor={attempt.executor} />
    </>
  );
}

/** The JUnit results this run reported, failures first and then its slowest passes. */
function AttemptTests({ attemptId, executor }: { attemptId: Id<"attempts">; executor: string }) {
  const tests = useQuery(api.testReports.forAttempt, { attemptId });
  if (tests === undefined) return <Skeleton className="h-24" />;
  if (tests === null) {
    return (
      <Card>
        <EmptyState>
          <EmptyStateMedia>
            <TestTubeDiagonalIcon />
          </EmptyStateMedia>
          <EmptyStateTitle>No test results for this run</EmptyStateTitle>
          <EmptyStateDescription>
            {executor === "firecracker"
              ? "The job left no JUnit XML file the collector looks for, or it ran on an image older than the collector. Results are kept for 30 days."
              : "Test results are collected on the Firecracker executor only."}
          </EmptyStateDescription>
        </EmptyState>
      </Card>
    );
  }
  return (
    <Card className="gap-0 py-0">
      <CardHeader className="border-b py-4">
        <CardTitle render={<h2 />}>Tests</CardTitle>
        <CardDescription>
          {totalsLine(tests.totals)} · from {tests.files} JUnit{" "}
          {tests.files === 1 ? "file" : "files"}
          {tests.commitSha !== undefined && (
            <span className="font-mono"> · {tests.commitSha.slice(0, 8)}</span>
          )}
          {tests.truncated && " · the report hit a size bound and lists only part of the run"}
        </CardDescription>
      </CardHeader>
      {tests.cases.length === 0 ? (
        <p className="px-4 py-3 text-sm text-muted-foreground">Every test passed.</p>
      ) : (
        <TestCaseList cases={tests.cases} />
      )}
    </Card>
  );
}

function OomNotice({ summary, executor }: { summary: MetricsSummary; executor: string }) {
  if (summary.oomKills === null || summary.oomKills === 0) return null;
  return (
    <Alert variant="destructive">
      <OctagonAlertIcon />
      <AlertTitle>
        {summary.oomKills} process{summary.oomKills === 1 ? " was" : "es were"} killed for running
        out of memory
      </AlertTitle>
      <AlertDescription>
        {executor === "firecracker"
          ? "Reported by the guest kernel on the microVM's serial console."
          : "Counted by the container's memory cgroup."}{" "}
        Peak use was {formatBytes(summary.memoryPeakBytes)} of{" "}
        {formatBytes(summary.memoryLimitBytes)}.
      </AlertDescription>
    </Alert>
  );
}

function SummaryTiles({ summary }: { summary: MetricsSummary }) {
  return (
    <StatGroup>
      <Stat>
        <StatLabel>CPU p95</StatLabel>
        <StatValue>
          {formatVcpus(summary.cpuP95Vcpus)}
          <StatUnit>/{summary.vcpus} vCPU</StatUnit>
        </StatValue>
        <StatHint>
          average {formatVcpus(summary.cpuAvgVcpus)} · busiest {formatVcpus(summary.cpuMaxVcpus)}
        </StatHint>
      </Stat>
      <Stat>
        <StatLabel>Memory peak</StatLabel>
        <StatValue>
          {(summary.memoryPeakBytes / GIB).toFixed(1)}
          <StatUnit>/{(summary.memoryLimitBytes / GIB).toFixed(0)} GiB</StatUnit>
        </StatValue>
        <StatHint>
          {summary.oomKills === null
            ? "OOM kills not visible"
            : `${summary.oomKills} OOM kill${summary.oomKills === 1 ? "" : "s"}`}
        </StatHint>
      </Stat>
      <Stat>
        <StatLabel>Network</StatLabel>
        <StatValue>
          {summary.netRxBytes === undefined ? (
            "–"
          ) : (
            <>
              {formatBytes(summary.netRxBytes)}
              <StatUnit>in</StatUnit>
            </>
          )}
        </StatValue>
        <StatHint>
          {summary.netTxBytes === undefined
            ? "not measured"
            : `${formatBytes(summary.netTxBytes)} out`}
        </StatHint>
      </Stat>
      <Stat>
        <StatLabel>Disk</StatLabel>
        <StatValue>
          {summary.diskReadBytes === undefined ? (
            "–"
          ) : (
            <>
              {formatBytes(summary.diskReadBytes)}
              <StatUnit>read</StatUnit>
            </>
          )}
        </StatValue>
        <StatHint>
          {summary.diskWriteBytes === undefined
            ? "not measured"
            : `${formatBytes(summary.diskWriteBytes)} written`}
        </StatHint>
      </Stat>
    </StatGroup>
  );
}

function cell(value: number | undefined, format: (value: number) => string) {
  return value === undefined ? "–" : format(value);
}

const POINT_HEADINGS = [
  "Elapsed",
  "CPU avg",
  "CPU busiest",
  "Memory",
  "Received",
  "Sent",
  "Read",
  "Written",
];

/** The table view every chart's values are reachable through without hovering. */
function PointsTable({ rows }: { rows: MetricsRow[] }) {
  return (
    <details className="group overflow-hidden rounded-xl border bg-card">
      <summary className="cursor-pointer px-4 py-3 text-sm text-muted-foreground hover:text-foreground focus-visible:-outline-offset-2">
        Show the {rows.length} points as a table
      </summary>
      <div className="border-t">
        <Table aria-label="Resource points" containerClassName="max-h-96">
          <TableHeader className="sticky top-0 bg-card">
            <TableRow className="hover:bg-transparent">
              {POINT_HEADINGS.map((heading) => (
                <TableHead key={heading}>{heading}</TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.seconds}>
                <TableCell>{formatElapsed(row.seconds)}</TableCell>
                <TableCell>{formatVcpus(row.cpuAvg)}</TableCell>
                <TableCell>{formatVcpus(row.cpuMax)}</TableCell>
                <TableCell>{formatBytes(row.memory)}</TableCell>
                <TableCell>{cell(row.netRx, formatRate)}</TableCell>
                <TableCell>{cell(row.netTx, formatRate)}</TableCell>
                <TableCell>{cell(row.diskRead, formatRate)}</TableCell>
                <TableCell>{cell(row.diskWrite, formatRate)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </details>
  );
}
