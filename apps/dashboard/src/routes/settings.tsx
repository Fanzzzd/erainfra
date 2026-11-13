import { api } from "@erainfra/backend/api";
import type { Id } from "@erainfra/backend/dataModel";
import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery } from "convex/react";
import { ConvexError } from "convex/values";
import { BellRingIcon, KeyRoundIcon, PlusIcon, SendIcon } from "lucide-react";
import { useCallback, useMemo, useState, type ReactElement, type ReactNode } from "react";

import { ApiTokens } from "@/components/api-tokens";
import { CodeBlock } from "@/components/code-block";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { DataTable, createDataTableColumns } from "@/components/data-table";
import {
  EmptyState,
  EmptyStateDescription,
  EmptyStateMedia,
  EmptyStateTitle,
} from "@/components/empty-state";
import { PageHeader, PageHeaderDescription, PageHeaderTitle } from "@/components/page-header";
import { Status } from "@/components/status";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { toast } from "@/components/ui/toast";
import { useNow } from "@/hooks/use-now";
import { convexSiteUrl } from "@/lib/convex-site";
import { deliveryStates, incidentStates } from "@/lib/states";
import { formatAbsoluteTime, formatRelativeTime } from "@/lib/time";

export const Route = createFileRoute("/settings")({ component: SettingsPage });

type Overview = (typeof api.alerts.overview)["_returnType"];
type Incident = Overview["incidents"][number];
type Rule = Overview["rules"][number];
type Destination = Overview["destinations"][number];
type Condition = Rule["condition"];
type ConditionKind = Condition["kind"];

function errorMessage(caught: unknown, fallback: string) {
  if (caught instanceof ConvexError && typeof caught.data === "string") return caught.data;
  return fallback;
}

// Runs one row action and reports a failure as a toast, leaving the row as it was.
async function runOrToast(action: () => Promise<unknown>, failure: string) {
  try {
    await action();
  } catch (caught) {
    toast.error(errorMessage(caught, failure));
  }
}

// Runs a confirmed action. A failure rejects with a readable message, which the confirm dialog
// shows while it stays open.
async function runOrReject(action: () => Promise<unknown>, failure: string) {
  try {
    await action();
  } catch (caught) {
    throw new Error(errorMessage(caught, failure), { cause: caught });
  }
}

/** A dialog or confirmation opened from a row menu. The row outlives `open`, so the text stays while it closes. */
/**
 * A dialog opened from a row menu. `session` changes on every open; key the dialog on it so each
 * open starts from the row's current values, with no error left over from the last one.
 */
function useRowDialog<T>() {
  const [row, setRow] = useState<T>();
  const [open, setOpen] = useState(false);
  const [session, setSession] = useState(0);
  const show = useCallback((next: T) => {
    setRow(next);
    setSession((current) => current + 1);
    setOpen(true);
  }, []);
  return { row, open, setOpen, show, session };
}

function SettingsPage() {
  return (
    <>
      <PageHeader>
        <PageHeaderTitle>Settings</PageHeaderTitle>
        <PageHeaderDescription>
          Alert rules and where they notify, the Prometheus endpoint, and the API tokens the CLI and
          Prometheus authenticate with.
        </PageHeaderDescription>
      </PageHeader>
      <Tabs defaultValue="alerts" className="gap-6">
        <div className="overflow-x-auto border-b">
          <TabsList variant="line" aria-label="Settings sections">
            <TabsTrigger value="alerts">Alerts</TabsTrigger>
            <TabsTrigger value="metrics">Metrics</TabsTrigger>
            <TabsTrigger value="tokens">API tokens</TabsTrigger>
          </TabsList>
        </div>
        <TabsContent value="alerts" className="flex flex-col gap-6">
          <AlertsSettings />
        </TabsContent>
        <TabsContent value="metrics" className="flex flex-col gap-6">
          <MetricsSettings />
        </TabsContent>
        <TabsContent value="tokens" className="flex flex-col gap-6">
          <ApiTokens />
        </TabsContent>
      </Tabs>
    </>
  );
}

// ---------------------------------------------------------------------------------------------
// Alerts

function AlertsSettings() {
  const overview = useQuery(api.alerts.overview);
  return (
    <>
      <IncidentsCard incidents={overview?.incidents} />
      <RulesCard rules={overview?.rules} destinations={overview?.destinations ?? []} />
      <DestinationsCard destinations={overview?.destinations} />
    </>
  );
}

function SectionHeader({
  title,
  description,
  action,
}: {
  title: string;
  description: ReactNode;
  action?: ReactNode;
}) {
  return (
    <CardHeader className="border-b py-4">
      <CardTitle render={<h2 />}>{title}</CardTitle>
      <CardDescription>{description}</CardDescription>
      {action === undefined ? null : <CardAction>{action}</CardAction>}
    </CardHeader>
  );
}

