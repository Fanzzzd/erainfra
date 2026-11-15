import { api } from "@erainfra/backend/api";
import { useMutation, useQuery } from "convex/react";
import { KeyRoundIcon } from "lucide-react";
import { useMemo, useState, type FormEvent } from "react";

import { CodeBlock } from "@/components/code-block";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { DataTable, createDataTableColumns } from "@/components/data-table";
import {
  EmptyState,
  EmptyStateDescription,
  EmptyStateMedia,
  EmptyStateTitle,
} from "@/components/empty-state";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Spinner } from "@/components/ui/spinner";
import { toast } from "@/components/ui/toast";
import { useNow } from "@/hooks/use-now";
import { convexSiteUrl } from "@/lib/convex-site";
import { formatAbsoluteTime, formatRelativeTime } from "@/lib/time";

type Scope = "read" | "admin" | "metrics";
type Token = NonNullable<(typeof api.apiTokens.list)["_returnType"]>[number];

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

const column = createDataTableColumns<Token>();

function tokenColumns(now: number) {
  return column.columns([
    column.accessor("name", {
      header: "Name",
      cell: (cell) => <span className="font-medium">{cell.getValue()}</span>,
    }),
    column.accessor("scope", {
      header: "Scope",
      cell: (cell) => (
        <Badge variant={SCOPE_BADGE[cell.getValue()]} className="capitalize">
          {cell.getValue()}
        </Badge>
      ),
    }),
    column.accessor("hint", {
      header: "Token",
      enableSorting: false,
      cell: (cell) => (
        <code className="font-mono text-xs text-muted-foreground">{cell.getValue()}…</code>
      ),
    }),
    column.accessor("createdAt", {
      header: "Created",
      cell: (cell) => {
        const token = cell.row.original;
        return (
          <span className="text-muted-foreground" title={formatAbsoluteTime(token.createdAt)}>
            {formatRelativeTime(token.createdAt, now)}
            {token.createdByEmail === undefined ? "" : ` by ${token.createdByEmail}`}
          </span>
        );
      },
    }),
    column.accessor((token) => token.lastUsedAt ?? 0, {
      id: "lastUsedAt",
      header: "Last used",
      cell: (cell) => {
        const lastUsedAt = cell.row.original.lastUsedAt;
        return (
          <span className="text-muted-foreground">
            {lastUsedAt === undefined ? "Never" : formatRelativeTime(lastUsedAt, now)}
          </span>
        );
      },
    }),
    column.accessor((token) => token.revokedAt ?? 0, {
      id: "revokedAt",
      header: "State",
      cell: (cell) => {
        const revokedAt = cell.row.original.revokedAt;
        return revokedAt === undefined ? (
          <Badge variant="success">Active</Badge>
        ) : (
          <Badge variant="neutral" title={formatAbsoluteTime(revokedAt)}>
            Revoked {formatRelativeTime(revokedAt, now)}
          </Badge>
        );
      },
    }),
  ]);
}

