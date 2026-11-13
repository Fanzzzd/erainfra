import { api } from "@erainfra/backend/api";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { RocketIcon } from "lucide-react";

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
import { useNow } from "@/hooks/use-now";
import { deployStageView } from "@/lib/states";
import { formatAbsoluteTime, formatDuration, formatRelativeTime } from "@/lib/time";

type Search = { app?: string };

export const Route = createFileRoute("/deployments")({
  validateSearch: (search: Record<string, unknown>): Search =>
    typeof search.app === "string" && /^[a-z0-9][a-z0-9-]{0,62}$/.test(search.app)
      ? { app: search.app }
      : {},
  component: DeploymentsPage,
});

const TERMINAL = new Set(["done", "failed"]);

type Run = FunctionReturnType<typeof api.infra.deployments.list>[number];

/** A run with the values judged against the dashboard's clock. */
type RunRow = Run & { live: boolean; now: number };

const column = createDataTableColumns<RunRow>();

const columns = column.columns([
  column.accessor("stage", {
    header: "Stage",
    cell: (cell) => {
      const run = cell.row.original;
      const view = deployStageView(run.stage);
      return (
        <div className="flex flex-col items-start gap-1">
          <Status state={view.state}>{view.label}</Status>
          {run.operation === "failover" && <Badge variant="warning">failover</Badge>}
        </div>
      );
    },
  }),
  column.accessor("app", {
    header: "App",
    cell: (cell) => {
      const run = cell.row.original;
      return (
        <div>
          <Link
            to="/deployments"
            search={{ app: run.app }}
            className="font-medium hover:underline hover:underline-offset-4"
          >
            {run.app}
          </Link>
          <code className="block text-xs text-muted-foreground">{run._id}</code>
        </div>
      );
    },
  }),
  column.display({
    id: "detail",
    header: "Detail",
    cell: (cell) => {
      const run = cell.row.original;
      return (
        <div className="max-w-md min-w-60 whitespace-normal">
          <div className="text-muted-foreground">{run.detail}</div>
          {run.error !== undefined && (
            <p className="text-xs break-words text-danger">{run.error}</p>
          )}
          {run.urls.map((url) => (
            <a
              key={url}
              className="block text-xs text-foreground underline decoration-border underline-offset-4 hover:decoration-foreground"
              href={url}
              target="_blank"
              rel="noreferrer"
            >
              {url}
            </a>
          ))}
        </div>
      );
    },
  }),
  column.display({
    id: "trigger",
    header: "Trigger",
    cell: (cell) => {
      const run = cell.row.original;
      return (
        <div>
          <div>
            {run.trigger ?? "Hub"}
            {run.sha !== undefined && (
              <code className="ml-1 text-xs text-muted-foreground">{run.sha.slice(0, 7)}</code>
            )}
          </div>
          {run.actor !== undefined && (
            <div className="max-w-44 truncate text-xs text-muted-foreground">{run.actor}</div>
          )}
        </div>
      );
    },
  }),
  column.accessor("startedAt", {
    header: "Timing",
    cell: (cell) => {
      const run = cell.row.original;
      return (
        <div title={formatAbsoluteTime(run.startedAt)}>
          <div>{formatRelativeTime(run.startedAt, run.now)}</div>
          <div className="text-xs text-muted-foreground">
            {run.live ? "running " : "took "}
            {formatDuration((run.finishedAt ?? run.now) - run.startedAt)}
          </div>
        </div>
      );
    },
  }),
]);

function DeploymentsPage() {
  const { app } = Route.useSearch();
  const runs = useQuery(api.infra.deployments.list, {
    ...(app === undefined ? {} : { app }),
    limit: 100,
  });
  const now = useNow();
  const rows = runs?.map((run) => ({ ...run, live: !TERMINAL.has(run.stage), now }));

  return (
    <>
      <PageHeader>
        <PageHeaderTitle>Deployments</PageHeaderTitle>
        <PageHeaderDescription>
          {app === undefined
            ? "Deploy and failover runs of every App, newest first."
            : `Deploy and failover runs of ${app}, newest first.`}
        </PageHeaderDescription>
        <PageHeaderActions>
          <LiveIndicator />
          {app !== undefined && (
            <Button
              variant="outline"
              size="sm"
              nativeButton={false}
              render={<Link to="/deployments" search={{}} />}
            >
              All Apps
            </Button>
          )}
        </PageHeaderActions>
      </PageHeader>

      <Card className="gap-0 py-0">
        <DataTable
          aria-label="Deployments"
          columns={columns}
          data={rows ?? []}
          loading={rows === undefined}
          loadingRows={4}
          getRowId={(run) => run._id}
          empty={
            <EmptyState>
              <EmptyStateMedia>
                <RocketIcon />
              </EmptyStateMedia>
              <EmptyStateTitle>No deployments yet</EmptyStateTitle>
              <EmptyStateDescription>
                Runs appear here when <code>erainfra deploy</code>, a push to a bound branch, or a
                failover starts one.
              </EmptyStateDescription>
            </EmptyState>
          }
        />
      </Card>
    </>
  );
}
