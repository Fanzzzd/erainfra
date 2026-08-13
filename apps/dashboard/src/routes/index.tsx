import { useId, useMemo, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useMutation, useQuery } from "convex/react";
import {
  Check,
  ChevronRight,
  CircleCheck,
  CircleX,
  Clipboard,
  Plus,
  Server,
  ShieldAlert,
  ShieldCheck,
  UserPlus,
} from "lucide-react";
import { toast } from "sonner";
import { api } from "@runner-center/backend/api";
import { EmptyState } from "@/components/empty-state";
import { GithubAppSetup } from "@/components/github-app-setup";
import { PageHeader } from "@/components/page-header";
import { StatusDot } from "@/components/status";
import { TableRowsSkeleton } from "@/components/table-skeleton";
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useNow } from "@/hooks/use-now";
import { convexSiteUrl } from "@/lib/convex-site";
import { formatAbsoluteTime, formatRelativeTime } from "@/lib/time";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/")({ component: MachinesPage });

type RegistrationCommand = {
  command: string;
  issuedAt: number;
  expiresAt: number;
  knownMachineIds: string[];
};

const REGISTRATION_TTL_MS = 15 * 60 * 1_000;

function MachinesPage() {
  const machines = useQuery(api.machines.list);
  const attempts = useQuery(api.attempts.list);
  const profiles = useQuery(api.profiles.list);
  const createRegistrationToken = useMutation(api.machines.createRegistrationToken);
  const now = useNow();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string>();
  const [registration, setRegistration] = useState<RegistrationCommand>();
  const [copied, setCopied] = useState(false);

  const summary = useMemo(() => {
    const list = machines ?? [];
    const startOfToday = new Date(now);
    startOfToday.setHours(0, 0, 0, 0);

    return {
      online: list.filter((machine) => isMachineOnline(machine.lastSeen, now)).length,
      totalMachines: list.length,
      usedSlots: list.reduce((total, machine) => total + machine.usedSlots, 0),
      totalSlots: list.reduce((total, machine) => total + machine.maxSlots, 0),
      runsToday:
        attempts?.filter((attempt) => attempt.createdAt >= startOfToday.getTime()).length ?? 0,
    };
  }, [attempts, machines, now]);

  const connectedMachine = useMemo(() => {
    if (registration === undefined || machines === undefined) return undefined;
    return machines.find(
      (machine) =>
        machine._creationTime >= registration.issuedAt &&
        !registration.knownMachineIds.includes(machine._id),
    );
  }, [machines, registration]);

  async function beginRegistration() {
    setSubmitting(true);
    setError(undefined);
    setRegistration(undefined);
    setCopied(false);

    try {
      const result = await createRegistrationToken({});
      const siteUrl = convexSiteUrl();
      setRegistration({
        command: `curl -fsSL ${siteUrl}/install | bash -s -- --token ${result.token}`,
        issuedAt: result.expiresAt - REGISTRATION_TTL_MS,
        expiresAt: result.expiresAt,
        knownMachineIds: (machines ?? []).map((machine) => machine._id),
      });
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Could not create a registration command",
      );
    } finally {
      setSubmitting(false);
    }
  }

  async function copyCommand(value: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1_500);
    } catch {
      toast.error("Clipboard access was blocked", {
        description: "Select the command above and copy it manually.",
      });
    }
  }

  function changeDialog(open: boolean) {
    setDialogOpen(open);
    if (open) {
      void beginRegistration();
    } else {
      setRegistration(undefined);
      setError(undefined);
      setCopied(false);
      setSubmitting(false);
    }
  }

  const machineCount = machines?.length;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Machines"
        description="Manage connected runner hosts, capacity, and active assignments."
      >
        <Dialog open={dialogOpen} onOpenChange={changeDialog}>
          <DialogTrigger asChild>
            <Button>
              <Plus />
              Add machine
            </Button>
          </DialogTrigger>
          <DialogContent className="sm:max-w-2xl">
            <DialogHeader>
              <DialogTitle>Add machine</DialogTitle>
              <DialogDescription>
                Run one command on a macOS or Linux host. Runner Center installs, registers, and
                starts the agent for you.
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-4 py-1">
              {submitting && (
                <div className="flex items-center gap-3 rounded-md border border-border bg-muted px-4 py-5 text-sm text-secondary-foreground">
                  <StatusDot tone="success" live />
                  Creating a short-lived registration command…
                </div>
              )}

              {registration && (
                <>
                  <div className="space-y-2">
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-sm font-medium text-secondary-foreground">
                        Run on the new machine
                      </span>
                      <span className="text-[11px] text-warning">
                        Expires in {Math.max(0, Math.ceil((registration.expiresAt - now) / 60_000))}{" "}
                        min
                      </span>
                    </div>
                    <div className="relative rounded-md border border-border bg-sunken p-3 pr-11">
                      <pre className="overflow-x-auto whitespace-pre-wrap break-all font-mono text-xs leading-5 text-secondary-foreground">
                        <code>{registration.command}</code>
                      </pre>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="absolute right-1.5 top-1.5 size-8"
                        aria-label="Copy install command"
                        onClick={() => void copyCommand(registration.command)}
                      >
                        {copied ? <Check /> : <Clipboard />}
                      </Button>
                    </div>
                    <p className="text-xs leading-5 text-muted-foreground">
                      The registration token expires in 15 minutes and can be used once.
                    </p>
                  </div>

                  {connectedMachine ? (
                    <Alert variant="success">
                      <Check />
                      <AlertTitle>{connectedMachine.name} connected</AlertTitle>
                      <AlertDescription>
                        The machine is registered and will report online after its first heartbeat.
                      </AlertDescription>
                    </Alert>
                  ) : now >= registration.expiresAt ? (
                    <Alert variant="warning">
                      <AlertTitle>This command has expired</AlertTitle>
                      <AlertDescription>Generate a new command before installing.</AlertDescription>
                    </Alert>
                  ) : (
                    <div className="flex items-center gap-3 rounded-md border border-border bg-muted p-3 text-sm text-secondary-foreground">
                      <StatusDot tone="success" live />
                      Waiting for machine…
                    </div>
                  )}

                  <details className="rounded-md border border-border bg-muted px-3 py-2.5 text-xs text-muted-foreground">
                    <summary className="cursor-pointer select-none font-medium text-secondary-foreground">
                      Advanced options
                    </summary>
                    <div className="mt-3 space-y-2 leading-5">
                      <p>
                        Append{" "}
                        <code className="text-secondary-foreground">--name build-linux-01</code> to
                        override the hostname.
                      </p>
                      <p>
                        Append{" "}
                        <code className="text-secondary-foreground">--labels gpu,docker</code> for
                        machine capability labels.
                      </p>
                      <p>
                        Append <code className="text-secondary-foreground">--slots 2</code> to
                        override detected concurrency.
                      </p>
                    </div>
                  </details>
                </>
              )}

              {error && (
                <Alert variant="destructive">
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              )}
            </div>

            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => changeDialog(false)}>
                {connectedMachine ? "Done" : "Cancel"}
              </Button>
              {(error || (registration && now >= registration.expiresAt)) && (
                <Button
                  type="button"
                  onClick={() => void beginRegistration()}
                  disabled={submitting}
                >
                  Generate new command
                </Button>
              )}
              {registration && !connectedMachine && now < registration.expiresAt && (
                <Button type="button" onClick={() => void copyCommand(registration.command)}>
                  {copied ? <Check /> : <Clipboard />}
                  {copied ? "Copied" : "Copy command"}
                </Button>
              )}
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </PageHeader>

      <AllowlistWarning />

      <div className="grid gap-3 sm:grid-cols-3">
        <StatTile
          label="Machines online"
          value={machines === undefined ? undefined : `${summary.online}/${summary.totalMachines}`}
          detail={
            machines === undefined
              ? "Loading fleet"
              : `${summary.totalMachines} registered ${summary.totalMachines === 1 ? "host" : "hosts"}`
          }
          live
        />
        <StatTile
          label="Slots in use"
          value={machines === undefined ? undefined : `${summary.usedSlots}/${summary.totalSlots}`}
          detail="Concurrent runner capacity"
        />
        <StatTile
          label="Runs today"
          value={attempts === undefined ? undefined : String(summary.runsToday)}
          detail="Scale-set Attempts since midnight"
        />
      </div>

      <Card className="overflow-hidden">
        <CardHeader className="border-b">
          <CardTitle>Runner Profiles</CardTitle>
          <CardDescription>
            Workflows target a Profile, never a machine. Compatible Workers discover and prewarm its
            immutable image automatically.
          </CardDescription>
          <CardAction>
            <code className="rounded-md border border-border bg-sunken px-2.5 py-1.5 text-xs text-primary">
              runs-on: {profiles?.[0]?.name ?? "rc-linux-js"}
            </code>
          </CardAction>
        </CardHeader>
        <Table className="min-w-[1000px]">
          <TableHeader>
            <TableRow>
              <TableHead className="w-[240px]">Profile / scale set</TableHead>
              <TableHead className="w-[190px]">Isolation boundary</TableHead>
              <TableHead className="w-[150px]">Resources</TableHead>
              <TableHead className="w-[150px]">Ready Workers</TableHead>
              <TableHead className="w-[130px]">Capacity</TableHead>
              <TableHead>Image Release</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {profiles === undefined ? (
              <TableRowsSkeleton columns={6} rows={2} />
            ) : profiles.length === 0 ? (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={6} className="p-0">
                  <EmptyState
                    icon={ShieldCheck}
                    title="No Profiles registered"
                    description="Start a scale-set controller to register its Profile and the isolation boundary it can promise."
                  />
                </TableCell>
              </TableRow>
            ) : (
              profiles.map((profile) => (
                <ProfileRow key={profile._id} profile={profile} now={now} />
              ))
            )}
          </TableBody>
        </Table>
      </Card>

      <Card className="overflow-hidden">
        <CardHeader className="border-b">
          <CardTitle className="flex items-center gap-2.5">
            Registered fleet
            {machineCount !== undefined && (
              <span className="tabular-nums text-xs font-normal text-subtle-foreground">
                {machineCount}
              </span>
            )}
          </CardTitle>
          <CardDescription>
            Every host that holds a machine credential, and what it is running right now.
          </CardDescription>
          <CardAction>
            <span className="flex items-center gap-2 text-xs text-muted-foreground">
              <StatusDot tone="success" live />
              Live
            </span>
          </CardAction>
        </CardHeader>

        <Table className="min-w-[1040px]">
          <TableHeader>
            <TableRow>
              <TableHead className="w-[112px]">Status</TableHead>
              <TableHead className="w-[170px]">Machine</TableHead>
              <TableHead className="w-[90px]">OS</TableHead>
              <TableHead className="w-[210px]">Ready Profiles</TableHead>
              <TableHead className="w-[130px]">Slots</TableHead>
              <TableHead className="w-[112px]">Last seen</TableHead>
              <TableHead>Active runs</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {machines === undefined ? (
              <TableRowsSkeleton columns={7} rows={3} />
            ) : machines.length === 0 ? (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={7} className="p-0">
                  <EmptyState
                    icon={Server}
                    title="No machines registered"
                    description="Add a host to make capacity available to the scheduler."
                  >
                    <Button size="sm" onClick={() => changeDialog(true)}>
                      <Plus />
                      Add machine
                    </Button>
                  </EmptyState>
                </TableCell>
              </TableRow>
            ) : (
              machines.map((machine) => {
                const online = isMachineOnline(machine.lastSeen, now);
                const slotPercent = Math.min(
                  100,
                  Math.max(0, (machine.usedSlots / machine.maxSlots) * 100),
                );

                return (
                  <TableRow key={machine._id}>
                    <TableCell>
                      <MachineStatus online={online} />
                    </TableCell>
                    <TableCell>
                      <div className="font-medium text-foreground">{machine.name}</div>
                      {machine.arch && (
                        <div className="mt-0.5 text-[10px] text-subtle-foreground">
                          {machine.arch}
                          {machine.cpus && ` · ${machine.cpus} CPU`}
                          {machine.memoryMiB && ` · ${formatMemory(machine.memoryMiB)}`}
                        </div>
                      )}
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline" className="font-mono">
                        {formatOs(machine.os)}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <ProfileReadiness readiness={machine.readiness} />
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-3">
                        <span className="tabular-nums w-7 text-secondary-foreground">
                          {machine.usedSlots}/{machine.maxSlots}
                        </span>
                        <div
                          className="h-1 w-12 overflow-hidden rounded-full bg-accent"
                          role="progressbar"
                          aria-label={`${machine.usedSlots} of ${machine.maxSlots} slots in use`}
                          aria-valuemin={0}
                          aria-valuemax={machine.maxSlots}
                          aria-valuenow={machine.usedSlots}
                        >
                          <div
                            className={cn(
                              "h-full rounded-full transition-[width] duration-150",
                              machine.usedSlots >= machine.maxSlots
                                ? "bg-warning"
                                : "bg-muted-foreground",
                            )}
                            style={{ width: `${slotPercent}%` }}
                          />
                        </div>
                      </div>
                      {machine.recommendedSlots !== undefined && (
                        <p className="mt-1 text-[10px] text-subtle-foreground">
                          {machine.slotPolicy === "fixed" ? "fixed" : "auto"} · recommended{" "}
                          {machine.recommendedSlots}
                        </p>
                      )}
                    </TableCell>
                    <TableCell>
                      <span
                        className="tabular-nums whitespace-nowrap text-muted-foreground"
                        title={
                          machine.lastSeen > 0
                            ? formatAbsoluteTime(machine.lastSeen)
                            : "No heartbeat received"
                        }
                      >
                        {formatRelativeTime(machine.lastSeen, now)}
                      </span>
                    </TableCell>
                    <TableCell>
                      <ActiveRuns
                        attempts={machine.currentAttempts}
                        experiments={machine.currentExperiments}
                        legacyJobs={machine.currentJobs}
                      />
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </Card>

      <InviteOperator />

      <Card>
        <CardContent className="px-0 pb-0">
          <details className="group">
            <summary className="cursor-pointer select-none px-4 py-3.5 text-sm font-medium text-secondary-foreground">
              Legacy webhook runner migration
            </summary>
            <div className="space-y-4 border-t border-border px-4 py-4">
              <GithubAppSetup />
            </div>
          </details>
        </CardContent>
      </Card>
    </div>
  );
}

/**
 * Registering machines is pointless while intake rejects everything, and the
 * rejection is otherwise invisible from this page — so the warning belongs
 * here, next to onboarding, not only on the Jobs page where the diagnosis
 * lives. Silent when the allowlist is set.
 */
function AllowlistWarning() {
  const policy = useQuery(api.settings.repositoryPolicy);
  if (policy === undefined || policy.configured) return null;

  return (
    <Alert variant="destructive">
      <ShieldAlert />
      <AlertTitle>No repositories are allowed yet</AlertTitle>
      <AlertDescription>
        <p>
          <code>ALLOWED_REPOS</code> is unset, so every workflow job is rejected. Set it before
          installing the GitHub App.
        </p>
        <Link to="/jobs" className="underline underline-offset-2 hover:text-destructive-foreground">
          See rejected deliveries
        </Link>
      </AlertDescription>
    </Alert>
  );
}

function StatTile({
  label,
  value,
  detail,
  live = false,
}: {
  label: string;
  value: string | undefined;
  detail: string;
  live?: boolean;
}) {
  return (
    <Card className="px-4 py-3.5">
      <div className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
        {live && <StatusDot tone="success" live />}
        {label}
      </div>
      <div className="mt-2 flex items-baseline justify-between gap-3">
        {value === undefined ? (
          <Skeleton className="h-6 w-16" />
        ) : (
          <span className="tabular-nums text-xl font-semibold tracking-tight text-foreground">
            {value}
          </span>
        )}
        <span className="truncate text-[11px] text-subtle-foreground">{detail}</span>
      </div>
    </Card>
  );
}

function MachineStatus({ online }: { online: boolean }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-2",
        online ? "text-success" : "text-muted-foreground",
      )}
    >
      <StatusDot tone={online ? "success" : "muted"} live={online} />
      {online ? "Online" : "Offline"}
    </span>
  );
}

