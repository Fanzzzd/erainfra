import { api } from "@erainfra/backend/api";
import { controllerLiveness, type ControllerLiveness } from "@erainfra/backend/controllerLiveness";
import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery } from "convex/react";
import {
  CheckIcon,
  ChevronRightIcon,
  CircleCheckIcon,
  CircleXIcon,
  PlusIcon,
  ServerIcon,
  ShieldAlertIcon,
  ShieldCheckIcon,
  UserPlusIcon,
} from "lucide-react";
import { type MouseEvent, type ReactNode, useId, useMemo, useState } from "react";

import { CodeBlock } from "@/components/code-block";
import { CopyButton, copyText } from "@/components/copy-button";
import { createDataTableColumns, DataTable } from "@/components/data-table";
import {
  DescriptionDetails,
  DescriptionList,
  DescriptionListItem,
  DescriptionTerm,
} from "@/components/description-list";
import {
  EmptyState,
  EmptyStateActions,
  EmptyStateDescription,
  EmptyStateMedia,
  EmptyStateTitle,
} from "@/components/empty-state";
import {
  PageHeader,
  PageHeaderActions,
  PageHeaderDescription,
  PageHeaderTitle,
} from "@/components/page-header";
import { Stat, StatGroup, StatHint, StatLabel, StatUnit, StatValue } from "@/components/stat";
import { LiveIndicator, Status, StatusDot, statusStates } from "@/components/status";
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
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { Progress } from "@/components/ui/progress";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { toast } from "@/components/ui/toast";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useNow } from "@/hooks/use-now";
import { convexSiteUrl } from "@/lib/convex-site";
import { describeProfileEgress, egressTooltip } from "@/lib/egress";
import { attemptView, experimentView, onlineView, type StateView } from "@/lib/states";
import { formatAbsoluteTime, formatRelativeTime } from "@/lib/time";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/")({ component: MachinesPage });

type RegistrationCommand = {
  commands: Record<InstallOs, string>;
  issuedAt: number;
  expiresAt: number;
  knownMachineIds: string[];
};

/**
 * Which installer body a Worker command is for. Not the same axis as the machine's OS: `posix`
 * covers Linux and macOS because one bash script onboards both, and `win` is the PowerShell body
 * `/install.ps1` serves, because Windows cannot run the other one.
 */
type InstallOs = "posix" | "win";

const INSTALL_OS_LABEL: Record<InstallOs, string> = {
  posix: "Linux or macOS",
  win: "Windows",
};

const INSTALL_OS_SHELL: Record<InstallOs, string> = {
  posix: "Shell",
  win: "PowerShell",
};

const INSTALL_OS_ORDER: readonly InstallOs[] = ["posix", "win"];

const REGISTRATION_TTL_MS = 15 * 60 * 1_000;

/**
 * The two kinds of machine this platform runs on (CONTEXT.md). One flow onboards both: the role is
 * a flag on the installer, not a different script, and both roles verify what they downloaded
 * against a checksum this deployment pins.
 */
type MachineRole = "worker" | "node";

type Machine = (typeof api.machines.list)["_returnType"][number];

// Long install commands wrap inside the code block instead of scrolling a narrow dialog sideways.
const WRAP_CODE = "[&_pre]:break-all [&_pre]:whitespace-pre-wrap";

function copyFailed() {
  toast.error("Clipboard access was blocked", {
    description: "Select the text above and copy it by hand.",
  });
}

