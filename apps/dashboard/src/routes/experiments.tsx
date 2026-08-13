import { type FormEvent, useId, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery } from "convex/react";
import { FlaskConical, Square } from "lucide-react";
import { api } from "@runner-center/backend/api";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { LiveBadge } from "@/components/status";
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
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useNow } from "@/hooks/use-now";
import { formatDuration, formatRelativeTime } from "@/lib/time";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/experiments")({ component: ExperimentsPage });

type ExperimentState = "queued" | "preparing" | "running" | "completed" | "cancelled" | "failed";

function isLive(state: ExperimentState) {
  return state === "queued" || state === "preparing" || state === "running";
}

// The native control keeps the keyboard and mobile behaviour a Radix listbox
// would have to re-implement; it only needs the console's field styling.
const selectClassName =
  "flex h-10 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground outline-none transition-[color,border-color,box-shadow] duration-150 focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/25 disabled:cursor-not-allowed disabled:opacity-50";

function ExperimentsPage() {
  const profiles = useQuery(api.profiles.list);
  const experiments = useQuery(api.experiments.list);
  const createExperiment = useMutation(api.experiments.create);
  const cancelExperiment = useMutation(api.experiments.cancel);
  const now = useNow();
  const fieldId = useId();
  const [name, setName] = useState("");
  const [profile, setProfile] = useState("");
  const [command, setCommand] = useState("");
  const [timeoutSeconds, setTimeoutSeconds] = useState("900");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string>();
  const linuxProfiles =
    profiles?.filter((item) => item.state === "active" && item.executor === "firecracker") ?? [];

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setError(undefined);
    try {
      await createExperiment({
        name,
        profile,
        command: ["bash", "-lc", command],
        timeoutSeconds: Number(timeoutSeconds),
      });
      setName("");
      setCommand("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not queue Experiment");
    } finally {
      setSubmitting(false);
    }
  }

  async function cancel(experimentId: Parameters<typeof cancelExperiment>[0]["experimentId"]) {
    setError(undefined);
    try {
      await cancelExperiment({ experimentId });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not cancel Experiment");
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Experiments"
        description="Run an operator-authored command in the same immutable microVMs and shared capacity as CI."
      >
        <LiveBadge />
      </PageHeader>

      <Card>
        <CardHeader className="border-b">
          <CardTitle>Queue an Experiment</CardTitle>
          <CardDescription>
            The command runs under <code>bash -lc</code> inside a guest-kernel microVM, and is
            discarded with the snapshot when it exits.
          </CardDescription>
        </CardHeader>
        <CardContent className="pt-4">
          <form
            className="grid gap-4 lg:grid-cols-[1fr_1fr_140px_auto]"
            onSubmit={(event) => void submit(event)}
          >
            <div className="space-y-1.5">
              <Label htmlFor={`${fieldId}-name`}>Name</Label>
              <Input
                id={`${fieldId}-name`}
                required
                maxLength={80}
                placeholder="dependency benchmark"
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`${fieldId}-profile`}>Profile</Label>
              <select
                id={`${fieldId}-profile`}
                required
                className={selectClassName}
                value={profile}
                onChange={(event) => setProfile(event.target.value)}
              >
                <option value="" disabled>
                  Select Profile
                </option>
                {linuxProfiles.map((item) => (
                  <option key={item._id} value={item.name}>
                    {item.name} · {item.freeSlots}/{item.readySlots} free
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`${fieldId}-timeout`}>Timeout (seconds)</Label>
              <Input
                id={`${fieldId}-timeout`}
                required
                type="number"
                min={1}
                max={21_600}
                value={timeoutSeconds}
                onChange={(event) => setTimeoutSeconds(event.target.value)}
              />
            </div>
            <Button
              className="self-end"
              type="submit"
              disabled={submitting || linuxProfiles.length === 0}
            >
              <FlaskConical />
              {submitting ? "Queuing…" : "Run"}
            </Button>
            <div className="space-y-1.5 lg:col-span-4">
              <Label htmlFor={`${fieldId}-command`}>Command</Label>
              <Input
                id={`${fieldId}-command`}
                required
                className="font-mono"
                placeholder="pnpm test"
                value={command}
                onChange={(event) => setCommand(event.target.value)}
              />
            </div>
            {linuxProfiles.length === 0 && profiles !== undefined && (
              <Alert variant="warning" className="lg:col-span-4">
                <AlertDescription>
                  Register an active Linux Firecracker Profile before running Experiments.
                </AlertDescription>
              </Alert>
            )}
            {error && (
              <Alert variant="destructive" className="lg:col-span-4">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
          </form>
        </CardContent>
      </Card>

      <Card className="overflow-hidden">
        <Table className="min-w-[900px]">
          <TableHeader>
            <TableRow>
              <TableHead className="w-[120px]">State</TableHead>
              <TableHead>Name / command</TableHead>
              <TableHead className="w-[150px]">Profile</TableHead>
              <TableHead className="w-[160px]">Worker</TableHead>
              <TableHead className="w-[170px]">Timing</TableHead>
              <TableHead className="w-[80px]">
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {experiments === undefined ? (
              <TableRowsSkeleton columns={6} rows={3} />
            ) : experiments.length === 0 ? (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={6} className="p-0">
                  <EmptyState
                    icon={FlaskConical}
                    title="No Experiments yet"
                    description="Queue one above to run a command on the same capacity CI uses, without pushing a workflow."
                  />
                </TableCell>
              </TableRow>
            ) : (
              experiments.map((experiment) => {
                const end = experiment.finishedAt ?? now;
                return (
                  <TableRow key={experiment._id}>
                    <TableCell>
                      <StateBadge state={experiment.state} />
                      {experiment.exitCode !== undefined && (
                        <p
                          className={cn(
                            "tabular-nums mt-1 text-[10px]",
                            experiment.exitCode === 0
                              ? "text-subtle-foreground"
                              : "text-destructive",
                          )}
                        >
                          exit {experiment.exitCode}
                        </p>
                      )}
                    </TableCell>
                    <TableCell>
                      <p className="text-xs font-medium text-secondary-foreground">
                        {experiment.name}
                      </p>
                      <code
                        className="mt-0.5 block max-w-[420px] truncate text-[10px] text-subtle-foreground"
                        title={experiment.command.join(" ")}
                      >
                        {experiment.command.slice(2).join(" ")}
                      </code>
                      {experiment.lastError && (
                        <p className="mt-0.5 break-words text-[10px] leading-4 text-destructive">
                          <span className="sr-only">Last error: </span>
                          {experiment.lastError}
                        </p>
                      )}
                    </TableCell>
                    <TableCell>
                      <code className="text-xs text-secondary-foreground">
                        {experiment.profile}
                      </code>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {experiment.machineName ?? (
                        <span className="text-subtle-foreground">Unassigned</span>
                      )}
                    </TableCell>
                    <TableCell className="tabular-nums text-xs text-muted-foreground">
                      {experiment.startedAt === undefined
                        ? `queued ${formatDuration(end - experiment.createdAt)}`
                        : `ran ${formatDuration(end - experiment.startedAt)}`}
                      <p className="mt-0.5 text-[10px] text-subtle-foreground">
                        {formatRelativeTime(experiment.createdAt, now)}
                      </p>
                    </TableCell>
                    <TableCell>
                      {isLive(experiment.state) && (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              aria-label={`Cancel ${experiment.name}`}
                              onClick={() => void cancel(experiment._id)}
                            >
                              <Square />
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent side="left">Cancel this Experiment</TooltipContent>
                        </Tooltip>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </Card>
    </div>
  );
}

function StateBadge({ state }: { state: ExperimentState }) {
  const variant =
    state === "completed"
      ? "success"
      : state === "failed" || state === "cancelled"
        ? "destructive"
        : state === "running"
          ? "info"
          : "warning";
  return (
    <Badge variant={variant} className="capitalize">
      {state}
    </Badge>
  );
}
