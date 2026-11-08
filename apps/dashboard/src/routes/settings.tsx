import { useState, type ReactNode } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery } from "convex/react";
import { ConvexError } from "convex/values";
import { BellRing, Check, Clipboard, KeyRound, Plus, Send, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { api } from "@erainfra/backend/api";
import type { Id } from "@erainfra/backend/dataModel";
import { ApiTokens } from "@/components/api-tokens";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { StatusDot, type Tone } from "@/components/status";
import { TableRowsSkeleton } from "@/components/table-skeleton";
import { Alert, AlertDescription } from "@/components/ui/alert";
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useNow } from "@/hooks/use-now";
import { convexSiteUrl } from "@/lib/convex-site";
import { formatAbsoluteTime, formatRelativeTime } from "@/lib/time";

export const Route = createFileRoute("/settings")({ component: SettingsPage });

type Overview = (typeof api.alerts.overview)["_returnType"];
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

const selectClass =
  "flex h-10 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/25";

function SettingsPage() {
  return (
    <div className="space-y-6">
      <PageHeader
        title="Settings"
        description="Alert rules and where they notify, the Prometheus endpoint, and the API tokens the CLI and Prometheus authenticate with."
      />
      <Tabs defaultValue="alerts">
        <TabsList>
          <TabsTrigger value="alerts">Alerts</TabsTrigger>
          <TabsTrigger value="metrics">Metrics</TabsTrigger>
          <TabsTrigger value="tokens">API tokens</TabsTrigger>
        </TabsList>
        <TabsContent value="alerts" className="mt-6 space-y-6">
          <AlertsSettings />
        </TabsContent>
        <TabsContent value="metrics" className="mt-6 space-y-6">
          <MetricsSettings />
        </TabsContent>
        <TabsContent value="tokens" className="mt-6 space-y-6">
          <ApiTokens />
        </TabsContent>
      </Tabs>
    </div>
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

const INCIDENT_TONE: Record<Overview["incidents"][number]["status"], Tone> = {
  firing: "destructive",
  pending: "warning",
  resolved: "success",
};

function IncidentsCard({ incidents }: { incidents: Overview["incidents"] | undefined }) {
  const now = useNow();
  return (
    <Card className="overflow-hidden">
      <CardHeader className="border-b">
        <CardTitle>Incidents</CardTitle>
        <CardDescription>
          Firing and pending incidents, then the most recent resolved ones. Rules are evaluated
          every minute.
        </CardDescription>
      </CardHeader>
      <Table className="min-w-[900px]">
        <TableHeader>
          <TableRow>
            <TableHead className="w-[120px]">State</TableHead>
            <TableHead className="w-[200px]">Rule / subject</TableHead>
            <TableHead>Summary</TableHead>
            <TableHead className="w-[170px]">Since</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {incidents === undefined ? (
            <TableRowsSkeleton columns={4} rows={2} />
          ) : incidents.length === 0 ? (
            <TableRow className="hover:bg-transparent">
              <TableCell colSpan={4} className="p-0">
                <EmptyState
                  icon={BellRing}
                  title="No incidents"
                  description="When a rule's condition holds, its incident shows here."
                />
              </TableCell>
            </TableRow>
          ) : (
            incidents.map((incident) => (
              <TableRow key={incident._id}>
                <TableCell>
                  <span className="flex items-center gap-2 text-xs capitalize">
                    <StatusDot
                      tone={INCIDENT_TONE[incident.status]}
                      live={incident.status === "firing"}
                    />
                    {incident.status}
                  </span>
                  {incident.status === "firing" && !incident.notified && (
                    <p className="mt-1 text-[10px] text-subtle-foreground">not notified</p>
                  )}
                </TableCell>
                <TableCell>
                  <p className="text-sm text-secondary-foreground">{incident.ruleName}</p>
                  <p className="font-mono text-[11px] text-muted-foreground">{incident.subject}</p>
                </TableCell>
                <TableCell className="whitespace-normal text-xs leading-5 text-muted-foreground">
                  {incident.summary}
                </TableCell>
                <TableCell className="text-xs text-muted-foreground">
                  <span title={formatAbsoluteTime(incident.since)}>
                    {formatRelativeTime(incident.since, now)}
                  </span>
                  {incident.resolvedAt !== undefined && (
                    <p className="text-[10px] text-subtle-foreground">
                      resolved {formatRelativeTime(incident.resolvedAt, now)}
                    </p>
                  )}
                </TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
    </Card>
  );
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
  const destinationName = new Map(destinations.map((item) => [item._id, item.name]));

  return (
    <Card className="overflow-hidden">
      <CardHeader className="border-b">
        <CardTitle>Rules</CardTitle>
        <CardDescription>
          A rule fires once its condition has held for the pending time, notifies once per incident,
          and notifies again when the incident resolves.
        </CardDescription>
        <CardAction>
          <RuleDialog destinations={destinations} />
        </CardAction>
      </CardHeader>
      <Table className="min-w-[1000px]">
        <TableHeader>
          <TableRow>
            <TableHead className="w-[220px]">Rule</TableHead>
            <TableHead className="w-[150px]">Scope</TableHead>
            <TableHead className="w-[160px]">Timing</TableHead>
            <TableHead className="w-[180px]">Notifies</TableHead>
            <TableHead className="w-[130px]">State</TableHead>
            <TableHead className="text-right">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rules === undefined ? (
            <TableRowsSkeleton columns={6} rows={2} />
          ) : rules.length === 0 ? (
            <TableRow className="hover:bg-transparent">
              <TableCell colSpan={6} className="p-0">
                <EmptyState
                  icon={BellRing}
                  title="No alert rules"
                  description="Start with Worker offline and queue backlog; they catch most fleet outages."
                />
              </TableCell>
            </TableRow>
          ) : (
            rules.map((rule) => {
              const muted = rule.mutedUntil !== undefined && rule.mutedUntil > now;
              return (
                <TableRow key={rule._id}>
                  <TableCell>
                    <p className="text-sm text-secondary-foreground">{rule.name}</p>
                    <p className="text-[11px] text-muted-foreground">{rule.description}</p>
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {rule.profile ?? "Every Profile"}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    <p>pending {rule.forMinutes}m</p>
                    <p>cooldown {rule.cooldownMinutes}m</p>
                  </TableCell>
                  <TableCell className="whitespace-normal text-xs text-muted-foreground">
                    {rule.destinationIds.length === 0
                      ? "Nowhere (dashboard and /metrics only)"
                      : rule.destinationIds.map((id) => destinationName.get(id) ?? "?").join(", ")}
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-1">
                      {!rule.enabled ? (
                        <Badge variant="outline">off</Badge>
                      ) : rule.firing > 0 ? (
                        <Badge variant="destructive">{rule.firing} firing</Badge>
                      ) : rule.pending > 0 ? (
                        <Badge variant="warning">{rule.pending} pending</Badge>
                      ) : (
                        <Badge variant="success">ok</Badge>
                      )}
                      {muted && rule.mutedUntil !== undefined && (
                        <Badge variant="outline" title={formatAbsoluteTime(rule.mutedUntil)}>
                          muted
                        </Badge>
                      )}
                    </div>
                  </TableCell>
                  <TableCell>
                    <div className="flex justify-end gap-1.5">
                      <RuleDialog destinations={destinations} rule={rule} />
                      {muted ? (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() =>
                            void runOrToast(
                              () => mute({ id: rule._id, until: null }),
                              "Could not unmute",
                            )
                          }
                        >
                          Unmute
                        </Button>
                      ) : (
                        <>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() =>
                              void runOrToast(
                                () => mute({ id: rule._id, until: Date.now() + 60 * 60_000 }),
                                "Could not mute",
                              )
                            }
                          >
                            Mute 1h
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() =>
                              void runOrToast(
                                () => mute({ id: rule._id, until: Date.now() + 24 * 60 * 60_000 }),
                                "Could not mute",
                              )
                            }
                          >
                            24h
                          </Button>
                        </>
                      )}
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() =>
                          void runOrToast(
                            () => setEnabled({ id: rule._id, enabled: !rule.enabled }),
                            "Could not change the rule",
                          )
                        }
                      >
                        {rule.enabled ? "Disable" : "Enable"}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-label={`Delete ${rule.name}`}
                        onClick={() => {
                          if (window.confirm(`Delete the rule "${rule.name}" and its incidents?`)) {
                            void runOrToast(
                              () => remove({ id: rule._id }),
                              "Could not delete the rule",
                            );
                          }
                        }}
                      >
                        <Trash2 />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              );
            })
          )}
        </TableBody>
      </Table>
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

function Field({ label, id, children }: { label: string; id: string; children: ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id} className="text-xs">
        {label}
      </Label>
      {children}
    </div>
  );
}

function RuleDialog({ destinations, rule }: { destinations: Destination[]; rule?: Rule }) {
  const profiles = useQuery(api.profiles.list);
  const create = useMutation(api.alerts.createRule);
  const update = useMutation(api.alerts.updateRule);
  const [open, setOpen] = useState(false);
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
    } catch (caught) {
      setError(errorMessage(caught, "Could not save the rule"));
    } finally {
      setPending(false);
    }
  }

  const number = (key: keyof ConditionForm, label: string) => (
    <Field label={label} id={`rule-${key}`}>
      <Input
        id={`rule-${key}`}
        inputMode="numeric"
        value={form[key]}
        onChange={(event) => setForm({ ...form, [key]: event.target.value })}
      />
    </Field>
  );

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) return;
        setError(undefined);
        // A new rule notifies every destination unless the operator unticks one.
        if (rule === undefined) setSelected(new Set(destinations.map((item) => item._id)));
      }}
    >
      <DialogTrigger asChild>
        {rule === undefined ? (
          <Button size="sm">
            <Plus />
            Add rule
          </Button>
        ) : (
          <Button size="sm" variant="outline">
            Edit
          </Button>
        )}
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{rule === undefined ? "Add alert rule" : `Edit ${rule.name}`}</DialogTitle>
          <DialogDescription>
            Evaluated every minute against what the control plane knows about the fleet.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <Field label="Condition" id="rule-kind">
            <select
              id="rule-kind"
              className={selectClass}
              value={kind}
              onChange={(event) => changeKind(event.target.value as ConditionKind)}
            >
              {CONDITION_ORDER.map((item) => (
                <option key={item} value={item}>
                  {CONDITION_LABEL[item]}
                </option>
              ))}
            </select>
          </Field>
          <div className="grid grid-cols-2 gap-3">
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
          <Field label="Name" id="rule-name">
            <Input id="rule-name" value={name} onChange={(event) => setName(event.target.value)} />
          </Field>
          <Field label="Profile" id="rule-profile">
            <select
              id="rule-profile"
              className={selectClass}
              value={profile}
              onChange={(event) => setProfile(event.target.value)}
            >
              <option value="">Every Profile</option>
              {profiles?.map((item) => (
                <option key={item._id} value={item.name}>
                  {item.name}
                </option>
              ))}
            </select>
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Pending before firing (minutes)" id="rule-for">
              <Input
                id="rule-for"
                inputMode="numeric"
                value={forMinutes}
                onChange={(event) => setForMinutes(event.target.value)}
              />
            </Field>
            <Field label="Cooldown between notices (minutes)" id="rule-cooldown">
              <Input
                id="rule-cooldown"
                inputMode="numeric"
                value={cooldownMinutes}
                onChange={(event) => setCooldownMinutes(event.target.value)}
              />
            </Field>
          </div>
          <fieldset className="space-y-2">
            <legend className="text-xs font-medium">Notify</legend>
            {destinations.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                No destinations yet. The rule still opens incidents here and in /metrics.
              </p>
            ) : (
              destinations.map((destination) => (
                <label
                  key={destination._id}
                  className="flex items-center gap-2 text-sm text-secondary-foreground"
                >
                  <input
                    type="checkbox"
                    checked={selected.has(destination._id)}
                    onChange={(event) => {
                      const next = new Set(selected);
                      if (event.target.checked) next.add(destination._id);
                      else next.delete(destination._id);
                      setSelected(next);
                    }}
                  />
                  {destination.name}
                  <span className="text-xs text-muted-foreground">{destination.kind}</span>
                </label>
              ))
            )}
          </fieldset>
          {error !== undefined && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
        </div>
        <DialogFooter>
          <Button type="button" disabled={pending} onClick={() => void submit()}>
            {pending ? "Saving…" : rule === undefined ? "Add rule" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DestinationsCard({ destinations }: { destinations: Destination[] | undefined }) {
  const now = useNow();
  const sendTest = useMutation(api.alerts.sendTest);
  const update = useMutation(api.alerts.updateDestination);
  const rotate = useMutation(api.alerts.rotateSigningSecret);
  const remove = useMutation(api.alerts.deleteDestination);
  const [revealed, setRevealed] = useState<{ name: string; secret: string }>();

  return (
    <Card className="overflow-hidden">
      <CardHeader className="border-b">
        <CardTitle>Destinations</CardTitle>
        <CardDescription>
          A generic webhook receives signed JSON; a Slack destination posts to an incoming webhook.
          URLs and signing secrets can be replaced but never read back.
        </CardDescription>
        <CardAction>
          <DestinationDialog onSecret={setRevealed} />
        </CardAction>
      </CardHeader>
      {revealed !== undefined && (
        <CardContent className="border-b py-4">
          <SecretOnce
            title={`Signing secret for ${revealed.name}`}
            value={revealed.secret}
            note="Shown once. The receiver verifies X-EraInfra-Signature with it; see the README for the scheme."
            onDismiss={() => setRevealed(undefined)}
          />
        </CardContent>
      )}
      <Table className="min-w-[900px]">
        <TableHeader>
          <TableRow>
            <TableHead className="w-[200px]">Destination</TableHead>
            <TableHead className="w-[260px]">URL</TableHead>
            <TableHead className="w-[220px]">Last delivery</TableHead>
            <TableHead className="text-right">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {destinations === undefined ? (
            <TableRowsSkeleton columns={4} rows={1} />
          ) : destinations.length === 0 ? (
            <TableRow className="hover:bg-transparent">
              <TableCell colSpan={4} className="p-0">
                <EmptyState
                  icon={Send}
                  title="No destinations"
                  description="Add a Slack incoming webhook or a generic webhook to receive notifications."
                />
              </TableCell>
            </TableRow>
          ) : (
            destinations.map((destination) => {
              const last = destination.lastDelivery;
              return (
                <TableRow key={destination._id}>
                  <TableCell>
                    <p className="text-sm text-secondary-foreground">{destination.name}</p>
                    <div className="mt-1 flex gap-1">
                      <Badge variant="outline">{destination.kind}</Badge>
                      {destination.signed && <Badge variant="outline">signed</Badge>}
                      {!destination.enabled && <Badge variant="warning">disabled</Badge>}
                    </div>
                  </TableCell>
                  <TableCell className="font-mono text-[11px] text-muted-foreground">
                    {destination.urlHint}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {last === undefined ? (
                      "Never"
                    ) : (
                      <>
                        <span className="flex items-center gap-2">
                          <StatusDot
                            tone={
                              last.status === "delivered"
                                ? "success"
                                : last.status === "failed"
                                  ? "destructive"
                                  : "warning"
                            }
                            live={last.status === "pending"}
                          />
                          {last.event} {last.status} {formatRelativeTime(last.createdAt, now)}
                        </span>
                        {last.lastError !== undefined && last.status !== "delivered" && (
                          <p className="mt-1 text-[10px] text-destructive">
                            {last.lastError} (attempt {last.attempts})
                          </p>
                        )}
                      </>
                    )}
                  </TableCell>
                  <TableCell>
                    <div className="flex justify-end gap-1.5">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() =>
                          void runOrToast(async () => {
                            await sendTest({ id: destination._id });
                            toast.success("Test notification queued");
                          }, "Could not queue a test")
                        }
                      >
                        <Send />
                        Test
                      </Button>
                      <ReplaceUrlDialog destination={destination} />
                      {destination.kind === "webhook" && (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => {
                            if (
                              window.confirm(
                                `Rotate the signing secret for ${destination.name}? The old one stops working at once.`,
                              )
                            ) {
                              void runOrToast(async () => {
                                const result = await rotate({ id: destination._id });
                                setRevealed({
                                  name: destination.name,
                                  secret: result.signingSecret,
                                });
                              }, "Could not rotate the secret");
                            }
                          }}
                        >
                          <KeyRound />
                          Rotate
                        </Button>
                      )}
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() =>
                          void runOrToast(
                            () => update({ id: destination._id, enabled: !destination.enabled }),
                            "Could not change the destination",
                          )
                        }
                      >
                        {destination.enabled ? "Disable" : "Enable"}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-label={`Delete ${destination.name}`}
                        onClick={() => {
                          if (window.confirm(`Delete the destination "${destination.name}"?`)) {
                            void runOrToast(
                              () => remove({ id: destination._id }),
                              "Could not delete the destination",
                            );
                          }
                        }}
                      >
                        <Trash2 />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              );
            })
          )}
        </TableBody>
      </Table>
    </Card>
  );
}

