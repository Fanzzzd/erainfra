import { type FormEvent, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery } from "convex/react";
import { FlaskConical, Square } from "lucide-react";
import { api } from "@runner-center/backend/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useNow } from "@/hooks/use-now";
import { formatDuration, formatRelativeTime } from "@/lib/time";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/experiments")({ component: ExperimentsPage });

type ExperimentState = "queued" | "preparing" | "running" | "completed" | "cancelled" | "failed";

function isLive(state: ExperimentState) {
  return state === "queued" || state === "preparing" || state === "running";
}

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
      <div>
        <h1 className="text-2xl font-semibold tracking-[-0.025em] text-zinc-50">Experiments</h1>
        <p className="mt-1.5 text-sm text-[#8a8a93]">
          Run an operator-authored command in the same immutable microVMs and shared capacity as CI.
        </p>
      </div>

      <form
        className="grid gap-4 rounded-lg border border-white/[0.08] bg-[#0d0d0f] p-4 lg:grid-cols-[1fr_1fr_140px_auto]"
        onSubmit={(event) => void submit(event)}
      >
        <label className="space-y-1.5 text-xs text-zinc-400">
          Name
          <Input
            required
            maxLength={80}
            placeholder="dependency benchmark"
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <label className="space-y-1.5 text-xs text-zinc-400">
          Profile
          <select
            required
            className="flex h-10 w-full rounded-md border border-white/[0.12] bg-[#0a0a0b] px-3 text-sm text-zinc-100 outline-none focus-visible:border-emerald-400/70 focus-visible:ring-2 focus-visible:ring-emerald-400/15"
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
        </label>
        <label className="space-y-1.5 text-xs text-zinc-400">
          Timeout (seconds)
          <Input
            required
            type="number"
            min={1}
            max={21_600}
            value={timeoutSeconds}
            onChange={(event) => setTimeoutSeconds(event.target.value)}
          />
        </label>
        <Button
          className="self-end"
          type="submit"
          disabled={submitting || linuxProfiles.length === 0}
        >
          <FlaskConical />
          {submitting ? "Queuing…" : "Run"}
        </Button>
        <label className="space-y-1.5 text-xs text-zinc-400 lg:col-span-4">
          Command
          <Input
            required
            placeholder="pnpm test"
            value={command}
            onChange={(event) => setCommand(event.target.value)}
          />
        </label>
        {linuxProfiles.length === 0 && profiles !== undefined && (
          <p className="text-xs text-amber-300 lg:col-span-4">
            Register an active Linux Firecracker Profile before running Experiments.
          </p>
        )}
        {error && <p className="text-xs text-red-300 lg:col-span-4">{error}</p>}
      </form>

      <section className="overflow-hidden rounded-lg border border-white/[0.08] bg-[#0d0d0f]">
        <Table className="min-w-[900px]">
          <TableHeader>
            <TableRow>
              <TableHead className="w-[120px]">State</TableHead>
              <TableHead>Name / command</TableHead>
              <TableHead className="w-[150px]">Profile</TableHead>
              <TableHead className="w-[160px]">Worker</TableHead>
              <TableHead className="w-[170px]">Timing</TableHead>
              <TableHead className="w-[80px]" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {experiments === undefined ? (
              <TableRow>
                <TableCell colSpan={6} className="h-36 text-center text-[#8a8a93]">
                  Syncing Experiments…
                </TableCell>
              </TableRow>
            ) : experiments.length === 0 ? (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={6} className="h-48 text-center text-sm text-[#8a8a93]">
                  No Experiments yet.
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
                        <p className="mt-1 pl-2 text-[10px] text-[#7c7c85]">
                          exit {experiment.exitCode}
                        </p>
                      )}
                    </TableCell>
                    <TableCell>
                      <p className="text-xs font-medium text-zinc-200">{experiment.name}</p>
                      <code
                        className="mt-0.5 block max-w-[420px] truncate text-[10px] text-[#7c7c85]"
                        title={experiment.command.join(" ")}
                      >
                        {experiment.command.slice(2).join(" ")}
                      </code>
                      {experiment.lastError && (
                        <p className="mt-0.5 text-[10px] text-red-300/75">{experiment.lastError}</p>
                      )}
                    </TableCell>
                    <TableCell>
                      <code className="text-xs text-zinc-300">{experiment.profile}</code>
                    </TableCell>
                    <TableCell className="text-xs text-zinc-400">
                      {experiment.machineName ?? "Unassigned"}
                    </TableCell>
                    <TableCell className="tabular-nums text-xs text-zinc-400">
                      {experiment.startedAt === undefined
                        ? `queued ${formatDuration(end - experiment.createdAt)}`
                        : `ran ${formatDuration(end - experiment.startedAt)}`}
                      <p className="mt-0.5 text-[10px] text-[#7c7c85]">
                        {formatRelativeTime(experiment.createdAt, now)}
                      </p>
                    </TableCell>
                    <TableCell>
                      {isLive(experiment.state) && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          aria-label={`Cancel ${experiment.name}`}
                          onClick={() => void cancel(experiment._id)}
                        >
                          <Square />
                        </Button>
                      )}
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

function StateBadge({ state }: { state: ExperimentState }) {
  const tone =
    state === "completed"
      ? "bg-emerald-400/10 text-emerald-300"
      : state === "failed" || state === "cancelled"
        ? "bg-red-400/10 text-red-300"
        : state === "running"
          ? "bg-sky-400/10 text-sky-300"
          : "bg-amber-400/10 text-amber-300";
  return (
    <span className={cn("inline-flex rounded-full px-2 py-0.5 text-[11px]", tone)}>{state}</span>
  );
}
