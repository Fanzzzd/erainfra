import { useId, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { Check, Clipboard, KeyRound } from "lucide-react";
import { toast } from "sonner";
import { api } from "@erainfra/backend/api";
import type { Id } from "@erainfra/backend/dataModel";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useNow } from "@/hooks/use-now";
import { convexSiteUrl } from "@/lib/convex-site";
import { formatAbsoluteTime, formatRelativeTime } from "@/lib/time";

type Scope = "read" | "admin";

/**
 * Tokens for the operator API and the `erainfra` CLI. A new token is shown once, in this
 * component's state, and only its SHA-256 is stored; revoking one takes effect on its next
 * request. Minting lives here and nowhere in the API itself, so a leaked admin token cannot mint
 * its own replacement.
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

  const loginCommand =
    created === undefined
      ? undefined
      : `erainfra auth login --url ${convexSiteUrl()} --token ${created.token}`;

  async function copy() {
    if (loginCommand === undefined) return;
    try {
      await navigator.clipboard.writeText(loginCommand);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1_500);
    } catch {
      toast.error("Clipboard access was blocked", {
        description: "Select the command above and copy it manually.",
      });
    }
  }

  return (
    <Card>
      <CardContent className="px-0 pb-0">
        <details>
          <summary className="cursor-pointer select-none px-4 py-3.5 text-sm font-medium text-secondary-foreground">
            API tokens
          </summary>
          <div className="space-y-4 border-t border-border px-4 py-4 text-xs text-muted-foreground">
            <p className="leading-5">
              A token lets the <code className="font-mono">erainfra</code> CLI or a script read
              Profiles, Workers and Runs through <code className="font-mono">/api/v1</code>. A read
              token can only read. An admin token can also mint Worker registration tokens, the one
              action the API offers. A new token is shown once.
            </p>

            <form
              className="flex flex-wrap items-end gap-3"
              onSubmit={(event) => void submit(event)}
            >
              <div className="grid gap-1.5">
                <Label htmlFor={nameId}>Name</Label>
                <Input
                  id={nameId}
                  className="h-9 w-56"
                  placeholder="laptop, nightly-report"
                  value={name}
                  maxLength={64}
                  required
                  onChange={(event) => setName(event.target.value)}
                />
              </div>
              <fieldset className="flex items-center gap-3">
                <legend className="sr-only">Scope</legend>
                {(["read", "admin"] as const).map((option) => (
                  <label
                    key={option}
                    className="flex items-center gap-1.5 text-secondary-foreground"
                  >
                    <input
                      type="radio"
                      name="api-token-scope"
                      value={option}
                      checked={scope === option}
                      onChange={() => setScope(option)}
                    />
                    {option === "read" ? "Read" : "Admin"}
                  </label>
                ))}
              </fieldset>
              <Button type="submit" size="sm" disabled={pending || name.trim().length === 0}>
                {pending ? "Please wait…" : "Create token"}
                {!pending && <KeyRound />}
              </Button>
            </form>

            {loginCommand !== undefined && (
              <div className="space-y-2">
                <div className="relative rounded-md border border-border bg-sunken p-3 pr-11">
                  <code className="block break-all font-mono text-xs leading-5 text-secondary-foreground">
                    {loginCommand}
                  </code>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="absolute right-1.5 top-1.5 size-8"
                    aria-label="Copy login command"
                    onClick={() => void copy()}
                  >
                    {copied ? <Check /> : <Clipboard />}
                  </Button>
                </div>
                <p className="leading-5">
                  Copy it now. Only a digest is stored, so this {created?.scope} token cannot be
                  shown again.
                </p>
              </div>
            )}

            {error !== undefined && (
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}

            {tokens !== undefined && tokens.length > 0 && (
              <table className="w-full text-left">
                <thead className="text-subtle-foreground">
                  <tr>
                    <th className="py-1.5 font-medium">Name</th>
                    <th className="py-1.5 font-medium">Scope</th>
                    <th className="py-1.5 font-medium">Token</th>
                    <th className="py-1.5 font-medium">Created</th>
                    <th className="py-1.5 font-medium">Last used</th>
                    <th className="py-1.5" />
                  </tr>
                </thead>
                <tbody>
                  {tokens.map((token) => (
                    <tr key={token._id} className="border-t border-border">
                      <td className="py-2 text-secondary-foreground">{token.name}</td>
                      <td className="py-2">
                        <Badge variant={token.scope === "admin" ? "warning" : "secondary"}>
                          {token.scope}
                        </Badge>
                      </td>
                      <td className="py-2 font-mono">{token.hint}…</td>
                      <td className="py-2" title={formatAbsoluteTime(token.createdAt)}>
                        {formatRelativeTime(token.createdAt, now)}
                        {token.createdByEmail === undefined ? "" : ` by ${token.createdByEmail}`}
                      </td>
                      <td className="py-2">
                        {token.lastUsedAt === undefined
                          ? "Never"
                          : formatRelativeTime(token.lastUsedAt, now)}
                      </td>
                      <td className="py-2 text-right">
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
                          <span title={formatAbsoluteTime(token.revokedAt)}>
                            Revoked {formatRelativeTime(token.revokedAt, now)}
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </details>
      </CardContent>
    </Card>
  );
}
