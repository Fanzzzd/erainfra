import { api } from "@erainfra/backend/api";
import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { FlaskConicalIcon } from "lucide-react";
import { createContext, type FormEvent, useContext, useState } from "react";

import { ConfirmDialog } from "@/components/confirm-dialog";
import { copyText } from "@/components/copy-button";
import { DataTable, createDataTableColumns } from "@/components/data-table";
import {
  EmptyState,
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
import { LiveIndicator, Status } from "@/components/status";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { toast } from "@/components/ui/toast";
import { useNow } from "@/hooks/use-now";
import { experimentStates, type ExperimentState } from "@/lib/states";
import { formatDuration, formatRelativeTime } from "@/lib/time";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/experiments")({ component: ExperimentsPage });

type Experiment = FunctionReturnType<typeof api.experiments.list>[number];

function isLive(state: ExperimentState) {
  return state === "queued" || state === "preparing" || state === "running";
}

/** The page's clock, so every row's timing ticks from one interval. */
const NowContext = createContext(0);

function ExperimentTiming({ experiment }: { experiment: Experiment }) {
  const now = useContext(NowContext);
  const end = experiment.finishedAt ?? now;
  return (
    <div className="whitespace-nowrap">
      <p>
        {experiment.startedAt === undefined
          ? `queued ${formatDuration(end - experiment.createdAt)}`
          : `ran ${formatDuration(end - experiment.startedAt)}`}
      </p>
      <p className="text-xs text-muted-foreground">
        {formatRelativeTime(experiment.createdAt, now)}
      </p>
    </div>
  );
}

const column = createDataTableColumns<Experiment>();

const columns = column.columns([
  column.accessor("state", {
    header: "State",
    enableSorting: false,
    cell: (cell) => {
      const experiment = cell.row.original;
      return (
        <div>
          <Status states={experimentStates} state={experiment.state} className="font-medium" />
          {experiment.exitCode !== undefined && (
            <p
              className={cn(
                "mt-0.5 pl-4 text-xs tabular-nums",
                experiment.exitCode === 0 ? "text-muted-foreground" : "text-danger",
              )}
            >
              exit {experiment.exitCode}
            </p>
          )}
        </div>
      );
    },
  }),
  column.accessor("name", {
    header: "Name and command",
    cell: (cell) => {
      const experiment = cell.row.original;
      return (
        <div className="max-w-md min-w-0">
          <p className="truncate font-medium">{experiment.name}</p>
          <code
            className="block truncate text-xs text-muted-foreground"
            title={experiment.command.join(" ")}
          >
            {experiment.command.slice(2).join(" ")}
          </code>
          {experiment.lastError && (
            <p className="text-xs break-words text-danger">
              <span className="sr-only">Last error: </span>
              {experiment.lastError}
            </p>
          )}
        </div>
      );
    },
  }),
  column.accessor("profile", {
    header: "Profile",
    cell: (cell) => <span className="text-muted-foreground">{cell.getValue()}</span>,
  }),
  column.accessor((row) => row.machineName ?? "", {
    id: "machine",
    header: "Worker",
    cell: (cell) => (
      <span title={cell.row.original.selectionReason}>
        {cell.row.original.machineName ?? <span className="text-muted-foreground">Unassigned</span>}
      </span>
    ),
  }),
  column.accessor("createdAt", {
    header: "Timing",
    enableSorting: false,
    cell: (cell) => <ExperimentTiming experiment={cell.row.original} />,
  }),
]);

/** Asks to cancel an Experiment; the page provides it. */
const CancelContext = createContext<(experiment: Experiment) => void>(() => {});

function ExperimentMenuItems({ experiment }: { experiment: Experiment }) {
  const onCancel = useContext(CancelContext);
  return (
    <>
      <DropdownMenuGroup>
        <DropdownMenuItem
          onClick={() =>
            void copyText(experiment.command.join(" ")).then((ok) =>
              ok
                ? toast.success("Command copied")
                : toast.error("Could not copy", {
                    description: "Select the text and copy it by hand.",
                  }),
            )
          }
        >
          Copy command
        </DropdownMenuItem>
      </DropdownMenuGroup>
      <DropdownMenuSeparator />
      <DropdownMenuItem
        variant="destructive"
        disabled={!isLive(experiment.state)}
        onClick={() => onCancel(experiment)}
      >
        Cancel Experiment
      </DropdownMenuItem>
    </>
  );
}

/** Module-level, so the menu items are not a new component on each render. */
const rowActions = {
  label: (experiment: Experiment) => `Actions for ${experiment.name}`,
  items: (experiment: Experiment) => <ExperimentMenuItems experiment={experiment} />,
};

function ExperimentsPage() {
  const profiles = useQuery(api.profiles.list);
  const experiments = useQuery(api.experiments.list);
  const createExperiment = useMutation(api.experiments.create);
  const cancelExperiment = useMutation(api.experiments.cancel);
  const now = useNow();
  const [name, setName] = useState("");
  const [profile, setProfile] = useState("");
  const [command, setCommand] = useState("");
  const [timeoutSeconds, setTimeoutSeconds] = useState("900");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string>();
  const [cancelling, setCancelling] = useState<Experiment | undefined>(undefined);
  const linuxProfiles =
    profiles?.filter((item) => item.state === "active" && item.executor === "firecracker") ?? [];
  const profileItems = Object.fromEntries(
    linuxProfiles.map((item) => [
      item.name,
      `${item.name} · ${item.freeSlots}/${item.readySlots} free`,
    ]),
  );

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
      toast.success("Experiment queued", { description: name });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not queue Experiment");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <NowContext.Provider value={now}>
      <CancelContext.Provider value={setCancelling}>
        <PageHeader>
          <PageHeaderTitle>Experiments</PageHeaderTitle>
          <PageHeaderDescription>
            Run an operator-authored command in the same immutable microVMs and shared capacity as
            CI.
          </PageHeaderDescription>
          <PageHeaderActions>
            <LiveIndicator />
          </PageHeaderActions>
        </PageHeader>

        <Card>
          <CardHeader className="border-b">
            <CardTitle render={<h2 />}>Queue an Experiment</CardTitle>
            <CardDescription>
              The command runs under <code className="text-foreground">bash -lc</code> inside a
              guest-kernel microVM, and is discarded with the snapshot when it exits.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form
              className="grid gap-4 lg:grid-cols-[1fr_1fr_160px_auto]"
              onSubmit={(event) => void submit(event)}
            >
              <Field>
                <FieldLabel>Name</FieldLabel>
                <Input
                  required
                  maxLength={80}
                  placeholder="dependency benchmark"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                />
              </Field>
              <Field>
                <FieldLabel>Profile</FieldLabel>
                <Select
                  required
                  items={profileItems}
                  value={profile === "" ? null : profile}
                  onValueChange={(value) => setProfile(value ?? "")}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Select Profile" />
                  </SelectTrigger>
                  <SelectContent>
                    {linuxProfiles.map((item) => (
                      <SelectItem key={item._id} value={item.name}>
                        {item.name} · {item.freeSlots}/{item.readySlots} free
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Field>
                <FieldLabel>Timeout (seconds)</FieldLabel>
                <Input
                  required
                  type="number"
                  min={1}
                  max={21_600}
                  value={timeoutSeconds}
                  onChange={(event) => setTimeoutSeconds(event.target.value)}
                />
              </Field>
              <Button
                className="self-end"
                type="submit"
                disabled={submitting || linuxProfiles.length === 0}
                aria-busy={submitting || undefined}
              >
                {submitting ? (
                  <Spinner data-icon="inline-start" />
                ) : (
                  <FlaskConicalIcon data-icon="inline-start" />
                )}
                {submitting ? "Queuing…" : "Run"}
              </Button>
              <Field className="lg:col-span-4">
                <FieldLabel>Command</FieldLabel>
                <Input
                  required
                  className="font-mono"
                  placeholder="pnpm test"
                  value={command}
                  onChange={(event) => setCommand(event.target.value)}
                />
              </Field>
              {linuxProfiles.length === 0 && profiles !== undefined && (
                <Alert variant="warning" className="lg:col-span-4">
                  <AlertDescription>
                    Register an active Linux Firecracker Profile before running Experiments.
                  </AlertDescription>
                </Alert>
              )}
              {error && (
                <Alert variant="danger" className="lg:col-span-4">
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              )}
            </form>
          </CardContent>
        </Card>

        <Card className="gap-0 py-0">
          <CardHeader className="border-b py-4">
            <CardTitle render={<h2 />}>History</CardTitle>
            <CardDescription>The last 100 Experiments, newest first.</CardDescription>
          </CardHeader>
          <DataTable
            aria-label="Experiments"
            columns={columns}
            data={experiments ?? []}
            getRowId={(experiment) => experiment._id}
            loading={experiments === undefined}
            loadingRows={3}
            rowActions={rowActions}
            empty={
              <EmptyState>
                <EmptyStateMedia>
                  <FlaskConicalIcon />
                </EmptyStateMedia>
                <EmptyStateTitle>No Experiments yet</EmptyStateTitle>
                <EmptyStateDescription>
                  Queue one above to run a command on the same capacity CI uses, without pushing a
                  workflow.
                </EmptyStateDescription>
              </EmptyState>
            }
          />
        </Card>

        <ConfirmDialog
          open={cancelling !== undefined}
          onOpenChange={(open) => {
            if (!open) setCancelling(undefined);
          }}
          title={`Cancel ${cancelling?.name ?? "this Experiment"}?`}
          description="The microVM stops and its work is discarded. The Experiment cannot be resumed."
          confirmLabel="Cancel Experiment"
          cancelLabel="Keep running"
          onConfirm={async () => {
            if (cancelling === undefined) return;
            await cancelExperiment({ experimentId: cancelling._id });
            toast.success("Experiment cancelled", { description: cancelling.name });
          }}
        />
      </CancelContext.Provider>
    </NowContext.Provider>
  );
}
