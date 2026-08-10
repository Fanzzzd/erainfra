import { type ReactNode, useMemo, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useMutation, useQuery } from "convex/react";
import { Check, Clipboard, Plus, Server, ShieldAlert } from "lucide-react";
import { api } from "@runner-center/backend/api";
import { GithubAppSetup } from "@/components/github-app-setup";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
      setError(undefined);
      window.setTimeout(() => setCopied(false), 1_500);
    } catch {
      setError("Clipboard access was blocked. Select and copy the command manually.");
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
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-start">
        <PageHeading
          title="Machines"
          description="Manage connected runner hosts, capacity, and active assignments."
        />
        <Dialog open={dialogOpen} onOpenChange={changeDialog}>
          <DialogTrigger asChild>
            <Button className="shrink-0">
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

            <div className="space-y-4 py-2">
              {submitting && (
                <div className="flex items-center gap-3 rounded-md border border-white/[0.08] bg-white/[0.025] px-4 py-5 text-sm text-zinc-300">
                  <span className="status-pulse size-2 rounded-full bg-emerald-400" />
                  Creating a short-lived registration command…
                </div>
              )}

              {registration && (
                <>
                  <div className="space-y-2">
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-sm font-medium text-zinc-200">
                        Run on the new machine
                      </span>
                      <span className="text-[11px] text-amber-300">
                        Expires in {Math.max(0, Math.ceil((registration.expiresAt - now) / 60_000))}{" "}
                        min
                      </span>
                    </div>
                    <div className="relative rounded-md border border-white/[0.08] bg-[#09090a] p-3 pr-11">
                      <pre className="overflow-x-auto whitespace-pre-wrap break-all font-mono text-xs leading-5 text-zinc-300">
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
                    <p className="text-xs leading-5 text-[#8a8a93]">
                      The registration token expires in 15 minutes and can be used once.
                    </p>
                  </div>

                  {connectedMachine ? (
                    <div className="flex gap-3 rounded-md border border-emerald-400/20 bg-emerald-400/[0.07] p-3 text-sm text-emerald-200">
                      <Check className="mt-0.5 size-4 shrink-0" />
                      <div>
                        <p className="font-medium">{connectedMachine.name} connected</p>
                        <p className="mt-0.5 text-xs text-emerald-200/70">
                          The machine is registered and will report online after its first
                          heartbeat.
                        </p>
                      </div>
                    </div>
                  ) : now >= registration.expiresAt ? (
                    <div className="rounded-md border border-amber-400/20 bg-amber-400/[0.07] p-3 text-xs leading-5 text-amber-200">
                      This command has expired. Generate a new command before installing.
                    </div>
                  ) : (
                    <div className="flex items-center gap-3 rounded-md border border-white/[0.08] bg-white/[0.025] p-3 text-sm text-zinc-300">
                      <span className="status-pulse size-2 rounded-full bg-emerald-400" />
                      Waiting for machine…
                    </div>
                  )}

                  <details className="rounded-md border border-white/[0.08] bg-white/[0.02] px-3 py-2.5 text-xs text-[#8a8a93]">
                    <summary className="cursor-pointer select-none font-medium text-zinc-300">
                      Advanced options
                    </summary>
                    <div className="mt-3 space-y-2 leading-5">
                      <p>
                        Append <code className="text-zinc-300">--name build-linux-01</code> to
                        override the hostname.
                      </p>
                      <p>
                        Append <code className="text-zinc-300">--labels gpu,docker</code> for
                        machine capability labels.
                      </p>
                      <p>
                        Append <code className="text-zinc-300">--slots 2</code> to override detected
                        concurrency.
                      </p>
                    </div>
                  </details>
                </>
              )}

              {error && <ErrorMessage>{error}</ErrorMessage>}
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
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <StatTile
          label="Machines online"
          value={machines === undefined ? "—" : `${summary.online}/${summary.totalMachines}`}
          detail={
            machines === undefined
              ? "Loading fleet"
              : `${summary.totalMachines} registered ${summary.totalMachines === 1 ? "host" : "hosts"}`
          }
          indicator="online"
        />
        <StatTile
          label="Slots in use"
          value={machines === undefined ? "—" : `${summary.usedSlots}/${summary.totalSlots}`}
          detail="Concurrent runner capacity"
        />
        <StatTile
          label="Runs today"
          value={attempts === undefined ? "—" : String(summary.runsToday)}
          detail="Scale-set Attempts since midnight"
        />
      </div>

      <section
        className="overflow-hidden rounded-lg border border-white/[0.08] bg-[#0d0d0f]"
        aria-labelledby="profiles-heading"
      >
        <div className="flex flex-col gap-2 border-b border-white/[0.08] px-4 py-3.5 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 id="profiles-heading" className="text-sm font-medium text-zinc-200">
              Runner Profiles
            </h2>
            <p className="mt-1 text-xs leading-5 text-[#8a8a93]">
              Workflows target a Profile, never a machine. Compatible Workers discover and prewarm
              its immutable image automatically.
            </p>
          </div>
          <code className="rounded-md border border-white/[0.08] bg-[#09090a] px-2.5 py-1.5 text-xs text-emerald-300">
            runs-on: {profiles?.[0]?.name ?? "rc-linux-js"}
          </code>
        </div>
        <Table className="min-w-[900px]">
          <TableHeader>
            <TableRow>
              <TableHead>Profile / scale set</TableHead>
              <TableHead>Executor</TableHead>
              <TableHead>Resources</TableHead>
              <TableHead>Ready Workers</TableHead>
              <TableHead>Capacity</TableHead>
              <TableHead>Image Release</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {profiles === undefined ? (
              <TableRow>
                <TableCell colSpan={6} className="h-24 text-center text-[#8a8a93]">
                  Syncing Profiles…
                </TableCell>
              </TableRow>
            ) : profiles.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="h-28 text-center text-[#8a8a93]">
                  Start a scale-set controller to register its Profile.
                </TableCell>
              </TableRow>
            ) : (
              profiles.map((profile) => (
                <TableRow key={profile._id}>
                  <TableCell>
                    <code className="text-xs text-zinc-100">{profile.name}</code>
                    <p className="mt-0.5 text-[10px] text-[#7c7c85]">{profile.scaleSetName}</p>
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline" className="font-mono text-zinc-400">
                      {profile.executor}
                    </Badge>
                  </TableCell>
                  <TableCell className="tabular-nums text-xs text-zinc-300">
                    {profile.vcpus} vCPU · {formatMemory(profile.memoryMiB)}
                  </TableCell>
                  <TableCell className="tabular-nums text-xs text-zinc-300">
                    {profile.readyWorkers}
                  </TableCell>
                  <TableCell className="tabular-nums text-xs text-zinc-300">
                    {profile.freeSlots}/{profile.readySlots} free
                  </TableCell>
                  <TableCell>
                    <code
                      className="block max-w-[270px] truncate text-[10px] text-[#7c7c85]"
                      title={profile.imageRelease}
                    >
                      {profile.imageRelease}
                    </code>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </section>

      <details className="rounded-lg border border-white/[0.08] bg-[#0d0d0f] px-4 py-3.5">
        <summary className="cursor-pointer text-sm font-medium text-zinc-200">
          Legacy webhook runner migration
        </summary>
        <div className="mt-4 space-y-4">
          <AllowlistWarning />
          <GithubAppSetup />
        </div>
      </details>

      <InviteOperator />

      <section
        className="overflow-hidden rounded-lg border border-white/[0.08] bg-[#0d0d0f]"
        aria-labelledby="fleet-heading"
      >
        <div className="flex h-12 items-center justify-between border-b border-white/[0.08] px-4">
          <div className="flex items-center gap-2.5">
            <h2 id="fleet-heading" className="text-sm font-medium text-zinc-200">
              Registered fleet
            </h2>
            {machineCount !== undefined && (
              <span className="tabular-nums text-xs text-[#7c7c85]">{machineCount}</span>
            )}
          </div>
          <span className="flex items-center gap-2 text-xs text-[#8a8a93]">
            <span className="status-pulse size-1.5 rounded-full bg-emerald-400" />
            Live
          </span>
        </div>

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
              <TableRow>
                <TableCell colSpan={7} className="h-36 text-center text-[#8a8a93]">
                  Syncing fleet…
                </TableCell>
              </TableRow>
            ) : machines.length === 0 ? (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={7} className="h-64 text-center">
                  <div className="mx-auto flex max-w-xs flex-col items-center">
                    <div className="grid size-9 place-items-center rounded-md border border-white/[0.08] bg-white/[0.025] text-[#8a8a93]">
                      <Server className="size-4" />
                    </div>
                    <p className="mt-4 text-sm font-medium text-zinc-200">No machines registered</p>
                    <p className="mt-1 text-xs leading-5 text-[#8a8a93]">
                      Add a host to make capacity available to the scheduler.
                    </p>
                    <Button className="mt-4" size="sm" onClick={() => changeDialog(true)}>
                      <Plus />
                      Add machine
                    </Button>
                  </div>
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
                      <div className="font-medium text-zinc-100">{machine.name}</div>
                      {machine.arch && (
                        <div className="mt-0.5 text-[10px] text-[#7c7c85]">
                          {machine.arch}
                          {machine.cpus && ` · ${machine.cpus} CPU`}
                          {machine.memoryMiB && ` · ${formatMemory(machine.memoryMiB)}`}
                        </div>
                      )}
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline" className="font-mono text-zinc-400">
                        {formatOs(machine.os)}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <ProfileReadiness readiness={machine.readiness} />
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-3">
                        <span className="tabular-nums w-7 text-zinc-300">
                          {machine.usedSlots}/{machine.maxSlots}
                        </span>
                        <div
                          className="h-1 w-12 overflow-hidden rounded-full bg-white/[0.08]"
                          role="progressbar"
                          aria-label={`${machine.usedSlots} of ${machine.maxSlots} slots in use`}
                          aria-valuemin={0}
                          aria-valuemax={machine.maxSlots}
                          aria-valuenow={machine.usedSlots}
                        >
                          <div
                            className={`h-full rounded-full transition-[width] duration-150 ${
                              machine.usedSlots >= machine.maxSlots ? "bg-amber-400" : "bg-zinc-400"
                            }`}
                            style={{ width: `${slotPercent}%` }}
                          />
                        </div>
                      </div>
                      {machine.recommendedSlots !== undefined && (
                        <p className="mt-1 text-[10px] text-[#7c7c85]">
                          {machine.slotPolicy === "auto" ? "auto" : "fixed"} · recommended{" "}
                          {machine.recommendedSlots}
                        </p>
                      )}
                    </TableCell>
                    <TableCell>
                      <span
                        className="tabular-nums whitespace-nowrap text-zinc-400"
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
      </section>
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
    <div
      role="alert"
      className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg border border-red-400/20 bg-red-400/[0.07] px-4 py-3 text-xs leading-5 text-red-200"
    >
      <span className="inline-flex items-center gap-2 font-medium">
        <ShieldAlert className="size-4 shrink-0" aria-hidden="true" />
        No repositories are allowed yet
      </span>
      <span className="text-red-200/80">
        <code className="text-red-100">ALLOWED_REPOS</code> is unset, so every workflow job is
        rejected. Set it before installing the GitHub App.
      </span>
      <Link to="/jobs" className="ml-auto shrink-0 underline underline-offset-2 hover:text-red-100">
        See rejected deliveries
      </Link>
    </div>
  );
}

function PageHeading({ title, description }: { title: string; description: string }) {
  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-[-0.025em] text-zinc-50">{title}</h1>
      <p className="mt-1.5 text-sm text-[#8a8a93]">{description}</p>
    </div>
  );
}

function StatTile({
  label,
  value,
  detail,
  indicator,
}: {
  label: string;
  value: string;
  detail: string;
  indicator?: "online";
}) {
  return (
    <div className="rounded-lg border border-white/[0.08] bg-[#0d0d0f] px-4 py-3.5">
      <div className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-[0.08em] text-[#8a8a93]">
        {indicator === "online" && (
          <span className="status-pulse size-1.5 rounded-full bg-emerald-400" />
        )}
        {label}
      </div>
      <div className="mt-2 flex items-baseline justify-between gap-3">
        <span className="tabular-nums text-xl font-semibold tracking-tight text-zinc-100">
          {value}
        </span>
        <span className="truncate text-[11px] text-[#7c7c85]">{detail}</span>
      </div>
    </div>
  );
}

function MachineStatus({ online }: { online: boolean }) {
  return (
    <span
      className={`inline-flex items-center gap-2 ${online ? "text-emerald-300" : "text-[#8a8a93]"}`}
    >
      <span
        className={`size-1.5 rounded-full ${online ? "status-pulse bg-emerald-400" : "bg-zinc-500"}`}
        aria-hidden="true"
      />
      {online ? "Online" : "Offline"}
    </span>
  );
}

function ProfileReadiness({
  readiness,
}: {
  readiness: Array<{
    profile: string;
    state: "preparing" | "ready" | "failed";
    lastError?: string;
  }>;
}) {
  if (readiness.length === 0) return <span className="text-[#7c7c85]">Discovering…</span>;

  return (
    <div className="flex max-w-[240px] flex-wrap gap-1">
      {readiness.map((entry) => (
        <Badge
          key={entry.profile}
          variant="outline"
          className={
            entry.state === "ready"
              ? "font-mono text-emerald-300"
              : entry.state === "failed"
                ? "font-mono text-red-300"
                : "font-mono text-amber-300"
          }
          title={entry.lastError}
        >
          {entry.profile}
        </Badge>
      ))}
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
    return <span className="text-[#7c7c85]">—</span>;
  }

  return (
    <div className="space-y-1.5">
      {attempts.map((attempt) => (
        <div key={attempt._id} className="flex min-w-0 items-center gap-2 whitespace-nowrap">
          <span
            className={`size-1.5 shrink-0 rounded-full ${
              attempt.state === "running" ? "status-pulse bg-emerald-400" : "bg-amber-400"
            }`}
            aria-hidden="true"
          />
          <span className="max-w-40 truncate font-mono text-[12px] text-zinc-300">
            {attempt.profile}
          </span>
          <span className="text-xs text-[#7c7c85]">{attempt.state}</span>
        </div>
      ))}
      {experiments.map((experiment) => (
        <div key={experiment._id} className="flex min-w-0 items-center gap-2 whitespace-nowrap">
          <span
            className={`size-1.5 shrink-0 rounded-full ${
              experiment.state === "running" ? "status-pulse bg-sky-400" : "bg-amber-400"
            }`}
            aria-hidden="true"
          />
          <span className="max-w-40 truncate text-[12px] text-zinc-300">{experiment.name}</span>
          <span className="text-xs text-[#7c7c85]">experiment</span>
        </div>
      ))}
      {legacyJobs.map((job) => (
        <div key={job._id} className="flex min-w-0 items-center gap-2 whitespace-nowrap">
          <span
            className={`size-1.5 shrink-0 rounded-full ${
              job.status === "running" ? "status-pulse bg-emerald-400" : "bg-amber-400"
            }`}
            aria-hidden="true"
          />
          <span className="sr-only">{job.status}: </span>
          <span className="max-w-40 truncate font-mono text-[12px] text-zinc-300">{job.repo}</span>
          <span className="max-w-40 truncate text-xs text-[#7c7c85]">{job.workflowName}</span>
        </div>
      ))}
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
      // Clipboard blocked: the invitation stays selectable below.
    }
  }

  return (
    <details className="mt-3 rounded-md border border-white/[0.08] bg-white/[0.02] px-3 py-2.5 text-xs text-[#8a8a93]">
      <summary className="cursor-pointer select-none font-medium text-zinc-300">
        Invite another operator
      </summary>
      <p className="mt-3 leading-5">
        Sign-up is closed. An invitation is the only way to add an account after the first one. It
        is single-use, expires in ten minutes, and is shown here once — send it over a channel you
        trust.
      </p>

      {grant === undefined ? (
        <Button type="button" className="mt-3" disabled={pending} onClick={() => void generate()}>
          {pending ? "Please wait…" : "Create an invitation"}
          {!pending && <Plus />}
        </Button>
      ) : (
        <div className="relative mt-3 rounded-md border border-white/[0.08] bg-[#09090a] p-3 pr-11">
          <code className="block break-all font-mono text-xs leading-5 text-zinc-300">
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
      )}

      {grant !== undefined && (
        <p className="mt-2 leading-5">
          Expires {formatAbsoluteTime(grant.expiresAt)}. The recipient enters it on the sign-in page
          under “Accept an invitation”.
        </p>
      )}

      {error !== undefined && (
        <p role="alert" className="mt-2 leading-5 text-red-300">
          {error}
        </p>
      )}
    </details>
  );
}

function ErrorMessage({ children }: { children: ReactNode }) {
  return (
    <p
      role="alert"
      className="rounded-md border border-red-400/20 bg-red-400/[0.07] px-3 py-2 text-xs leading-5 text-red-300"
    >
      {children}
    </p>
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
