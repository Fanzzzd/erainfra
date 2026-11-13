import { api } from "@erainfra/backend/api";
import { createFileRoute } from "@tanstack/react-router";
import { useConvex } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { GaugeIcon, RefreshCwIcon } from "lucide-react";
import { useEffect, useState } from "react";

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
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge, type BadgeProps } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { formatBytes, formatVcpus } from "@/lib/metrics";
import { formatAbsoluteTime } from "@/lib/time";

export const Route = createFileRoute("/rightsize")({ component: RightsizePage });

type Report = FunctionReturnType<typeof api.rightsize.report>;
type Recommendation = Report["recommendations"][number];

const windows = [
  { days: 3, label: "3 days" },
  { days: 7, label: "7 days" },
  { days: 14, label: "14 days" },
] as const;

const verdicts: Record<
  Recommendation["verdict"],
  { label: string; variant: NonNullable<BadgeProps["variant"]> }
> = {
  upsize: { label: "Larger", variant: "danger" },
  downsize: { label: "Smaller", variant: "success" },
  keep: { label: "Right size", variant: "secondary" },
  insufficient_data: { label: "Not enough data", variant: "outline" },
};

function size(value: { vcpus: number; memoryMiB: number }) {
  return `${value.vcpus} vCPU, ${formatBytes(value.memoryMiB * 1024 * 1024)}`;
}

const column = createDataTableColumns<Recommendation>();

const columns = column.columns([
  column.accessor("verdict", {
    header: "Verdict",
    cell: (cell) => (
      <Badge variant={verdicts[cell.getValue()].variant}>{verdicts[cell.getValue()].label}</Badge>
    ),
    meta: { cellClassName: "align-top" },
  }),
  column.accessor("repo", {
    header: "Repository and job",
    cell: (cell) => (
      <div className="max-w-56 whitespace-normal">
        <div className="font-medium break-all">{cell.getValue()}</div>
        <div className="text-xs break-all text-muted-foreground">{cell.row.original.job}</div>
      </div>
    ),
    meta: { cellClassName: "align-top" },
  }),
  column.accessor("profile", {
    header: "Profile now",
    cell: (cell) => (
      <div>
        <code className="text-[13px]">{cell.getValue()}</code>
        <div className="text-xs text-muted-foreground">{size(cell.row.original.current)}</div>
      </div>
    ),
    meta: { cellClassName: "align-top" },
  }),
  column.display({
    id: "move",
    header: "Move to",
    cell: (cell) => {
      const entry = cell.row.original;
      return (
        <div>
          {entry.recommendedProfile !== null ? (
            <code className="text-[13px] font-medium">{entry.recommendedProfile}</code>
          ) : entry.suggestedProfile !== null ? (
            <>
              <code className="text-[13px]">{entry.suggestedProfile}</code>
              <div className="text-xs text-warning">Not registered</div>
            </>
          ) : entry.target !== null ? (
            <div className="text-warning">Register {size(entry.target)}</div>
          ) : (
            <span className="text-muted-foreground">None</span>
          )}
          {entry.target !== null &&
            (entry.recommendedProfile !== null || entry.suggestedProfile !== null) && (
              <div className="text-xs text-muted-foreground">{size(entry.target)}</div>
            )}
        </div>
      );
    },
    meta: { cellClassName: "align-top" },
  }),
  column.accessor("attempts", {
    header: "Measured",
    cell: (cell) => {
      const entry = cell.row.original;
      return (
        <div className="text-xs leading-5 text-muted-foreground">
          <div>
            CPU p95 {formatVcpus(entry.cpu.p95Vcpus)}/{entry.current.vcpus}
          </div>
          <div>
            Peak {formatBytes(entry.memory.peakBytes)}
            {entry.memory.measure === "host-resident" && (
              <span title="Firecracker: host-resident memory, page cache included"> (host)</span>
            )}
          </div>
          <div>
            {entry.attempts} runs
            {entry.memory.oomAttempts > 0 && (
              <span className="text-danger">, {entry.memory.oomAttempts} OOM</span>
            )}
          </div>
        </div>
      );
    },
    meta: { cellClassName: "align-top" },
  }),
  column.accessor("explanation", {
    header: "Why",
    enableSorting: false,
    cell: (cell) => (
      <p className="max-w-md min-w-64 text-[13px] leading-5 whitespace-normal text-muted-foreground">
        {cell.getValue()}
      </p>
    ),
    meta: { cellClassName: "align-top" },
  }),
]);

function rowId(entry: Recommendation) {
  return `${entry.repo}\u0000${entry.job}\u0000${entry.profile}`;
}