function ProfileReadiness({
  readiness,
}: {
  readiness: Array<{
    profile: string;
    state: "preparing" | "ready" | "degraded" | "failed";
    statusDetail?: string;
    lastError?: string;
  }>;
}) {
  if (readiness.length === 0) return <span className="text-subtle-foreground">Discovering…</span>;

  return (
    <div className="flex max-w-[240px] flex-wrap gap-1">
      {readiness.map((entry) => {
        const badge = (
          <Badge
            variant={
              entry.state === "ready"
                ? "success"
                : entry.state === "failed"
                  ? "destructive"
                  : "warning"
            }
            className="font-mono"
          >
            {entry.profile}
          </Badge>
        );

        const detail = entry.lastError || entry.statusDetail;
        if (detail === undefined || detail === "") return <div key={entry.profile}>{badge}</div>;

        return (
          <Tooltip key={entry.profile}>
            <TooltipTrigger asChild>
              <div>{badge}</div>
            </TooltipTrigger>
            <TooltipContent side="top">{detail}</TooltipContent>
          </Tooltip>
        );
      })}
    </div>
  );
}

function ActiveRuns({
  attempts,
  experiments,
  legacyJobs,
}: {
  attempts: Array<{
    _id: string;
    profile: string;
    state: "pending" | "preparing" | "ready" | "running";
  }>;
  experiments: Array<{
    _id: string;
    name: string;
    state: "queued" | "preparing" | "running";
  }>;
  legacyJobs: Array<{
    _id: string;
    repo: string;
    workflowName: string;
    status: "assigned" | "running";
  }>;
}) {
  if (attempts.length === 0 && experiments.length === 0 && legacyJobs.length === 0) {
    return <span className="text-subtle-foreground">—</span>;
  }

  return (
    <div className="space-y-1.5">
      {attempts.map((attempt) => (
        <div key={attempt._id} className="flex min-w-0 items-center gap-2 whitespace-nowrap">
          <StatusDot
            tone={attempt.state === "running" ? "success" : "warning"}
            live={attempt.state === "running"}
          />
          <span className="max-w-40 truncate font-mono text-[12px] text-secondary-foreground">
            {attempt.profile}
          </span>
          <span className="text-xs text-subtle-foreground">{attempt.state}</span>
        </div>
      ))}
      {experiments.map((experiment) => (
        <div key={experiment._id} className="flex min-w-0 items-center gap-2 whitespace-nowrap">
          <StatusDot
            tone={experiment.state === "running" ? "info" : "warning"}
            live={experiment.state === "running"}
          />
          <span className="max-w-40 truncate text-[12px] text-secondary-foreground">
            {experiment.name}
          </span>
          <span className="text-xs text-subtle-foreground">experiment</span>
        </div>
      ))}
      {legacyJobs.map((job) => (
        <div key={job._id} className="flex min-w-0 items-center gap-2 whitespace-nowrap">
          <StatusDot
            tone={job.status === "running" ? "success" : "warning"}
            live={job.status === "running"}
          />
          <span className="sr-only">{job.status}: </span>
          <span className="max-w-40 truncate font-mono text-[12px] text-secondary-foreground">
            {job.repo}
          </span>
          <span className="max-w-40 truncate text-xs text-subtle-foreground">
            {job.workflowName}
          </span>
        </div>
      ))}
    </div>
  );
}

