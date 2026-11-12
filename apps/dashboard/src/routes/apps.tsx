import { api } from "@erainfra/backend/api";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useMutation, useQuery } from "convex/react";
import { Boxes, Trash2 } from "lucide-react";
import { toast } from "sonner";

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
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useNow } from "@/hooks/use-now";
import { APP_STATUS, appStatus, DEPLOY_STAGE_TONE, heartbeatsByName } from "@/lib/infra";
import { formatRelativeTime } from "@/lib/time";

export const Route = createFileRoute("/apps")({ component: AppsPage });

function AppsPage() {
  const apps = useQuery(api.infra.operator.apps);
  const nodes = useQuery(api.infra.operator.nodes);
  const remove = useMutation(api.infra.operator.remove);
  const now = useNow();
  const heartbeats = heartbeatsByName(nodes ?? []);

  async function removeApp(name: string) {
    const typed = window.prompt(
      `Removing ${name} stops its containers on every Node and forgets its routes and ports. Its env stays. Type the App's name to confirm.`,
    );
    if (typed !== name) return;
    try {
      await remove({ app: name });
      toast.success(`Removing ${name}`, {
        description: "Each Node stops the containers when it next polls.",
      });
    } catch (caught) {
      toast.error(caught instanceof Error ? caught.message : "Could not remove the App");
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Apps"
        description="Apps deployed onto your Nodes, where each service runs, and its last deploy."
      >
        <LiveBadge />
      </PageHeader>

      <Card className="overflow-hidden">
        <Table className="min-w-[960px]">
          <TableHeader>
            <TableRow>
              <TableHead className="w-[200px]">App</TableHead>
              <TableHead className="w-[140px]">Status</TableHead>
              <TableHead>Services</TableHead>
              <TableHead className="w-[200px]">Last deploy</TableHead>
              <TableHead className="w-[60px]">
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {apps === undefined ? (
              <TableRowsSkeleton columns={5} rows={3} />
            ) : apps.length === 0 ? (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={5} className="p-0">
                  <EmptyState
                    icon={Boxes}
                    title="No Apps yet"
                    description="Deploy one with erainfra deploy."
                  />
                </TableCell>
              </TableRow>
            ) : (
              apps.map((app) => {
                const status = APP_STATUS[appStatus(app, heartbeats, now)];
                const last = app.lastDeployment;
                return (
                  <TableRow key={app.name}>
                    <TableCell>
                      <p className="text-xs font-medium text-secondary-foreground">{app.name}</p>
                      <p className="mt-0.5 text-[10px] text-subtle-foreground">
                        {app.kind === "container" ? "single container" : `on ${app.node ?? "?"}`}
                        {app.kind === "app" &&
                          !app.failover &&
                          " · no failover until deployed through Convex"}
                      </p>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      <span className="flex items-center gap-2">
                        <StatusDot tone={status.tone} live={status.tone === "info"} />
                        {status.label}
                      </span>
                    </TableCell>
                    <TableCell>
                      <ul className="space-y-1">
                        {app.services.map((service) => (
                          <li key={service.name} className="text-xs text-muted-foreground">
                            <span className="text-secondary-foreground">{service.name}</span>
                            {" on "}
                            {service.node ?? "?"}
                            {service.url !== null && (
                              <>
                                {" · "}
                                <a
                                  className="text-primary underline-offset-2 hover:underline"
                                  href={service.url}
                                  target="_blank"
                                  rel="noreferrer"
                                >
                                  {service.url.replace(/^https:\/\//, "")}
                                </a>
                              </>
                            )}
                          </li>
                        ))}
                      </ul>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {last === null ? (
                        <span className="text-subtle-foreground">None in Convex</span>
                      ) : (
                        <Link to="/deployments" search={{ app: app.name }} className="block">
                          <span className="flex items-center gap-2">
                            <StatusDot tone={DEPLOY_STAGE_TONE[last.stage] ?? "muted"} />
                            <span className="capitalize">{last.stage}</span>
                            {last.operation === "failover" && (
                              <Badge variant="warning">failover</Badge>
                            )}
                          </span>
                          <span className="mt-0.5 block text-[10px] text-subtle-foreground">
                            {formatRelativeTime(last.startedAt, now)}
                          </span>
                        </Link>
                      )}
                    </TableCell>
                    <TableCell>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            aria-label={`Remove ${app.name}`}
                            disabled={app.status === "deploying"}
                            onClick={() => void removeApp(app.name)}
                          >
                            <Trash2 />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent side="left">Remove this App everywhere</TooltipContent>
                      </Tooltip>
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