/**
 * Right-sizing per workflow job. Read once per visit and on Refresh rather than subscribed:
 * the report scans up to two thousand metric summaries, and every live Attempt rewrites its own
 * every 30 seconds.
 */
function RightsizePage() {
  const convex = useConvex();
  const [days, setDays] = useState<number>(14);
  const [repoInput, setRepoInput] = useState("");
  const [repo, setRepo] = useState("");
  const [refreshes, setRefreshes] = useState(0);
  const [report, setReport] = useState<Report | undefined>(undefined);
  // Which request last finished, and its error if it failed. The page is loading until the
  // request for the current filters and refresh count finishes; a reply to an older request is
  // dropped, so a slow earlier query cannot overwrite a newer one. The last good report stays on
  // screen while the next one loads or after it fails.
  const [settled, setSettled] = useState<{ key: string; error?: string }>();
  const key = JSON.stringify([days, repo, refreshes]);

  useEffect(() => {
    const stale = new AbortController();
    void (async () => {
      try {
        const next = await convex.query(api.rightsize.report, {
          sinceDays: days,
          ...(repo === "" ? {} : { repo }),
        });
        if (stale.signal.aborted) return;
        setReport(next);
        setSettled({ key });
      } catch (caught) {
        if (stale.signal.aborted) return;
        setSettled({ key, error: caught instanceof Error ? caught.message : String(caught) });
      }
    })();
    return () => stale.abort();
  }, [convex, days, repo, key]);

  const loading = settled?.key !== key;
  const error = loading ? undefined : settled.error;

  const recommendations = report?.recommendations;
  const actionable =
    recommendations?.filter((entry) => entry.verdict === "upsize" || entry.verdict === "downsize")
      .length ?? 0;

  return (
    <>
      <PageHeader>
        <PageHeaderTitle>Rightsize</PageHeaderTitle>
        <PageHeaderDescription>
          Which Profile each workflow job should run on, from the CPU and memory its own runs used.
        </PageHeaderDescription>
        <PageHeaderActions>
          <Button
            variant="outline"
            onClick={() => setRefreshes((count) => count + 1)}
            disabled={loading}
          >
            <RefreshCwIcon
              data-icon="inline-start"
              className={loading ? "motion-safe:animate-spin" : undefined}
            />
            Refresh
          </Button>
        </PageHeaderActions>
      </PageHeader>

      {error !== undefined && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <Card className="gap-0 py-0">
        <CardHeader className="border-b py-4">
          <CardTitle render={<h2 />}>Recommendations</CardTitle>
          <CardDescription>
            {report === undefined
              ? "Reading measured runs."
              : `${actionable} to move, from ${report.scanned} measured runs since ${formatAbsoluteTime(report.windowStart)}.`}
            {report?.truncated && " Newest runs only: narrow the window or the repository."}
          </CardDescription>
        </CardHeader>
        <div className="border-b px-4 py-3">
          <Filters
            days={days}
            setDays={setDays}
            repoInput={repoInput}
            setRepoInput={setRepoInput}
            apply={() => setRepo(repoInput.trim())}
          />
        </div>
        <DataTable
          aria-label="Rightsize recommendations"
          columns={columns}
          data={recommendations ?? []}
          getRowId={rowId}
          loading={recommendations === undefined}
          loadingRows={4}
          empty={
            <EmptyState>
              <EmptyStateMedia>
                <GaugeIcon />
              </EmptyStateMedia>
              <EmptyStateTitle>No measured runs in this window</EmptyStateTitle>
              <EmptyStateDescription>
                Linux Attempts on Firecracker and Docker are measured. A job needs five finished
                runs before it gets a recommendation.
              </EmptyStateDescription>
            </EmptyState>
          }
        />
      </Card>
    </>
  );
}

function Filters({
  days,
  setDays,
  repoInput,
  setRepoInput,
  apply,
}: {
  days: number;
  setDays: (days: number) => void;
  repoInput: string;
  setRepoInput: (value: string) => void;
  apply: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Tabs value={String(days)} onValueChange={(value) => setDays(Number(value))}>
        <TabsList aria-label="Window">
          {windows.map((item) => (
            <TabsTrigger key={item.days} value={String(item.days)}>
              {item.label}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
      <form
        className="flex gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          apply();
        }}
      >
        <Input
          aria-label="Repository"
          placeholder="owner/name"
          value={repoInput}
          maxLength={201}
          onChange={(event) => setRepoInput(event.target.value)}
          className="w-44"
        />
        <Button type="submit" variant="outline">
          Filter
        </Button>
      </form>
    </div>
  );
}
