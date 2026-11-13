import { api } from "@erainfra/backend/api";
import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { HardDriveIcon, KeyRoundIcon } from "lucide-react";
import { type FormEvent, useMemo, useState } from "react";

import { CodeBlock } from "@/components/code-block";
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
import { Stat, StatGroup, StatHint, StatLabel, StatUnit, StatValue } from "@/components/stat";
import { LiveIndicator, Status } from "@/components/status";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { toast } from "@/components/ui/toast";
import { useNow } from "@/hooks/use-now";
import { nodeOnline } from "@/lib/infra";
import { onlineView } from "@/lib/states";
import { formatRelativeTime } from "@/lib/time";

export const Route = createFileRoute("/nodes")({ component: NodesPage });

type Node = FunctionReturnType<typeof api.infra.operator.nodes>[number];

/** A Node with the values judged against the dashboard's clock. */
type NodeRow = Node & { online: boolean; now: number };

const BLOCKED_LABEL: Record<string, string> = {
  journal_full: "journal full",
  journal_error: "journal unwritable",
  command_api: "command requests failing",
  command_error: "commands failing",
};

const column = createDataTableColumns<NodeRow>();

const columns = column.columns([
  column.accessor("name", {
    header: "Node",
    cell: (cell) => {
      const node = cell.row.original;
      return (
        <div>
          <div className="font-medium">{node.name}</div>
          <div className="text-xs text-muted-foreground">
            {node.source === "hub-import" ? "imported from the Hub" : "enrolled"}
            {node.infraAgentVersion !== null && `, ${node.infraAgentVersion}`}
          </div>
        </div>
      );
    },
  }),
  column.accessor("lastSeenAt", {
    header: "Heartbeat",
    cell: (cell) => {
      const node = cell.row.original;
      return (
        <div>
          {node.lastSeenAt === null ? (
            <Status state="offline">Never connected</Status>
          ) : (
            <Status state={onlineView(node.online).state} />
          )}
          {node.lastSeenAt !== null && (
            <div className="text-xs text-muted-foreground">
              {formatRelativeTime(node.lastSeenAt, node.now)}
            </div>
          )}
          <CommandHealth commands={node.commands} now={node.now} />
        </div>
      );
    },
  }),
  column.display({
    id: "endpoint",
    header: "Mesh endpoint",
    cell: (cell) => {
      const node = cell.row.original;
      const relays = node.endpoint.relayUrls.length;
      return (
        <div>
          {node.endpoint.proven ? (
            <Badge variant="success">Proven</Badge>
          ) : node.endpoint.id !== null ? (
            <Badge variant="warning">Unproven</Badge>
          ) : (
            <Badge variant="outline">None</Badge>
          )}
          {node.endpoint.id !== null && (
            <code
              className="mt-1 block max-w-[260px] truncate text-xs text-muted-foreground"
              title={node.endpoint.id}
            >
              {node.endpoint.id}
            </code>
          )}
          {node.endpoint.provenAt !== null && (
            <div className="text-xs text-muted-foreground">
              proven {formatRelativeTime(node.endpoint.provenAt, node.now)}
              {relays > 0 && `, ${relays} relay${relays === 1 ? "" : "s"}`}
            </div>
          )}
        </div>
      );
    },
  }),
  column.accessor("placementRoles", {
    header: "Placement roles",
    enableSorting: false,
    cell: (cell) =>
      cell.getValue().length === 0 ? (
        <span className="text-muted-foreground">None</span>
      ) : (
        <span className="flex flex-wrap gap-1">
          {cell.getValue().map((role) => (
            <Badge key={role} variant="secondary">
              {role}
            </Badge>
          ))}
        </span>
      ),
  }),
  column.accessor("liveCredentials", {
    header: "Credentials",
    meta: { align: "end" },
    cell: (cell) => {
      const node = cell.row.original;
      const revoked = node.credentials.length - node.liveCredentials;
      return (
        <div>
          <div>{node.liveCredentials} live</div>
          {revoked > 0 && <div className="text-xs text-muted-foreground">{revoked} revoked</div>}
        </div>
      );
    },
  }),
]);

/** The row menu. Built once per page, so the menu items are not new components on each render. */
function nodeActions(onRevoke: (node: NodeRow) => void) {
  return {
    label: (node: NodeRow) => `Actions for ${node.name}`,
    items: (node: NodeRow) => (
      <DropdownMenuItem
        variant="destructive"
        disabled={node.liveCredentials === 0}
        onClick={() => onRevoke(node)}
      >
        Revoke credentials
      </DropdownMenuItem>
    ),
  };
}

