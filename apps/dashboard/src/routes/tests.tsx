import { api } from "@erainfra/backend/api";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { ListXIcon, ShuffleIcon, TimerIcon } from "lucide-react";
import { type ComponentType, type ReactNode, useMemo, useState } from "react";

import { createDataTableColumns, DataTable } from "@/components/data-table";
import {
  EmptyState,
  EmptyStateDescription,
  EmptyStateMedia,
  EmptyStateTitle,
} from "@/components/empty-state";
import {
  PageHeader,
  PageHeaderActions,
  PageHeaderDescription,
  PageHeaderTitle,
} from "@/components/page-header";
import { LiveIndicator } from "@/components/status";
import {
  formatTestDuration,
  TestCaseList,
  TestMessage,
  TestName,
  totalsLine,
} from "@/components/test-results";
import { Badge } from "@/components/ui/badge";
import { Card, CardAction, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useNow } from "@/hooks/use-now";
import { formatAbsoluteTime, formatRelativeTime } from "@/lib/time";

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

// The Select needs a non-empty value for "All repositories"; the query gets no repository.
const ALL_REPOSITORIES = "__all__";

const DAY_MS = 86_400_000;

const linkClass = "font-medium text-foreground underline-offset-4 hover:underline";

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
  const repositoryItems = [
    { value: ALL_REPOSITORIES, label: "All repositories" },
    ...(repositories ?? []).map((name) => ({ value: name, label: name })),
  ];

  return (
    <>
      <PageHeader>
        <PageHeaderTitle>Tests</PageHeaderTitle>
        <PageHeaderDescription>
          Results parsed from the JUnit XML each run leaves in its workspace.
        </PageHeaderDescription>
        <PageHeaderActions>
          <LiveIndicator />
        </PageHeaderActions>
      </PageHeader>

      <div className="flex flex-wrap items-center gap-2">
        <Tabs value={view} onValueChange={(value) => setView(value as View)}>
          <TabsList aria-label="Choose a test view">
            {views.map((item) => (
              <TabsTrigger key={item.value} value={item.value}>
                {item.label}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        <div className="flex flex-wrap items-center gap-2 sm:ml-auto">
          <Select
            items={repositoryItems}
            value={repository === "" ? ALL_REPOSITORIES : repository}
            onValueChange={(value) =>
              setRepository(value === null || value === ALL_REPOSITORIES ? "" : value)
            }
          >
            <SelectTrigger aria-label="Repository" className="max-w-64 min-w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {repositoryItems.map((item) => (
                <SelectItem key={item.value} value={item.value}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select
            items={windows}
            value={days}
            onValueChange={(value) => {
              if (value !== null) setDays(value);
            }}
          >
            <SelectTrigger aria-label="Time window" className="min-w-36">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {windows.map((item) => (
                <SelectItem key={item.value} value={item.value}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {view === "failures" && <FailuresView filter={filter} now={now} />}
      {view === "flaky" && <FlakyView filter={filter} now={now} />}
      {view === "slowest" && <SlowestView filter={filter} now={now} />}
    </>
  );
}

type Filter = { repository?: string; since: number };

function Loading() {
  return (
    <div className="flex flex-col gap-3" aria-busy="true">
      {[0, 1, 2].map((index) => (
        <Skeleton key={index} className="h-24 rounded-xl" />
      ))}
    </div>
  );
}

function Empty({
  icon: Icon,
  title,
  children,
}: {
  icon: ComponentType;
  title: string;
  children: ReactNode;
}) {
  return (
    <EmptyState>
      <EmptyStateMedia>
        <Icon />
      </EmptyStateMedia>
      <EmptyStateTitle>{title}</EmptyStateTitle>
      <EmptyStateDescription>{children}</EmptyStateDescription>
    </EmptyState>
  );
}

function FailuresView({ filter, now }: { filter: Filter; now: number }) {
  const runs = useQuery(api.testReports.runs, { ...filter, failedOnly: true, limit: 50 });
  if (runs === undefined) return <Loading />;
  if (runs.length === 0) {
    return (
      <Card className="py-0">
        <Empty icon={ListXIcon} title="No failing runs in this window">
          A run appears here when a test in its JUnit files failed or errored. Runs that wrote no
          JUnit file report no tests.
        </Empty>
      </Card>
    );
  }
  return (
    <div className="flex flex-col gap-4">
      {runs.map((run) => (
        <Card key={run.reportId} className="gap-0 py-0">
          <CardHeader className="border-b py-3">
            <CardTitle render={<h2 />} className="truncate text-sm">
              {[run.repository, run.jobName].filter(Boolean).join(" / ") || "Unbound run"}
            </CardTitle>
            <CardDescription className="text-xs">
              {totalsLine(run.totals)}
              {run.branch !== undefined && ` · ${run.branch}`}
              {run.commitSha !== undefined && (
                <span className="font-mono"> · {run.commitSha.slice(0, 8)}</span>
              )}
              {run.truncated && " · report truncated"}
            </CardDescription>
            <CardAction className="flex items-center gap-3 text-xs text-muted-foreground">
              <span className="hidden sm:inline" title={formatAbsoluteTime(run.recordedAt)}>
                {formatRelativeTime(run.recordedAt, now)}
              </span>
              <Link
                to="/attempts/$attemptId"
                params={{ attemptId: run.attemptId }}
                className={linkClass}
              >
                Run details
              </Link>
            </CardAction>
          </CardHeader>
          <TestCaseList cases={run.failures} />
        </Card>
      ))}
    </div>
  );
}

type FlakyRow = FunctionReturnType<typeof api.testReports.flaky>[number];
type SlowRow = FunctionReturnType<typeof api.testReports.slowest>[number];

const flakyColumn = createDataTableColumns<FlakyRow>();
const slowColumn = createDataTableColumns<SlowRow>();

function useFlakyColumns(now: number) {
  return useMemo(
    () =>
      flakyColumn.columns([
        flakyColumn.accessor("name", {
          header: "Test",
          cell: (cell) => (
            <div className="max-w-xl min-w-64 whitespace-normal">
              <TestName
                name={cell.getValue()}
                suite={cell.row.original.suite}
                file={cell.row.original.file}
              />
              <TestMessage message={cell.row.original.lastMessage} />
            </div>
          ),
          meta: { cellClassName: "align-top" },
        }),
        flakyColumn.accessor("repository", {
          header: "Repository",
          meta: { cellClassName: "align-top" },
        }),
        flakyColumn.accessor("occurrences", {
          header: "Seen flaky",
          cell: (cell) => `${cell.getValue()} ${cell.getValue() === 1 ? "run" : "runs"}`,
          meta: { align: "end", cellClassName: "align-top" },
        }),
        flakyColumn.accessor("lastEvidence", {
          header: "Evidence",
          enableSorting: false,
          cell: (cell) => (
            <Badge variant="warning">
              {cell.getValue() === "retried" ? "Retried into a pass" : "Failed, then passed"}
            </Badge>
          ),
          meta: { cellClassName: "align-top" },
        }),
        flakyColumn.accessor("lastSeenAt", {
          header: "Last seen",
          cell: (cell) => {
            const latest = cell.row.original.attemptIds[0];
            return (
              <div>
                <div className="text-muted-foreground" title={formatAbsoluteTime(cell.getValue())}>
                  {formatRelativeTime(cell.getValue(), now)}
                </div>
                {latest !== undefined && (
                  <Link
                    to="/attempts/$attemptId"
                    params={{ attemptId: latest }}
                    className={`${linkClass} text-xs`}
                  >
                    Latest run
                  </Link>
                )}
              </div>
            );
          },
          meta: { cellClassName: "align-top" },
        }),
      ]),
    [now],
  );
}

function FlakyView({ filter, now }: { filter: Filter; now: number }) {
  const rows = useQuery(api.testReports.flaky, { ...filter, limit: 100 });
  const columns = useFlakyColumns(now);
  return (
    <Card className="gap-0 py-0">
      <DataTable
        aria-label="Flaky tests"
        columns={columns}
        data={rows ?? []}
        getRowId={(row) => `${row.repository}:${row.testId}`}
        loading={rows === undefined}
        loadingRows={4}
        empty={
          <Empty icon={ShuffleIcon} title="No flaky tests in this window">
            A test is flaky when it failed and passed in two runs of the same code (a rerun, or
            another push or scheduled run of the same branch and commit), or when its test runner
            retried it into a pass.
          </Empty>
        }
      />
    </Card>
  );
}

function useSlowColumns(now: number) {
  return useMemo(
    () =>
      slowColumn.columns([
        slowColumn.accessor("name", {
          header: "Test",
          cell: (cell) => (
            <div className="max-w-xl min-w-64 whitespace-normal">
              <TestName name={cell.getValue()} suite={cell.row.original.suite} />
            </div>
          ),
        }),
        slowColumn.accessor("meanDurationMs", {
          header: "Mean",
          cell: (cell) => formatTestDuration(cell.getValue()),
          meta: { align: "end" },
        }),
        slowColumn.accessor("maxDurationMs", {
          header: "Slowest",
          cell: (cell) => formatTestDuration(cell.getValue()),
          meta: { align: "end" },
        }),
        slowColumn.accessor("lastDurationMs", {
          header: "Last",
          cell: (cell) => formatTestDuration(cell.getValue()),
          meta: { align: "end" },
        }),
        slowColumn.accessor("runs", { header: "Runs", meta: { align: "end" } }),
        slowColumn.accessor("lastSeenAt", {
          header: "Last seen",
          cell: (cell) => (
            <span className="text-muted-foreground">
              {formatRelativeTime(cell.getValue(), now)}
            </span>
          ),
        }),
      ]),
    [now],
  );
}

function SlowestView({ filter, now }: { filter: Filter; now: number }) {
  const rows = useQuery(api.testReports.slowest, { ...filter, limit: 50 });
  const columns = useSlowColumns(now);
  return (
    <Card className="gap-0 py-0">
      <DataTable
        aria-label="Slowest tests"
        columns={columns}
        data={rows ?? []}
        getRowId={(row) => row.testId}
        loading={rows === undefined}
        loadingRows={4}
        empty={
          <Empty icon={TimerIcon} title="No timed tests in this window">
            Each run keeps its 50 slowest passing tests. They appear here once a run with JUnit
            files has finished.
          </Empty>
        }
      />
      {rows !== undefined && rows.length > 0 && (
        <p className="border-t bg-subtle px-4 py-2.5 text-xs text-muted-foreground">
          Built from the slowest 50 passing tests each run kept, so a test that is slow only now and
          then shows fewer runs than it had.
        </p>
      )}
    </Card>
  );
}
