import { api } from "@erainfra/backend/api";
import type { Id } from "@erainfra/backend/dataModel";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { ActivityIcon, EllipsisIcon } from "lucide-react";
import { createContext, useContext, useMemo, useState } from "react";

import { copyText } from "@/components/copy-button";
import { DataTable, createDataTableColumns } from "@/components/data-table";
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
import { LiveIndicator, Status } from "@/components/status";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { toast } from "@/components/ui/toast";
import { useNow } from "@/hooks/use-now";
import { summaryLine, type MetricsSummary } from "@/lib/metrics";
import { attemptView, type AttemptState } from "@/lib/states";
import { formatAbsoluteTime, formatDuration, formatRelativeTime } from "@/lib/time";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/attempts")({ component: AttemptsPage });

type Attempt = FunctionReturnType<typeof api.attempts.list>[number];
type RunRow = Attempt & { summary: MetricsSummary | undefined };
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

function matches(filter: Filter, state: AttemptState) {
  if (filter === "active") return isActive(state);
  if (filter === "completed") return state === "completed";
  if (filter === "failed") return state === "failed" || state === "cancelled";
  return true;
}

/** The page's clock, so every row's timing ticks from one interval. */
const NowContext = createContext(0);

function repositoryOf(attempt: Attempt) {
  if (attempt.repo === undefined) return undefined;
  return attempt.owner === undefined || attempt.repo.includes("/")
    ? attempt.repo
    : `${attempt.owner}/${attempt.repo}`;
}

function hasEgressRecord(attempt: Attempt) {
  return attempt.executor === "firecracker" && attempt.finishedAt !== undefined;
}

function timingLine(attempt: Attempt, now: number) {
  const end = attempt.finishedAt ?? now;
  return attempt.startedAt === undefined
    ? `queued ${formatDuration(end - attempt.createdAt)}`
    : `ran ${formatDuration(end - attempt.startedAt)}`;
}

function RunState({ attempt }: { attempt: Attempt }) {
  const view = attemptView(attempt.state);
  return (
    <div>
      <Status state={view.state} className="font-medium">
        {view.label}
      </Status>
      {attempt.result && (
        <p className="mt-0.5 pl-4 text-xs text-muted-foreground">{attempt.result}</p>
      )}
    </div>
  );
}

function RunJob({ attempt }: { attempt: Attempt }) {
  const repository = repositoryOf(attempt);
  const detail = attempt.lastError ?? attempt.cancelReason;
  return (
    <div className="max-w-64 min-w-0">
      <p className="truncate font-medium" title={attempt.displayName ?? attempt.runnerName}>
        {attempt.displayName ?? attempt.runnerName}
      </p>
      <p className="truncate text-xs text-muted-foreground" title={repository}>
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
      {detail && (
        <p className="truncate text-xs text-danger" title={attempt.cause?.summary ?? detail}>
          {detail}
        </p>
      )}
    </div>
  );
}

function RunTiming({ run }: { run: RunRow }) {
  const now = useContext(NowContext);
  return (
    <div className="whitespace-nowrap">
      <p>{timingLine(run, now)}</p>
      <p className="text-xs text-muted-foreground">
        {run.queueWaitMs !== null && (
          <span title="Time GitHub held the job before a Runner on this Profile picked it up">
            waited {formatDuration(run.queueWaitMs)},{" "}
          </span>
        )}
        <span title={formatAbsoluteTime(run.createdAt)}>
          {formatRelativeTime(run.createdAt, now)}
        </span>
      </p>
      {run.summary !== undefined && (
        <Link
          to="/attempts/$attemptId"
          params={{ attemptId: run._id }}
          className="block text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
        >
          {summaryLine(run.summary)}
          {run.summary.oomKills !== null && run.summary.oomKills > 0 && (
            <span className="block text-danger">
              {run.summary.oomKills} OOM kill{run.summary.oomKills === 1 ? "" : "s"}
            </span>
          )}
        </Link>
      )}
    </div>
  );
}

