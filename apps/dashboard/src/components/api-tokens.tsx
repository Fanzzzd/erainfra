import { useId, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { Check, Clipboard, KeyRound } from "lucide-react";
import { toast } from "sonner";
import { api } from "@erainfra/backend/api";
import type { Id } from "@erainfra/backend/dataModel";
import { EmptyState } from "@/components/empty-state";
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
import { convexSiteUrl } from "@/lib/convex-site";
import { formatAbsoluteTime, formatRelativeTime } from "@/lib/time";

type Scope = "read" | "admin" | "metrics";

const SCOPES: { value: Scope; label: string; description: string }[] = [
  {
    value: "read",
    label: "Read",
    description: "the erainfra CLI and scripts: Profiles, Workers, Runs",
  },
  { value: "admin", label: "Admin", description: "read, plus minting Worker registration tokens" },
  {
    value: "metrics",
    label: "Metrics",
    description: "Prometheus scrapes of /metrics, nothing else",
  },
];

const SCOPE_BADGE = { read: "secondary", admin: "warning", metrics: "info" } as const;

/**
 * Every token the control plane accepts, whatever it is for: the `erainfra` CLI and scripts on
 * /api/v1, and Prometheus on /metrics. One table and one list, told apart by scope. A new token
 * is shown once, in this component's state, and only its SHA-256 is stored; revoking takes effect
 * on its next request. Minting lives here and nowhere in the API, so a leaked admin token cannot
 * mint its own replacement.
 */
export function ApiTokens() {
  const tokens = useQuery(api.apiTokens.list);
  const create = useMutation(api.apiTokens.create);
  const revoke = useMutation(api.apiTokens.revoke);
  const now = useNow(30_000);
  const nameId = useId();
  const [name, setName] = useState("");
  const [scope, setScope] = useState<Scope>("read");
  const [created, setCreated] = useState<{ token: string; scope: Scope }>();
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);
  const [copied, setCopied] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(undefined);
    setPending(true);
    try {
      const result = await create({ name, scope });
      setCreated({ token: result.token, scope });
      setName("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not create a token");
    } finally {
      setPending(false);
    }
  }

  async function revokeToken(tokenId: Id<"apiTokens">, tokenName: string) {
    if (!window.confirm(`Revoke "${tokenName}"? Anything using it stops working immediately.`)) {
      return;
    }
    try {
      await revoke({ tokenId });
    } catch (caught) {
      toast.error(caught instanceof Error ? caught.message : "Could not revoke the token");
    }
  }

  // A CLI token is most useful as the login command; a metrics token goes into a file.
  const shown =
    created === undefined
      ? undefined
      : created.scope === "metrics"
        ? created.token
        : `erainfra auth login --url ${convexSiteUrl()} --token ${created.token}`;

  async function copy() {
    if (shown === undefined) return;
    try {
      await navigator.clipboard.writeText(shown);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1_500);
    } catch {
      toast.error("Clipboard access was blocked", {
        description: "Select the text above and copy it manually.",
      });
    }
  }

  return (
    <>
      <Card>
        <CardHeader className="border-b">
          <CardTitle>Create a token</CardTitle>
          <CardDescription>
            Sent as <code className="font-mono">Authorization: Bearer</code>. Several can be live at
            once, so rotate by creating the replacement before revoking the old one.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4 py-4 text-xs text-muted-foreground">
          <form className="space-y-3" onSubmit={(event) => void submit(event)}>
            <div className="grid max-w-sm gap-1.5">
              <Label htmlFor={nameId}>Name</Label>
              <Input
                id={nameId}
                placeholder="laptop, prometheus, nightly-report"
                value={name}
                maxLength={100}
                required
                onChange={(event) => setName(event.target.value)}
              />
            </div>
            <fieldset className="space-y-1.5">
              <legend className="mb-1.5 text-sm font-medium text-secondary-foreground">
                Scope
              </legend>
              {SCOPES.map((option) => (
                <label key={option.value} className="flex items-center gap-2">
                  <input
                    type="radio"
                    name="api-token-scope"
                    value={option.value}
                    checked={scope === option.value}
                    onChange={() => setScope(option.value)}
                  />
                  <span className="text-secondary-foreground">{option.label}</span>
                  <span>{option.description}</span>
                </label>
              ))}
            </fieldset>
            <Button type="submit" disabled={pending || name.trim().length === 0}>
              {pending ? "Please wait…" : "Create token"}
              {!pending && <KeyRound />}
            </Button>
          </form>

          {shown !== undefined && (
            <div className="space-y-2">
              <div className="relative rounded-md border border-border bg-sunken p-3 pr-11">
                <code className="block break-all font-mono text-xs leading-5 text-secondary-foreground">
                  {shown}
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
                Copy it now. Only a digest is stored, so this {created?.scope} token cannot be shown
                again.
                {created?.scope === "metrics" &&
                  " The Metrics tab has the Prometheus scrape config."}
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
        <CardHeader className="border-b">
          <CardTitle>Tokens</CardTitle>
          <CardDescription>
            Last use is recorded to five minutes. A revoked token is refused on its next request.
          </CardDescription>
        </CardHeader>
        <Table className="min-w-[760px]">
          <TableHeader>
            <TableRow>
              <TableHead className="w-[180px]">Name</TableHead>
              <TableHead className="w-[90px]">Scope</TableHead>
              <TableHead className="w-[170px]">Token</TableHead>
              <TableHead className="w-[200px]">Created</TableHead>
              <TableHead className="w-[120px]">Last used</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {tokens === undefined ? (
              <TableRowsSkeleton columns={6} rows={1} />
            ) : tokens.length === 0 ? (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={6} className="p-0">
                  <EmptyState
                    icon={KeyRound}
                    title="No tokens"
                    description="/api/v1 and /metrics refuse every request until a token exists."
                  />
                </TableCell>
              </TableRow>
            ) : (
              tokens.map((token) => (
                <TableRow key={token._id}>
                  <TableCell className="text-sm text-secondary-foreground">{token.name}</TableCell>
                  <TableCell>
                    <Badge variant={SCOPE_BADGE[token.scope]}>{token.scope}</Badge>
                  </TableCell>
                  <TableCell className="font-mono text-[11px] text-muted-foreground">
                    {token.hint}…
                  </TableCell>
                  <TableCell
                    className="text-xs text-muted-foreground"
                    title={formatAbsoluteTime(token.createdAt)}
                  >
                    {formatRelativeTime(token.createdAt, now)}
                    {token.createdByEmail === undefined ? "" : ` by ${token.createdByEmail}`}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {token.lastUsedAt === undefined
                      ? "Never"
                      : formatRelativeTime(token.lastUsedAt, now)}
                  </TableCell>
                  <TableCell className="text-right">
                    {token.revokedAt === undefined ? (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => void revokeToken(token._id, token.name)}
                      >
                        Revoke
                      </Button>
                    ) : (
                      <Badge variant="outline" title={formatAbsoluteTime(token.revokedAt)}>
                        revoked {formatRelativeTime(token.revokedAt, now)}
                      </Badge>
                    )}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </Card>
    </>
  );
}
