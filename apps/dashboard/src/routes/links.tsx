import { api } from "@erainfra/backend/api";
import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery } from "convex/react";
import { Link2, Plus, Trash2 } from "lucide-react";
import { type FormEvent, useId, useState } from "react";

import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { LiveBadge, StatusDot, type Tone } from "@/components/status";
import { TableRowsSkeleton } from "@/components/table-skeleton";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { confirmDestructive } from "@/components/ui/confirm";
import { Input, inputClass } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { toast } from "@/components/ui/toast";
import { useNow } from "@/hooks/use-now";
import { heartbeatsByName, type LinkState, linkState } from "@/lib/infra";

export const Route = createFileRoute("/links")({ component: LinksPage });

const STATE_TONE: Record<LinkState, Tone> = {
  active: "success",
  degraded: "destructive",
  pending: "warning",
};

function LinksPage() {
  const links = useQuery(api.infra.operator.links);
  const nodes = useQuery(api.infra.operator.nodes);
  const declare = useMutation(api.infra.operator.link);
  const unlink = useMutation(api.infra.operator.unlink);
  const now = useNow();
  const fieldId = useId();
  const [provider, setProvider] = useState("");
  const [providerPort, setProviderPort] = useState("");
  const [consumer, setConsumer] = useState("");
  const [localPort, setLocalPort] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const heartbeats = heartbeatsByName(nodes ?? []);
  const nodeNames = (nodes ?? []).map((node) => node.name);

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
    const confirmed = await confirmDestructive({
      title: `Remove ${name}?`,
      description: "Both Nodes drop the link on their next snapshot.",
      confirmLabel: "Remove",
    });
    if (!confirmed) return;
    try {
      await unlink({ name });
    } catch (caught) {
      toast.error(caught instanceof Error ? caught.message : "Could not remove the link");
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Links"
        description="Node-to-Node links over erainfra-mesh: standalone links and each App's dependency links."
      >
        <LiveBadge />
      </PageHeader>

      <Card>
        <CardHeader className="border-b">
          <CardTitle>Declare a link</CardTitle>
          <CardDescription>
            The consumer reaches the provider's <code>127.0.0.1:&lt;port&gt;</code> at its own
            loopback port. Both Nodes need a proven endpoint before the link carries traffic.
          </CardDescription>
        </CardHeader>
        <CardContent className="pt-4">
          <form
            className="grid gap-4 lg:grid-cols-[1fr_120px_1fr_120px_auto]"
            onSubmit={(event) => void submit(event)}
          >
            <div className="space-y-1.5">
              <Label htmlFor={`${fieldId}-provider`}>Provider Node</Label>
              <select
                id={`${fieldId}-provider`}
                required
                className={inputClass}
                value={provider}
                onChange={(event) => setProvider(event.target.value)}
              >
                <option value="" disabled>
                  Select Node
                </option>
                {nodeNames.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`${fieldId}-port`}>Port</Label>
              <Input
                id={`${fieldId}-port`}
                required
                type="number"
                min={1}
                max={65_535}
                value={providerPort}
                onChange={(event) => setProviderPort(event.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`${fieldId}-consumer`}>Consumer Node</Label>
              <select
                id={`${fieldId}-consumer`}
                required
                className={inputClass}
                value={consumer}
                onChange={(event) => setConsumer(event.target.value)}
              >
                <option value="" disabled>
                  Select Node
                </option>
                {nodeNames
                  .filter((name) => name !== provider)
                  .map((name) => (
                    <option key={name} value={name}>
                      {name}
                    </option>
                  ))}
              </select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`${fieldId}-local`}>Local port</Label>
              <Input
                id={`${fieldId}-local`}
                type="number"
                min={1}
                max={65_535}
                placeholder="same"
                value={localPort}
                onChange={(event) => setLocalPort(event.target.value)}
              />
            </div>
            <Button className="self-end" type="submit" disabled={pending}>
              <Plus />
              {pending ? "Declaring…" : "Declare"}
            </Button>
            {error !== undefined && (
              <Alert variant="destructive" className="lg:col-span-5">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
          </form>
        </CardContent>
      </Card>

      <Card className="overflow-hidden">
        <Table className="min-w-[840px]">
          <TableHeader>
            <TableRow>
              <TableHead className="w-[220px]">Link</TableHead>
              <TableHead className="w-[180px]">From</TableHead>
              <TableHead className="w-[220px]">Surfaced on</TableHead>
              <TableHead>State</TableHead>
              <TableHead className="w-[60px]">
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {links === undefined ? (
              <TableRowsSkeleton columns={5} rows={3} />
            ) : links.length === 0 ? (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={5} className="p-0">
                  <EmptyState
                    icon={Link2}
                    title="No links yet"
                    description="Declare one above, or deploy an App whose services need each other across Nodes."
                  />
                </TableCell>
              </TableRow>
            ) : (
              links.map((link) => {
                const { state, reason } = linkState(link, heartbeats, now);
                return (
                  <TableRow key={`${link.kind}:${link.app ?? ""}:${link.name}`}>
                    <TableCell>
                      <p className="text-xs font-medium text-secondary-foreground">{link.name}</p>
                      <p className="mt-0.5 text-[10px] text-subtle-foreground">
                        {link.app !== null
                          ? `dependency of ${link.app}`
                          : link.createdBy === "deploy"
                            ? "managed by the deploy pipeline"
                            : "standalone"}
                      </p>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {link.provider ?? "?"}:{link.providerPort}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {link.consumer ?? "?"} <code className="text-[10px]">{link.listen}</code>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      <span className="flex items-center gap-2 capitalize">
                        <StatusDot tone={STATE_TONE[state]} />
                        {state}
                      </span>
                      {reason !== null && (
                        <p className="mt-0.5 text-[10px] leading-4 text-subtle-foreground">
                          {reason}
                        </p>
                      )}
                    </TableCell>
                    <TableCell>
                      {link.kind === "standalone" && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          aria-label={`Remove ${link.name}`}
                          onClick={() => void remove(link.name)}
                        >
                          <Trash2 />
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
        Convex grants a link over erainfra-mesh once both Nodes have a proven endpoint and a live
        credential; until then it is pending. State comes from endpoint proofs and heartbeats, not
        from traffic.
      </p>
    </div>
  );
}
