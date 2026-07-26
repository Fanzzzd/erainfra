import { useMemo, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "convex/react";
import { ListChecks } from "lucide-react";
import { api } from "@convex/_generated/api";
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
import {
  formatAbsoluteTime,
  formatDuration,
  formatRelativeTime,
} from "@/lib/time";
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
    return [...jobs].sort((a, b) => {
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
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-start">
        <div>
          <h1 className="text-2xl font-semibold tracking-[-0.025em] text-zinc-50">Jobs</h1>
          <p className="mt-1.5 text-sm text-[#8a8a93]">
            Track workflow queues, assignments, and runner outcomes in real time.
          </p>
        </div>
        <span className="flex h-8 shrink-0 items-center gap-2 rounded-md border border-white/[0.08] bg-white/[0.025] px-2.5 text-xs text-zinc-400">
          <span className="status-pulse size-1.5 rounded-full bg-emerald-400" />
          Live updates
        </span>
      </div>

      <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
        <div
          className="flex w-fit items-center gap-1 rounded-lg border border-white/[0.08] bg-[#0d0d0f] p-1"
          aria-label="Filter jobs"
        >
          {filters.map((item) => (
            <button
              key={item.value}
              type="button"
              aria-pressed={filter === item.value}
              className={cn(
                "flex h-7 items-center gap-2 rounded-full px-2.5 text-xs font-medium text-[#8a8a93] outline-none transition-colors duration-150 hover:text-zinc-200 focus-visible:ring-2 focus-visible:ring-emerald-400/80",
                filter === item.value && "bg-white/[0.08] text-zinc-100",
              )}
              onClick={() => setFilter(item.value)}
            >
              {item.label}
              <span className="tabular-nums text-[10px] text-[#7c7c85]">
                {counts[item.value]}
              </span>
            </button>
          ))}
        </div>
        <span className="text-xs text-[#7c7c85]">Newest first</span>
      </div>

      <section className="overflow-hidden rounded-lg border border-white/[0.08] bg-[#0d0d0f]" aria-labelledby="jobs-heading">
        <div className="flex h-12 items-center gap-2.5 border-b border-white/[0.08] px-4">
          <h2 id="jobs-heading" className="text-sm font-medium text-zinc-200">
            Job history
          </h2>
          {visibleJobs !== undefined && (
            <span className="tabular-nums text-xs text-[#7c7c85]">
              {visibleJobs.length}
              {filter !== "all" && ` of ${counts.all}`}
            </span>
          )}
        </div>

        <Table className="min-w-[1100px]">
          <TableHeader>
            <TableRow>
              <TableHead className="w-[118px]">Status</TableHead>
              <TableHead className="w-[190px]">Repository</TableHead>
              <TableHead className="w-[180px]">Workflow</TableHead>
              <TableHead className="w-[160px]">Machine</TableHead>
              <TableHead className="w-[220px]">Labels</TableHead>
              <TableHead className="w-[190px]">Timing</TableHead>
              <TableHead className="w-[112px]">Queued</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {visibleJobs === undefined ? (
              <TableRow>
                <TableCell colSpan={7} className="h-36 text-center text-[#8a8a93]">
                  Syncing jobs…
                </TableCell>
              </TableRow>
            ) : visibleJobs.length === 0 ? (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={7} className="h-64 text-center">
                  <div className="mx-auto flex max-w-sm flex-col items-center">
                    <div className="grid size-9 place-items-center rounded-md border border-white/[0.08] bg-white/[0.025] text-[#8a8a93]">
                      <ListChecks className="size-4" />
                    </div>
                    <p className="mt-4 text-sm font-medium text-zinc-200">
                      {counts.all === 0 ? "No jobs received" : `No ${filter} jobs`}
                    </p>
                    <p className="mt-1 text-xs leading-5 text-[#8a8a93]">
                      {counts.all === 0
                        ? "Workflow jobs requesting self-hosted runners will appear here."
                        : "Try another status filter."}
                    </p>
                  </div>
                </TableCell>
              </TableRow>
            ) : (
              visibleJobs.map((job) => {
                const queueEnd = job.startedAt ?? job.finishedAt ?? now;
                const runEnd = job.finishedAt ?? now;

                return (
                  <TableRow key={job._id}>
                    <TableCell>
                      <JobStatusBadge status={job.status} />
                      {job.conclusion && job.status === "failed" && (
                        <div className="mt-1 pl-2 text-[10px] text-[#7c7c85]">
                          {job.conclusion}
                        </div>
                      )}
                    </TableCell>
                    <TableCell>
                      <div className="max-w-[190px] truncate font-mono text-[12px] text-zinc-200" title={job.repo}>
                        {job.repo}
                      </div>
                      <div className="tabular-nums mt-0.5 font-mono text-[10px] text-[#7c7c85]">
                        #{job.ghJobId}
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="max-w-[180px] truncate text-zinc-300" title={job.workflowName}>
                        {job.workflowName}
                      </div>
                    </TableCell>
                    <TableCell>
                      {job.machineName ? (
                        <span className="inline-block max-w-[160px] truncate align-middle text-zinc-300" title={job.runnerName}>
                          {job.machineName}
                        </span>
                      ) : (
                        <span className="text-[#7c7c85]">Unassigned</span>
                      )}
                    </TableCell>
                    <TableCell>
                      <LabelChips labels={job.labels} />
                    </TableCell>
                    <TableCell className="tabular-nums whitespace-nowrap text-xs text-zinc-400">
                      queued {formatDuration(queueEnd - job.queuedAt)}
                      {job.startedAt !== undefined && (
                        <>
                          <span className="px-1.5 text-[#7c7c85]">·</span>
                          ran {formatDuration(runEnd - job.startedAt)}
                        </>
                      )}
                    </TableCell>
                    <TableCell>
                      <span
                        className="tabular-nums whitespace-nowrap text-xs text-[#8a8a93]"
                        title={formatAbsoluteTime(job.queuedAt)}
                      >
                        {formatRelativeTime(job.queuedAt, now)}
                      </span>
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

function JobStatusBadge({ status }: { status: JobStatus }) {
  const styles: Record<JobStatus, string> = {
    queued: "border-amber-400/20 bg-amber-400/[0.08] text-amber-300",
    assigned: "border-amber-400/20 bg-amber-400/[0.08] text-amber-300",
    running: "border-emerald-400/20 bg-emerald-400/[0.08] text-emerald-300",
    done: "border-emerald-400/20 bg-emerald-400/[0.08] text-emerald-300",
    failed: "border-red-400/20 bg-red-400/[0.08] text-red-300",
  };
  const dotStyles: Record<JobStatus, string> = {
    queued: "bg-amber-400",
    assigned: "bg-amber-400",
    running: "status-pulse bg-emerald-400",
    done: "bg-emerald-400",
    failed: "bg-red-400",
  };

  return (
    <span
      className={cn(
        "inline-flex h-6 items-center gap-2 rounded-md border px-2 text-xs font-medium capitalize",
        styles[status],
      )}
    >
      <span className={cn("size-1.5 rounded-full", dotStyles[status])} aria-hidden="true" />
      {status}
    </span>
  );
}

function LabelChips({ labels }: { labels: string[] }) {
  if (labels.length === 0) return <span className="text-[#7c7c85]">—</span>;

  return (
    <div className="flex max-w-[220px] flex-wrap gap-1">
      {labels.map((label, index) => (
        <Badge key={`${label}-${index}`} variant="outline" className="font-mono text-zinc-400">
          {label}
        </Badge>
      ))}
    </div>
  );
}

function isActive(status: JobStatus) {
  return status === "queued" || status === "assigned" || status === "running";
}
