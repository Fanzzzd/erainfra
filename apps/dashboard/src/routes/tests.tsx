import { api } from "@erainfra/backend/api";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "convex/react";
import { ListX, Shuffle, Timer } from "lucide-react";
import { useState } from "react";

import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { LiveBadge } from "@/components/status";
import {
  formatTestDuration,
  TestCaseList,
  TestMessage,
  TestName,
  totalsLine,
} from "@/components/test-results";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { inputClass } from "@/components/ui/input";
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
import { formatAbsoluteTime, formatRelativeTime } from "@/lib/time";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/tests")({ component: TestsPage });

type View = "failures" | "flaky" | "slowest";
const views: Array<{ value: View; label: string }> = [
  { value: "failures", label: "Failures" },
  { value: "flaky", label: "Flaky" },
  { value: "slowest", label: "Slowest" },
];

const windows = [
  { value: "1", label: "Last 24 hours" },
  { value: "7", label: "Last 7 days" },
  { value: "30", label: "Last 30 days" },
] as const;

const DAY_MS = 86_400_000;

function TestsPage() {
  const now = useNow();
  const [view, setView] = useState<View>("failures");
  const [repository, setRepository] = useState<string>("");
  const [days, setDays] = useState<string>("7");
  // The window is rounded to the minute so the query arguments, and with them the subscription,
  // do not change on every tick of the clock.
  const since = Math.floor((now - Number(days) * DAY_MS) / 60_000) * 60_000;
  const filter = { ...(repository === "" ? {} : { repository }), since };
  const repositories = useQuery(api.testReports.repositories, {});

  return (
    <div className="space-y-6">
      <PageHeader
        title="Tests"
        description="Results parsed from the JUnit XML each run leaves in its workspace."
      >
        <LiveBadge />
      </PageHeader>

      <div className="flex flex-wrap items-center gap-3">
        <Tabs value={view} onValueChange={(value) => setView(value as View)}>
          <TabsList aria-label="Choose a test view">
            {views.map((item) => (
              <TabsTrigger key={item.value} value={item.value}>
                {item.label}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        <select
          aria-label="Repository"
          className={cn(inputClass, "w-auto")}
          value={repository}
          onChange={(event) => setRepository(event.target.value)}
        >
          <option value="">All repositories</option>
          {repositories?.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
        <select
          aria-label="Time window"
          className={cn(inputClass, "w-auto")}
          value={days}
          onChange={(event) => setDays(event.target.value)}
        >
          {windows.map((item) => (
            <option key={item.value} value={item.value}>
              {item.label}
            </option>
          ))}
        </select>
      </div>

      {view === "failures" && <FailuresView filter={filter} now={now} />}
      {view === "flaky" && <FlakyView filter={filter} now={now} />}
      {view === "slowest" && <SlowestView filter={filter} now={now} />}
    </div>
  );
}

type Filter = { repository?: string; since: number };

function Loading() {
  return (
    <div className="space-y-3">
      {[0, 1, 2].map((index) => (
        <Skeleton key={index} className="h-24" />
      ))}
    </div>
  );
}

function FailuresView({ filter, now }: { filter: Filter; now: number }) {
  const runs = useQuery(api.testReports.runs, { ...filter, failedOnly: true, limit: 50 });
  if (runs === undefined) return <Loading />;
  if (runs.length === 0) {
    return (
      <Card>
        <EmptyState
          icon={ListX}
          title="No failing runs in this window"
          description="A run appears here when a test in its JUnit files failed or errored. Runs that wrote no JUnit file report no tests."
        />
      </Card>
    );
  }
  return (
    <div className="space-y-4">
      {runs.map((run) => (
        <Card key={run.reportId} className="gap-0 overflow-hidden py-0">
          <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border px-4 py-3">
            <div className="min-w-0">
              <p className="truncate text-sm font-medium text-foreground">
                {[run.repository, run.jobName].filter(Boolean).join(" / ") || "Unbound run"}
              </p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {totalsLine(run.totals)}
                {run.branch !== undefined && ` · ${run.branch}`}
                {run.commitSha !== undefined && (
                  <span className="font-mono"> · {run.commitSha.slice(0, 8)}</span>
                )}
                {run.truncated && " · report truncated"}
              </p>
            </div>
            <div className="flex items-center gap-3 text-xs text-muted-foreground">
              <span title={formatAbsoluteTime(run.recordedAt)}>
                {formatRelativeTime(run.recordedAt, now)}
              </span>
              <Link
                to="/attempts/$attemptId"
                params={{ attemptId: run.attemptId }}
                className="text-primary hover:underline"
              >
                Run details
              </Link>
            </div>
          </div>
          <TestCaseList cases={run.failures} />
        </Card>
      ))}
    </div>
  );
}

function FlakyView({ filter, now }: { filter: Filter; now: number }) {
  const rows = useQuery(api.testReports.flaky, { ...filter, limit: 100 });
  if (rows === undefined) return <Loading />;
  if (rows.length === 0) {
    return (
      <Card>
        <EmptyState
          icon={Shuffle}
          title="No flaky tests in this window"
          description="A test is flaky when it failed and passed in two runs of the same code (a rerun, or another push or scheduled run of the same branch and commit), or when its test runner retried it into a pass."
        />
      </Card>
    );
  }
  return (
    <Card className="overflow-hidden py-0">
      <Table className="min-w-[900px]">
        <TableHeader>
          <TableRow>
            <TableHead>Test</TableHead>
            <TableHead className="w-[160px]">Repository</TableHead>
            <TableHead className="w-[110px]">Seen flaky</TableHead>
            <TableHead className="w-[150px]">Evidence</TableHead>
            <TableHead className="w-[120px]">Last seen</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={`${row.repository}:${row.testId}`} className="align-top">
              <TableCell className="max-w-0">
                <TestName name={row.name} suite={row.suite} file={row.file} />
                <TestMessage message={row.lastMessage} />
              </TableCell>
              <TableCell className="truncate text-xs">{row.repository}</TableCell>
              <TableCell className="text-xs tabular-nums">
                {row.occurrences} {row.occurrences === 1 ? "run" : "runs"}
              </TableCell>
              <TableCell>
                <Badge variant="warning">
                  {row.lastEvidence === "retried" ? "retried into a pass" : "failed, then passed"}
                </Badge>
              </TableCell>
              <TableCell className="text-xs text-muted-foreground">
                <span title={formatAbsoluteTime(row.lastSeenAt)}>
                  {formatRelativeTime(row.lastSeenAt, now)}
                </span>
                {row.attemptIds[0] !== undefined && (
                  <Link
                    to="/attempts/$attemptId"
                    params={{ attemptId: row.attemptIds[0] }}
                    className="block text-primary hover:underline"
                  >
                    Latest run
                  </Link>
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Card>
  );
}

function SlowestView({ filter, now }: { filter: Filter; now: number }) {
  const rows = useQuery(api.testReports.slowest, { ...filter, limit: 50 });
  if (rows === undefined) return <Loading />;
  if (rows.length === 0) {
    return (
      <Card>
        <EmptyState
          icon={Timer}
          title="No timed tests in this window"
          description="Each run keeps its 50 slowest passing tests. They appear here once a run with JUnit files has finished."
        />
      </Card>
    );
  }
  return (
    <Card className="overflow-hidden py-0">
      <Table className="min-w-[800px]">
        <TableHeader>
          <TableRow>
            <TableHead>Test</TableHead>
            <TableHead className="w-[110px] text-right">Mean</TableHead>
            <TableHead className="w-[110px] text-right">Slowest</TableHead>
            <TableHead className="w-[110px] text-right">Last</TableHead>
            <TableHead className="w-[80px] text-right">Runs</TableHead>
            <TableHead className="w-[110px]">Last seen</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row.testId}>
              <TableCell className="max-w-0">
                <TestName name={row.name} suite={row.suite} />
              </TableCell>
              <TableCell className="text-right text-xs tabular-nums">
                {formatTestDuration(row.meanDurationMs)}
              </TableCell>
              <TableCell className="text-right text-xs tabular-nums">
                {formatTestDuration(row.maxDurationMs)}
              </TableCell>
              <TableCell className="text-right text-xs tabular-nums">
                {formatTestDuration(row.lastDurationMs)}
              </TableCell>
              <TableCell className="text-right text-xs tabular-nums">{row.runs}</TableCell>
              <TableCell className="text-xs text-muted-foreground">
                {formatRelativeTime(row.lastSeenAt, now)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <p className="border-t border-border px-4 py-2 text-[11px] text-subtle-foreground">
        Built from the slowest 50 passing tests each run kept, so a test that is slow only now and
        then shows fewer runs than it had.
      </p>
    </Card>
  );
}