function Empty({ icon, title, children }: { icon: ReactNode; title: string; children: string }) {
  return (
    <EmptyState>
      <EmptyStateMedia>{icon}</EmptyStateMedia>
      <EmptyStateTitle>{title}</EmptyStateTitle>
      <EmptyStateDescription>{children}</EmptyStateDescription>
    </EmptyState>
  );
}

const incidentColumn = createDataTableColumns<Incident>();

function incidentColumns(now: number) {
  return incidentColumn.columns([
    incidentColumn.accessor("status", {
      header: "State",
      enableSorting: false,
      cell: (cell) => {
        const incident = cell.row.original;
        return (
          <div>
            <Status states={incidentStates} state={incident.status} className="font-medium" />
            {incident.status === "firing" && !incident.notified && (
              <p className="mt-1 text-xs text-muted-foreground">Not notified</p>
            )}
          </div>
        );
      },
    }),
    incidentColumn.accessor("ruleName", {
      header: "Rule and subject",
      cell: (cell) => (
        <div>
          <div className="font-medium">{cell.getValue()}</div>
          <div className="font-mono text-xs text-muted-foreground">{cell.row.original.subject}</div>
        </div>
      ),
    }),
    incidentColumn.accessor("summary", {
      header: "Summary",
      enableSorting: false,
      meta: { cellClassName: "min-w-64 whitespace-normal text-muted-foreground" },
    }),
    incidentColumn.accessor("since", {
      header: "Since",
      cell: (cell) => {
        const incident = cell.row.original;
        return (
          <div className="text-muted-foreground">
            <span title={formatAbsoluteTime(incident.since)}>
              {formatRelativeTime(incident.since, now)}
            </span>
            {incident.resolvedAt !== undefined && (
              <p className="text-xs">resolved {formatRelativeTime(incident.resolvedAt, now)}</p>
            )}
          </div>
        );
      },
    }),
  ]);
}

function IncidentsCard({ incidents }: { incidents: Overview["incidents"] | undefined }) {
  const now = useNow();
  const columns = useMemo(() => incidentColumns(now), [now]);
  return (
    <Card className="gap-0 py-0">
      <SectionHeader
        title="Incidents"
        description="Firing and pending incidents, then the most recent resolved ones. Rules are evaluated every minute."
      />
      <DataTable
        aria-label="Incidents"
        columns={columns}
        data={incidents ?? []}
        loading={incidents === undefined}
        loadingRows={2}
        getRowId={(incident) => incident._id}
        empty={
          <Empty icon={<BellRingIcon />} title="No incidents">
            When a rule's condition holds, its incident shows here.
          </Empty>
        }
      />
    </Card>
  );
}

const ruleColumn = createDataTableColumns<Rule>();

function ruleColumns(now: number, destinationName: Map<Id<"alertDestinations">, string>) {
  return ruleColumn.columns([
    ruleColumn.accessor("name", {
      header: "Rule",
      cell: (cell) => (
        <div className="min-w-48">
          <div className="font-medium">{cell.getValue()}</div>
          <div className="text-xs whitespace-normal text-muted-foreground">
            {cell.row.original.description}
          </div>
        </div>
      ),
    }),
    ruleColumn.accessor((rule) => rule.profile ?? "", {
      id: "profile",
      header: "Scope",
      cell: (cell) => (
        <span className="text-muted-foreground">
          {cell.row.original.profile ?? "Every Profile"}
        </span>
      ),
    }),
    ruleColumn.display({
      id: "timing",
      header: "Timing",
      cell: (cell) => (
        <div className="text-muted-foreground">
          <div>pending {cell.row.original.forMinutes}m</div>
          <div>cooldown {cell.row.original.cooldownMinutes}m</div>
        </div>
      ),
    }),
    ruleColumn.display({
      id: "notifies",
      header: "Notifies",
      meta: { cellClassName: "min-w-40 whitespace-normal text-muted-foreground" },
      cell: (cell) => {
        const ids = cell.row.original.destinationIds;
        return ids.length === 0
          ? "Nowhere (dashboard and /metrics only)"
          : ids.map((id) => destinationName.get(id) ?? "?").join(", ");
      },
    }),
    ruleColumn.display({
      id: "state",
      header: "State",
      cell: (cell) => {
        const rule = cell.row.original;
        const muted = rule.mutedUntil !== undefined && rule.mutedUntil > now;
        return (
          <div className="flex flex-wrap gap-1">
            {!rule.enabled ? (
              <Badge variant="neutral">Off</Badge>
            ) : rule.firing > 0 ? (
              <Badge variant="danger">{rule.firing} firing</Badge>
            ) : rule.pending > 0 ? (
              <Badge variant="warning">{rule.pending} pending</Badge>
            ) : (
              <Badge variant="success">OK</Badge>
            )}
            {muted && rule.mutedUntil !== undefined && (
              <Badge variant="outline" title={formatAbsoluteTime(rule.mutedUntil)}>
                Muted
              </Badge>
            )}
          </div>
        );
      },
    }),
  ]);
}

