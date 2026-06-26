import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { GitBranch, Plus, RefreshCw, Rocket, Trash2, Upload } from 'lucide-react';
import { trpcQuery, trpcMutation, uploadSource, type AgentInfo, type GitBinding } from '@/api';
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

type DeployResult = { ok: boolean; stage?: string; error?: string };

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
    </div>
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
    try {
      const r = await trpcMutation<DeployResult>('git.deployNow', { id: b.id, confirm: true });
      if (r.ok) toast.success(`Redeployed ${b.name}`);
      else toast.error(`Failed at ${r.stage}: ${r.error ?? 'see server logs'}`);
      refresh();
    } catch (e) {
      toast.error((e as Error).message);
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
  const [port, setPort] = useState(8080);
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
      await trpcMutation('git.bind', { repo, branch, buildNode, deployNode, name, port, confirm: true });
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
            <Label htmlFor="git-port">Port</Label>
            <Input id="git-port" type="number" value={port} onChange={(e) => setPort(Number(e.target.value))} />
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
  const [port, setPort] = useState(8080);
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
  const canDeploy = !!file && !!name && !!buildNode && !!deployNode && !noNodes && !busy;

  async function deploy() {
    if (!file) return;
    setBusy(true);
    const t = toast.loading('Uploading…');
    try {
      const { buildId } = await uploadSource(file);
      toast.loading('Building + deploying…', { id: t });
      const r = await trpcMutation<DeployResult>('upload.deploy', { buildId, name, port, buildNode, deployNode, confirm: true });
      if (r.ok) toast.success(`Deployed ${name} on port ${port}`, { id: t });
      else toast.error(`Failed at ${r.stage}: ${r.error ?? 'see server logs'}`, { id: t });
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
            <Label htmlFor="up-port">Port</Label>
            <Input id="up-port" type="number" value={port} onChange={(e) => setPort(Number(e.target.value))} />
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
