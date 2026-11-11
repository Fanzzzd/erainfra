import { api } from "@erainfra/backend/api";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "convex/react";
import { Rocket } from "lucide-react";

import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { LiveBadge, StatusDot } from "@/components/status";
import { TableRowsSkeleton } from "@/components/table-skeleton";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useNow } from "@/hooks/use-now";
import { DEPLOY_STAGE_TONE } from "@/lib/infra";
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

function DeploymentsPage() {
  const { app } = Route.useSearch();
  const runs = useQuery(api.infra.deployments.list, {
    ...(app === undefined ? {} : { app }),
    limit: 100,
  });
  const now = useNow();

  return (
    <div className="space-y-6">
      <PageHeader
        title="Deployments"
        description={
          app === undefined
            ? "Deploy and failover runs of every App, newest first."
            : `Deploy and failover runs of ${app}, newest first.`
        }
      >
        {app !== undefined && (
          <Button asChild variant="outline" size="sm">
            <Link to="/deployments" search={{}}>
              All Apps
            </Link>
          </Button>
        )}
        <LiveBadge />
      </PageHeader>

      <Card className="overflow-hidden">
        <Table className="min-w-[900px]">
          <TableHeader>
            <TableRow>
              <TableHead className="w-[150px]">Stage</TableHead>
              <TableHead className="w-[180px]">App</TableHead>
              <TableHead>Detail</TableHead>
              <TableHead className="w-[170px]">Trigger</TableHead>
              <TableHead className="w-[160px]">Timing</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {runs === undefined ? (
              <TableRowsSkeleton columns={5} rows={4} />
            ) : runs.length === 0 ? (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={5} className="p-0">
                  <EmptyState
                    icon={Rocket}
                    title="No deployments yet"
                    description="Runs appear here when erainfra deploy, a push to a bound branch, or a failover starts one."
                  />
                </TableCell>
              </TableRow>
            ) : (
              runs.map((run) => {
                const live = !TERMINAL.has(run.stage);
                return (
                  <TableRow key={run._id}>
                    <TableCell className="text-xs text-muted-foreground">
                      <span className="flex items-center gap-2">
                        <StatusDot tone={DEPLOY_STAGE_TONE[run.stage] ?? "muted"} live={live} />
                        <span className="capitalize">{run.stage}</span>
                      </span>
                      {run.operation === "failover" && (
                        <Badge variant="warning" className="mt-1">
                          failover
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell>
                      <Link
                        to="/deployments"
                        search={{ app: run.app }}
                        className="text-xs font-medium text-secondary-foreground hover:underline"
                      >
                        {run.app}
                      </Link>
                      <code className="mt-0.5 block text-[10px] text-subtle-foreground">
                        {run._id}
                      </code>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {run.detail}
                      {run.error !== undefined && (
                        <p className="mt-0.5 break-words text-[10px] leading-4 text-destructive">
                          {run.error}
                        </p>
                      )}
                      {run.urls.map((url) => (
                        <a
                          key={url}
                          className="mt-0.5 block text-[10px] text-primary underline-offset-2 hover:underline"
                          href={url}
                          target="_blank"
                          rel="noreferrer"
                        >
                          {url}
                        </a>
                      ))}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {run.trigger ?? "Hub"}
                      {run.sha !== undefined && (
                        <code className="ml-1 text-[10px]">{run.sha.slice(0, 7)}</code>
                      )}
                      {run.actor !== undefined && (
                        <p className="mt-0.5 truncate text-[10px] text-subtle-foreground">
                          {run.actor}
                        </p>
                      )}
                    </TableCell>
                    <TableCell
                      className="tabular-nums text-xs text-muted-foreground"
                      title={formatAbsoluteTime(run.startedAt)}
                    >
                      {formatRelativeTime(run.startedAt, now)}
                      <p className="mt-0.5 text-[10px] text-subtle-foreground">
                        {live ? "running " : "took "}
                        {formatDuration((run.finishedAt ?? now) - run.startedAt)}
                      </p>
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