function NodesPage() {
  const nodes = useQuery(api.infra.operator.nodes);
  const enroll = useMutation(api.infra.nodes.enroll);
  const revoke = useMutation(api.infra.nodes.revokeCredential);
  const now = useNow();
  const [name, setName] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const [created, setCreated] = useState<{ name: string; credential: string }>();
  // The target outlives `open`, so the dialog keeps its text while it closes.
  const [revoking, setRevoking] = useState<{ open: boolean; node?: NodeRow }>({ open: false });
  const rowActions = useMemo(
    () => nodeActions((node) => setRevoking({ open: true, node })),
    [setRevoking],
  );

  const rows = nodes?.map((node) => ({ ...node, online: nodeOnline(node.lastSeenAt, now), now }));

  async function submit(event: FormEvent) {
    event.preventDefault();
    setPending(true);
    setError(undefined);
    try {
      const result = await enroll({ name });
      setCreated({ name: name.trim(), credential: result.credential });
      setName("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not enroll the Node");
    } finally {
      setPending(false);
    }
  }

  async function revokeAll(node: NodeRow) {
    const live = node.credentials.filter((credential) => credential.revokedAt === null);
    for (const credential of live) await revoke({ credentialId: credential.id });
    toast.success(`Revoked every credential of ${node.name}`);
  }

  return (
    <>
      <PageHeader>
        <PageHeaderTitle>Nodes</PageHeaderTitle>
        <PageHeaderDescription>
          Machines that run deployed Apps, how they reach Convex, and whether their mesh key is
          proven.
        </PageHeaderDescription>
        <PageHeaderActions>
          <LiveIndicator />
        </PageHeaderActions>
      </PageHeader>

      {rows !== undefined && rows.length > 0 && (
        <StatGroup className="@5xl:grid-cols-3">
          <Stat>
            <StatLabel>Nodes online</StatLabel>
            <StatValue>
              {rows.filter((node) => node.online).length}
              <StatUnit>/{rows.length}</StatUnit>
            </StatValue>
            <StatHint>By heartbeat</StatHint>
          </Stat>
          <Stat>
            <StatLabel>Proven endpoints</StatLabel>
            <StatValue>
              {rows.filter((node) => node.endpoint.proven).length}
              <StatUnit>/{rows.length}</StatUnit>
            </StatValue>
            <StatHint>Needed for mesh peers</StatHint>
          </Stat>
          <Stat>
            <StatLabel>Live credentials</StatLabel>
            <StatValue>{rows.reduce((sum, node) => sum + node.liveCredentials, 0)}</StatValue>
            <StatHint>Across every Node</StatHint>
          </Stat>
        </StatGroup>
      )}

      <Card>
        <CardHeader>
          <CardTitle render={<h2 />}>Enroll a Node</CardTitle>
          <CardDescription>
            Issues a credential bound to this one Node. Enrolling a name again issues another
            credential for it, so a credential rotates without a gap.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <form
            className="flex flex-col gap-3 sm:flex-row sm:items-end"
            onSubmit={(event) => void submit(event)}
          >
            <Field className="max-w-sm">
              <FieldLabel>Name</FieldLabel>
              <Input
                required
                maxLength={63}
                placeholder="edge-1"
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </Field>
            <Button type="submit" disabled={pending || name.trim().length === 0}>
              {pending ? (
                <Spinner data-icon="inline-start" />
              ) : (
                <KeyRoundIcon data-icon="inline-start" />
              )}
              {pending ? "Enrolling" : "Enroll"}
            </Button>
          </form>
          {created !== undefined && (
            <div className="flex flex-col gap-2">
              <CodeBlock code={created.credential} title={`Credential for ${created.name}`} />
              <p className="text-xs text-muted-foreground">
                Copy it now; only a digest is stored. Put it on {created.name} in a 0600 file and
                start <code>infra-agent connect-convex --credential-file &lt;file&gt;</code>.
              </p>
            </div>
          )}
          {error !== undefined && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
        </CardContent>
      </Card>

      <Card className="gap-0 py-0">
        <CardHeader className="border-b py-4">
          <CardTitle render={<h2 />}>Nodes</CardTitle>
          <CardDescription>Every enrolled or imported Node and its last heartbeat.</CardDescription>
        </CardHeader>
        <DataTable
          aria-label="Nodes"
          columns={columns}
          data={rows ?? []}
          loading={rows === undefined}
          loadingRows={3}
          getRowId={(node) => node.id}
          empty={
            <EmptyState>
              <EmptyStateMedia>
                <HardDriveIcon />
              </EmptyStateMedia>
              <EmptyStateTitle>No Nodes yet</EmptyStateTitle>
              <EmptyStateDescription>Enroll one above.</EmptyStateDescription>
            </EmptyState>
          }
          rowActions={rowActions}
        />
      </Card>

      <p className="text-xs leading-5 text-muted-foreground">
        A Node is on Convex once its Infra Agent heartbeats in <code>connect-convex</code> mode, and
        is granted mesh peers only with a proven endpoint and a live credential. Set placement roles
        with <code>erainfra nodes set-roles</code>. A Node marked <em>commands blocked</em> is
        online but refuses or fails its builds, deploys and operations; the reasons and the recovery
        are in docs/infra-management.md, under &ldquo;When the journal is full&rdquo;.
      </p>

      <ConfirmDialog
        open={revoking.open}
        onOpenChange={(open) => setRevoking((current) => ({ ...current, open }))}
        title={`Revoke every credential of ${revoking.node?.name ?? "this Node"}?`}
        description="Its next request is refused and it leaves the mesh."
        confirmLabel="Revoke"
        onConfirm={() => (revoking.node === undefined ? undefined : revokeAll(revoking.node))}
      />
    </>
  );
}

type NodeCommands = {
  blocked: string | null;
  blockedSince: number | null;
  journalKeys: number | null;
  journalKeyLimit: number | null;
};

/** What the Node's last heartbeat said about running commands and its execution journal. */
function CommandHealth({ commands, now }: { commands: NodeCommands; now: number }) {
  const { blocked, blockedSince, journalKeys, journalKeyLimit } = commands;
  // A journal past nine tenths is worth a look before it refuses work.
  const nearlyFull =
    journalKeys !== null && journalKeyLimit !== null && journalKeys >= journalKeyLimit * 0.9;
  return (
    <>
      {blocked !== null && (
        <Badge variant="danger" className="mt-1" title={blocked}>
          Commands blocked: {BLOCKED_LABEL[blocked] ?? blocked}
          {blockedSince !== null && `, ${formatRelativeTime(blockedSince, now)}`}
        </Badge>
      )}
      {journalKeys !== null && (
        <div className={`text-xs ${nearlyFull ? "text-warning" : "text-muted-foreground"}`}>
          journal {journalKeys}
          {journalKeyLimit !== null && ` / ${journalKeyLimit}`} keys
        </div>
      )}
    </>
  );
}