/** The row menu for a rule. Module-level, so the menu is not a new component on each render. */
function ruleActions(on: {
  edit: (rule: Rule) => void;
  remove: (rule: Rule) => void;
  mute: (rule: Rule, until: number | null) => void;
  toggle: (rule: Rule) => void;
}) {
  return {
    label: (rule: Rule) => `Actions for ${rule.name}`,
    items: (rule: Rule) => {
      const muted = rule.mutedUntil !== undefined && rule.mutedUntil > Date.now();
      return (
        <>
          <DropdownMenuGroup>
            <DropdownMenuItem onClick={() => on.edit(rule)}>Edit rule</DropdownMenuItem>
            {muted ? (
              <DropdownMenuItem onClick={() => on.mute(rule, null)}>Unmute</DropdownMenuItem>
            ) : (
              <>
                <DropdownMenuItem onClick={() => on.mute(rule, Date.now() + 60 * 60_000)}>
                  Mute for 1 hour
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => on.mute(rule, Date.now() + 24 * 60 * 60_000)}>
                  Mute for 24 hours
                </DropdownMenuItem>
              </>
            )}
            <DropdownMenuItem onClick={() => on.toggle(rule)}>
              {rule.enabled ? "Disable rule" : "Enable rule"}
            </DropdownMenuItem>
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onClick={() => on.remove(rule)}>
            Delete rule
          </DropdownMenuItem>
        </>
      );
    },
  };
}

function RulesCard({
  rules,
  destinations,
}: {
  rules: Rule[] | undefined;
  destinations: Destination[];
}) {
  const now = useNow();
  const setEnabled = useMutation(api.alerts.setRuleEnabled);
  const mute = useMutation(api.alerts.muteRule);
  const remove = useMutation(api.alerts.deleteRule);
  const editing = useRowDialog<Rule>();
  const deleting = useRowDialog<Rule>();
  const destinationName = useMemo(
    () => new Map(destinations.map((item) => [item._id, item.name])),
    [destinations],
  );
  const columns = useMemo(() => ruleColumns(now, destinationName), [now, destinationName]);
  const showEdit = editing.show;
  const showDelete = deleting.show;
  const rowActions = useMemo(
    () =>
      ruleActions({
        edit: showEdit,
        remove: showDelete,
        mute: (rule, until) =>
          void runOrToast(
            () => mute({ id: rule._id, until }),
            until === null ? "Could not unmute" : "Could not mute",
          ),
        toggle: (rule) =>
          void runOrToast(
            () => setEnabled({ id: rule._id, enabled: !rule.enabled }),
            "Could not change the rule",
          ),
      }),
    [showEdit, showDelete, mute, setEnabled],
  );

  return (
    <Card className="gap-0 py-0">
      <SectionHeader
        title="Rules"
        description="A rule fires once its condition has held for the pending time, notifies once per incident, and notifies again when the incident resolves."
        action={
          <RuleDialog
            destinations={destinations}
            trigger={
              <Button size="sm">
                <PlusIcon data-icon="inline-start" />
                Add rule
              </Button>
            }
          />
        }
      />
      <DataTable
        aria-label="Alert rules"
        columns={columns}
        data={rules ?? []}
        loading={rules === undefined}
        loadingRows={2}
        getRowId={(rule) => rule._id}
        empty={
          <Empty icon={<BellRingIcon />} title="No alert rules">
            Start with Worker offline and queue backlog; they catch most fleet outages.
          </Empty>
        }
        rowActions={rowActions}
      />
      {editing.row === undefined ? null : (
        <RuleDialog
          key={`${editing.row._id}-${editing.session}`}
          destinations={destinations}
          rule={editing.row}
          open={editing.open}
          onOpenChange={editing.setOpen}
        />
      )}
      <ConfirmDialog
        open={deleting.open}
        onOpenChange={deleting.setOpen}
        title={`Delete the rule "${deleting.row?.name ?? ""}"?`}
        description="Its incidents are deleted with it."
        confirmLabel="Delete rule"
        onConfirm={async () => {
          const rule = deleting.row;
          if (rule === undefined) return;
          await runOrReject(() => remove({ id: rule._id }), "Could not delete the rule");
          toast.success(`Deleted ${rule.name}`);
        }}
      />
    </Card>
  );
}