/** The row menu for a token. Module-level, so the menu is not a new component on each render. */
function tokenActions(revoke: (token: Token) => void) {
  return {
    label: (token: Token) => `Actions for ${token.name}`,
    items: (token: Token) => (
      <DropdownMenuItem
        variant="destructive"
        disabled={token.revokedAt !== undefined}
        onClick={() => revoke(token)}
      >
        Revoke token
      </DropdownMenuItem>
    ),
  };
}

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
  const [name, setName] = useState("");
  const [scope, setScope] = useState<Scope>("read");
  const [created, setCreated] = useState<{ token: string; scope: Scope }>();
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);
  // The target outlives the open state, so the dialog keeps its text while it closes.
  const [revoking, setRevoking] = useState<Token>();
  const [revokeOpen, setRevokeOpen] = useState(false);
  const columns = useMemo(() => tokenColumns(now), [now]);
  const rowActions = useMemo(
    () =>
      tokenActions((token) => {
        setRevoking(token);
        setRevokeOpen(true);
      }),
    [],
  );

  async function submit(event: FormEvent) {
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

  async function revokeToken(token: Token) {
    try {
      await revoke({ tokenId: token._id });
    } catch (caught) {
      throw new Error(caught instanceof Error ? caught.message : "Could not revoke the token", {
        cause: caught,
      });
    }
    toast.success(`Revoked ${token.name}`);
  }

  // A CLI token is most useful as the login command; a metrics token goes into a file.
  const shown =
    created === undefined
      ? undefined
      : created.scope === "metrics"
        ? created.token
        : `erainfra auth login --url ${convexSiteUrl()} --token ${created.token}`;

  return (
    <>
      <Card className="gap-0 py-0">
        <CardHeader className="border-b py-4">
          <CardTitle render={<h2 />}>Create a token</CardTitle>
          <CardDescription>
            Sent as <code className="font-mono text-foreground">Authorization: Bearer</code>.
            Several can be live at once, so rotate by creating the replacement before revoking the
            old one.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4 py-4">
          <form className="flex flex-col gap-4" onSubmit={(event) => void submit(event)}>
            <Field className="max-w-md">
              <FieldLabel>Name</FieldLabel>
              <Input
                placeholder="laptop, prometheus, nightly-report"
                value={name}
                maxLength={100}
                required
                onChange={(event) => setName(event.target.value)}
              />
            </Field>
            <FieldSet>
              <FieldLegend>Scope</FieldLegend>
              <RadioGroup
                value={scope}
                onValueChange={(value) => {
                  const next = SCOPES.find((option) => option.value === value);
                  if (next) setScope(next.value);
                }}
                className="sm:grid-cols-3"
              >
                {SCOPES.map((option) => (
                  <Field key={option.value} orientation="horizontal">
                    <RadioGroupItem value={option.value} id={`token-scope-${option.value}`} />
                    <FieldContent>
                      <FieldLabel htmlFor={`token-scope-${option.value}`}>
                        {option.label}
                      </FieldLabel>
                      <FieldDescription>For {option.description}.</FieldDescription>
                    </FieldContent>
                  </Field>
                ))}
              </RadioGroup>
            </FieldSet>
            <Button type="submit" className="w-fit" disabled={pending || name.trim().length === 0}>
              {pending ? (
                <Spinner data-icon="inline-start" />
              ) : (
                <KeyRoundIcon data-icon="inline-start" />
              )}
              Create token
            </Button>
          </form>

          {shown !== undefined && (
            <div className="flex flex-col gap-2">
              <CodeBlock code={shown} title={`New ${created?.scope ?? ""} token`} />
              <p className="text-xs text-muted-foreground">
                Copy it now. Only a digest is stored, so this {created?.scope} token cannot be shown
                again.
                {created?.scope === "metrics" &&
                  " The Metrics tab has the Prometheus scrape config."}
              </p>
            </div>
          )}

          {error !== undefined && (
            <Alert variant="danger">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
        </CardContent>
      </Card>

      <Card className="gap-0 py-0">
        <CardHeader className="border-b py-4">
          <CardTitle render={<h2 />}>Tokens</CardTitle>
          <CardDescription>
            Last use is recorded to five minutes. A revoked token is refused on its next request.
          </CardDescription>
        </CardHeader>
        <DataTable
          aria-label="API tokens"
          columns={columns}
          data={tokens ?? []}
          loading={tokens === undefined}
          loadingRows={2}
          getRowId={(token) => token._id}
          empty={
            <EmptyState>
              <EmptyStateMedia>
                <KeyRoundIcon />
              </EmptyStateMedia>
              <EmptyStateTitle>No tokens</EmptyStateTitle>
              <EmptyStateDescription>
                /api/v1 and /metrics refuse every request until a token exists.
              </EmptyStateDescription>
            </EmptyState>
          }
          rowActions={rowActions}
        />
      </Card>

      <ConfirmDialog
        open={revokeOpen}
        onOpenChange={setRevokeOpen}
        title={`Revoke "${revoking?.name ?? ""}"?`}
        description="Anything using it stops working immediately."
        confirmLabel="Revoke token"
        onConfirm={() => (revoking === undefined ? undefined : revokeToken(revoking))}
      />
    </>
  );
}