function MachinesPage() {
  const machines = useQuery(api.machines.list);
  const attempts = useQuery(api.attempts.list);
  const profiles = useQuery(api.profiles.list);
  const activity = useQuery(api.profiles.activity);
  const controllers = useQuery(api.profiles.controllers);
  const createRegistrationToken = useMutation(api.machines.createRegistrationToken);
  const now = useNow();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [role, setRole] = useState<MachineRole>("worker");
  const [installOs, setInstallOs] = useState<InstallOs>("posix");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string>();
  const [registration, setRegistration] = useState<RegistrationCommand>();

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

  const fleetColumns = useMemo(() => buildFleetColumns(now), [now]);

  async function beginRegistration() {
    setSubmitting(true);
    setError(undefined);
    setRegistration(undefined);

    try {
      const result = await createRegistrationToken({});
      const siteUrl = convexSiteUrl();
      setRegistration({
        commands: {
          posix: `curl -fsSL ${siteUrl}/install | bash -s -- --token ${result.token}`,
          // -Role worker is explicit because /install.ps1 defaults to the Node role, which now
          // only refuses: Windows Nodes ran Hub mode, which retired (ADR 0020).
          win: `& ([scriptblock]::Create((irm ${siteUrl}/install.ps1))) -Role worker -Token ${result.token}`,
        },
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

  function changeDialog(open: boolean) {
    setDialogOpen(open);
    if (open) {
      if (role === "worker") void beginRegistration();
    } else {
      setRegistration(undefined);
      setError(undefined);
      setSubmitting(false);
    }
  }

  // A Node's credential comes from enrolling it on the Nodes page, so switching to that role
  // neither needs nor spends a registration token.
  function changeRole(next: MachineRole) {
    setRole(next);
    if (next === "worker" && registration === undefined && !submitting) {
      void beginRegistration();
    }
  }

  const machineCount = machines?.length;
  const expired = registration !== undefined && now >= registration.expiresAt;

  return (
    <>
      <PageHeader>
        <PageHeaderTitle>Machines</PageHeaderTitle>
        <PageHeaderDescription>
          Manage connected runner hosts, capacity, and active assignments.
        </PageHeaderDescription>
        <PageHeaderActions>
          <Dialog open={dialogOpen} onOpenChange={changeDialog}>
            <DialogTrigger render={<Button />}>
              <PlusIcon data-icon="inline-start" />
              Add machine
            </DialogTrigger>
            <DialogContent size="lg" className="gap-5">
              <DialogHeader>
                <DialogTitle>Add machine</DialogTitle>
                <DialogDescription>
                  Run one command on the new host. The installer verifies what it downloads against
                  a checksum this deployment pins, and refuses to install on a mismatch.
                </DialogDescription>
              </DialogHeader>

              {/* Each trigger's aria-controls names a panel, so both panels have to exist: a tab
                  list whose triggers point at nothing announces controls that are not there. */}
              <Tabs
                value={role}
                onValueChange={(value) => changeRole(value as MachineRole)}
                className="gap-4"
              >
                <TabsList variant="line" aria-label="Machine role" className="w-full border-b">
                  <TabsTrigger value="worker" className="flex-none">
                    Worker, runs CI jobs
                  </TabsTrigger>
                  <TabsTrigger value="node" className="flex-none">
                    Node, runs deployed Apps
                  </TabsTrigger>
                </TabsList>

                <TabsContent value="node">
                  <AddNodeInstructions />
                </TabsContent>

                <TabsContent value="worker" className="flex flex-col gap-4">
                  {submitting && (
                    <div
                      role="status"
                      className="flex items-center gap-3 rounded-lg border bg-subtle px-4 py-5 text-muted-foreground"
                    >
                      <Spinner />
                      Creating a short-lived registration command…
                    </div>
                  )}

                  {registration && (
                    <>
                      {/* One registration token, two installer bodies. The token is the same
                          either way, so switching here re-renders the command and never spends a
                          second token. */}
                      <Tabs
                        value={installOs}
                        onValueChange={(value) => setInstallOs(value as InstallOs)}
                        className="gap-2"
                      >
                        <div className="flex items-center justify-between gap-3">
                          <span className="font-medium">Host</span>
                          <span className="text-xs text-warning">
                            Expires in{" "}
                            {Math.max(0, Math.ceil((registration.expiresAt - now) / 60_000))} min
                          </span>
                        </div>
                        <TabsList aria-label="Host operating system" className="w-full">
                          {INSTALL_OS_ORDER.map((value) => (
                            <TabsTrigger key={value} value={value}>
                              {INSTALL_OS_LABEL[value]}
                            </TabsTrigger>
                          ))}
                        </TabsList>
                        {INSTALL_OS_ORDER.map((value) => (
                          <TabsContent key={value} value={value}>
                            <CodeBlock
                              title={`${INSTALL_OS_SHELL[value]}, run on the new machine`}
                              code={registration.commands[value]}
                              className={WRAP_CODE}
                            />
                          </TabsContent>
                        ))}
                      </Tabs>
                      <div className="-mt-2 flex flex-col gap-2 text-xs text-muted-foreground">
                        <p>The registration token expires in 15 minutes and can be used once.</p>
                        {installOs === "win" && (
                          <p>
                            The installer registers a Scheduled Task for the installing account, at
                            logon. A Windows Worker is scheduled onto once readiness proves the
                            Hyper-V module, the VM switch, a parent VHDX under
                            %USERPROFILE%\.runner-center\images and its credential file.
                          </p>
                        )}
                      </div>

                      {connectedMachine ? (
                        <Alert className="text-success">
                          <CheckIcon />
                          <AlertTitle>{connectedMachine.name} connected</AlertTitle>
                          <AlertDescription>
                            The machine is registered and will report online after its first
                            heartbeat.
                          </AlertDescription>
                        </Alert>
                      ) : expired ? (
                        <Alert className="text-warning">
                          <AlertTitle>This command has expired</AlertTitle>
                          <AlertDescription>
                            Generate a new command before installing.
                          </AlertDescription>
                        </Alert>
                      ) : (
                        <div role="status" className="rounded-lg border bg-subtle p-3">
                          <LiveIndicator className="text-sm">Waiting for machine…</LiveIndicator>
                        </div>
                      )}

                      <details className="rounded-lg border bg-subtle px-3 py-2.5 text-xs text-muted-foreground">
                        <summary className="cursor-pointer font-medium text-foreground select-none">
                          Advanced options
                        </summary>
                        <div className="mt-3 flex flex-col gap-2">
                          <p>
                            Append{" "}
                            <code className="text-foreground">
                              {installOs === "win" ? "-Name build-win-01" : "--name build-linux-01"}
                            </code>{" "}
                            to override the hostname.
                          </p>
                          <p>
                            Append{" "}
                            <code className="text-foreground">
                              {installOs === "win" ? "-Labels gpu,hyperv" : "--labels gpu,docker"}
                            </code>{" "}
                            for host labels, which pin Profiles to this Worker.
                          </p>
                          <p>
                            Append{" "}
                            <code className="text-foreground">
                              {installOs === "win" ? "-Slots 2" : "--slots 2"}
                            </code>{" "}
                            to override detected concurrency.
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
                </TabsContent>
              </Tabs>

              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => changeDialog(false)}>
                  {connectedMachine && role === "worker" ? "Done" : "Cancel"}
                </Button>
                {role === "worker" && (error || expired) && (
                  <Button
                    type="button"
                    onClick={() => void beginRegistration()}
                    disabled={submitting}
                  >
                    Generate new command
                  </Button>
                )}
                {role === "worker" && registration && !connectedMachine && !expired && (
                  <CopyButton
                    variant="default"
                    size="default"
                    value={registration.commands[installOs]}
                    onCopy={(ok) => {
                      if (ok) toast.success("Command copied");
                      else copyFailed();
                    }}
                  >
                    Copy the {INSTALL_OS_LABEL[installOs]} command
                  </CopyButton>
                )}
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </PageHeaderActions>
      </PageHeader>

      <StatGroup className="@5xl:grid-cols-3">
        <Stat>
          <StatLabel>Machines online</StatLabel>
          <StatValue>
            {machines === undefined ? (
              <Skeleton className="my-1 h-6 w-16" />
            ) : (
              <>
                {summary.online}
                <StatUnit>/{summary.totalMachines}</StatUnit>
              </>
            )}
          </StatValue>
          <StatHint>
            {machines === undefined
              ? "Loading fleet"
              : `${summary.totalMachines} registered ${summary.totalMachines === 1 ? "host" : "hosts"}`}
          </StatHint>
        </Stat>
        <Stat>
          <StatLabel>Slots in use</StatLabel>
          <StatValue>
            {machines === undefined ? (
              <Skeleton className="my-1 h-6 w-16" />
            ) : (
              <>
                {summary.usedSlots}
                <StatUnit>/{summary.totalSlots}</StatUnit>
              </>
            )}
          </StatValue>
          <StatHint>Concurrent runner capacity</StatHint>
        </Stat>
        <Stat>
          <StatLabel>Runs today</StatLabel>
          <StatValue>
            {attempts === undefined ? <Skeleton className="my-1 h-6 w-16" /> : summary.runsToday}
          </StatValue>
          <StatHint>Scale-set Attempts since midnight</StatHint>
        </Stat>
      </StatGroup>

      <Card className="gap-0 py-0">
        <CardHeader className="border-b py-4">
          <CardTitle render={<h2 />}>Runner Profiles</CardTitle>
          <CardDescription>
            Workflows target a Profile, never a machine. Compatible Workers discover and prewarm its
            immutable image automatically.
          </CardDescription>
          <p className="mt-1 hidden sm:block">
            <code className="rounded-md border bg-subtle px-2 py-1 text-xs whitespace-nowrap">
              runs-on: {profiles?.[0]?.name ?? "erainfra-4vcpu-ubuntu-2404"}
            </code>
          </p>
        </CardHeader>
        <Table aria-label="Runner Profiles" className="min-w-[960px] text-[13px]">
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className="w-[250px] pl-4">Profile and scale set</TableHead>
              <TableHead className="w-[190px]">Controller</TableHead>
              <TableHead className="w-[200px]">Isolation boundary</TableHead>
              <TableHead className="w-[200px]">Resources and image</TableHead>
              <TableHead className="w-[150px]">Capacity</TableHead>
              <TableHead className="pr-4">Last job</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {profiles === undefined ? (
              Array.from({ length: 2 }, (_unused, row) => (
                <TableRow key={`loading-${row}`} className="hover:bg-transparent">
                  {Array.from({ length: 6 }, (_alsoUnused, cell) => (
                    <TableCell key={cell} className={cn(cell === 0 && "pl-4")}>
                      <Skeleton className={cn("h-4", cell === 0 ? "w-32" : "w-full max-w-24")} />
                    </TableCell>
                  ))}
                </TableRow>
              ))
            ) : profiles.length === 0 ? (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={6} className="p-0 whitespace-normal">
                  <EmptyState>
                    <EmptyStateMedia>
                      <ShieldCheckIcon />
                    </EmptyStateMedia>
                    <EmptyStateTitle>No Profiles registered</EmptyStateTitle>
                    <EmptyStateDescription>
                      Start a scale-set controller to register its Profile and the isolation
                      boundary it can promise.
                    </EmptyStateDescription>
                  </EmptyState>
                </TableCell>
              </TableRow>
            ) : (
              profiles.map((profile) => (
                <ProfileRow
                  key={profile._id}
                  profile={profile}
                  activity={activity?.find((entry) => entry.name === profile.name)}
                  controller={
                    controllers === undefined
                      ? undefined
                      : controllerLiveness(
                          controllers.filter((row) => row.profile === profile.name),
                          now,
                        )
                  }
                  now={now}
                />
              ))
            )}
          </TableBody>
        </Table>
      </Card>

      <Card className="gap-0 py-0">
        <CardHeader className="border-b py-4">
          <CardTitle render={<h2 />} className="flex items-center gap-2">
            Registered fleet
            {machineCount !== undefined && (
              <Badge variant="neutral" className="rounded-full">
                {machineCount}
              </Badge>
            )}
          </CardTitle>
          <CardDescription>
            Every host that holds a machine credential, and what it is running right now.
          </CardDescription>
          <CardAction>
            <LiveIndicator />
          </CardAction>
        </CardHeader>

        {machines !== undefined && machines.length > 0 && (
          <ul aria-label="Registered fleet" className="divide-y md:hidden">
            {machines.map((machine) => (
              <MachineListItem key={machine._id} machine={machine} now={now} />
            ))}
          </ul>
        )}
        <div className={cn(machines !== undefined && machines.length > 0 && "hidden md:block")}>
          <DataTable
            aria-label="Registered fleet"
            className="min-w-[860px] text-[13px]"
            columns={fleetColumns}
            data={machines ?? []}
            loading={machines === undefined}
            loadingRows={3}
            getRowId={(machine) => machine._id}
            rowActions={machineActions}
            empty={
              <EmptyState>
                <EmptyStateMedia>
                  <ServerIcon />
                </EmptyStateMedia>
                <EmptyStateTitle>No machines registered</EmptyStateTitle>
                <EmptyStateDescription>
                  Add a host to make capacity available to the scheduler.
                </EmptyStateDescription>
                <EmptyStateActions>
                  <Button size="sm" onClick={() => changeDialog(true)}>
                    <PlusIcon data-icon="inline-start" />
                    Add machine
                  </Button>
                </EmptyStateActions>
              </EmptyState>
            }
          />
        </div>
      </Card>

      <InviteOperator />
    </>
  );
}

const machineColumn = createDataTableColumns<Machine>();

/** The fleet columns. Liveness and "last seen" read the page clock, so they rebuild with it. */
function buildFleetColumns(now: number) {
  return machineColumn.columns([
    machineColumn.accessor("name", {
      header: "Machine",
      meta: { headerClassName: "w-[240px] pl-4", cellClassName: "pl-4" },
      cell: (cell) => {
        const machine = cell.row.original;
        const online = isMachineOnline(machine.lastSeen, now);
        return (
          <div>
            <span className="flex items-center gap-2 font-medium">
              <MachineStatus online={online} label={false} />
              {machine.name}
              <span className="sr-only">, {online ? "online" : "offline"}</span>
            </span>
            <div className="mt-0.5 pl-4 text-xs text-muted-foreground">
              {formatOs(machine.os)}
              {machine.arch && `, ${hardwareLine(machine)}`}
            </div>
          </div>
        );
      },
    }),
    machineColumn.display({
      id: "readiness",
      header: "Ready Profiles",
      meta: { headerClassName: "w-[220px]" },
      cell: (cell) => <ProfileReadiness readiness={cell.row.original.readiness} />,
    }),
    machineColumn.accessor("usedSlots", {
      header: "Slots",
      meta: { headerClassName: "w-[150px]" },
      cell: (cell) => <MachineSlots machine={cell.row.original} />,
    }),
    machineColumn.accessor("lastSeen", {
      header: "Last seen",
      meta: { headerClassName: "w-[110px]" },
      cell: (cell) => <LastSeen lastSeen={cell.getValue()} now={now} />,
    }),
    machineColumn.display({
      id: "active",
      header: "Active runs",
      cell: (cell) => (
        <ActiveRuns
          attempts={cell.row.original.currentAttempts}
          experiments={cell.row.original.currentExperiments}
        />
      ),
    }),
  ]);
}

async function copyMachineName(name: string) {
  if (await copyText(name)) toast.success("Machine name copied", { description: name });
  else copyFailed();
}

/** Module-level, so the menu items are not a new component on each render. */
const machineActions = {
  label: (machine: Machine) => `Actions for ${machine.name}`,
  items: (machine: Machine) => (
    <DropdownMenuItem onClick={() => void copyMachineName(machine.name)}>
      Copy machine name
    </DropdownMenuItem>
  ),
};

/** One machine as a stacked row, for screens too narrow for the fleet table. */
function MachineListItem({ machine, now }: { machine: Machine; now: number }) {
  const online = isMachineOnline(machine.lastSeen, now);
  return (
    <li className="flex flex-col gap-2 px-4 py-3 text-[13px]">
      <div className="flex items-center justify-between gap-3">
        <span className="flex min-w-0 items-center gap-2">
          <MachineStatus online={online} label={false} />
          <span className="truncate font-medium">{machine.name}</span>
          <span className="sr-only">, {online ? "online" : "offline"}</span>
        </span>
        <LastSeen lastSeen={machine.lastSeen} now={now} />
      </div>
      <div className="text-xs text-muted-foreground">
        {formatOs(machine.os)}
        {machine.arch && `, ${hardwareLine(machine)}`}
      </div>
      <MachineSlots machine={machine} compact />
      <ProfileReadiness readiness={machine.readiness} />
      <ActiveRuns attempts={machine.currentAttempts} experiments={machine.currentExperiments} />
    </li>
  );
}

function hardwareLine(machine: Machine) {
  return [
    machine.arch,
    machine.cpus ? `${machine.cpus} CPU` : undefined,
    machine.memoryMiB ? formatMemory(machine.memoryMiB) : undefined,
  ]
    .filter((part) => part !== undefined)
    .join(", ");
}

function LastSeen({ lastSeen, now }: { lastSeen: number; now: number }) {
  return (
    <span
      className="whitespace-nowrap text-muted-foreground tabular-nums"
      title={lastSeen > 0 ? formatAbsoluteTime(lastSeen) : "No heartbeat received"}
    >
      {formatRelativeTime(lastSeen, now)}
    </span>
  );
}

function MachineSlots({ machine, compact = false }: { machine: Machine; compact?: boolean }) {
  const full = machine.usedSlots >= machine.maxSlots;
  return (
    <div>
      <div className="flex items-center gap-2.5">
        <Progress
          value={Math.min(machine.usedSlots, machine.maxSlots)}
          max={Math.max(1, machine.maxSlots)}
          tone={full ? "warning" : "default"}
          aria-label={`${machine.usedSlots} of ${machine.maxSlots} slots in use`}
          className="w-12 shrink-0"
        />
        <span className="tabular-nums">
          {machine.usedSlots}/{machine.maxSlots}
          {compact && " slots"}
        </span>
      </div>
      {!compact && machine.recommendedSlots !== undefined && (
        <p className="mt-1 max-w-52 text-xs whitespace-normal text-muted-foreground">
          {machine.slotPolicy === "fixed" ? "fixed" : "auto"}, configured{" "}
          {machine.configuredSlots ?? "auto"}, resource{" "}
          {machine.resourceRecommendedSlots ?? machine.recommendedSlots}, recommended{" "}
          {machine.recommendedSlots}, effective {machine.maxSlots}
        </p>
      )}
      {!compact && machine.benchmark && (
        <p
          className="mt-1 text-xs text-muted-foreground"
          title={`CPU ${machine.benchmark.cpuSha256MiBps?.toFixed(0) ?? "n/a"} MiB/s · memory ${machine.benchmark.memoryCopyMiBps?.toFixed(0) ?? "n/a"} MiB/s · disk ${machine.benchmark.diskWriteMiBps?.toFixed(0) ?? "n/a"}/${machine.benchmark.diskReadMiBps?.toFixed(0) ?? "n/a"} MiB/s · fsync ${machine.benchmark.diskFsyncLatencyMs?.toFixed(1) ?? "n/a"} ms · package-link ${machine.benchmark.packageLinkOpsPerSec?.toFixed(0) ?? "n/a"} files/s · ${machine.benchmark.network.map((observation) => `${observation.target} ${observation.ttfbMs?.toFixed(0) ?? "n/a"} ms/${observation.throughputMbps?.toFixed(1) ?? "n/a"} Mbps`).join(" · ")} · measured ${formatAbsoluteTime(machine.benchmark.measuredAt)} · ${machine.benchmark.confidence}${machine.benchmark.errors.length > 0 ? ` · ${machine.benchmark.errors.join("; ")}` : ""}`}
        >
          benchmark {machine.benchmark.scores.balanced}/100, CPU {machine.benchmark.scores.cpu}, I/O{" "}
          {machine.benchmark.scores.disk}, net {machine.benchmark.scores.network}
        </p>
      )}
    </div>
  );
}

/**
 * Onboarding a Node, in the same dialog as onboarding a Worker. A Node runs the Infra Agent in
 * Convex mode (`connect-convex`), which needs Linux with systemd, and authenticates with a
 * credential issued when it is enrolled on the Nodes page, so there is no token to mint here.
 */
function AddNodeInstructions() {
  const site = convexSiteUrl();
  const command = `curl -fsSL ${site}/install | sudo bash -s -- --role node --credential-file /root/node.credential`;

  return (
    <div className="flex flex-col gap-4">
      <p className="text-muted-foreground">
        Enroll the Node on the Nodes page first, then save its credential on the Node in a file only
        root can read (<code className="text-foreground">chmod 600</code>). On the Node, which must
        run Linux with systemd:
      </p>
      <CodeBlock title="Shell, run on the Node" code={command} className={WRAP_CODE} />

      <p className="text-xs text-muted-foreground">
        This deployment serves the installer and the checksum; the binary itself comes from the
        release, and the install stops if the two disagree. The installer copies the credential to
        <code className="text-foreground"> /etc/erainfra-node.credential</code>; delete the file you
        saved afterwards.
      </p>

      <details className="rounded-lg border bg-subtle px-3 py-2.5 text-xs text-muted-foreground">
        <summary className="cursor-pointer font-medium text-foreground select-none">
          Air-gapped
        </summary>
        <div className="mt-3 flex flex-col gap-2">
          <p>
            Append <code className="text-foreground">--source file:///path/to/infra-agent</code> to
            take the bytes off local disk instead of the release.
          </p>
          <p>
            Verification is identical either way: the digest arrives with this script over TLS from
            this deployment, so where the bytes come from does not have to be trusted.
          </p>
          <p>
            Append <code className="text-foreground">--no-docker</code> to skip the
            container-runtime install.
          </p>
        </div>
      </details>
    </div>
  );
}

function MachineStatus({ online, label = true }: { online: boolean; label?: boolean }) {
  const view = onlineView(online);
  if (label) return <Status state={view.state}>{view.label}</Status>;
  const def = statusStates[view.state];
  return <StatusDot tone={def.tone} hollow={"hollow" in def && def.hollow} />;
}

type Readiness = Machine["readiness"][number];

const READINESS_BADGE = {
  ready: "success",
  failed: "danger",
  degraded: "warning",
  preparing: "warning",
} as const satisfies Record<Readiness["state"], "success" | "danger" | "warning">;

function ProfileReadiness({ readiness }: { readiness: Readiness[] }) {
  if (readiness.length === 0) return <span className="text-muted-foreground">Discovering…</span>;

  return (
    <div className="flex max-w-[260px] flex-wrap gap-1">
      {readiness.map((entry) => {
        const badge = (
          <Badge variant={READINESS_BADGE[entry.state]} className="font-mono">
            {entry.profile}
          </Badge>
        );

        const detail = entry.lastError || entry.statusDetail;
        if (detail === undefined || detail === "") return <div key={entry.profile}>{badge}</div>;

        return (
          // The detail also shows in the Worker row under the expanded Profile, so this trigger
          // stays out of the tab order; the group name and the tooltip still reach a screen reader.
          <Tooltip key={entry.profile}>
            <TooltipTrigger
              render={<div role="group" aria-label={`${entry.profile}, ${entry.state}`} />}
            >
              {badge}
            </TooltipTrigger>
            <TooltipContent>{detail}</TooltipContent>
          </Tooltip>
        );
      })}
    </div>
  );
}

/** A state, with the dashboard's label, followed by what it belongs to. */
function StateLine({ view, children }: { view: StateView; children: ReactNode }) {
  return (
    <Status state={view.state} className="min-w-0 text-xs">
      {children}
      <span className="text-muted-foreground">{view.label ?? statusStates[view.state].label}</span>
    </Status>
  );
}

function ActiveRuns({
  attempts,
  experiments,
}: {
  attempts: Machine["currentAttempts"];
  experiments: Machine["currentExperiments"];
}) {
  if (attempts.length === 0 && experiments.length === 0) {
    return <span className="text-muted-foreground">None</span>;
  }

  return (
    <div className="flex flex-col gap-1.5">
      {attempts.map((attempt) => (
        <StateLine key={attempt._id} view={attemptView(attempt.state)}>
          <span className="max-w-44 truncate font-mono text-foreground">{attempt.profile}</span>
        </StateLine>
      ))}
      {experiments.map((experiment) => (
        <StateLine
          key={experiment._id}
          view={{ ...experimentView(experiment.state), label: "experiment" }}
        >
          <span className="max-w-44 truncate text-foreground">{experiment.name}</span>
        </StateLine>
      ))}
    </div>
  );
}

type ProfileSummary = (typeof api.profiles.list)["_returnType"][number];
type ProfileActivity = (typeof api.profiles.activity)["_returnType"][number];

// A Profile that served a job this week is in use. One that did not, while it
// has ready Workers, is capacity nobody is sending work to: a consumer that
// moved to hosted during a rollout and was never moved back (#138).
const ACTIVITY_WINDOW_MS = 7 * 24 * 60 * 60_000;

const BOUNDARY_COPY = {
  "guest-kernel": {
    label: "guest kernel",
    tooltip: "Each Job boots its own guest kernel. Safe for untrusted pull request code.",
  },
  "shared-kernel": {
    label: "shared kernel",
    tooltip:
      "Every Job shares this host's kernel and Docker daemon. Trusted repositories only: one Job's kernel exploit is every other Job's problem.",
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
function ProfileRow({
  profile,
  activity,
  controller,
  now,
}: {
  profile: ProfileSummary;
  activity: ProfileActivity | undefined;
  controller: ControllerLiveness | undefined;
  now: number;
}) {
  const [expanded, setExpanded] = useState(false);
  const panelId = useId();
  const guestKernel = profile.boundary === "guest-kernel";
  const boundary = BOUNDARY_COPY[profile.boundary];
  const unhealthy = profile.workers.filter((worker) => worker.state !== "ready");
  const lastJob = activity?.lastJob;
  const idle =
    profile.readyWorkers > 0 &&
    activity !== undefined &&
    (lastJob === undefined || now - lastJob.at > ACTIVITY_WINDOW_MS);

  return (
    <>
      <TableRow
        className="cursor-pointer align-top"
        data-state={expanded ? "selected" : undefined}
        onClick={() => setExpanded((open) => !open)}
      >
        <TableCell className="pl-4">
          <div className="flex items-start gap-2">
            <Button
              variant="ghost"
              size="icon-xs"
              aria-expanded={expanded}
              aria-controls={panelId}
              className="-ml-1 text-muted-foreground"
              onClick={(event) => {
                event.stopPropagation();
                setExpanded((open) => !open);
              }}
            >
              <ChevronRightIcon
                aria-hidden="true"
                className={cn("transition-transform", expanded && "rotate-90")}
              />
              <span className="sr-only">
                {expanded ? "Hide" : "Show"} Worker readiness for {profile.name}
              </span>
            </Button>
            <div className="min-w-0">
              <div className="font-medium">{profile.name}</div>
              <p className="mt-0.5 text-xs text-muted-foreground">{profile.scaleSetName}</p>
            </div>
          </div>
        </TableCell>
        <TableCell>
          <ControllerStatus liveness={controller} paused={profile.state === "paused"} now={now} />
        </TableCell>
        <TableCell>
          {/* A button, so the keyboard reaches the explanation, which shows nowhere else. */}
          <Tooltip>
            <TooltipTrigger
              className="rounded-sm"
              onClick={(event: MouseEvent) => event.stopPropagation()}
            >
              <Badge variant={guestKernel ? "success" : "warning"}>
                {guestKernel ? (
                  <ShieldCheckIcon aria-hidden="true" />
                ) : (
                  <ShieldAlertIcon aria-hidden="true" />
                )}
                {boundary.label}
              </Badge>
            </TooltipTrigger>
            <TooltipContent>{boundary.tooltip}</TooltipContent>
          </Tooltip>
          <p className="mt-1 font-mono text-xs text-muted-foreground">
            {profile.executor}
            {profile.trustedOnly && ", trusted only"}
          </p>
          <p
            className={cn(
              "mt-0.5 font-mono text-xs",
              profile.egress.mode === "public" ? "text-muted-foreground" : "text-foreground",
            )}
            title={egressTooltip(profile.egress)}
          >
            {describeProfileEgress(profile.egress)}
          </p>
          {profile.workerLabels.length > 0 && (
            <p
              className="mt-0.5 font-mono text-xs text-foreground"
              title="Only Workers carrying every one of these host labels serve this Profile"
            >
              pinned to {profile.workerLabels.join(", ")}
            </p>
          )}
          {profile.labelConflicts.length > 0 && (
            <p className="mt-0.5 text-xs text-warning" title={profile.labelConflicts.join("\n")}>
              scale-set labels overlap another Profile
            </p>
          )}
        </TableCell>
        <TableCell className="tabular-nums">
          {profile.vcpus} vCPU, {formatMemory(profile.memoryMiB)}
          {profile.warmPool > 0 && `, ${profile.warmPool} warm`}
          <p className="mt-0.5 text-xs text-muted-foreground">{profile.fitPolicy} benchmark fit</p>
          <p
            className="mt-0.5 max-w-[220px] truncate font-mono text-xs text-muted-foreground"
            title={`Image Release ${profile.imageRelease}`}
          >
            {profile.imageRelease}
          </p>
        </TableCell>
        <TableCell className="tabular-nums">
          {profile.freeSlots}/{profile.readySlots} free
          <p className="mt-0.5 text-xs text-muted-foreground">
            {profile.readyWorkers} ready {profile.readyWorkers === 1 ? "Worker" : "Workers"}
            {unhealthy.length > 0 && (
              <span className="text-warning">, {unhealthy.length} not ready</span>
            )}
          </p>
        </TableCell>
        <TableCell className="pr-4">
          {activity === undefined ? (
            <Skeleton className="h-4 w-28" />
          ) : lastJob === undefined ? (
            <span className={cn("text-muted-foreground", idle && "text-warning")}>
              No job started here yet
            </span>
          ) : (
            <>
              <span
                className="block max-w-[200px] truncate font-mono text-xs"
                title={lastJob.displayName ?? lastJob.repo}
              >
                {lastJob.repo}
              </span>
              <p
                className={cn(
                  "mt-0.5 text-xs text-muted-foreground tabular-nums",
                  idle && "text-warning",
                )}
              >
                {formatRelativeTime(lastJob.at, now)}, {activity.jobsInWindow}
                {activity.sampleExhausted && "+"} in 7 d
              </p>
            </>
          )}
        </TableCell>
      </TableRow>
      {expanded && (
        <TableRow className="hover:bg-transparent">
          <TableCell colSpan={6} id={panelId} className="bg-subtle px-4 py-3.5 whitespace-normal">
            {profile.workers.length === 0 ? (
              <p className="text-muted-foreground">
                No Worker has reported readiness for this Profile yet.
              </p>
            ) : (
              <div className="flex flex-col gap-2.5">
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

const SESSION_COPY = {
  starting: "starting",
  standby: "standing by for the lease",
  listening: "listening",
  conflict: "refused the session (another one exists)",
  stopped: "stopped",
} as const;

/** Which credential the controller reported with: a dedicated host's token, or its Worker's. */
const TOKEN_SLOT_COPY = {
  current: "CONTROLLER_TOKEN",
  next: "CONTROLLER_TOKEN_NEXT",
  machine: "Worker credential",
} as const;

/** A controller's liveness in the registry's state map. A dead controller is a fault. */
const CONTROLLER_VIEW: Record<"online" | "waiting" | "offline", StateView> = {
  online: { state: "online" },
  waiting: { state: "connecting", label: "Waiting for session" },
  offline: { state: "unhealthy", label: "Offline" },
};

/**
 * Whether anything is listening for the Profile's jobs. A dead controller creates no Attempts, so
 * without this column it reads exactly like an idle Profile. Status is computed here against the
 * page clock, not in the query: a controller that died writes nothing, so a reactive query would
 * never notice.
 */
function ControllerStatus({
  liveness,
  paused,
  now,
}: {
  liveness: ControllerLiveness | undefined;
  paused: boolean;
  now: number;
}) {
  if (liveness === undefined) return <Skeleton className="h-4 w-24" />;
  if (liveness.status === "unknown") {
    return (
      <Tooltip>
        <TooltipTrigger
          className="rounded-sm text-muted-foreground"
          onClick={(event: MouseEvent) => event.stopPropagation()}
        >
          Not reporting
        </TooltipTrigger>
        <TooltipContent>
          No controller has ever reported a heartbeat for this Profile. Controllers built before the
          heartbeat do not send one; liveness is tracked from the first report on.
        </TooltipContent>
      </Tooltip>
    );
  }
  const base = CONTROLLER_VIEW[liveness.status];
  // A retired Profile's controller is meant to be stopped, so it reads as quiet, not as a fault.
  const view: StateView =
    paused && liveness.status !== "online"
      ? { state: "offline", label: base.label ?? statusStates[base.state].label }
      : base;
  const primary = liveness.primary;
  const lastHeartbeatAt = liveness.lastHeartbeatAt;
  const detail =
    liveness.status === "online" && primary?.lastMessageAt !== undefined
      ? `GitHub answered ${formatRelativeTime(primary.lastMessageAt, now)}`
      : lastHeartbeatAt === undefined
        ? undefined
        : `reported ${formatRelativeTime(lastHeartbeatAt, now)}`;
  return (
    <Tooltip>
      {/* A button, so the keyboard reaches the job counts and controller rows in the tooltip. */}
      <TooltipTrigger
        className="block max-w-full min-w-0 rounded-sm text-left"
        onClick={(event: MouseEvent) => event.stopPropagation()}
      >
        <Status state={view.state}>{view.label}</Status>
        {primary !== undefined && (
          <span className="mt-0.5 block truncate font-mono text-xs text-muted-foreground">
            {primary.hostname}, {primary.version}
          </span>
        )}
        {detail !== undefined && (
          <span className="mt-0.5 block text-xs text-muted-foreground tabular-nums">{detail}</span>
        )}
      </TooltipTrigger>
      <TooltipContent className="flex max-w-sm flex-col items-start gap-1">
        {liveness.primary?.lastError !== undefined && (
          <p className="break-words">{liveness.primary.lastError}</p>
        )}
        <p>
          GitHub counts {primary?.assignedJobs ?? 0} assigned and {primary?.runningJobs ?? 0}{" "}
          running jobs.
        </p>
        {liveness.controllers.map((row) => (
          <p key={row.hostname} className="font-mono">
            {row.hostname} · {row.version} · {SESSION_COPY[row.sessionState]} ·{" "}
            {TOKEN_SLOT_COPY[row.tokenSlot]} ·{" "}
            {row.leaseRole === "holder" && row.leaseEpoch !== undefined
              ? `lease epoch ${row.leaseEpoch} · `
              : ""}
            {formatRelativeTime(row.receivedAt, now)}
          </p>
        ))}
      </TooltipContent>
    </Tooltip>
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
  // Evidence from a runtime that predates Profile egress carries none.
  const egress = network?.egress;
  if (egress !== undefined) {
    facts.push({
      label: "Egress",
      value:
        `${egress.mode} for this Profile (Profile ${egress.profileMode}, host ${egress.hostMode})` +
        (egress.allowedDomainCount > 0 ? ` · ${egress.allowedDomainCount} allowed domains` : ""),
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

const WORKER_BADGE = {
  ready: "success",
  failed: "danger",
} as const;

/**
 * The evidence layer under a Profile: what this Worker proved, then the host
 * facts it measured. Checks come first and stay legible on their own: a named
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
  const badge =
    worker.state === "ready" || worker.state === "failed" ? WORKER_BADGE[worker.state] : "warning";

  return (
    <Card size="sm" className="gap-0 py-3 @container">
      <CardContent>
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-xs font-medium">{worker.machineName}</span>
          <Badge variant={badge}>{worker.state}</Badge>
          {!worker.online && <Badge variant="outline">offline</Badge>}
          <span className="ml-auto text-xs text-muted-foreground tabular-nums">
            {worker.usedSlots}/{worker.maxSlots} slots used
          </span>
        </div>

        <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
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
                  <CircleCheckIcon
                    className="mt-0.5 size-3.5 shrink-0 text-success"
                    aria-hidden="true"
                  />
                ) : (
                  <CircleXIcon
                    className="mt-0.5 size-3.5 shrink-0 text-destructive"
                    aria-hidden="true"
                  />
                )}
                <span className="min-w-0">
                  <span className="sr-only">{check.passed ? "Passed: " : "Failed: "}</span>
                  <span
                    className={cn(
                      "font-mono text-xs",
                      check.passed ? "text-foreground" : "text-destructive",
                    )}
                  >
                    {check.name}
                  </span>
                  {check.detail !== undefined && check.detail !== "" && (
                    <span className="block text-xs break-words text-muted-foreground">
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
            <DescriptionList layout="grid" className="text-xs">
              {facts.map((fact) => (
                <DescriptionListItem key={fact.label}>
                  <DescriptionTerm className="font-medium">{fact.label}</DescriptionTerm>
                  <DescriptionDetails
                    className={fact.tone === "warning" ? "text-warning" : "text-muted-foreground"}
                  >
                    {fact.value}
                  </DescriptionDetails>
                </DescriptionListItem>
              ))}
            </DescriptionList>
          </>
        )}

        {worker.lastError !== undefined && worker.lastError !== "" && (
          <p className="mt-2.5 text-xs break-words text-destructive">
            <span className="sr-only">Last error: </span>
            {worker.lastError}
          </p>
        )}
      </CardContent>
    </Card>
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

  return (
    <Card>
      <CardHeader>
        <CardTitle render={<h2 />}>Invite another operator</CardTitle>
        <CardDescription>
          Sign-up is closed. An invitation is the only way to add an account after the first one. It
          is single-use, expires in ten minutes, and is shown here once. Send it over a channel you
          trust.
        </CardDescription>
        {grant === undefined && (
          <CardAction>
            <Button
              type="button"
              variant="outline"
              disabled={pending}
              onClick={() => void generate()}
            >
              {pending ? (
                <Spinner data-icon="inline-start" />
              ) : (
                <UserPlusIcon data-icon="inline-start" />
              )}
              Create an invitation
            </Button>
          </CardAction>
        )}
      </CardHeader>
      {(grant !== undefined || error !== undefined) && (
        <CardContent className="flex flex-col gap-3">
          {grant !== undefined && (
            <>
              <CodeBlock title="Invitation" code={grant.token} className={WRAP_CODE} />
              <p className="text-xs text-muted-foreground">
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
        </CardContent>
      )}
    </Card>
  );
}

function isMachineOnline(lastSeen: number, now: number) {
  return lastSeen > 0 && now - lastSeen < 120_000;
}

function formatOs(os: "linux" | "mac" | "win") {
  if (os === "mac") return "macOS";
  if (os === "win") return "Windows";
  return "Linux";
}