const column = createDataTableColumns<RunRow>();

const columns = column.columns([
  column.accessor("state", {
    header: "State",
    enableSorting: false,
    cell: (cell) => <RunState attempt={cell.row.original} />,
  }),
  column.accessor("profile", {
    header: "Profile",
    cell: (cell) => (
      <span className="block max-w-52 truncate text-muted-foreground" title={cell.getValue()}>
        {cell.getValue()}
      </span>
    ),
  }),
  column.accessor((row) => row.displayName ?? row.runnerName, {
    id: "job",
    header: "Repository and job",
    enableSorting: false,
    cell: (cell) => <RunJob attempt={cell.row.original} />,
  }),
  column.accessor((row) => row.machineName ?? "", {
    id: "machine",
    header: "Machine",
    cell: (cell) => (
      <span title={cell.row.original.selectionReason}>
        {cell.row.original.machineName ?? <span className="text-muted-foreground">Unassigned</span>}
      </span>
    ),
  }),
  column.accessor("executor", {
    header: "Executor",
    enableSorting: false,
    cell: (cell) => (
      <div className="max-w-48 min-w-0">
        <p className="text-muted-foreground">{cell.getValue()}</p>
        <p
          className="truncate font-mono text-xs text-muted-foreground"
          title={`Image Release ${cell.row.original.imageRelease}`}
        >
          {cell.row.original.imageRelease}
        </p>
      </div>
    ),
  }),
  column.accessor("createdAt", {
    header: "Timing",
    enableSorting: false,
    cell: (cell) => <RunTiming run={cell.row.original} />,
  }),
]);

/** Opens the egress dialog for a run; the page provides it. */
const EgressContext = createContext<(run: RunRow) => void>(() => {});

function RunMenuItems({ run }: { run: RunRow }) {
  const onEgress = useContext(EgressContext);
  return (
    <>
      <DropdownMenuGroup>
        <DropdownMenuItem
          render={<Link to="/attempts/$attemptId" params={{ attemptId: run._id }} />}
        >
          View run resources
        </DropdownMenuItem>
        {run.workflowRunUrl !== undefined && (
          <DropdownMenuItem
            render={<a href={run.workflowRunUrl} target="_blank" rel="noreferrer" />}
          >
            Open workflow run on GitHub
          </DropdownMenuItem>
        )}
        {hasEgressRecord(run) && (
          <DropdownMenuItem onClick={() => onEgress(run)}>Show egress record</DropdownMenuItem>
        )}
      </DropdownMenuGroup>
      <DropdownMenuSeparator />
      <DropdownMenuItem
        onClick={() =>
          void copyText(run._id).then((ok) =>
            ok
              ? toast.success("Attempt ID copied", { description: run._id })
              : toast.error("Could not copy", {
                  description: "Select the text and copy it by hand.",
                }),
          )
        }
      >
        Copy attempt ID
      </DropdownMenuItem>
    </>
  );
}

function runLabel(run: RunRow) {
  const repository = repositoryOf(run);
  const job = run.displayName ?? run.runnerName;
  return repository === undefined ? `Actions for ${job}` : `Actions for ${job} on ${repository}`;
}

/** Module-level, so the menu items are not a new component on each render. */
const rowActions = {
  label: runLabel,
  items: (run: RunRow) => <RunMenuItems run={run} />,
};

