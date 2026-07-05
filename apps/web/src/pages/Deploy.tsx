import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { ExternalLink, GitBranch, KeyRound, Plus, RefreshCw, Rocket, Trash2, Upload } from 'lucide-react';
import { trpcQuery, trpcMutation, uploadSource, waitForDeploy, type AgentInfo, type EnvVar, type GitBinding, type RouteInfo } from '@/api';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';

function since(iso: string): string {
  const s = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

// A node <select>, shared by both tabs and the bind dialog. When no node is connected it shows a
// disabled hint so the user knows to enroll one before deploying.
function NodeSelect(props: { id: string; value: string; agents: AgentInfo[]; disabled?: boolean; onChange: (v: string) => void }) {
  return (
    <select
      id={props.id}
      className="border-input bg-transparent h-9 rounded-md border px-3 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] disabled:opacity-50"
      value={props.value}
      disabled={props.disabled || props.agents.length === 0}
      onChange={(e) => props.onChange(e.target.value)}
    >
      {props.agents.length === 0 ? (
        <option value="">no nodes — enroll one first</option>
      ) : (
        props.agents.map((a) => (
          <option key={a.id} value={a.id}>
            {a.id}
          </option>
        ))
      )}
    </select>
  );
}

export function Deploy() {
  const [agents, setAgents] = useState<AgentInfo[]>([]);

  const refreshAgents = useCallback(async () => {
    try {
      setAgents(await trpcQuery<AgentInfo[]>('agents.list'));
    } catch {
      // keep last good; global indicator covers hard offline
    }
  }, []);

  useEffect(() => {
    refreshAgents();
    const t = setInterval(refreshAgents, 3000);
    return () => clearInterval(t);
  }, [refreshAgents]);

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold tracking-tight">Deploy</h2>
        <p className="text-muted-foreground text-sm">Ship an app from a Git repo or by uploading source — portless builds and runs it on a node.</p>
      </div>

      <Tabs defaultValue="git">
        <TabsList>
          <TabsTrigger value="git">
            <GitBranch /> From Git
          </TabsTrigger>
          <TabsTrigger value="upload">
            <Upload /> Upload
          </TabsTrigger>
        </TabsList>
        <TabsContent value="git" className="mt-4">
          <GitTab agents={agents} />
        </TabsContent>
        <TabsContent value="upload" className="mt-4">
          <UploadTab agents={agents} />
        </TabsContent>
      </Tabs>

      <DeployedApps />
    </div>
  );
}

