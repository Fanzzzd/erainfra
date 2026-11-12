import { api } from "@erainfra/backend/api";
import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery } from "convex/react";
import { Check, Clipboard, HardDrive, KeyRound } from "lucide-react";
import { type FormEvent, useId, useState } from "react";
import { toast } from "sonner";

import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { LiveBadge, StatusDot } from "@/components/status";
import { TableRowsSkeleton } from "@/components/table-skeleton";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useNow } from "@/hooks/use-now";
import { nodeOnline } from "@/lib/infra";
import { formatRelativeTime } from "@/lib/time";

export const Route = createFileRoute("/nodes")({ component: NodesPage });

function NodesPage() {
  const nodes = useQuery(api.infra.operator.nodes);
  const enroll = useMutation(api.infra.nodes.enroll);
  const revoke = useMutation(api.infra.nodes.revokeCredential);
  const now = useNow();
  const nameId = useId();
  const [name, setName] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const [created, setCreated] = useState<{ name: string; credential: string }>();
  const [copied, setCopied] = useState(false);

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

  async function copy() {
    if (created === undefined) return;
    try {
      await navigator.clipboard.writeText(created.credential);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1_500);
    } catch {
      toast.error("Clipboard access was blocked", {
        description: "Select the credential and copy it manually.",
      });
    }
  }

  async function revokeAll(node: NonNullable<typeof nodes>[number]) {
    const live = node.credentials.filter((credential) => credential.revokedAt === null);
    if (
      !window.confirm(
        `Revoke every credential of ${node.name}? Its next request is refused and it leaves the mesh.`,
      )
    ) {
      return;
    }
    try {
      for (const credential of live) await revoke({ credentialId: credential.id });
    } catch (caught) {
      toast.error(caught instanceof Error ? caught.message : "Could not revoke");
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Nodes"
        description="Machines that run deployed Apps, how they reach Convex, and whether their mesh key is proven."
      >
        <LiveBadge />
      </PageHeader>

      <Card>
        <CardHeader className="border-b">
          <CardTitle>Enroll a Node</CardTitle>
          <CardDescription>
            Issues a credential bound to this one Node. Enrolling a name again issues another
            credential for it, so a credential rotates without a gap.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4 py-4 text-xs text-muted-foreground">
          <form
            className="flex flex-col gap-3 sm:flex-row sm:items-end"
            onSubmit={(event) => void submit(event)}
          >
            <div className="grid w-full max-w-sm gap-1.5">
              <Label htmlFor={nameId}>Name</Label>
              <Input
                id={nameId}
                required
                maxLength={63}
                placeholder="edge-1"
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </div>
            <Button type="submit" disabled={pending || name.trim().length === 0}>
              {pending ? "Please wait…" : "Enroll"}
              {!pending && <KeyRound />}
            </Button>
          </form>
          {created !== undefined && (
            <div className="space-y-2">
              <div className="relative rounded-md border border-border bg-sunken p-3 pr-11">
                <code className="block break-all font-mono text-xs leading-5 text-secondary-foreground">
                  {created.credential}
                </code>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="absolute right-1.5 top-1.5 size-8"
                  aria-label="Copy"
                  onClick={() => void copy()}
                >
                  {copied ? <Check /> : <Clipboard />}
                </Button>
              </div>
              <p className="leading-5">
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

      <Card className="overflow-hidden">
        <Table className="min-w-[840px]">
          <TableHeader>
            <TableRow>
              <TableHead className="w-[180px]">Node</TableHead>
              <TableHead className="w-[160px]">Heartbeat</TableHead>
              <TableHead>Mesh endpoint</TableHead>
              <TableHead className="w-[150px]">Placement roles</TableHead>
              <TableHead className="w-[120px]">Credentials</TableHead>
              <TableHead className="w-[90px]">
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {nodes === undefined ? (
              <TableRowsSkeleton columns={6} rows={3} />
            ) : nodes.length === 0 ? (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={6} className="p-0">
                  <EmptyState
                    icon={HardDrive}
                    title="No Nodes yet"
                    description="Enroll one above."
                  />
                </TableCell>
              </TableRow>
            ) : (
              nodes.map((node) => {
                const online = nodeOnline(node.lastSeenAt, now);
                return (
                  <TableRow key={node.id}>
                    <TableCell>
                      <p className="text-xs font-medium text-secondary-foreground">{node.name}</p>
                      <p className="mt-0.5 text-[10px] text-subtle-foreground">
                        {node.source === "hub-import" ? "imported from the Hub" : "enrolled"}
                        {node.infraAgentVersion !== null && ` · ${node.infraAgentVersion}`}
                      </p>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      <span className="flex items-center gap-2">
                        <StatusDot
                          tone={
                            node.lastSeenAt === null ? "muted" : online ? "success" : "destructive"
                          }
                        />
                        {node.lastSeenAt === null
                          ? "Never connected"
                          : `${online ? "Online" : "Offline"} · ${formatRelativeTime(node.lastSeenAt, now)}`}
                      </span>
                      <CommandHealth commands={node.commands} now={now} />
                    </TableCell>
                    <TableCell>
                      {node.endpoint.proven ? (
                        <Badge variant="success">Proven</Badge>
                      ) : node.endpoint.id !== null ? (
                        <Badge variant="warning">Unproven</Badge>
                      ) : (
                        <Badge variant="outline">None</Badge>
                      )}
                      {node.endpoint.id !== null && (
                        <code
                          className="mt-1 block max-w-[260px] truncate text-[10px] text-subtle-foreground"
                          title={node.endpoint.id}
                        >
                          {node.endpoint.id}
                        </code>
                      )}
                      {node.endpoint.provenAt !== null && (
                        <p className="mt-0.5 text-[10px] text-subtle-foreground">
                          proven {formatRelativeTime(node.endpoint.provenAt, now)}
                          {node.endpoint.relayUrls.length > 0 &&
                            ` · ${node.endpoint.relayUrls.length} relay${node.endpoint.relayUrls.length === 1 ? "" : "s"}`}
                        </p>
                      )}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {node.placementRoles.length === 0 ? (
                        <span className="text-subtle-foreground">None</span>
                      ) : (
                        <span className="flex flex-wrap gap-1">
                          {node.placementRoles.map((role) => (
                            <Badge key={role} variant="secondary">
                              {role}
                            </Badge>
                          ))}
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="tabular-nums text-xs text-muted-foreground">
                      {node.liveCredentials} live
                      {node.credentials.length > node.liveCredentials && (
                        <p className="text-[10px] text-subtle-foreground">
                          {node.credentials.length - node.liveCredentials} revoked
                        </p>
                      )}
                    </TableCell>
                    <TableCell>
                      {node.liveCredentials > 0 && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() => void revokeAll(node)}
                        >
                          Revoke
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </Card>
      <p className="text-xs leading-5 text-muted-foreground">
        A Node is on Convex once its Infra Agent heartbeats in <code>connect-convex</code> mode, and
        is granted mesh peers only with a proven endpoint and a live credential. Set placement roles
        with <code>erainfra nodes set-roles</code>. A Node marked <em>commands blocked</em> is
        online but refuses or fails its builds, deploys and operations; the reasons and the recovery
        are in docs/infra-management.md, under &ldquo;When the journal is full&rdquo;.
      </p>
    </div>
  );
}

const BLOCKED_LABEL: Record<string, string> = {
  journal_full: "journal full",
  journal_error: "journal unwritable",
  command_api: "command requests failing",
  command_error: "commands failing",
};

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
        <Badge variant="destructive" className="mt-1" title={blocked}>
          Commands blocked: {BLOCKED_LABEL[blocked] ?? blocked}
          {blockedSince !== null && ` · ${formatRelativeTime(blockedSince, now)}`}
        </Badge>
      )}
      {journalKeys !== null && (
        <p
          className={`mt-0.5 text-[10px] ${nearlyFull ? "text-warning" : "text-subtle-foreground"}`}
        >
          journal {journalKeys}
          {journalKeyLimit !== null && ` / ${journalKeyLimit}`} keys
        </p>
      )}
    </>
  );
}
