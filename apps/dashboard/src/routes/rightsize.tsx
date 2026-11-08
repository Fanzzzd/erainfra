import { useEffect, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useConvex } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { Gauge, RefreshCw } from "lucide-react";
import { api } from "@erainfra/backend/api";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { TableRowsSkeleton } from "@/components/table-skeleton";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
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
  { label: string; variant: "destructive" | "success" | "outline" | "secondary" }
> = {
  upsize: { label: "Larger", variant: "destructive" },
  downsize: { label: "Smaller", variant: "success" },
  keep: { label: "Right size", variant: "secondary" },
  insufficient_data: { label: "Not enough data", variant: "outline" },
};

function size(value: { vcpus: number; memoryMiB: number }) {
  return `${value.vcpus} vCPU · ${formatBytes(value.memoryMiB * 1024 * 1024)}`;
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
    let current = true;
    void (async () => {
      try {
        const next = await convex.query(api.rightsize.report, {
          sinceDays: days,
          ...(repo === "" ? {} : { repo }),
        });
        if (!current) return;
        setReport(next);
        setSettled({ key });
      } catch (caught) {
        if (!current) return;
        setSettled({ key, error: caught instanceof Error ? caught.message : String(caught) });
      }
    })();
    return () => {
      current = false;
    };
  }, [convex, days, repo, key]);

  const loading = settled?.key !== key;
  const error = loading ? undefined : settled.error;

  const recommendations = report?.recommendations;
  const actionable =
    recommendations?.filter((entry) => entry.verdict === "upsize" || entry.verdict === "downsize")
      .length ?? 0;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Rightsize"
        description="Which Profile each workflow job should run on, from the CPU and memory its own runs used."
      >
        <Button
          variant="outline"
          size="sm"
          onClick={() => setRefreshes((count) => count + 1)}
          disabled={loading}
        >
          <RefreshCw className={loading ? "animate-spin" : undefined} />
          Refresh
        </Button>
      </PageHeader>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
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
            setRepo(repoInput.trim());
          }}
        >
          <Input
            aria-label="Repository"
            placeholder="owner/name"
            value={repoInput}
            maxLength={201}
            onChange={(event) => setRepoInput(event.target.value)}
            className="h-9 w-56"
          />
          <Button type="submit" variant="secondary" size="sm" className="h-9">
            Filter
          </Button>
        </form>
        {report !== undefined && (
          <p className="text-xs text-muted-foreground sm:ml-auto">
            {actionable} to move · {report.scanned} measured runs since{" "}
            {formatAbsoluteTime(report.windowStart)}
            {report.truncated && " (newest only: narrow the window or the repository)"}
          </p>
        )}
      </div>

      {error !== undefined && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}

      <Card className="overflow-hidden">
        <Table className="min-w-[1100px]">
          <TableHeader>
            <TableRow>
              <TableHead className="w-[130px]">Verdict</TableHead>
              <TableHead className="w-[220px]">Repository / job</TableHead>
              <TableHead className="w-[210px]">Profile now</TableHead>
              <TableHead className="w-[230px]">Move to</TableHead>
              <TableHead className="w-[150px]">Measured</TableHead>
              <TableHead>Why</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {recommendations === undefined ? (
              <TableRowsSkeleton columns={6} rows={4} />
            ) : recommendations.length === 0 ? (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={6} className="p-0">
                  <EmptyState
                    icon={Gauge}
                    title="No measured runs in this window"
                    description="Linux Attempts on Firecracker and Docker are measured. A job needs five finished runs before it gets a recommendation."
                  />
                </TableCell>
              </TableRow>
            ) : (
              recommendations.map((entry) => (
                <TableRow key={`${entry.repo}\u0000${entry.job}\u0000${entry.profile}`}>
                  <TableCell className="align-top">
                    <Badge variant={verdicts[entry.verdict].variant}>
                      {verdicts[entry.verdict].label}
                    </Badge>
                  </TableCell>
                  <TableCell className="align-top">
                    <p className="break-all text-xs text-secondary-foreground">{entry.repo}</p>
                    <p className="mt-0.5 break-all text-xs text-muted-foreground">{entry.job}</p>
                  </TableCell>
                  <TableCell className="align-top">
                    <code className="break-all text-xs text-secondary-foreground">
                      {entry.profile}
                    </code>
                    <p className="mt-0.5 text-[11px] text-subtle-foreground">
                      {size(entry.current)}
                    </p>
                  </TableCell>
                  <TableCell className="align-top">
                    {entry.recommendedProfile !== null ? (
                      <code className="break-all text-xs text-foreground">
                        {entry.recommendedProfile}
                      </code>
                    ) : entry.suggestedProfile !== null ? (
                      <>
                        <code className="break-all text-xs text-secondary-foreground">
                          {entry.suggestedProfile}
                        </code>
                        <p className="mt-0.5 text-[11px] text-warning">not registered</p>
                      </>
                    ) : entry.target !== null ? (
                      <p className="text-xs text-warning">register {size(entry.target)}</p>
                    ) : (
                      <span className="text-xs text-subtle-foreground">—</span>
                    )}
                    {entry.target !== null &&
                      (entry.recommendedProfile !== null || entry.suggestedProfile !== null) && (
                        <p className="mt-0.5 text-[11px] text-subtle-foreground">
                          {size(entry.target)}
                        </p>
                      )}
                  </TableCell>
                  <TableCell className="align-top text-xs tabular-nums text-muted-foreground">
                    <p>
                      cpu p95 {formatVcpus(entry.cpu.p95Vcpus)}/{entry.current.vcpus}
                    </p>
                    <p>
                      peak {formatBytes(entry.memory.peakBytes)}
                      {entry.memory.measure === "host-resident" && (
                        <span title="Firecracker: host-resident memory, page cache included">
                          {" "}
                          (host)
                        </span>
                      )}
                    </p>
                    <p>
                      {entry.attempts} runs
                      {entry.memory.oomAttempts > 0 && (
                        <span className="text-destructive"> · {entry.memory.oomAttempts} OOM</span>
                      )}
                    </p>
                  </TableCell>
                  <TableCell className="align-top text-xs leading-5 text-secondary-foreground">
                    {entry.explanation}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </Card>
    </div>
  );
}
