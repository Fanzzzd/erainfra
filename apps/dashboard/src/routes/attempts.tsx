import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "convex/react";
import { Activity } from "lucide-react";
import { api } from "@erainfra/backend/api";
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
  const now = useNow();
  const [filter, setFilter] = useState<Filter>("all");
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
        <Table className="min-w-[1050px]">
          <TableHeader>
            <TableRow>
              <TableHead className="w-[120px]">State</TableHead>
              <TableHead className="w-[150px]">Profile</TableHead>
              <TableHead className="w-[190px]">Repository / job</TableHead>
              <TableHead className="w-[150px]">Worker</TableHead>
              <TableHead className="w-[130px]">Executor</TableHead>
              <TableHead className="w-[170px]">Timing</TableHead>
              <TableHead>Image Release</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {visible === undefined ? (
              <TableRowsSkeleton columns={7} rows={4} />
            ) : visible.length === 0 ? (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={7} className="p-0">
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
                return (
                  <TableRow key={attempt._id}>
                    <TableCell>
                      <AttemptBadge state={attempt.state} />
                      {attempt.result && (
                        <p className="mt-1 text-[10px] text-subtle-foreground">{attempt.result}</p>
                      )}
                    </TableCell>
                    <TableCell>
                      <code className="text-xs text-secondary-foreground">{attempt.profile}</code>
                    </TableCell>
                    <TableCell>
                      <p className="max-w-[190px] truncate font-mono text-xs text-secondary-foreground">
                        {attempt.repo ?? "Waiting for GitHub"}
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
                    </TableCell>
                    <TableCell className="tabular-nums whitespace-nowrap text-xs text-muted-foreground">
                      {attempt.startedAt === undefined
                        ? `queued ${formatDuration(end - attempt.createdAt)}`
                        : `ran ${formatDuration(end - attempt.startedAt)}`}
                      <p
                        className="mt-0.5 text-[10px] text-subtle-foreground"
                        title={formatAbsoluteTime(attempt.createdAt)}
                      >
                        {formatRelativeTime(attempt.createdAt, now)}
                      </p>
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
                );
              })
            )}
          </TableBody>
        </Table>
      </Card>
    </div>
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
