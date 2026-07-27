import { type ReactNode, useMemo, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery } from "convex/react";
import { Check, Clipboard, Plus, Server } from "lucide-react";
import { api } from "@convex/_generated/api";
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
import { formatAbsoluteTime, formatRelativeTime } from "@/lib/time";

export const Route = createFileRoute("/")({ component: MachinesPage });

type RegistrationCommand = {
  command: string;
  issuedAt: number;
  expiresAt: number;
  knownMachineIds: string[];
};

const REGISTRATION_TTL_MS = 15 * 60 * 1_000;

function convexSiteUrl() {
  return String(import.meta.env.VITE_CONVEX_URL).replace(
    /\.convex\.cloud\/?$/,
    ".convex.site",
  );
}

const SUPPORTED_RUNS_ON_LABELS = [
  {
    os: "Linux",
    labels: ["ubuntu-22.04", "ubuntu-24.04", "rc-linux"],
  },
  {
    os: "macOS",
    labels: ["macos-15", "macos-26", "rc-mac"],
  },
] as const;

function MachinesPage() {
  const machines = useQuery(api.machines.list);
  const jobs = useQuery(api.jobs.list);
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
      jobsToday:
        jobs?.filter((job) => job.queuedAt >= startOfToday.getTime()).length ?? 0,
    };
  }, [jobs, machines, now]);

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
        caught instanceof Error
          ? caught.message
          : "Could not create a registration command",
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
                Run one command on a macOS or Linux host. Runner Center installs,
                registers, and starts the agent for you.
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
                        Expires in {Math.max(0, Math.ceil((registration.expiresAt - now) / 60_000))} min
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
                          The machine is registered and will report online after its first heartbeat.
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
                        Append <code className="text-zinc-300">--name build-linux-01</code> to override the hostname.
                      </p>
                      <p>
                        Append <code className="text-zinc-300">--labels gpu,docker</code> for machine capability labels.
                      </p>
                      <p>
                        Append <code className="text-zinc-300">--slots 2</code> to override detected concurrency.
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
                <Button type="button" onClick={() => void beginRegistration()} disabled={submitting}>
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
          label="Jobs today"
          value={jobs === undefined ? "—" : String(summary.jobsToday)}
          detail="Queued since local midnight"
        />
      </div>

      <section
        className="rounded-lg border border-white/[0.08] bg-[#0d0d0f] px-4 py-3.5"
        aria-labelledby="runs-on-labels-heading"
      >
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <h2 id="runs-on-labels-heading" className="text-sm font-medium text-zinc-200">
              Supported runs-on labels
            </h2>
            <p className="mt-1 text-xs leading-5 text-[#8a8a93]">
              Image labels select the execution environment by host OS. Machines do not
              need to register these labels.
            </p>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row sm:gap-5">
            {SUPPORTED_RUNS_ON_LABELS.map((group) => (
              <div key={group.os} className="flex items-center gap-2">
                <span className="w-12 shrink-0 text-xs text-[#7c7c85]">{group.os}</span>
                <div className="flex flex-wrap gap-1">
                  {group.labels.map((label) => (
                    <Badge key={label} variant="outline" className="font-mono text-zinc-300">
                      {label}
                    </Badge>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="overflow-hidden rounded-lg border border-white/[0.08] bg-[#0d0d0f]" aria-labelledby="fleet-heading">
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
              <TableHead className="w-[210px]">Labels</TableHead>
              <TableHead className="w-[130px]">Slots</TableHead>
              <TableHead className="w-[112px]">Last seen</TableHead>
              <TableHead>Current jobs</TableHead>
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
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline" className="font-mono text-zinc-400">
                        {formatOs(machine.os)}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <LabelChips labels={machine.labels} />
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
                              machine.usedSlots >= machine.maxSlots
                                ? "bg-amber-400"
                                : "bg-zinc-400"
                            }`}
                            style={{ width: `${slotPercent}%` }}
                          />
                        </div>
                      </div>
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
                      <CurrentJobs jobs={machine.currentJobs} />
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
    <span className={`inline-flex items-center gap-2 ${online ? "text-emerald-300" : "text-[#8a8a93]"}`}>
      <span
        className={`size-1.5 rounded-full ${online ? "status-pulse bg-emerald-400" : "bg-zinc-500"}`}
        aria-hidden="true"
      />
      {online ? "Online" : "Offline"}
    </span>
  );
}

function LabelChips({ labels }: { labels: string[] }) {
  if (labels.length === 0) return <span className="text-[#7c7c85]">—</span>;

  return (
    <div className="flex max-w-[240px] flex-wrap gap-1">
      {labels.map((label, index) => (
        <Badge key={`${label}-${index}`} variant="outline" className="font-mono text-zinc-400">
          {label}
        </Badge>
      ))}
    </div>
  );
}

function CurrentJobs({
  jobs,
}: {
  jobs: Array<{
    _id: string;
    repo: string;
    workflowName: string;
    status: "assigned" | "running";
  }>;
}) {
  if (jobs.length === 0) return <span className="text-[#7c7c85]">—</span>;

  return (
    <div className="space-y-1.5">
      {jobs.map((job) => (
        <div key={job._id} className="flex min-w-0 items-center gap-2 whitespace-nowrap">
          <span
            className={`size-1.5 shrink-0 rounded-full ${
              job.status === "running"
                ? "status-pulse bg-emerald-400"
                : "bg-amber-400"
            }`}
            aria-hidden="true"
          />
          <span className="sr-only">{job.status}: </span>
          <span className="max-w-40 truncate font-mono text-[12px] text-zinc-300">
            {job.repo}
          </span>
          <span className="max-w-40 truncate text-xs text-[#7c7c85]">
            {job.workflowName}
          </span>
        </div>
      ))}
    </div>
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
  if (os === "win") return "win";
  return "linux";
}
