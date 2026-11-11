import { api } from "@erainfra/backend/api";
import type { Id } from "@erainfra/backend/dataModel";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "convex/react";
import { ArrowLeft, Gauge, OctagonAlert, TestTubeDiagonal } from "lucide-react";

import { EmptyState } from "@/components/empty-state";
import { MetricChart } from "@/components/metric-chart";
import { PageHeader } from "@/components/page-header";
import { RunnerCauseNote } from "@/components/runner-cause";
import { TestCaseList, totalsLine } from "@/components/test-results";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
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
import { formatAbsoluteTime, formatDuration } from "@/lib/time";

export const Route = createFileRoute("/attempts_/$attemptId")({ component: AttemptPage });

const GIB = 1024 ** 3;

function AttemptPage() {
  const { attemptId } = Route.useParams();
  const page = useQuery(api.attemptMetrics.get, { attemptId: attemptId as Id<"attempts"> });

  const back = (
    <Link
      to="/attempts"
      className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
    >
      <ArrowLeft className="size-3.5" />
      Runs
    </Link>
  );

  if (page === undefined) {
    return (
      <div className="space-y-6">
        {back}
        <Skeleton className="h-8 w-64" />
        <div className="grid gap-4 lg:grid-cols-2">
          {[0, 1, 2, 3].map((index) => (
            <Skeleton key={index} className="h-56" />
          ))}
        </div>
      </div>
    );
  }
  if (page === null) {
    return (
      <div className="space-y-6">
        {back}
        <EmptyState
          icon={Gauge}
          title="No such run"
          description="Finished runs are kept for 30 days, and their resource metrics for 14."
        />
      </div>
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

  return (
    <div className="space-y-6">
      {back}
      <PageHeader
        title={attempt.displayName ?? attempt.runnerName}
        description={[repository, attempt.profile, attempt.machineName].filter(Boolean).join(" · ")}
      >
        <Badge variant="outline" className="font-mono">
          {attempt.executor}
        </Badge>
        <Badge variant="outline" className="capitalize">
          {attempt.state}
        </Badge>
      </PageHeader>
      <p className="text-xs text-muted-foreground">
        Allotted {attempt.vcpus} vCPU and {formatBytes(attempt.memoryMiB * 1024 * 1024)}
        {attempt.startedAt !== undefined &&
          ` · started ${formatAbsoluteTime(attempt.startedAt)}` +
            (end === undefined ? "" : ` · ran ${formatDuration(end - attempt.startedAt)}`)}
        {attempt.lastError !== undefined && (
          <span className="text-destructive"> · {attempt.lastError}</span>
        )}
      </p>
      {attempt.cause !== undefined && <RunnerCauseNote cause={attempt.cause} />}

      {summary === null || series === null ? (
        <Card>
          <EmptyState
            icon={Gauge}
            title="No resource metrics for this run"
            description={
              attempt.executor === "tart" || attempt.executor === "hyperv"
                ? "Only Linux executors are measured. Tart and Hyper-V runs have no resource chart."
                : "The Worker sends the first snapshot about 30 seconds into the job. Runs on a Worker older than this release, or finished more than 14 days ago, have none."
            }
          />
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
          <p className="text-[11px] leading-5 text-subtle-foreground">
            Measured on the Worker from the {sourceLabel(series.source)}, every{" "}
            {series.sampleSeconds} s; each point covers {series.bucketSeconds} s.
            {series.source === "firecracker-vmm" &&
              " Memory is what the host has backed for the guest, which does not shrink when the guest frees it."}
            {!summary.final && " The run is still reporting."}
            {series.errors > 0 &&
              ` ${series.errors} reading(s) failed${series.lastError ? `: ${series.lastError}` : ""}.`}
          </p>
          <DataTable rows={rows} />
        </>
      )}

      <AttemptTests attemptId={attempt._id} executor={attempt.executor} />
    </div>
  );
}

/** The JUnit results this run reported, failures first and then its slowest passes. */
function AttemptTests({ attemptId, executor }: { attemptId: Id<"attempts">; executor: string }) {
  const tests = useQuery(api.testReports.forAttempt, { attemptId });
  if (tests === undefined) return <Skeleton className="h-24" />;
  if (tests === null) {
    return (
      <Card>
        <EmptyState
          icon={TestTubeDiagonal}
          title="No test results for this run"
          description={
            executor === "firecracker"
              ? "The job left no JUnit XML file the collector looks for, or it ran on an image older than the collector. Results are kept for 30 days."
              : "Test results are collected on the Firecracker executor only."
          }
        />
      </Card>
    );
  }
  return (
    <Card className="gap-0 overflow-hidden py-0">
      <div className="border-b border-border px-4 py-3">
        <p className="text-sm font-medium text-foreground">Tests</p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {totalsLine(tests.totals)} · from {tests.files} JUnit{" "}
          {tests.files === 1 ? "file" : "files"}
          {tests.commitSha !== undefined && (
            <span className="font-mono"> · {tests.commitSha.slice(0, 8)}</span>
          )}
          {tests.truncated && " · the report hit a size bound and lists only part of the run"}
        </p>
      </div>
      {tests.cases.length === 0 ? (
        <p className="px-4 py-3 text-xs text-muted-foreground">Every test passed.</p>
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
      <OctagonAlert />
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

function Tile({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <Card className="px-4 py-3">
      <p className="text-[11px] text-muted-foreground">{label}</p>
      <p className="mt-1 text-lg font-semibold tabular-nums text-foreground">{value}</p>
      <p className="mt-0.5 text-[11px] tabular-nums text-subtle-foreground">{detail}</p>
    </Card>
  );
}

function SummaryTiles({ summary }: { summary: MetricsSummary }) {
  return (
    <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
      <Tile
        label="CPU p95"
        value={`${formatVcpus(summary.cpuP95Vcpus)} / ${summary.vcpus} vCPU`}
        detail={`average ${formatVcpus(summary.cpuAvgVcpus)} · busiest ${formatVcpus(summary.cpuMaxVcpus)}`}
      />
      <Tile
        label="Memory peak"
        value={`${(summary.memoryPeakBytes / GIB).toFixed(1)} / ${(summary.memoryLimitBytes / GIB).toFixed(0)} GiB`}
        detail={
          summary.oomKills === null
            ? "OOM kills not visible"
            : `${summary.oomKills} OOM kill${summary.oomKills === 1 ? "" : "s"}`
        }
      />
      <Tile
        label="Network"
        value={summary.netRxBytes === undefined ? "–" : `${formatBytes(summary.netRxBytes)} in`}
        detail={
          summary.netTxBytes === undefined
            ? "not measured"
            : `${formatBytes(summary.netTxBytes)} out`
        }
      />
      <Tile
        label="Disk"
        value={
          summary.diskReadBytes === undefined ? "–" : `${formatBytes(summary.diskReadBytes)} read`
        }
        detail={
          summary.diskWriteBytes === undefined
            ? "not measured"
            : `${formatBytes(summary.diskWriteBytes)} written`
        }
      />
    </div>
  );
}

function cell(value: number | undefined, format: (value: number) => string) {
  return value === undefined ? "–" : format(value);
}

/** The table view every chart's values are reachable through without hovering. */
function DataTable({ rows }: { rows: MetricsRow[] }) {
  return (
    <details className="rounded-lg border border-border bg-card">
      <summary className="cursor-pointer px-4 py-3 text-xs text-muted-foreground hover:text-foreground">
        Show the {rows.length} points as a table
      </summary>
      <div className="max-h-96 overflow-auto border-t border-border">
        <table className="w-full text-left text-[11px] tabular-nums">
          <thead className="sticky top-0 bg-card text-muted-foreground">
            <tr>
              {[
                "Elapsed",
                "CPU avg",
                "CPU busiest",
                "Memory",
                "Received",
                "Sent",
                "Read",
                "Written",
              ].map((heading) => (
                <th key={heading} className="px-3 py-2 font-medium">
                  {heading}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="text-secondary-foreground">
            {rows.map((row) => (
              <tr key={row.seconds} className="border-t border-border">
                <td className="px-3 py-1.5">{formatElapsed(row.seconds)}</td>
                <td className="px-3 py-1.5">{formatVcpus(row.cpuAvg)}</td>
                <td className="px-3 py-1.5">{formatVcpus(row.cpuMax)}</td>
                <td className="px-3 py-1.5">{formatBytes(row.memory)}</td>
                <td className="px-3 py-1.5">{cell(row.netRx, formatRate)}</td>
                <td className="px-3 py-1.5">{cell(row.netTx, formatRate)}</td>
                <td className="px-3 py-1.5">{cell(row.diskRead, formatRate)}</td>
                <td className="px-3 py-1.5">{cell(row.diskWrite, formatRate)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}