type ProfileSummary = (typeof api.profiles.list)["_returnType"][number];

const BOUNDARY_COPY = {
  "guest-kernel": {
    label: "guest kernel",
    tooltip: "Each Job boots its own guest kernel. Safe for untrusted pull request code.",
  },
  "shared-kernel": {
    label: "shared kernel",
    tooltip:
      "Every Job shares this host's kernel and Docker daemon. Trusted repositories only — one Job's kernel exploit is every other Job's problem.",
  },
} as const;

/**
 * One Profile, plus the evidence behind its readiness.
 *
 * The isolation boundary is the fact a workflow author actually needs before
 * pointing `runs-on` at a Profile, so it is a column rather than something to
 * infer from the executor name. Expanding a row shows exactly which
 * prerequisite each Worker proved, which is what turns "not ready" into an
 * actionable message.
 */
function ProfileRow({ profile, now }: { profile: ProfileSummary; now: number }) {
  const [expanded, setExpanded] = useState(false);
  const panelId = useId();
  const guestKernel = profile.boundary === "guest-kernel";
  const boundary = BOUNDARY_COPY[profile.boundary];
  const unhealthy = profile.workers.filter((worker) => worker.state !== "ready");

  return (
    <>
      <TableRow className="cursor-pointer" onClick={() => setExpanded((open) => !open)}>
        <TableCell>
          <div className="flex items-start gap-2">
            <button
              type="button"
              aria-expanded={expanded}
              aria-controls={panelId}
              className="mt-px grid size-5 shrink-0 place-items-center rounded-sm text-muted-foreground outline-none transition-colors duration-150 hover:bg-accent hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/40"
              onClick={(event) => {
                event.stopPropagation();
                setExpanded((open) => !open);
              }}
            >
              <ChevronRight
                className={cn(
                  "size-3.5 transition-transform duration-150",
                  expanded && "rotate-90",
                )}
              />
              <span className="sr-only">
                {expanded ? "Hide" : "Show"} Worker readiness for {profile.name}
              </span>
            </button>
            <div className="min-w-0">
              <code className="text-xs text-foreground">{profile.name}</code>
              <p className="mt-0.5 text-[10px] text-subtle-foreground">{profile.scaleSetName}</p>
            </div>
          </div>
        </TableCell>
        <TableCell>
          <Tooltip>
            <TooltipTrigger asChild>
              <Badge variant={guestKernel ? "success" : "warning"} className="text-[11px]">
                {guestKernel ? <ShieldCheck /> : <ShieldAlert />}
                {boundary.label}
              </Badge>
            </TooltipTrigger>
            <TooltipContent side="top">{boundary.tooltip}</TooltipContent>
          </Tooltip>
          <p className="mt-1 font-mono text-[10px] text-subtle-foreground">
            {profile.executor}
            {profile.trustedOnly && " · trusted only"}
          </p>
        </TableCell>
        <TableCell className="tabular-nums text-xs text-secondary-foreground">
          {profile.vcpus} vCPU · {formatMemory(profile.memoryMiB)}
        </TableCell>
        <TableCell className="tabular-nums text-xs text-secondary-foreground">
          {profile.readyWorkers}
          {unhealthy.length > 0 && (
            <span className="ml-1.5 text-[10px] text-warning">+{unhealthy.length} not ready</span>
          )}
        </TableCell>
        <TableCell className="tabular-nums text-xs text-secondary-foreground">
          {profile.freeSlots}/{profile.readySlots} free
        </TableCell>
        <TableCell>
          <code
            className="block max-w-[270px] truncate text-[10px] text-subtle-foreground"
            title={profile.imageRelease}
          >
            {profile.imageRelease}
          </code>
        </TableCell>
      </TableRow>
      {expanded && (
        <TableRow className="hover:bg-transparent">
          <TableCell colSpan={6} id={panelId} className="bg-sunken px-4 py-3.5">
            {profile.workers.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                No Worker has reported readiness for this Profile yet.
              </p>
            ) : (
              <div className="space-y-2.5">
                {profile.workers.map((worker) => (
                  <WorkerReadiness key={worker.machineId} worker={worker} now={now} />
                ))}
              </div>
            )}
          </TableCell>
        </TableRow>
      )}
    </>
  );
}