// Everything currently deployed (the routing/failover record), with its live URL and online status.
// This is where the wildcard-domain + secrets features surface: open the app, manage its env, remove it.
function DeployedApps() {
  const [routes, setRoutes] = useState<RouteInfo[]>([]);
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setRoutes(await trpcQuery<RouteInfo[]>('routes.list'));
    } catch {
      // keep last good
    }
  }, []);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 3000);
    return () => clearInterval(t);
  }, [refresh]);

  async function remove(app: string) {
    if (!confirm(`Remove ${app}? This stops its container and unroutes it.`)) return;
    setBusy(app);
    try {
      await trpcMutation('routes.remove', { app, confirm: true });
      toast.success(`Removed ${app}`);
      refresh();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  if (routes.length === 0) return null;

  return (
    <div className="space-y-3 pt-2">
      <h3 className="text-sm font-semibold tracking-tight">Deployed apps</h3>
      <Card className="py-0">
        <CardContent className="px-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-6">App</TableHead>
                <TableHead>URL</TableHead>
                <TableHead>Node</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="pr-6 text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {routes.map((r) => (
                <TableRow key={r.app}>
                  <TableCell className="pl-6 font-medium">{r.app}</TableCell>
                  <TableCell>
                    {r.url ? (
                      <a href={r.url} target="_blank" rel="noreferrer" className="text-primary inline-flex items-center gap-1 hover:underline">
                        {r.url.replace(/^https?:\/\//, '')} <ExternalLink className="size-3" />
                      </a>
                    ) : (
                      <span className="text-muted-foreground text-xs">set PORTLESS_APP_DOMAIN for a URL</span>
                    )}
                  </TableCell>
                  <TableCell className="text-muted-foreground">{r.node}</TableCell>
                  <TableCell>
                    <Badge variant={r.online ? 'default' : 'destructive'}>{r.online ? 'online' : r.nodeConnected ? 'starting' : 'offline'}</Badge>
                  </TableCell>
                  <TableCell className="pr-6">
                    <div className="flex justify-end gap-1">
                      <EnvDialog app={r.app} />
                      <Button variant="ghost" size="sm" className="text-destructive hover:text-destructive" onClick={() => remove(r.app)} disabled={busy === r.app}>
                        <Trash2 /> Remove
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}

// Manage an app's env vars / secrets. Values are write-only — the list shows masked previews; setting
// a var takes effect on the next deploy.
function EnvDialog(props: { app: string }) {
  const [open, setOpen] = useState(false);
  const [vars, setVars] = useState<EnvVar[]>([]);
  const [key, setKey] = useState('');
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setVars(await trpcQuery<EnvVar[]>('env.list', { app: props.app }));
    } catch {
      // keep last good
    }
  }, [props.app]);

  useEffect(() => {
    if (open) refresh();
  }, [open, refresh]);

  async function add() {
    if (!key) return;
    setBusy(true);
    try {
      await trpcMutation('env.set', { app: props.app, vars: { [key]: value } });
      toast.success(`Set ${key} — redeploy to apply`);
      setKey('');
      setValue('');
      refresh();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function unset(k: string) {
    setBusy(true);
    try {
      await trpcMutation('env.unset', { app: props.app, key: k });
      toast.success(`Removed ${k} — redeploy to apply`);
      refresh();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="sm">
          <KeyRound /> Env
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Environment — {props.app}</DialogTitle>
          <DialogDescription>Encrypted at rest, injected into the container on the next deploy. Values are never shown again.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 py-2">
          {vars.length > 0 && (
            <div className="rounded-md border">
              {vars.map((v) => (
                <div key={v.key} className="flex items-center justify-between gap-2 border-b px-3 py-2 text-sm last:border-0">
                  <span className="font-mono">{v.key}</span>
                  <span className="text-muted-foreground ml-auto font-mono text-xs">{v.preview}</span>
                  <Button variant="ghost" size="sm" className="text-destructive hover:text-destructive" onClick={() => unset(v.key)} disabled={busy} aria-label={`Remove ${v.key}`}>
                    <Trash2 />
                  </Button>
                </div>
              ))}
            </div>
          )}
          <div className="grid grid-cols-[1fr_1fr_auto] items-end gap-2">
            <div className="grid gap-1">
              <Label htmlFor="env-key">Key</Label>
              <Input id="env-key" placeholder="DATABASE_URL" value={key} onChange={(e) => setKey(e.target.value)} />
            </div>
            <div className="grid gap-1">
              <Label htmlFor="env-value">Value</Label>
              <Input id="env-value" type="password" placeholder="secret" value={value} onChange={(e) => setValue(e.target.value)} />
            </div>
            <Button onClick={add} disabled={!key || busy}>
              <Plus /> Set
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function GitTab(props: { agents: AgentInfo[] }) {
  const [bindings, setBindings] = useState<GitBinding[]>([]);
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setBindings(await trpcQuery<GitBinding[]>('git.list'));
    } catch {
      // keep last good
    }
  }, []);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 3000);
    return () => clearInterval(t);
  }, [refresh]);

  async function redeploy(b: GitBinding) {
    setBusy(b.id);
    const t = toast.loading(`Deploying ${b.name}…`);
    try {
      const { deployId } = await trpcMutation<{ deployId: string }>('git.deployNow', { id: b.id, confirm: true });
      const d = await waitForDeploy(deployId, (p) => toast.loading(`${b.name}: ${p.detail}`, { id: t }));
      if (d.stage === 'done') toast.success(`Deployed ${b.name}${d.urls[0] ? ` → ${d.urls[0]}` : ''}`, { id: t });
      else toast.error(`${b.name} failed: ${d.error ?? d.detail}`, { id: t });
      refresh();
    } catch (e) {
      toast.error((e as Error).message, { id: t });
    } finally {
      setBusy(null);
    }
  }

  async function unbind(b: GitBinding) {
    setBusy(b.id);
    try {
      await trpcMutation('git.unbind', { id: b.id, confirm: true });
      toast.success(`Unbound ${b.repo}@${b.branch}`);
      refresh();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-end gap-2">
        <Button variant="outline" size="sm" onClick={refresh}>
          <RefreshCw /> Refresh
        </Button>
        <BindDialog agents={props.agents} onBound={refresh} />
      </div>

      {bindings.length === 0 ? (
        <Card>
          <CardHeader className="items-center text-center">
            <GitBranch className="text-muted-foreground mx-auto mb-2 size-8" />
            <CardTitle>No repos bound</CardTitle>
            <CardDescription>Import a Git repo to deploy it on push (or with the Redeploy button).</CardDescription>
          </CardHeader>
        </Card>
      ) : (
        <Card className="py-0">
          <CardContent className="px-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-6">Repo</TableHead>
                  <TableHead>App</TableHead>
                  <TableHead>Port</TableHead>
                  <TableHead>Build node</TableHead>
                  <TableHead>Deploy node</TableHead>
                  <TableHead>Last deploy</TableHead>
                  <TableHead className="pr-6 text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {bindings.map((b) => (
                  <TableRow key={b.id}>
                    <TableCell className="pl-6 font-medium">
                      {b.repo}
                      <span className="text-muted-foreground">@{b.branch}</span>
                    </TableCell>
                    <TableCell>{b.name}</TableCell>
                    <TableCell className="text-muted-foreground tabular-nums">{b.port}</TableCell>
                    <TableCell className="text-muted-foreground">{b.buildNode}</TableCell>
                    <TableCell className="text-muted-foreground">{b.deployNode}</TableCell>
                    <TableCell>
                      {b.lastStatus ? (
                        <span className="inline-flex items-center gap-2 text-sm">
                          <Badge variant={b.lastStatus.ok ? 'default' : 'destructive'}>
                            {b.lastStatus.ok ? 'ok' : `failed: ${b.lastStatus.stage}`}
                          </Badge>
                          <span className="text-muted-foreground tabular-nums">{since(b.lastStatus.at)} ago</span>
                        </span>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell className="pr-6">
                      <div className="flex justify-end gap-1">
                        <Button variant="ghost" size="sm" onClick={() => redeploy(b)} disabled={busy === b.id}>
                          <Rocket /> Redeploy
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-destructive hover:text-destructive"
                          onClick={() => unbind(b)}
                          disabled={busy === b.id}
                        >
                          <Trash2 /> Unbind
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function BindDialog(props: { agents: AgentInfo[]; onBound: () => void }) {
  const [open, setOpen] = useState(false);
  const [repo, setRepo] = useState('');
  const [branch, setBranch] = useState('main');
  const [name, setName] = useState('');
  const [port, setPort] = useState(''); // only needed when the repo has no portless.yaml
  const [buildNode, setBuildNode] = useState('');
  const [deployNode, setDeployNode] = useState('');
  const [busy, setBusy] = useState(false);

  // Default both node selects to the first connected node.
  useEffect(() => {
    if (props.agents.length) {
      if (!buildNode) setBuildNode(props.agents[0].id);
      if (!deployNode) setDeployNode(props.agents[0].id);
    }
  }, [props.agents, buildNode, deployNode]);

  const noNodes = props.agents.length === 0;
  const canSubmit = !!repo && !!branch && !!name && !!buildNode && !!deployNode && !noNodes && !busy;

  async function bind() {
    setBusy(true);
    try {
      await trpcMutation('git.bind', { repo, branch, buildNode, deployNode, name, ...(port ? { port: Number(port) } : {}), confirm: true });
      toast.success(`Imported ${repo}@${branch}`);
      setOpen(false);
      setRepo('');
      setName('');
      props.onBound();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" disabled={noNodes}>
          <Plus /> Import Git repo
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Import a Git repo</DialogTitle>
          <DialogDescription>Binds a repo+branch to build/deploy nodes. A GitHub push (or Redeploy) builds and ships it.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 py-2">
          <div className="grid gap-2">
            <Label htmlFor="repo">Repo</Label>
            <Input id="repo" placeholder="owner/name" value={repo} onChange={(e) => setRepo(e.target.value)} />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="grid gap-2">
              <Label htmlFor="branch">Branch</Label>
              <Input id="branch" placeholder="main" value={branch} onChange={(e) => setBranch(e.target.value)} />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="git-name">App name</Label>
              <Input id="git-name" placeholder="my-app" value={name} onChange={(e) => setName(e.target.value.toLowerCase())} />
            </div>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="git-port">Port (only if the repo has no portless.yaml)</Label>
            <Input id="git-port" type="number" placeholder="from portless.yaml" value={port} onChange={(e) => setPort(e.target.value)} />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="grid gap-2">
              <Label htmlFor="git-build">Build node</Label>
              <NodeSelect id="git-build" value={buildNode} agents={props.agents} onChange={setBuildNode} />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="git-deploy">Deploy node</Label>
              <NodeSelect id="git-deploy" value={deployNode} agents={props.agents} onChange={setDeployNode} />
            </div>
          </div>
        </div>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline">Cancel</Button>
          </DialogClose>
          <Button onClick={bind} disabled={!canSubmit}>
            <Plus /> {busy ? 'Importing…' : 'Import'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function UploadTab(props: { agents: AgentInfo[] }) {
  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState('');
  const [port, setPort] = useState(''); // only needed when the source has no portless.yaml
  const [buildNode, setBuildNode] = useState('');
  const [deployNode, setDeployNode] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (props.agents.length) {
      if (!buildNode) setBuildNode(props.agents[0].id);
      if (!deployNode) setDeployNode(props.agents[0].id);
    }
  }, [props.agents, buildNode, deployNode]);

  const noNodes = props.agents.length === 0;
  const canDeploy = !!file && !!name && !noNodes && !busy;

  async function deploy() {
    if (!file) return;
    setBusy(true);
    const t = toast.loading('Uploading…');
    try {
      const { buildId } = await uploadSource(file);
      const { deployId } = await trpcMutation<{ deployId: string }>('upload.deploy', {
        buildId,
        app: name,
        ...(port ? { port: Number(port) } : {}),
        buildNode,
        node: deployNode,
        confirm: true,
      });
      const d = await waitForDeploy(deployId, (p) => toast.loading(`${name}: ${p.detail}`, { id: t }));
      if (d.stage === 'done') toast.success(`Deployed ${name}${d.urls[0] ? ` → ${d.urls[0]}` : ''}`, { id: t });
      else toast.error(`${name} failed: ${d.error ?? d.detail}`, { id: t });
    } catch (e) {
      toast.error((e as Error).message, { id: t });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Upload source</CardTitle>
        <CardDescription>Select a .tar.gz of your app. No Dockerfile needed — portless builds it with Nixpacks.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        <div className="grid gap-2">
          <Label htmlFor="tarball">Source tarball</Label>
          <Input
            id="tarball"
            type="file"
            accept=".tgz,.gz,application/gzip"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          />
        </div>
        <div className="grid grid-cols-2 gap-4">
          <div className="grid gap-2">
            <Label htmlFor="up-name">App name</Label>
            <Input id="up-name" placeholder="my-app" value={name} onChange={(e) => setName(e.target.value.toLowerCase())} />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="up-port">Port (only if no portless.yaml)</Label>
            <Input id="up-port" type="number" placeholder="from portless.yaml" value={port} onChange={(e) => setPort(e.target.value)} />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-4">
          <div className="grid gap-2">
            <Label htmlFor="up-build">Build node</Label>
            <NodeSelect id="up-build" value={buildNode} agents={props.agents} onChange={setBuildNode} />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="up-deploy">Deploy node</Label>
            <NodeSelect id="up-deploy" value={deployNode} agents={props.agents} onChange={setDeployNode} />
          </div>
        </div>
        <div>
          <Button onClick={deploy} disabled={!canDeploy}>
            <Rocket /> {busy ? 'Deploying…' : 'Deploy'}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
