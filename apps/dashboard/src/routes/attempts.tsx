import { api } from "@erainfra/backend/api";
import type { Id } from "@erainfra/backend/dataModel";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "convex/react";
import { Activity, ChevronRight } from "lucide-react";
import { Fragment, useState } from "react";

import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { LiveBadge } from "@/components/status";
import { TableRowsSkeleton } from "@/components/table-skeleton";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
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
import { summaryLine } from "@/lib/metrics";
import { formatAbsoluteTime, formatDuration, formatRelativeTime } from "@/lib/time";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/attempts")({ component: AttemptsPage });

type AttemptState =
  | "pending"
  | "preparing"
  | "ready"
  | "running"
  | "completed"
  | "cancelled"
  | "failed";
type Filter = "all" | "active" | "completed" | "failed";

const filters: Array<{ value: Filter; label: string }> = [
  { value: "all", label: "All" },
  { value: "active", label: "Active" },
  { value: "completed", label: "Completed" },
  { value: "failed", label: "Failed" },
];

function isActive(state: AttemptState) {
  return state === "pending" || state === "preparing" || state === "ready" || state === "running";
}

function AttemptsPage() {
  const attempts = useQuery(api.attempts.list);
  const summaries = useQuery(
    api.attemptMetrics.summaries,
    attempts === undefined ? "skip" : { attemptIds: attempts.map((attempt) => attempt._id) },
  );
  const summaryByAttempt = new Map(summaries?.map((row) => [row.attemptId, row.summary]));
  const now = useNow();
  const [filter, setFilter] = useState<Filter>("all");
  const [egressShown, setEgressShown] = useState<string | undefined>(undefined);
  const counts = {
    all: attempts?.length ?? 0,
    active: attempts?.filter((attempt) => isActive(attempt.state)).length ?? 0,
    completed: attempts?.filter((attempt) => attempt.state === "completed").length ?? 0,
    failed:
      attempts?.filter((attempt) => attempt.state === "failed" || attempt.state === "cancelled")
        .length ?? 0,
  };
  const visible = attempts?.filter((attempt) => {
    if (filter === "active") return isActive(attempt.state);
    if (filter === "completed") return attempt.state === "completed";
    if (filter === "failed") return attempt.state === "failed" || attempt.state === "cancelled";
    return true;
  });

  return (
    <div className="space-y-6">
      <PageHeader
        title="Runs"
        description="One durable Attempt for every isolated scale-set execution."
      >
        <LiveBadge />
      </PageHeader>

      <Tabs value={filter} onValueChange={(value) => setFilter(value as Filter)}>
        <TabsList aria-label="Filter runs by state">
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

      <Card className="overflow-hidden">
        <Table className="min-w-[1250px]">
          <TableHeader>
            <TableRow>
              <TableHead className="w-[120px]">State</TableHead>
              <TableHead className="w-[150px]">Profile</TableHead>
              <TableHead className="w-[190px]">Repository / job</TableHead>
              <TableHead className="w-[150px]">Worker</TableHead>
              <TableHead className="w-[130px]">Executor</TableHead>
              <TableHead className="w-[170px]">Timing</TableHead>
              <TableHead className="w-[200px]">Resources</TableHead>
              <TableHead>Image Release</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {visible === undefined ? (
              <TableRowsSkeleton columns={8} rows={4} />
            ) : visible.length === 0 ? (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={8} className="p-0">
                  <EmptyState
                    icon={Activity}
                    title={counts.all === 0 ? "No runs yet" : `No ${filter} runs`}
                    description={
                      counts.all === 0
                        ? "Jobs targeting an active EraInfra Profile will appear here."
                        : "Every run is still there — try another state filter."
                    }
                  />
                </TableCell>
              </TableRow>
            ) : (
              visible.map((attempt) => {
                const end = attempt.finishedAt ?? now;
                const detail = attempt.lastError ?? attempt.cancelReason;
                const repository =
                  attempt.repo === undefined
                    ? undefined
                    : attempt.owner === undefined || attempt.repo.includes("/")
                      ? attempt.repo
                      : `${attempt.owner}/${attempt.repo}`;
                return (
                  <Fragment key={attempt._id}>
                    <TableRow>
                      <TableCell>
                        <AttemptBadge state={attempt.state} />
                        {attempt.result && (
                          <p className="mt-1 text-[10px] text-subtle-foreground">
                            {attempt.result}
                          </p>
                        )}
                      </TableCell>
                      <TableCell>
                        <code className="text-xs text-secondary-foreground">{attempt.profile}</code>
                      </TableCell>
                      <TableCell>
                        <p
                          className="max-w-[190px] truncate font-mono text-xs text-secondary-foreground"
                          title={repository}
                        >
                          {repository === undefined ? (
                            "Waiting for GitHub"
                          ) : attempt.workflowRunUrl === undefined ? (
                            repository
                          ) : (
                            <a
                              href={attempt.workflowRunUrl}
                              target="_blank"
                              rel="noreferrer"
                              className="underline-offset-2 hover:text-foreground hover:underline"
                            >
                              {repository}
                            </a>
                          )}
                        </p>
                        <p
                          className={cn(
                            "mt-0.5 max-w-[190px] truncate text-[10px]",
                            detail ? "text-destructive" : "text-subtle-foreground",
                          )}
                          title={detail ?? attempt.displayName}
                        >
                          {detail ?? attempt.displayName ?? attempt.runnerName}
                        </p>
                      </TableCell>
                      <TableCell className="text-xs text-secondary-foreground">
                        <span title={attempt.selectionReason}>
                          {attempt.machineName ?? (
                            <span className="text-subtle-foreground">Unassigned</span>
                          )}
                        </span>
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline" className="font-mono">
                          {attempt.executor}
                        </Badge>
                        {attempt.executor === "firecracker" && attempt.finishedAt !== undefined && (
                          <button
                            type="button"
                            className="mt-1 flex items-center gap-0.5 text-[10px] text-subtle-foreground hover:text-foreground"
                            aria-expanded={egressShown === attempt._id}
                            onClick={() =>
                              setEgressShown(egressShown === attempt._id ? undefined : attempt._id)
                            }
                          >
                            <ChevronRight
                              className={cn(
                                "size-3 transition-transform",
                                egressShown === attempt._id && "rotate-90",
                              )}
                            />
                            Egress
                          </button>
                        )}
                      </TableCell>
                      <TableCell className="tabular-nums whitespace-nowrap text-xs text-muted-foreground">
                        {attempt.startedAt === undefined
                          ? `queued ${formatDuration(end - attempt.createdAt)}`
                          : `ran ${formatDuration(end - attempt.startedAt)}`}
                        {attempt.queueWaitMs !== null && (
                          <p
                            className="mt-0.5 text-[10px] text-subtle-foreground"
                            title="Time GitHub held the job before a Runner on this Profile picked it up"
                          >
                            waited {formatDuration(attempt.queueWaitMs)} in queue
                          </p>
                        )}
                        <p
                          className="mt-0.5 text-[10px] text-subtle-foreground"
                          title={formatAbsoluteTime(attempt.createdAt)}
                        >
                          {formatRelativeTime(attempt.createdAt, now)}
                        </p>
                      </TableCell>
                      <TableCell className="text-xs">
                        <ResourceCell
                          attemptId={attempt._id}
                          summary={summaryByAttempt.get(attempt._id)}
                        />
                      </TableCell>
                      <TableCell>
                        <code
                          className="block max-w-[280px] truncate text-[10px] text-subtle-foreground"
                          title={attempt.imageRelease}
                        >
                          {attempt.imageRelease}
                        </code>
                      </TableCell>
                    </TableRow>
                    {egressShown === attempt._id && (
                      <TableRow className="hover:bg-transparent">
                        <TableCell colSpan={8} className="bg-muted/30">
                          <EgressRecord attemptId={attempt._id} />
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

function ResourceCell({
  attemptId,
  summary,
}: {
  attemptId: string;
  summary: Parameters<typeof summaryLine>[0] | undefined;
}) {
  return (
    <Link
      to="/attempts/$attemptId"
      params={{ attemptId }}
      className="block underline-offset-2 hover:text-foreground hover:underline"
    >
      {summary === undefined ? (
        <span className="text-subtle-foreground">Details</span>
      ) : (
        <>
          <span className="tabular-nums whitespace-nowrap text-secondary-foreground">
            {summaryLine(summary)}
          </span>
          {summary.oomKills !== null && summary.oomKills > 0 && (
            <span className="mt-0.5 block text-[10px] text-destructive">
              {summary.oomKills} OOM kill{summary.oomKills === 1 ? "" : "s"}
            </span>
          )}
        </>
      )}
    </Link>
  );
}

function AttemptBadge({ state }: { state: AttemptState }) {
  const variant =
    state === "completed"
      ? "success"
      : state === "failed" || state === "cancelled"
        ? "destructive"
        : state === "running"
          ? "info"
          : "warning";
  return (
    <Badge variant={variant} className="capitalize">
      {state}
    </Badge>
  );
}

/**
 * What one Attempt's guest talked to, measured on the Worker's host: the DNS
 * names it asked the host resolver for and the new flows the kernel recorded.
 */
function EgressRecord({ attemptId }: { attemptId: Id<"attempts"> }) {
  const egress = useQuery(api.attempts.egress, { attemptId });
  if (egress === undefined) return <p className="text-xs text-subtle-foreground">Loading…</p>;
  if (egress === null) {
    return (
      <p className="text-xs text-subtle-foreground">
        No egress record. The Profile has public egress, or its Worker predates egress records.
      </p>
    );
  }
  const { record } = egress;
  const names = record.names ?? [];
  const flows = record.flows ?? [];
  const blocked =
    flows.filter((flow) => flow.verdict === "blocked").length +
    names.filter((name) => name.verdict === "blocked").length;
  return (
    <div className="space-y-3 text-xs">
      <p className="text-secondary-foreground">
        <span className="font-mono">{record.mode}</span> egress · {names.length} names ·{" "}
        {flows.length} flows
        {blocked > 0 && <span className="text-destructive"> · {blocked} blocked</span>}
        {(record.omittedNames ?? 0) + (record.omittedFlows ?? 0) > 0 &&
          ` · ${(record.omittedNames ?? 0) + (record.omittedFlows ?? 0)} more not kept`}
      </p>
      {record.error && <p className="text-warning">{record.error}</p>}
      <div className="grid gap-4 md:grid-cols-2">
        <ul className="space-y-0.5 font-mono text-[11px]">
          {names.map((name) => (
            <li key={name.name} className={verdictTone(name.verdict)}>
              {name.name}{" "}
              <span className="text-subtle-foreground">
                ×{name.queries} {name.verdict}
              </span>
            </li>
          ))}
        </ul>
        <ul className="space-y-0.5 font-mono text-[11px]">
          {flows.map((flow) => (
            <li
              key={`${flow.destination}:${flow.protocol}:${flow.port}`}
              className={verdictTone(flow.verdict)}
            >
              {flow.destination}:{flow.port}/{flow.protocol}
              {flow.name && <span className="text-subtle-foreground"> {flow.name}</span>}
              <span className="text-subtle-foreground"> {flow.verdict}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function verdictTone(verdict: "allowed" | "blocked" | "unlisted") {
  if (verdict === "blocked") return "text-destructive";
  if (verdict === "unlisted") return "text-warning";
  return "text-secondary-foreground";
}