const CONDITION_LABEL: Record<ConditionKind, string> = {
  "worker-offline": "Worker offline",
  "profile-no-ready-worker": "Profile has no ready Worker",
  "profile-readiness-degraded": "Worker readiness degraded or failed",
  "profile-label-conflict": "Profiles' scale-set labels overlap",
  "queue-backlog": "Queue backlog",
  "failure-rate": "Attempt failure rate",
  "consecutive-failures": "Consecutive failed Attempts",
  "attempt-duration": "Attempt running too long",
  "controller-silent": "No controller listening",
  "node-commands-blocked": "Node unable to run commands",
  "node-offline": "Node offline",
  "runner-release-expiring": "actions/runner near GitHub's cutoff",
};

const CONDITION_ORDER = Object.keys(CONDITION_LABEL) as ConditionKind[];

const CONDITION_ITEMS = CONDITION_ORDER.map((kind) => ({
  value: kind,
  label: CONDITION_LABEL[kind],
}));

// The Profile select's value for "no Profile": a rule that watches every Profile.
const EVERY_PROFILE = "*";

type ConditionForm = {
  minutes: string;
  percent: string;
  windowMinutes: string;
  minAttempts: string;
  count: string;
};

const DEFAULT_MINUTES: Partial<Record<ConditionKind, string>> = {
  "worker-offline": "5",
  "queue-backlog": "15",
  "attempt-duration": "60",
  "controller-silent": "3",
  "node-commands-blocked": "10",
  "node-offline": "5",
};

function conditionForm(condition: Condition | undefined): ConditionForm {
  return {
    minutes: condition !== undefined && "minutes" in condition ? String(condition.minutes) : "15",
    percent: condition?.kind === "failure-rate" ? String(condition.percent) : "50",
    windowMinutes: condition?.kind === "failure-rate" ? String(condition.windowMinutes) : "60",
    minAttempts: condition?.kind === "failure-rate" ? String(condition.minAttempts) : "5",
    count: condition?.kind === "consecutive-failures" ? String(condition.count) : "3",
  };
}

function buildCondition(kind: ConditionKind, form: ConditionForm): Condition {
  switch (kind) {
    case "worker-offline":
    case "queue-backlog":
    case "attempt-duration":
    case "controller-silent":
    case "node-commands-blocked":
    case "node-offline":
      return { kind, minutes: Number(form.minutes) };
    case "failure-rate":
      return {
        kind,
        percent: Number(form.percent),
        windowMinutes: Number(form.windowMinutes),
        minAttempts: Number(form.minAttempts),
      };
    case "consecutive-failures":
      return { kind, count: Number(form.count) };
    case "profile-no-ready-worker":
    case "profile-readiness-degraded":
    case "profile-label-conflict":
    case "runner-release-expiring":
      return { kind };
  }
}

function FormError({ error }: { error: string | undefined }) {
  if (error === undefined) return null;
  return (
    <Alert variant="danger">
      <AlertDescription>{error}</AlertDescription>
    </Alert>
  );
}

/**
 * Adds a rule, or edits `rule`. A new rule opens from `trigger`; an existing one opens from its
 * row menu, which controls `open`.
 */
