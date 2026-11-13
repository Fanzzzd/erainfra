import { api } from "@erainfra/backend/api";
import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { Link2Icon, PlusIcon } from "lucide-react";
import { type FormEvent, useMemo, useState } from "react";

import { ConfirmDialog } from "@/components/confirm-dialog";
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
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { toast } from "@/components/ui/toast";
import { useNow } from "@/hooks/use-now";
import { heartbeatsByName, linkState } from "@/lib/infra";
import { type LinkState, linkStates } from "@/lib/states";

export const Route = createFileRoute("/links")({ component: LinksPage });

type MeshLink = FunctionReturnType<typeof api.infra.operator.links>[number];

/** A link with its state re-judged against the dashboard's clock. */
type LinkRow = MeshLink & { id: string; liveState: LinkState; reason: string | null };

const column = createDataTableColumns<LinkRow>();

const columns = column.columns([
  column.accessor("name", {
    header: "Link",
    cell: (cell) => {
      const link = cell.row.original;
      return (
        <div>
          <div className="font-medium">{link.name}</div>
          <div className="text-xs text-muted-foreground">
            {link.app !== null
              ? `dependency of ${link.app}`
              : link.createdBy === "deploy"
                ? "managed by the deploy pipeline"
                : "standalone"}
          </div>
        </div>
      );
    },
  }),
  column.display({
    id: "from",
    header: "From",
    cell: (cell) => (
      <span className="text-muted-foreground">
        {cell.row.original.provider ?? "?"}:{cell.row.original.providerPort}
      </span>
    ),
  }),
  column.display({
    id: "surfaced",
    header: "Surfaced on",
    cell: (cell) => (
      <span className="text-muted-foreground">
        {cell.row.original.consumer ?? "?"}{" "}
        <code className="text-xs">{cell.row.original.listen}</code>
      </span>
    ),
  }),
  column.accessor("liveState", {
    header: "State",
    cell: (cell) => {
      const reason = cell.row.original.reason;
      return (
        <div>
          <Status states={linkStates} state={cell.getValue()} />
          {reason !== null && (
            <div className="max-w-xs text-xs whitespace-normal text-muted-foreground">{reason}</div>
          )}
        </div>
      );
    },
  }),
]);

/** The row menu. Built once per page, so the menu items are not new components on each render. */
function linkActions(onRemove: (name: string) => void) {
  return {
    label: (link: LinkRow) => `Actions for ${link.name}`,
    items: (link: LinkRow) => (
      <DropdownMenuItem
        variant="destructive"
        disabled={link.kind !== "standalone"}
        onClick={() => onRemove(link.name)}
      >
        Remove link
      </DropdownMenuItem>
    ),
  };
}