type Fact = { label: string; value: string; tone?: "warning" };

function workerFacts(worker: ProfileSummary["workers"][number]): Fact[] {
  const facts: Fact[] = [];
  if (worker.isolation) facts.push({ label: "Isolation", value: worker.isolation });

  const hardware = worker.hardware;
  if (hardware) {
    const shape = [
      hardware.cpus === undefined ? undefined : `${hardware.cpus} CPU`,
      hardware.memoryMiB === undefined ? undefined : formatMemory(hardware.memoryMiB),
      hardware.kvm === true ? `KVM (${hardware.virtualization ?? "hardware"})` : undefined,
    ].filter((part): part is string => part !== undefined);
    if (hardware.cpuModel !== undefined) facts.push({ label: "CPU", value: hardware.cpuModel });
    if (shape.length > 0) facts.push({ label: "Hardware", value: shape.join(" · ") });
  }

  const storage = worker.storage;
  if (storage?.poolFreeMiB !== undefined) {
    facts.push({
      label: "Storage",
      value: `${storage.snapshotter ?? "snapshotter"} · ${formatMemory(storage.poolFreeMiB)} free of ${formatMemory(storage.poolTotalMiB ?? 0)}`,
    });
  }

  const network = worker.network;
  if (network?.subnet !== undefined) {
    facts.push({
      label: "Network",
      value: [network.subnet, network.egressMode, network.policyName]
        .filter((part): part is string => part !== undefined && part.length > 0)
        .join(" · "),
    });
  }

  if (worker.cacheScope) {
    facts.push({
      label: "Cache",
      // A writable cache shared between Jobs is a cross-job path, so it is
      // never just a fact: it is the reason a Worker cannot be trusted ready.
      value: `${worker.cacheScope} · ${worker.cacheSharedWritable ? "shared writable" : "nothing shared"}`,
      ...(worker.cacheSharedWritable === true ? { tone: "warning" as const } : {}),
    });
  }

  return facts;
}