function RuleDialog({
  destinations,
  rule,
  trigger,
  open: openProp,
  onOpenChange,
}: {
  destinations: Destination[];
  rule?: Rule;
  trigger?: ReactElement;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const profiles = useQuery(api.profiles.list);
  const create = useMutation(api.alerts.createRule);
  const update = useMutation(api.alerts.updateRule);
  const [openState, setOpenState] = useState(false);
  const open = openProp ?? openState;
  const [name, setName] = useState(rule?.name ?? "");
  const [kind, setKind] = useState<ConditionKind>(rule?.condition.kind ?? "worker-offline");
  const [form, setForm] = useState<ConditionForm>(() => conditionForm(rule?.condition));
  const [profile, setProfile] = useState(rule?.profile ?? "");
  const [forMinutes, setForMinutes] = useState(String(rule?.forMinutes ?? 0));
  const [cooldownMinutes, setCooldownMinutes] = useState(String(rule?.cooldownMinutes ?? 30));
  const [selected, setSelected] = useState<Set<Id<"alertDestinations">>>(
    () => new Set(rule?.destinationIds ?? destinations.map((item) => item._id)),
  );
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);

  const profileItems = [
    { value: EVERY_PROFILE, label: "Every Profile" },
    ...(profiles ?? []).map((item) => ({ value: item.name, label: item.name })),
  ];

  function setOpen(next: boolean) {
    setOpenState(next);
    onOpenChange?.(next);
    if (!next) return;
    setError(undefined);
    // A new rule notifies every destination unless the operator unticks one.
    if (rule === undefined) setSelected(new Set(destinations.map((item) => item._id)));
  }

  function changeKind(next: ConditionKind) {
    setKind(next);
    if (rule === undefined) {
      setForm((current) => ({ ...current, minutes: DEFAULT_MINUTES[next] ?? current.minutes }));
      if (name.length === 0 || CONDITION_ORDER.some((item) => CONDITION_LABEL[item] === name)) {
        setName(CONDITION_LABEL[next]);
      }
    }
  }

  async function submit() {
    setError(undefined);
    setPending(true);
    const fields = {
      name,
      condition: buildCondition(kind, form),
      ...(profile.length === 0 ? {} : { profile }),
      forMinutes: Number(forMinutes),
      cooldownMinutes: Number(cooldownMinutes),
      destinationIds: [...selected],
    };
    try {
      if (rule === undefined) await create(fields);
      else await update({ id: rule._id, ...fields });
      setOpen(false);
      toast.success(rule === undefined ? `Added ${name}` : `Saved ${name}`);
    } catch (caught) {
      setError(errorMessage(caught, "Could not save the rule"));
    } finally {
      setPending(false);
    }
  }

  const number = (key: keyof ConditionForm, label: string) => (
    <Field>
      <FieldLabel>{label}</FieldLabel>
      <Input
        inputMode="numeric"
        value={form[key]}
        onChange={(event) => setForm({ ...form, [key]: event.target.value })}
      />
    </Field>
  );

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      {trigger === undefined ? null : <DialogTrigger render={trigger} />}
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{rule === undefined ? "Add alert rule" : `Edit ${rule.name}`}</DialogTitle>
          <DialogDescription>
            Evaluated every minute against what the control plane knows about the fleet.
          </DialogDescription>
        </DialogHeader>
        <form
          id="rule-form"
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <Field>
            <FieldLabel>Condition</FieldLabel>
            <Select
              items={CONDITION_ITEMS}
              value={kind}
              onValueChange={(value) => {
                if (value !== null) changeKind(value);
              }}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CONDITION_ITEMS.map((item) => (
                  <SelectItem key={item.value} value={item.value}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          {(kind === "worker-offline" ||
            kind === "queue-backlog" ||
            kind === "attempt-duration" ||
            kind === "controller-silent" ||
            kind === "node-commands-blocked" ||
            kind === "node-offline" ||
            kind === "consecutive-failures" ||
            kind === "failure-rate") && (
            <div className="grid gap-3 sm:grid-cols-2">
              {kind === "worker-offline" && number("minutes", "No heartbeat for (minutes)")}
              {kind === "queue-backlog" && number("minutes", "Oldest queued for (minutes)")}
              {kind === "attempt-duration" && number("minutes", "Running longer than (minutes)")}
              {kind === "controller-silent" &&
                number("minutes", "No listening controller for (minutes)")}
              {kind === "node-commands-blocked" && number("minutes", "Blocked for (minutes)")}
              {kind === "node-offline" && number("minutes", "No heartbeat for (minutes)")}
              {kind === "consecutive-failures" && number("count", "Failed Attempts in a row")}
              {kind === "failure-rate" && (
                <>
                  {number("percent", "Failure rate at least (%)")}
                  {number("windowMinutes", "Over the last (minutes)")}
                  {number("minAttempts", "Once at least (Attempts)")}
                </>
              )}
            </div>
          )}
          <Field>
            <FieldLabel>Name</FieldLabel>
            <Input value={name} onChange={(event) => setName(event.target.value)} />
          </Field>
          <Field>
            <FieldLabel>Profile</FieldLabel>
            <Select
              items={profileItems}
              value={profile.length === 0 ? EVERY_PROFILE : profile}
              onValueChange={(value) => {
                if (value !== null) setProfile(value === EVERY_PROFILE ? "" : value);
              }}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {profileItems.map((item) => (
                  <SelectItem key={item.value} value={item.value}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field>
              <FieldLabel>Pending before firing (minutes)</FieldLabel>
              <Input
                inputMode="numeric"
                value={forMinutes}
                onChange={(event) => setForMinutes(event.target.value)}
              />
            </Field>
            <Field>
              <FieldLabel>Cooldown between notices (minutes)</FieldLabel>
              <Input
                inputMode="numeric"
                value={cooldownMinutes}
                onChange={(event) => setCooldownMinutes(event.target.value)}
              />
            </Field>
          </div>
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-2 text-sm font-medium">Notify</legend>
            {destinations.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No destinations yet. The rule still opens incidents here and in /metrics.
              </p>
            ) : (
              destinations.map((destination) => (
                <Field key={destination._id} orientation="horizontal">
                  <FieldLabel className="font-normal">
                    <Checkbox
                      checked={selected.has(destination._id)}
                      onCheckedChange={(checked) => {
                        const next = new Set(selected);
                        if (checked) next.add(destination._id);
                        else next.delete(destination._id);
                        setSelected(next);
                      }}
                    />
                    {destination.name}
                    <span className="text-xs text-muted-foreground">{destination.kind}</span>
                  </FieldLabel>
                </Field>
              ))
            )}
          </fieldset>
          <FormError error={error} />
        </form>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button type="submit" form="rule-form" disabled={pending}>
            {pending ? <Spinner data-icon="inline-start" /> : null}
            {rule === undefined ? "Add rule" : "Save rule"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const destinationColumn = createDataTableColumns<Destination>();

function destinationColumns(now: number) {
  return destinationColumn.columns([
    destinationColumn.accessor("name", {
      header: "Destination",
      cell: (cell) => {
        const destination = cell.row.original;
        return (
          <div>
            <div className="font-medium">{destination.name}</div>
            <div className="mt-1 flex gap-1">
              <Badge variant="outline">{destination.kind}</Badge>
              {destination.signed && <Badge variant="outline">signed</Badge>}
              {!destination.enabled && <Badge variant="warning">disabled</Badge>}
            </div>
          </div>
        );
      },
    }),
    destinationColumn.accessor("urlHint", {
      header: "URL",
      enableSorting: false,
      cell: (cell) => (
        <code className="font-mono text-xs text-muted-foreground">{cell.getValue()}</code>
      ),
    }),
    destinationColumn.display({
      id: "lastDelivery",
      header: "Last delivery",
      meta: { cellClassName: "min-w-48 whitespace-normal" },
      cell: (cell) => {
        const last = cell.row.original.lastDelivery;
        if (last === undefined) return <span className="text-muted-foreground">Never</span>;
        return (
          <div>
            <Status states={deliveryStates} state={last.status} />
            <p className="text-xs text-muted-foreground">
              {last.event}, {formatRelativeTime(last.createdAt, now)}
            </p>
            {last.lastError !== undefined && last.status !== "delivered" && (
              <p className="mt-1 text-xs text-danger">
                {last.lastError} (attempt {last.attempts})
              </p>
            )}
          </div>
        );
      },
    }),
  ]);
}

/** The row menu for a destination. Module-level, so the menu is not a new component on each render. */
function destinationActions(on: {
  test: (destination: Destination) => void;
  replace: (destination: Destination) => void;
  rotate: (destination: Destination) => void;
  toggle: (destination: Destination) => void;
  remove: (destination: Destination) => void;
}) {
  return {
    label: (destination: Destination) => `Actions for ${destination.name}`,
    items: (destination: Destination) => (
      <>
        <DropdownMenuGroup>
          <DropdownMenuItem onClick={() => on.test(destination)}>Send test</DropdownMenuItem>
          <DropdownMenuItem onClick={() => on.replace(destination)}>Replace URL</DropdownMenuItem>
          {destination.kind === "webhook" && (
            <DropdownMenuItem onClick={() => on.rotate(destination)}>
              Rotate signing secret
            </DropdownMenuItem>
          )}
          <DropdownMenuItem onClick={() => on.toggle(destination)}>
            {destination.enabled ? "Disable destination" : "Enable destination"}
          </DropdownMenuItem>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" onClick={() => on.remove(destination)}>
          Delete destination
        </DropdownMenuItem>
      </>
    ),
  };
}

type Revealed = { name: string; secret: string };

function DestinationsCard({ destinations }: { destinations: Destination[] | undefined }) {
  const now = useNow();
  const sendTest = useMutation(api.alerts.sendTest);
  const update = useMutation(api.alerts.updateDestination);
  const rotate = useMutation(api.alerts.rotateSigningSecret);
  const remove = useMutation(api.alerts.deleteDestination);
  const [revealed, setRevealed] = useState<Revealed>();
  const replacing = useRowDialog<Destination>();
  const rotating = useRowDialog<Destination>();
  const deleting = useRowDialog<Destination>();
  const columns = useMemo(() => destinationColumns(now), [now]);
  const showReplace = replacing.show;
  const showRotate = rotating.show;
  const showDelete = deleting.show;
  const rowActions = useMemo(
    () =>
      destinationActions({
        test: (destination) =>
          void runOrToast(async () => {
            await sendTest({ id: destination._id });
            toast.success("Test notification queued");
          }, "Could not queue a test"),
        replace: showReplace,
        rotate: showRotate,
        toggle: (destination) =>
          void runOrToast(
            () => update({ id: destination._id, enabled: !destination.enabled }),
            "Could not change the destination",
          ),
        remove: showDelete,
      }),
    [sendTest, update, showReplace, showRotate, showDelete],
  );

  return (
    <Card className="gap-0 py-0">
      <SectionHeader
        title="Destinations"
        description="A generic webhook receives signed JSON; a Slack destination posts to an incoming webhook. URLs and signing secrets can be replaced but never read back."
        action={<DestinationDialog onSecret={setRevealed} />}
      />
      {revealed !== undefined && (
        <CardContent className="border-b py-4">
          <SecretOnce
            title={`Signing secret for ${revealed.name}`}
            value={revealed.secret}
            note="Shown once. The receiver verifies X-EraInfra-Signature with it; docs/monitoring.md, Alerts, describes the scheme."
            onDismiss={() => setRevealed(undefined)}
          />
        </CardContent>
      )}
      <DataTable
        aria-label="Alert destinations"
        columns={columns}
        data={destinations ?? []}
        loading={destinations === undefined}
        loadingRows={1}
        getRowId={(destination) => destination._id}
        empty={
          <Empty icon={<SendIcon />} title="No destinations">
            Add a Slack incoming webhook or a generic webhook to receive notifications.
          </Empty>
        }
        rowActions={rowActions}
      />
      {replacing.row === undefined ? null : (
        <ReplaceUrlDialog
          key={`${replacing.row._id}-${replacing.session}`}
          destination={replacing.row}
          open={replacing.open}
          onOpenChange={replacing.setOpen}
        />
      )}
      <ConfirmDialog
        open={rotating.open}
        onOpenChange={rotating.setOpen}
        title={`Rotate the signing secret for ${rotating.row?.name ?? ""}?`}
        description="The old secret stops working at once."
        confirmLabel="Rotate secret"
        onConfirm={async () => {
          const destination = rotating.row;
          if (destination === undefined) return;
          await runOrReject(async () => {
            const result = await rotate({ id: destination._id });
            setRevealed({ name: destination.name, secret: result.signingSecret });
          }, "Could not rotate the secret");
        }}
      />
      <ConfirmDialog
        open={deleting.open}
        onOpenChange={deleting.setOpen}
        title={`Delete the destination "${deleting.row?.name ?? ""}"?`}
        confirmLabel="Delete destination"
        onConfirm={async () => {
          const destination = deleting.row;
          if (destination === undefined) return;
          await runOrReject(
            () => remove({ id: destination._id }),
            "Could not delete the destination",
          );
          toast.success(`Deleted ${destination.name}`);
        }}
      />
    </Card>
  );
}

const KIND_ITEMS = [
  { value: "slack", label: "Slack incoming webhook (or a Slack-compatible one)" },
  { value: "webhook", label: "Generic webhook, JSON signed with HMAC-SHA256" },
] as const;

function DestinationDialog({ onSecret }: { onSecret: (revealed: Revealed) => void }) {
  const create = useMutation(api.alerts.createDestination);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [kind, setKind] = useState<"webhook" | "slack">("slack");
  const [url, setUrl] = useState("");
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);

  async function submit() {
    setError(undefined);
    setPending(true);
    try {
      const result = await create({ name, kind, url });
      if (result.signingSecret !== undefined) onSecret({ name, secret: result.signingSecret });
      setOpen(false);
      setName("");
      setUrl("");
      toast.success(`Added ${name}`);
    } catch (caught) {
      setError(errorMessage(caught, "Could not add the destination"));
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          <Button size="sm">
            <PlusIcon data-icon="inline-start" />
            Add destination
          </Button>
        }
      />
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add destination</DialogTitle>
          <DialogDescription>
            The URL is stored for sending only; the dashboard shows its host and last characters.
          </DialogDescription>
        </DialogHeader>
        <form
          id="destination-form"
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <Field>
            <FieldLabel>Kind</FieldLabel>
            <Select
              items={KIND_ITEMS}
              value={kind}
              onValueChange={(value) => {
                if (value !== null) setKind(value);
              }}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {KIND_ITEMS.map((item) => (
                  <SelectItem key={item.value} value={item.value}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field>
            <FieldLabel>Name</FieldLabel>
            <Input
              value={name}
              placeholder={kind === "slack" ? "#ci-alerts" : "pager"}
              onChange={(event) => setName(event.target.value)}
            />
          </Field>
          <Field>
            <FieldLabel>URL</FieldLabel>
            <Input
              type="url"
              autoComplete="off"
              value={url}
              placeholder={
                kind === "slack"
                  ? "https://hooks.slack.com/services/…"
                  : "https://alerts.example.com/erainfra"
              }
              onChange={(event) => setUrl(event.target.value)}
            />
            {kind === "webhook" && (
              <FieldDescription>
                A signing secret is generated for the webhook and shown once after you add it.
              </FieldDescription>
            )}
          </Field>
          <FormError error={error} />
        </form>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button type="submit" form="destination-form" disabled={pending}>
            {pending ? <Spinner data-icon="inline-start" /> : null}
            Add destination
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ReplaceUrlDialog({
  destination,
  open,
  onOpenChange,
}: {
  destination: Destination;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const update = useMutation(api.alerts.updateDestination);
  const [url, setUrl] = useState("");
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);

  async function submit() {
    setError(undefined);
    setPending(true);
    try {
      await update({ id: destination._id, url });
      onOpenChange(false);
      setUrl("");
      toast.success(`Replaced the URL for ${destination.name}`);
    } catch (caught) {
      setError(errorMessage(caught, "Could not replace the URL"));
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Replace URL for {destination.name}</DialogTitle>
          <DialogDescription>
            Currently <code className="font-mono">{destination.urlHint}</code>
          </DialogDescription>
        </DialogHeader>
        <form
          id="replace-url-form"
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <Field>
            <FieldLabel>New URL</FieldLabel>
            <Input
              type="url"
              autoComplete="off"
              value={url}
              onChange={(event) => setUrl(event.target.value)}
            />
          </Field>
          <FormError error={error} />
        </form>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="submit" form="replace-url-form" disabled={pending}>
            {pending ? <Spinner data-icon="inline-start" /> : null}
            Replace URL
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** A secret the control plane shows once: the value with a copy button, and a dismiss button. */
function SecretOnce({
  title,
  value,
  note,
  onDismiss,
  children,
}: {
  title: string;
  value: string;
  note: string;
  onDismiss: () => void;
  children?: ReactNode;
}) {
  return (
    <Alert>
      <KeyRoundIcon />
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription className="flex flex-col gap-3">
        <CodeBlock code={value} wrap />
        <p>{note}</p>
        {children}
        <Button type="button" size="sm" variant="outline" className="w-fit" onClick={onDismiss}>
          I have stored it
        </Button>
      </AlertDescription>
    </Alert>
  );
}

// ---------------------------------------------------------------------------------------------
// Metrics

function scrapeConfig(endpoint: URL) {
  return [
    "scrape_configs:",
    "  - job_name: erainfra",
    "    scrape_interval: 30s",
    "    scheme: https",
    `    metrics_path: ${endpoint.pathname}`,
    "    authorization:",
    "      type: Bearer",
    "      credentials_file: /etc/prometheus/erainfra-metrics-token",
    "    static_configs:",
    `      - targets: ["${endpoint.host}"]`,
  ].join("\n");
}

function MetricsSettings() {
  const create = useMutation(api.apiTokens.create);
  const [label, setLabel] = useState("prometheus");
  const [minted, setMinted] = useState<string>();
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);
  const endpoint = new URL("/metrics", convexSiteUrl());

  async function mint() {
    setError(undefined);
    setPending(true);
    try {
      const result = await create({ name: label, scope: "metrics" });
      setMinted(result.token);
    } catch (caught) {
      setError(errorMessage(caught, "Could not create a token"));
    } finally {
      setPending(false);
    }
  }

  return (
    <Card className="gap-0 py-0">
      <SectionHeader
        title="Prometheus endpoint"
        description="Fleet state in Prometheus text format: Workers by readiness, slots, queue depth and age, recent queue wait and run time, benchmark scores. docs/monitoring.md lists every metric."
      />
      <CardContent className="flex flex-col gap-4 py-4">
        <CodeBlock title="Scrape with GET" code={endpoint.toString()} />
        {minted === undefined ? (
          <form
            className="grid gap-3 sm:grid-cols-[minmax(0,20rem)_auto] sm:items-end"
            onSubmit={(event) => {
              event.preventDefault();
              void mint();
            }}
          >
            <Field>
              <FieldLabel>Token name</FieldLabel>
              <Input value={label} onChange={(event) => setLabel(event.target.value)} />
            </Field>
            <Button type="submit" disabled={pending}>
              {pending ? (
                <Spinner data-icon="inline-start" />
              ) : (
                <KeyRoundIcon data-icon="inline-start" />
              )}
              Create metrics token
            </Button>
          </form>
        ) : (
          <SecretOnce
            title="Metrics token"
            value={minted}
            note="Shown once; only its SHA-256 is stored. Save it to the credentials file below. To rotate, create a new token, reload Prometheus, then revoke the old one under API tokens."
            onDismiss={() => setMinted(undefined)}
          >
            <CodeBlock title="prometheus.yml" code={scrapeConfig(endpoint)} />
          </SecretOnce>
        )}
        <p className="text-sm text-muted-foreground">
          A metrics token can scrape and do nothing else. Read and admin tokens can scrape too.
          Every token is listed, and revoked, under API tokens.
        </p>
        <FormError error={error} />
      </CardContent>
    </Card>
  );
}
