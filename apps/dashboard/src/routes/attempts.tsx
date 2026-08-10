import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "convex/react";
import { Activity } from "lucide-react";
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
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-start">
        <div>
          <h1 className="text-2xl font-semibold tracking-[-0.025em] text-zinc-50">Runs</h1>
          <p className="mt-1.5 text-sm text-[#8a8a93]">
            One durable Attempt for every isolated scale-set execution.
          </p>
        </div>
        <span className="flex h-8 shrink-0 items-center gap-2 rounded-md border border-white/[0.08] bg-white/[0.025] px-2.5 text-xs text-zinc-400">
          <span className="status-pulse size-1.5 rounded-full bg-emerald-400" />
          Live updates
        </span>
      </div>

      <div className="flex w-fit items-center gap-1 rounded-lg border border-white/[0.08] bg-[#0d0d0f] p-1">
        {filters.map((item) => (
          <button
            key={item.value}
            type="button"
            aria-pressed={filter === item.value}
            className={cn(
              "flex h-7 items-center gap-2 rounded-full px-2.5 text-xs font-medium text-[#8a8a93] outline-none transition-colors hover:text-zinc-200 focus-visible:ring-2 focus-visible:ring-emerald-400/80",
              filter === item.value && "bg-white/[0.08] text-zinc-100",
            )}
            onClick={() => setFilter(item.value)}
          >
            {item.label}
            <span className="tabular-nums text-[10px] text-[#7c7c85]">{counts[item.value]}</span>
          </button>
        ))}
      </div>

      <section className="overflow-hidden rounded-lg border border-white/[0.08] bg-[#0d0d0f]">
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
              <TableRow>
                <TableCell colSpan={7} className="h-36 text-center text-[#8a8a93]">
                  Syncing Attempts…
                </TableCell>
              </TableRow>
            ) : visible.length === 0 ? (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={7} className="h-64 text-center">
                  <div className="mx-auto flex max-w-sm flex-col items-center">
                    <div className="grid size-9 place-items-center rounded-md border border-white/[0.08] bg-white/[0.025] text-[#8a8a93]">
                      <Activity className="size-4" />
                    </div>
                    <p className="mt-4 text-sm font-medium text-zinc-200">No matching runs</p>
                    <p className="mt-1 text-xs leading-5 text-[#8a8a93]">
                      Jobs targeting an active Runner Center Profile will appear here.
                    </p>
                  </div>
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
                        <p className="mt-1 pl-2 text-[10px] text-[#7c7c85]">{attempt.result}</p>
                      )}
                    </TableCell>
                    <TableCell>
                      <code className="text-xs text-zinc-200">{attempt.profile}</code>
                    </TableCell>
                    <TableCell>
                      <p className="max-w-[190px] truncate font-mono text-xs text-zinc-200">
                        {attempt.repo ?? "Waiting for GitHub"}
                      </p>
                      <p
                        className={cn(
                          "mt-0.5 max-w-[190px] truncate text-[10px] text-[#7c7c85]",
                          detail && "text-red-300/75",
                        )}
                        title={detail ?? attempt.displayName}
                      >
                        {detail ?? attempt.displayName ?? attempt.runnerName}
                      </p>
                    </TableCell>
                    <TableCell className="text-xs text-zinc-300">
                      {attempt.machineName ?? "Unassigned"}
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline" className="font-mono text-zinc-400">
                        {attempt.executor}
                      </Badge>
                    </TableCell>
                    <TableCell className="tabular-nums whitespace-nowrap text-xs text-zinc-400">
                      {attempt.startedAt === undefined
                        ? `queued ${formatDuration(end - attempt.createdAt)}`
                        : `ran ${formatDuration(end - attempt.startedAt)}`}
                      <p
                        className="mt-0.5 text-[10px] text-[#7c7c85]"
                        title={formatAbsoluteTime(attempt.createdAt)}
                      >
                        {formatRelativeTime(attempt.createdAt, now)}
                      </p>
                    </TableCell>
                    <TableCell>
                      <code
                        className="block max-w-[280px] truncate text-[10px] text-[#7c7c85]"
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
      </section>
    </div>
  );
}

function AttemptBadge({ state }: { state: AttemptState }) {
  const tone =
    state === "completed"
      ? "bg-emerald-400/10 text-emerald-300"
      : state === "failed" || state === "cancelled"
        ? "bg-red-400/10 text-red-300"
        : state === "running"
          ? "bg-sky-400/10 text-sky-300"
          : "bg-amber-400/10 text-amber-300";
  return (
    <span className={cn("inline-flex rounded-full px-2 py-0.5 text-[11px]", tone)}>{state}</span>
  );
}