function NodeSelect({
  value,
  onValueChange,
  names,
}: {
  value: string;
  onValueChange: (value: string) => void;
  names: string[];
}) {
  return (
    <Select
      required
      value={value === "" ? null : value}
      onValueChange={(next) => onValueChange(typeof next === "string" ? next : "")}
    >
      <SelectTrigger className="w-full">
        <SelectValue placeholder="Select Node" />
      </SelectTrigger>
      <SelectContent>
        {names.map((name) => (
          <SelectItem key={name} value={name}>
            {name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function LinksPage() {
  const links = useQuery(api.infra.operator.links);
  const nodes = useQuery(api.infra.operator.nodes);
  const declare = useMutation(api.infra.operator.link);
  const unlink = useMutation(api.infra.operator.unlink);
  const now = useNow();
  const [provider, setProvider] = useState("");
  const [providerPort, setProviderPort] = useState("");
  const [consumer, setConsumer] = useState("");
  const [localPort, setLocalPort] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  // The target outlives `open`, so the dialog keeps its text while it closes.
  const [removing, setRemoving] = useState<{ open: boolean; name?: string }>({ open: false });
  const rowActions = useMemo(
    () => linkActions((name) => setRemoving({ open: true, name })),
    [setRemoving],
  );
  const heartbeats = heartbeatsByName(nodes ?? []);
  const nodeNames = (nodes ?? []).map((node) => node.name);

  const rows = links?.map((link) => {
    const { state, reason } = linkState(link, heartbeats, now);
    return {
      ...link,
      id: `${link.kind}:${link.app ?? ""}:${link.name}`,
      liveState: state,
      reason,
    };
  });

  async function submit(event: FormEvent) {
    event.preventDefault();
    setPending(true);
    setError(undefined);
    try {
      const result = await declare({
        provider,
        providerPort: Number(providerPort),
        consumer,
        ...(localPort === "" ? {} : { localPort: Number(localPort) }),
      });
      toast.success(`${result.replaced ? "Re-pointed" : "Declared"} ${result.name}`, {
        description: `${consumer} reaches it at ${result.address} after its next snapshot.`,
      });
      setProviderPort("");
      setLocalPort("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not declare the link");
    } finally {
      setPending(false);
    }
  }

  async function remove(name: string) {
    await unlink({ name });
    toast.success(`Removed ${name}`, {
      description: "Both Nodes drop the link on their next snapshot.",
    });
  }

  return (
    <>
      <PageHeader>
        <PageHeaderTitle>Links</PageHeaderTitle>
        <PageHeaderDescription>
          Node-to-Node links over erainfra-mesh: standalone links and each App's dependency links.
        </PageHeaderDescription>
        <PageHeaderActions>
          <LiveIndicator />
        </PageHeaderActions>
      </PageHeader>

      <Card>
        <CardHeader>
          <CardTitle render={<h2 />}>Declare a link</CardTitle>
          <CardDescription>
            The consumer reaches the provider's <code>127.0.0.1:&lt;port&gt;</code> at its own
            loopback port. Both Nodes need a proven endpoint before the link carries traffic.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form
            className="grid gap-4 sm:grid-cols-2 lg:grid-cols-[1fr_120px_1fr_120px_auto]"
            onSubmit={(event) => void submit(event)}
          >
            <Field>
              <FieldLabel>Provider Node</FieldLabel>
              <NodeSelect value={provider} onValueChange={setProvider} names={nodeNames} />
            </Field>
            <Field>
              <FieldLabel>Port</FieldLabel>
              <Input
                required
                type="number"
                min={1}
                max={65_535}
                value={providerPort}
                onChange={(event) => setProviderPort(event.target.value)}
              />
            </Field>
            <Field>
              <FieldLabel>Consumer Node</FieldLabel>
              <NodeSelect
                value={consumer}
                onValueChange={setConsumer}
                names={nodeNames.filter((name) => name !== provider)}
              />
            </Field>
            <Field>
              <FieldLabel>Local port</FieldLabel>
              <Input
                type="number"
                min={1}
                max={65_535}
                placeholder="same"
                value={localPort}
                onChange={(event) => setLocalPort(event.target.value)}
              />
            </Field>
            <Button className="self-end" type="submit" disabled={pending}>
              {pending ? (
                <Spinner data-icon="inline-start" />
              ) : (
                <PlusIcon data-icon="inline-start" />
              )}
              {pending ? "Declaring" : "Declare"}
            </Button>
            {error !== undefined && (
              <Alert variant="danger" className="sm:col-span-2 lg:col-span-5">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
          </form>
        </CardContent>
      </Card>

      <Card className="gap-0 py-0">
        <CardHeader className="border-b py-4">
          <CardTitle render={<h2 />}>Links</CardTitle>
          <CardDescription>
            Standalone links can be removed here. Dependency links follow their App.
          </CardDescription>
        </CardHeader>
        <DataTable
          aria-label="Links"
          columns={columns}
          data={rows ?? []}
          loading={rows === undefined}
          loadingRows={3}
          getRowId={(link) => link.id}
          empty={
            <EmptyState>
              <EmptyStateMedia>
                <Link2Icon />
              </EmptyStateMedia>
              <EmptyStateTitle>No links yet</EmptyStateTitle>
              <EmptyStateDescription>
                Declare one above, or deploy an App whose services need each other across Nodes.
              </EmptyStateDescription>
            </EmptyState>
          }
          rowActions={rowActions}
        />
      </Card>

      <p className="text-xs leading-5 text-muted-foreground">
        Convex grants a link over erainfra-mesh once both Nodes have a proven endpoint and a live
        credential; until then it is pending. State comes from endpoint proofs and heartbeats, not
        from traffic.
      </p>

      <ConfirmDialog
        open={removing.open}
        onOpenChange={(open) => setRemoving((current) => ({ ...current, open }))}
        title={`Remove ${removing.name ?? "this link"}?`}
        description="Both Nodes drop the link on their next snapshot."
        confirmLabel="Remove"
        onConfirm={() => (removing.name === undefined ? undefined : remove(removing.name))}
      />
    </>
  );
}