/** Narrow screens: one stacked row per run, from design option A. */
function RunList({ runs }: { runs: RunRow[] }) {
  const now = useContext(NowContext);
  return (
    <ul className="divide-y" aria-label="Runs">
      {runs.map((run) => {
        const view = attemptView(run.state);
        const repository = repositoryOf(run);
        return (
          <li key={run._id} className="flex gap-2 py-3 pr-2 pl-4 text-[13px]">
            <div className="min-w-0 flex-1 space-y-1">
              <div className="flex items-center justify-between gap-2">
                <Status state={view.state} className="font-medium">
                  {view.label}
                </Status>
                <span className="text-muted-foreground tabular-nums">{timingLine(run, now)}</span>
              </div>
              <p className="truncate font-medium">
                {run.displayName ?? run.runnerName}
                {repository !== undefined && (
                  <span className="font-normal text-muted-foreground"> in {repository}</span>
                )}
              </p>
              <p className="truncate text-xs text-muted-foreground">{run.profile}</p>
              <p className="truncate text-xs text-muted-foreground">
                {run.machineName ?? "Unassigned"}, {run.executor}
                {run.summary !== undefined && `, ${summaryLine(run.summary)}`}
              </p>
              {(run.lastError ?? run.cancelReason) && (
                <p className="truncate text-xs text-danger">{run.lastError ?? run.cancelReason}</p>
              )}
            </div>
            <DropdownMenu>
              <DropdownMenuTrigger
                render={<Button variant="ghost" size="icon-sm" aria-label={runLabel(run)} />}
              >
                <EllipsisIcon aria-hidden="true" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56">
                <RunMenuItems run={run} />
              </DropdownMenuContent>
            </DropdownMenu>
          </li>
        );
      })}
    </ul>
  );
}

function AttemptsPage() {
  const attempts = useQuery(api.attempts.list);
  const summaries = useQuery(
    api.attemptMetrics.summaries,
    attempts === undefined ? "skip" : { attemptIds: attempts.map((attempt) => attempt._id) },
  );
  const now = useNow();
  const [filter, setFilter] = useState<Filter>("all");
  const [egressShown, setEgressShown] = useState<RunRow | undefined>(undefined);

  const rows = useMemo(() => {
    if (attempts === undefined) return undefined;
    const summaryByAttempt = new Map(summaries?.map((row) => [row.attemptId, row.summary]));
    return attempts.map((attempt) => ({ ...attempt, summary: summaryByAttempt.get(attempt._id) }));
  }, [attempts, summaries]);
  const visible = useMemo(
    () => rows?.filter((row) => matches(filter, row.state)) ?? [],
    [rows, filter],
  );

  const total = rows?.length ?? 0;
  const empty = (
    <EmptyState>
      <EmptyStateMedia>
        <ActivityIcon />
      </EmptyStateMedia>
      <EmptyStateTitle>{total === 0 ? "No runs yet" : `No ${filter} runs`}</EmptyStateTitle>
      <EmptyStateDescription>
        {total === 0
          ? "Jobs targeting an active EraInfra Profile will appear here."
          : "Every run is still there. Try another state filter."}
      </EmptyStateDescription>
    </EmptyState>
  );

  return (
    <NowContext.Provider value={now}>
      <EgressContext.Provider value={setEgressShown}>
        <PageHeader>
          <PageHeaderTitle>Runs</PageHeaderTitle>
          <PageHeaderDescription>
            One durable Attempt for every isolated scale-set execution.
          </PageHeaderDescription>
          <PageHeaderActions>
            <LiveIndicator />
          </PageHeaderActions>
        </PageHeader>

        <Card className="gap-0 py-0">
          <Tabs
            value={filter}
            onValueChange={(value) => setFilter(value as Filter)}
            className="gap-0"
          >
            <div className="overflow-x-auto border-b px-2">
              <TabsList variant="line" aria-label="Filter runs by state">
                {filters.map((item) => (
                  <TabsTrigger key={item.value} value={item.value} className="px-1.5 @lg:px-2.5">
                    {item.label}
                    <Badge variant="neutral" className="rounded-full">
                      {rows?.filter((row) => matches(item.value, row.state)).length ?? 0}
                    </Badge>
                  </TabsTrigger>
                ))}
              </TabsList>
            </div>
          </Tabs>
          <div className="hidden @3xl:block">
            <DataTable
              aria-label="Runs"
              columns={columns}
              data={visible}
              getRowId={(run) => run._id}
              loading={rows === undefined}
              loadingRows={4}
              empty={empty}
              rowActions={rowActions}
            />
          </div>
          <div className="@3xl:hidden">
            {rows === undefined ? (
              <div className="space-y-3 p-4" aria-busy="true">
                {[0, 1, 2].map((index) => (
                  <Skeleton key={index} className="h-16" />
                ))}
              </div>
            ) : visible.length === 0 ? (
              empty
            ) : (
              <RunList runs={visible} />
            )}
          </div>
        </Card>

        <Dialog
          open={egressShown !== undefined}
          onOpenChange={(open) => {
            if (!open) setEgressShown(undefined);
          }}
        >
          <DialogContent className="sm:max-w-2xl">
            <DialogHeader>
              <DialogTitle>
                Egress for{" "}
                {egressShown === undefined
                  ? "this run"
                  : (egressShown.displayName ?? egressShown.runnerName)}
              </DialogTitle>
              <DialogDescription>
                The DNS names the guest asked the host resolver for and the new flows the kernel
                recorded, measured on the Worker's host.
              </DialogDescription>
            </DialogHeader>
            {egressShown !== undefined && <EgressRecord attemptId={egressShown._id} />}
          </DialogContent>
        </Dialog>
      </EgressContext.Provider>
    </NowContext.Provider>
  );
}