function DestinationDialog({
  onSecret,
}: {
  onSecret: (revealed: { name: string; secret: string }) => void;
}) {
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
    } catch (caught) {
      setError(errorMessage(caught, "Could not add the destination"));
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm">
          <Plus />
          Add destination
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Add destination</DialogTitle>
          <DialogDescription>
            The URL is stored for sending only; the dashboard shows its host and last characters.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <Field label="Kind" id="destination-kind">
            <select
              id="destination-kind"
              className={selectClass}
              value={kind}
              onChange={(event) => setKind(event.target.value as "webhook" | "slack")}
            >
              <option value="slack">Slack incoming webhook (or a Slack-compatible one)</option>
              <option value="webhook">Generic webhook, JSON signed with HMAC-SHA256</option>
            </select>
          </Field>
          <Field label="Name" id="destination-name">
            <Input
              id="destination-name"
              value={name}
              placeholder={kind === "slack" ? "#ci-alerts" : "pager"}
              onChange={(event) => setName(event.target.value)}
            />
          </Field>
          <Field label="URL" id="destination-url">
            <Input
              id="destination-url"
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
          </Field>
          {kind === "webhook" && (
            <p className="text-xs leading-5 text-muted-foreground">
              A signing secret is generated for the webhook and shown once after you add it.
            </p>
          )}
          {error !== undefined && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
        </div>
        <DialogFooter>
          <Button type="button" disabled={pending} onClick={() => void submit()}>
            {pending ? "Adding…" : "Add destination"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ReplaceUrlDialog({ destination }: { destination: Destination }) {
  const update = useMutation(api.alerts.updateDestination);
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState("");
  const [error, setError] = useState<string>();

  async function submit() {
    setError(undefined);
    try {
      await update({ id: destination._id, url });
      setOpen(false);
      setUrl("");
    } catch (caught) {
      setError(errorMessage(caught, "Could not replace the URL"));
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline">
          Replace URL
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Replace URL for {destination.name}</DialogTitle>
          <DialogDescription>Currently {destination.urlHint}</DialogDescription>
        </DialogHeader>
        <Input
          type="url"
          autoComplete="off"
          aria-label="New URL"
          value={url}
          onChange={(event) => setUrl(event.target.value)}
        />
        {error !== undefined && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <DialogFooter>
          <Button type="button" onClick={() => void submit()}>
            Replace
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

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
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1_500);
    } catch {
      toast.error("Clipboard access was blocked", { description: "Select and copy it manually." });
    }
  }
  return (
    <div className="space-y-3 text-xs text-muted-foreground">
      <p className="text-sm font-medium text-secondary-foreground">{title}</p>
      <div className="relative rounded-md border border-border bg-sunken p-3 pr-11">
        <code className="block break-all font-mono text-xs leading-5 text-secondary-foreground">
          {value}
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
      <p className="leading-5">{note}</p>
      {children}
      <Button type="button" size="sm" variant="outline" onClick={onDismiss}>
        I have stored it
      </Button>
    </div>
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
  const endpoint = new URL("/metrics", convexSiteUrl());

  async function mint() {
    setError(undefined);
    try {
      const result = await create({ name: label, scope: "metrics" });
      setMinted(result.token);
    } catch (caught) {
      setError(errorMessage(caught, "Could not create a token"));
    }
  }

  return (
    <Card>
      <CardHeader className="border-b">
        <CardTitle>Prometheus endpoint</CardTitle>
        <CardDescription>
          Fleet state in Prometheus text format: Workers by readiness, slots, queue depth and age,
          recent queue wait and run time, benchmark scores. The README lists every metric.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 py-4 text-xs text-muted-foreground">
        <code className="block rounded-md border border-border bg-sunken px-3 py-2 font-mono text-secondary-foreground">
          GET {endpoint.toString()}
        </code>
        {minted === undefined ? (
          <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
            <div className="flex-1">
              <Field label="Token name" id="metrics-label">
                <Input
                  id="metrics-label"
                  value={label}
                  onChange={(event) => setLabel(event.target.value)}
                />
              </Field>
            </div>
            <Button type="button" onClick={() => void mint()}>
              <KeyRound />
              Create metrics token
            </Button>
          </div>
        ) : (
          <SecretOnce
            title="Metrics token"
            value={minted}
            note="Shown once; only its SHA-256 is stored. Save it to the credentials file below. To rotate, create a new token, reload Prometheus, then revoke the old one under API tokens."
            onDismiss={() => setMinted(undefined)}
          >
            <pre className="overflow-x-auto rounded-md border border-border bg-sunken p-3 font-mono text-[11px] leading-5 text-secondary-foreground">
              {scrapeConfig(endpoint)}
            </pre>
          </SecretOnce>
        )}
        <p className="leading-5">
          A metrics token can scrape and do nothing else. Read and admin tokens can scrape too.
          Every token is listed, and revoked, under API tokens.
        </p>
        {error !== undefined && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
      </CardContent>
    </Card>
  );
}
