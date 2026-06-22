import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Plus, RefreshCw, ScrollText, Square, ExternalLink, Rocket, Trash2 } from 'lucide-react';
import { trpcQuery, trpcMutation, type LocalProc, type Template } from '@/api';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DialogClose,
} from '@/components/ui/dialog';

type Health = 'passing' | 'critical' | 'unknown';

function uptime(iso: string): string {
  const s = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h`;
}

// Apps = what's actually running on this machine: real processes launched by the local runtime,
// with live health, logs and lifecycle. (A project's declarative spec + topology lives under Projects.)
export function Apps() {
  const [procs, setProcs] = useState<LocalProc[]>([]);
  const [health, setHealth] = useState<Record<string, Health>>({});
  const [templates, setTemplates] = useState<Template[]>([]);
  const [offline, setOffline] = useState(false);
  const [logsFor, setLogsFor] = useState<string | null>(null);
  const [logLines, setLogLines] = useState<string[]>([]);

  const refresh = useCallback(async () => {
    let list: LocalProc[];
    try {
      list = await trpcQuery<LocalProc[]>('local.list');
    } catch {
      setOffline(true); // only the list call failing means the control plane is down
      return;
    }
    setProcs(list);
    setOffline(false);
    // Health checks are best-effort: one slow/hung process must not stall the table.
    const results = await Promise.allSettled(
      list.map((p) => (p.status === 'running' ? trpcQuery<Health>('local.health', { name: p.name }) : Promise.resolve<Health>('critical'))),
    );
    setHealth(
      Object.fromEntries(
        list.map((p, i) => {
          const r = results[i];
          return [p.name, r.status === 'fulfilled' ? r.value : 'unknown'];
        }),
      ),
    );
  }, []);

  useEffect(() => {
    trpcQuery<Template[]>('local.templates').then(setTemplates).catch(() => setOffline(true));
    refresh();
    const t = setInterval(refresh, 3000);
    return () => clearInterval(t);
  }, [refresh]);

  async function openLogs(name: string) {
    setLogsFor(name);
    try {
      const res = await trpcQuery<{ lines: string[] }>('local.logs', { name, lines: 200 });
      setLogLines(res.lines);
    } catch (e) {
      setLogLines([`error: ${(e as Error).message}`]);
    }
  }

  async function stop(name: string) {
    try {
      await trpcMutation('local.stop', { name, confirm: true });
      toast.success(`Stopped ${name}`);
      refresh();
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  async function clear(name: string) {
    try {
      await trpcMutation('local.forget', { name });
      toast.success(`Cleared ${name}`);
      refresh();
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  if (offline) {
    return (
      <EmptyState
        title="Control plane offline"
        body="Start the API with `npm run api:dev`, then this page manages real processes on this machine."
      />
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-semibold tracking-tight">Apps</h2>
          <p className="text-muted-foreground text-sm">Real processes running on this machine — live health, logs, and lifecycle.</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={refresh}>
            <RefreshCw /> Refresh
          </Button>
          <DeployDialog templates={templates} onDeployed={refresh} runningPorts={procs.map((p) => p.port).filter(Boolean) as number[]} />
        </div>
      </div>

      {procs.length === 0 ? (
        <EmptyState title="No apps running" body="Deploy an app to launch a real, health-checked process on this machine." icon />
      ) : (
        <Card className="py-0">
          <CardContent className="px-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-6">Name</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Health</TableHead>
                  <TableHead>Port</TableHead>
                  <TableHead>PID</TableHead>
                  <TableHead>Uptime</TableHead>
                  <TableHead className="pr-6 text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {procs.map((p) => (
                  <TableRow key={p.name}>
                    <TableCell className="pl-6 font-medium">{p.name}</TableCell>
                    <TableCell>
                      <Badge variant={p.status === 'running' ? 'default' : 'secondary'}>{p.status}</Badge>
                    </TableCell>
                    <TableCell>
                      <HealthDot health={health[p.name] ?? 'unknown'} />
                    </TableCell>
                    <TableCell>
                      {p.port ? (
                        <a className="text-primary inline-flex items-center gap-1 hover:underline" href={`http://127.0.0.1:${p.port}`} target="_blank" rel="noreferrer">
                          {p.port} <ExternalLink className="size-3" />
                        </a>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell className="text-muted-foreground tabular-nums">{p.pid}</TableCell>
                    <TableCell className="text-muted-foreground tabular-nums">{p.status === 'running' ? uptime(p.startedAt) : '—'}</TableCell>
                    <TableCell className="pr-6">
                      <div className="flex justify-end gap-1">
                        <Button variant="ghost" size="sm" onClick={() => openLogs(p.name)}>
                          <ScrollText /> Logs
                        </Button>
                        {p.status === 'running' ? (
                          <Button variant="ghost" size="sm" className="text-destructive hover:text-destructive" onClick={() => stop(p.name)}>
                            <Square /> Stop
                          </Button>
                        ) : (
                          <Button variant="ghost" size="sm" className="text-muted-foreground" onClick={() => clear(p.name)} aria-label={`Clear ${p.name}`}>
                            <Trash2 /> Clear
                          </Button>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      <Dialog open={logsFor !== null} onOpenChange={(o) => !o && setLogsFor(null)}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Logs — {logsFor}</DialogTitle>
            <DialogDescription>Last 200 lines, streamed from the process log file.</DialogDescription>
          </DialogHeader>
          <pre className="bg-muted max-h-[50vh] overflow-auto rounded-md p-4 text-xs leading-relaxed">
            {logLines.length ? logLines.join('\n') : 'No output yet.'}
          </pre>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function DeployDialog(props: { templates: Template[]; onDeployed: () => void; runningPorts: number[] }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [template, setTemplate] = useState('');
  const [port, setPort] = useState(8080);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (props.templates.length && !template) setTemplate(props.templates[0].id);
  }, [props.templates, template]);

  async function deploy() {
    if (!name) return toast.error('Name is required');
    setBusy(true);
    try {
      await trpcMutation('local.deploy', { name, template, port, dryRun: false, confirm: true });
      toast.success(`Deployed ${name} on port ${port}`);
      setOpen(false);
      setName('');
      props.onDeployed();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm">
          <Plus /> Deploy app
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Deploy an app</DialogTitle>
          <DialogDescription>Launches a real process on this machine. Confirmation is required and the action is audited.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 py-2">
          <div className="grid gap-2">
            <Label htmlFor="name">Name</Label>
            <Input id="name" placeholder="my-web-app" value={name} onChange={(e) => setName(e.target.value.toLowerCase())} />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="template">Template</Label>
            <select
              id="template"
              className="border-input bg-transparent h-9 rounded-md border px-3 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]"
              value={template}
              onChange={(e) => setTemplate(e.target.value)}
            >
              {props.templates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.label}
                </option>
              ))}
            </select>
            <p className="text-muted-foreground text-xs">{props.templates.find((t) => t.id === template)?.description}</p>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="port">Port</Label>
            <Input id="port" type="number" value={port} onChange={(e) => setPort(Number(e.target.value))} />
            {props.runningPorts.includes(port) && <p className="text-destructive text-xs">Port {port} is already in use by a running app.</p>}
          </div>
        </div>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline">Cancel</Button>
          </DialogClose>
          <Button onClick={deploy} disabled={busy}>
            <Rocket /> {busy ? 'Deploying…' : 'Deploy & run'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function HealthDot(props: { health: Health }) {
  const map = { passing: 'bg-emerald-500', critical: 'bg-red-500', unknown: 'bg-zinc-300' } as const;
  const label = { passing: 'passing', critical: 'critical', unknown: 'unknown' } as const;
  return (
    <span className="inline-flex items-center gap-2 text-sm">
      <span className={`size-2 rounded-full ${map[props.health]}`} />
      {label[props.health]}
    </span>
  );
}

function EmptyState(props: { title: string; body: string; icon?: boolean }) {
  return (
    <Card>
      <CardHeader className="items-center text-center">
        {props.icon && <Rocket className="text-muted-foreground mx-auto mb-2 size-8" />}
        <CardTitle>{props.title}</CardTitle>
        <CardDescription>{props.body}</CardDescription>
      </CardHeader>
    </Card>
  );
}