/**
 * What one Attempt's guest talked to, measured on the Worker's host: the DNS
 * names it asked the host resolver for and the new flows the kernel recorded.
 */
function EgressRecord({ attemptId }: { attemptId: Id<"attempts"> }) {
  const egress = useQuery(api.attempts.egress, { attemptId });
  if (egress === undefined) return <Skeleton className="h-24" />;
  if (egress === null) {
    return (
      <p className="text-sm text-muted-foreground">
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
  const omitted = (record.omittedNames ?? 0) + (record.omittedFlows ?? 0);
  return (
    <div className="min-w-0 space-y-3 text-sm">
      <p className="text-muted-foreground">
        <span className="font-mono text-foreground">{record.mode}</span> egress, {names.length}{" "}
        names, {flows.length} flows
        {blocked > 0 && <span className="text-danger">, {blocked} blocked</span>}
        {omitted > 0 && `, ${omitted} more not kept`}
      </p>
      {record.error && <p className="text-warning">{record.error}</p>}
      <div className="grid max-h-[60vh] gap-4 overflow-auto rounded-lg border bg-subtle p-3 md:grid-cols-2">
        <div className="min-w-0">
          <p className="mb-1.5 text-xs font-medium text-muted-foreground">DNS names</p>
          <ul className="space-y-0.5 font-mono text-xs">
            {names.map((name) => (
              <li key={name.name} className={cn("break-all", verdictTone(name.verdict))}>
                {name.name}{" "}
                <span className="text-muted-foreground">
                  ×{name.queries} {name.verdict}
                </span>
              </li>
            ))}
          </ul>
        </div>
        <div className="min-w-0">
          <p className="mb-1.5 text-xs font-medium text-muted-foreground">Flows</p>
          <ul className="space-y-0.5 font-mono text-xs">
            {flows.map((flow) => (
              <li
                key={`${flow.destination}:${flow.protocol}:${flow.port}`}
                className={cn("break-all", verdictTone(flow.verdict))}
              >
                {flow.destination}:{flow.port}/{flow.protocol}
                {flow.name && <span className="text-muted-foreground"> {flow.name}</span>}
                <span className="text-muted-foreground"> {flow.verdict}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}

function verdictTone(verdict: "allowed" | "blocked" | "unlisted") {
  if (verdict === "blocked") return "text-danger";
  if (verdict === "unlisted") return "text-warning";
  return "text-foreground";
}
