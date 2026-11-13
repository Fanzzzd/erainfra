import { api } from "@erainfra/backend/api";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { BoxesIcon } from "lucide-react";
import { useMemo, useState } from "react";

import { ConfirmDialog } from "@/components/confirm-dialog";
import { DataTable, createDataTableColumns } from "@/components/data-table";
import { DeployStageStatus } from "@/components/deploy-stage";
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
import { Card } from "@/components/ui/card";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { toast } from "@/components/ui/toast";
import { useNow } from "@/hooks/use-now";
import { appStatus, heartbeatsByName } from "@/lib/infra";
import { type AppStatus, appStates } from "@/lib/states";
import { formatRelativeTime } from "@/lib/time";

export const Route = createFileRoute("/apps")({ component: AppsPage });

type App = FunctionReturnType<typeof api.infra.operator.apps>[number];

/** An App with its status judged against the dashboard's clock. */
type AppRow = App & { liveStatus: AppStatus; now: number };

const column = createDataTableColumns<AppRow>();

const columns = column.columns([
  column.accessor("name", {
    header: "App",
    cell: (cell) => {
      const app = cell.row.original;
      return (
        <div>
          <div className="font-medium">{app.name}</div>
          <div className="text-xs text-muted-foreground">
            {app.kind === "container" ? "single container" : `on ${app.node ?? "?"}`}
            {app.kind === "app" && !app.failover && ", no failover until deployed through Convex"}
          </div>
        </div>
      );
    },
  }),
  column.accessor("liveStatus", {
    header: "Status",
    cell: (cell) => {
      return <Status states={appStates} state={cell.getValue()} />;
    },
  }),
  column.display({
    id: "services",
    header: "Services",
    cell: (cell) => (
      <ul className="flex flex-col gap-0.5">
        {cell.row.original.services.map((service) => (
          <li key={service.name} className="text-muted-foreground">
            <span className="text-foreground">{service.name}</span>
            {" on "}
            {service.node ?? "?"}
            {service.url !== null && (
              <>
                {", "}
                <a
                  className="text-foreground underline decoration-border underline-offset-4 hover:decoration-foreground"
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
    ),
  }),
  column.display({
    id: "lastDeploy",
    header: "Last deploy",
    cell: (cell) => {
      const app = cell.row.original;
      const last = app.lastDeployment;
      if (last === null) return <span className="text-muted-foreground">None in Convex</span>;
      return (
        <Link
          to="/deployments"
          search={{ app: app.name }}
          className="block rounded-sm hover:underline hover:underline-offset-4"
        >
          <span className="flex items-center gap-2">
            <DeployStageStatus stage={last.stage} />
            {last.operation === "failover" && <Badge variant="warning">failover</Badge>}
          </span>
          <span className="block text-xs text-muted-foreground">
            {formatRelativeTime(last.startedAt, app.now)}
          </span>
        </Link>
      );
    },
  }),
]);

/** The row menu. Built once per page, so the menu items are not new components on each render. */
function appActions(onRemove: (name: string) => void) {
  return {
    label: (app: AppRow) => `Actions for ${app.name}`,
    items: (app: AppRow) => (
      <>
        <DropdownMenuItem render={<Link to="/deployments" search={{ app: app.name }} />}>
          View deployments
        </DropdownMenuItem>
        <DropdownMenuItem
          variant="destructive"
          disabled={app.status === "deploying"}
          onClick={() => onRemove(app.name)}
        >
          Remove App everywhere
        </DropdownMenuItem>
      </>
    ),
  };
}

function AppsPage() {
  const apps = useQuery(api.infra.operator.apps);
  const nodes = useQuery(api.infra.operator.nodes);
  const remove = useMutation(api.infra.operator.remove);
  const now = useNow();
  const heartbeats = heartbeatsByName(nodes ?? []);
  // The target outlives `open`, so the dialog keeps its text while it closes.
  const [removing, setRemoving] = useState<{ open: boolean; name?: string }>({ open: false });
  const rowActions = useMemo(
    () => appActions((name) => setRemoving({ open: true, name })),
    [setRemoving],
  );

  const rows = apps?.map((app) => ({
    ...app,
    liveStatus: appStatus(app, heartbeats, now),
    now,
  }));

  async function removeApp(name: string) {
    await remove({ app: name });
    toast.success(`Removing ${name}`, {
      description: "Each Node stops the containers when it next polls.",
    });
  }

  return (
    <>
      <PageHeader>
        <PageHeaderTitle>Apps</PageHeaderTitle>
        <PageHeaderDescription>
          Apps deployed onto your Nodes, where each service runs, and its last deploy.
        </PageHeaderDescription>
        <PageHeaderActions>
          <LiveIndicator />
        </PageHeaderActions>
      </PageHeader>

      <Card className="gap-0 py-0">
        <DataTable
          aria-label="Apps"
          columns={columns}
          data={rows ?? []}
          loading={rows === undefined}
          loadingRows={3}
          getRowId={(app) => app.name}
          empty={
            <EmptyState>
              <EmptyStateMedia>
                <BoxesIcon />
              </EmptyStateMedia>
              <EmptyStateTitle>No Apps yet</EmptyStateTitle>
              <EmptyStateDescription>
                Deploy one with <code>erainfra deploy</code>.
              </EmptyStateDescription>
            </EmptyState>
          }
          rowActions={rowActions}
        />
      </Card>

      <ConfirmDialog
        open={removing.open}
        onOpenChange={(open) => setRemoving((current) => ({ ...current, open }))}
        title={`Remove ${removing.name ?? "this App"}?`}
        description="Removing it stops its containers on every Node and forgets its routes and ports. Its env stays."
        confirmLabel="Remove App"
        confirmationText={removing.name ?? ""}
        onConfirm={() => (removing.name === undefined ? undefined : removeApp(removing.name))}
      />
    </>
  );
}