/**
 * The evidence layer under a Profile: what this Worker proved, then the host
 * facts it measured. Checks come first and stay legible on their own — a named
 * check with its detail is the difference between "not ready" and a fix.
 */
function WorkerReadiness({
  worker,
  now,
}: {
  worker: ProfileSummary["workers"][number];
  now: number;
}) {
  const facts = workerFacts(worker);
  const checks = worker.checks ?? [];

  return (
    <div className="rounded-md border border-border bg-card px-3 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <code className="text-xs text-foreground">{worker.machineName}</code>
        <Badge
          variant={
            worker.state === "ready"
              ? "success"
              : worker.state === "failed"
                ? "destructive"
                : "warning"
          }
        >
          {worker.state}
        </Badge>
        {!worker.online && <Badge variant="outline">offline</Badge>}
        <span className="tabular-nums ml-auto text-[10px] text-subtle-foreground">
          {worker.usedSlots}/{worker.maxSlots} slots used
        </span>
      </div>

      <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[10px] leading-4 text-subtle-foreground">
        {worker.statusDetail !== undefined && worker.statusDetail !== "" && (
          <span>{worker.statusDetail}</span>
        )}
        <span title={formatAbsoluteTime(worker.checkedAt)}>
          checked {formatRelativeTime(worker.checkedAt, now)}
        </span>
        {worker.preparedAt !== undefined && (
          <span title={formatAbsoluteTime(worker.preparedAt)}>
            last ready {formatRelativeTime(worker.preparedAt, now)}
          </span>
        )}
      </div>

      {checks.length > 0 && (
        <ul className="mt-2.5 grid gap-1.5 sm:grid-cols-2">
          {checks.map((check) => (
            <li key={check.name} className="flex items-start gap-2">
              {check.passed ? (
                <CircleCheck className="mt-0.5 size-3.5 shrink-0 text-success" aria-hidden="true" />
              ) : (
                <CircleX className="mt-0.5 size-3.5 shrink-0 text-destructive" aria-hidden="true" />
              )}
              <span className="min-w-0">
                <span className="sr-only">{check.passed ? "Passed: " : "Failed: "}</span>
                <span
                  className={cn(
                    "font-mono text-[11px] leading-4",
                    check.passed ? "text-secondary-foreground" : "text-destructive",
                  )}
                >
                  {check.name}
                </span>
                {check.detail !== undefined && check.detail !== "" && (
                  <span className="block break-words text-[10px] leading-4 text-muted-foreground">
                    {check.detail}
                  </span>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}

      {facts.length > 0 && (
        <>
          <Separator className="my-2.5" />
          <dl className="grid gap-x-6 gap-y-1.5 sm:grid-cols-2 lg:grid-cols-3">
            {facts.map((fact) => (
              <div key={fact.label} className="min-w-0">
                <dt className="text-[10px] uppercase tracking-[0.08em] text-subtle-foreground">
                  {fact.label}
                </dt>
                <dd
                  className={cn(
                    "break-words text-[11px] leading-4",
                    fact.tone === "warning" ? "text-warning" : "text-muted-foreground",
                  )}
                >
                  {fact.value}
                </dd>
              </div>
            ))}
          </dl>
        </>
      )}

      {worker.lastError !== undefined && worker.lastError !== "" && (
        <p className="mt-2.5 break-words text-[11px] leading-4 text-destructive">
          <span className="sr-only">Last error: </span>
          {worker.lastError}
        </p>
      )}
    </div>
  );
}

function formatMemory(memoryMiB: number) {
  return memoryMiB % 1024 === 0 ? `${memoryMiB / 1024} GiB` : `${memoryMiB} MiB`;
}

/**
 * The only way to open sign-up once this instance has an admin. The grant is
 * shown once and never read back: it exists in this component's state until the
 * operator navigates away, and only its hash is stored server-side.
 */
function InviteOperator() {
  const invite = useMutation(api.bootstrap.invite);
  const [grant, setGrant] = useState<{ token: string; expiresAt: number }>();
  const [error, setError] = useState<string>();
  const [copied, setCopied] = useState(false);
  const [pending, setPending] = useState(false);

  async function generate() {
    setError(undefined);
    setPending(true);
    try {
      const result = await invite({});
      setGrant({ token: result.grantToken, expiresAt: result.expiresAt });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not create an invitation");
    } finally {
      setPending(false);
    }
  }

  async function copy() {
    if (grant === undefined) return;
    try {
      await navigator.clipboard.writeText(grant.token);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1_500);
    } catch {
      toast.error("Clipboard access was blocked", {
        description: "Select the invitation above and copy it manually.",
      });
    }
  }

  return (
    <Card>
      <CardContent className="px-0 pb-0">
        <details>
          <summary className="cursor-pointer select-none px-4 py-3.5 text-sm font-medium text-secondary-foreground">
            Invite another operator
          </summary>
          <div className="space-y-3 border-t border-border px-4 py-4 text-xs text-muted-foreground">
            <p className="leading-5">
              Sign-up is closed. An invitation is the only way to add an account after the first
              one. It is single-use, expires in ten minutes, and is shown here once — send it over a
              channel you trust.
            </p>

            {grant === undefined ? (
              <Button type="button" disabled={pending} onClick={() => void generate()}>
                {pending ? "Please wait…" : "Create an invitation"}
                {!pending && <UserPlus />}
              </Button>
            ) : (
              <>
                <div className="relative rounded-md border border-border bg-sunken p-3 pr-11">
                  <code className="block break-all font-mono text-xs leading-5 text-secondary-foreground">
                    {grant.token}
                  </code>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="absolute right-1.5 top-1.5 size-8"
                    aria-label="Copy invitation"
                    onClick={() => void copy()}
                  >
                    {copied ? <Check /> : <Clipboard />}
                  </Button>
                </div>
                <p className="leading-5">
                  Expires {formatAbsoluteTime(grant.expiresAt)}. The recipient enters it on the
                  sign-in page under “Accept an invitation”.
                </p>
              </>
            )}

            {error !== undefined && (
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
          </div>
        </details>
      </CardContent>
    </Card>
  );
}

function isMachineOnline(lastSeen: number, now: number) {
  return lastSeen > 0 && now - lastSeen < 120_000;
}

function formatOs(os: "linux" | "mac" | "win") {
  if (os === "mac") return "macOS";
  // Windows machines can only exist through manual onboarding, and their images
  // stay inert without the rc-preview opt-in label. Say so where they are listed.
  if (os === "win") return "Windows (preview)";
  return "linux";
}
