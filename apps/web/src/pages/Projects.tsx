import { useCallback, useEffect, useState } from 'react';
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  Handle,
  Position,
  useNodesState,
  useEdgesState,
  type Node,
  type Edge,
  type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { toast } from 'sonner';
import { Globe, Server, Database, Cog, HardDrive, BarChart3, Zap, ListOrdered, Box, Plus, ArrowLeft, FolderOpen, Trash2 } from 'lucide-react';
import { trpcQuery, trpcMutation } from '@/api';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';

const STARTER_SPEC = `project: my-app
environment: prod
network:
  provider: netmaker
  overlayCidr: 10.88.0.0/16
  containerSubnetStrategy: per-machine-/24
services:
  - name: api
    type: web
    image: ghcr.io/example/api:latest
    replicas: 2
    port: 3000
    resources:
      cpu: 250
      memoryMb: 256
    health:
      path: /health
    connections:
      - to: assets
        type: object-storage
        provider: r2
domains:
  - hostname: api.example.com
    service: api
    ingress: cloudflare-tunnel
`;

interface TopoNodeData extends Record<string, unknown> {
  kind: 'ingress' | 'service' | 'resource';
  label: string;
  subtype?: string;
  meta?: Record<string, string | number | boolean>;
}
interface TopoResponse {
  nodes: Array<{ id: string; kind: TopoNodeData['kind']; label: string; subtype?: string; meta?: TopoNodeData['meta']; position: { x: number; y: number } }>;
  edges: Array<{ id: string; source: string; target: string; kind: string; label?: string; latencySensitive?: boolean }>;
}

interface ProjectSummary {
  id: string;
  project: string;
  environment: string;
  services: number;
  domains: number;
  source: 'example' | 'imported';
}

interface ServiceDetail {
  name: string;
  type: string;
  image: string;
  replicas: number;
  port: number | null;
  cpu: number;
  memoryMb: number;
  healthPath: string | null;
  dependencies: string[];
  connections: Array<{ to: string; type: string; provider: string | null; external: boolean }>;
  requiredRoles: string[];
  avoidRoles: string[];
}
interface ProjectDetail {
  id: string;
  project: string;
  environment: string;
  source: 'example' | 'imported';
  network: { provider: string; overlayCidr: string; containerSubnetStrategy: string } | null;
  services: ServiceDetail[];
  domains: Array<{ hostname: string; service: string; ingress: string }>;
}

function iconFor(kind: string, subtype?: string) {
  if (kind === 'ingress') return Globe;
  if (kind === 'service') return subtype === 'database' ? Database : subtype === 'worker' ? Cog : Server;
  switch (subtype) {
    case 'r2':
    case 's3':
    case 'object-storage':
      return HardDrive;
    case 'data-platform':
      return BarChart3;
    case 'redis':
    case 'cache':
      return Zap;
    case 'queue':
      return ListOrdered;
    case 'postgres':
    case 'database':
      return Database;
    default:
      return Box;
  }
}

const ACCENT: Record<string, string> = {
  ingress: 'border-orange-400 bg-orange-50',
  service: 'border-zinc-800 bg-white',
  resource: 'border-violet-400 bg-violet-50',
};
const ICONBG: Record<string, string> = {
  ingress: 'bg-orange-500',
  service: 'bg-zinc-900',
  resource: 'bg-violet-500',
};

function PortlessNode({ data }: NodeProps<Node<TopoNodeData>>) {
  const Icon = iconFor(data.kind, data.subtype);
  return (
    <div className={`flex min-w-44 items-center gap-3 rounded-lg border-2 px-3 py-2 shadow-sm ${ACCENT[data.kind]}`}>
      <Handle type="target" position={Position.Left} className="!size-2 !border-0 !bg-zinc-400" />
      <div className={`flex size-8 shrink-0 items-center justify-center rounded-md text-white ${ICONBG[data.kind]}`}>
        <Icon className="size-4" />
      </div>
      <div className="min-w-0">
        <div className="truncate text-sm font-semibold leading-tight">{data.label}</div>
        <div className="text-muted-foreground truncate text-xs">
          {data.subtype}
          {data.meta?.replicas ? ` · ${data.meta.replicas}×` : ''}
          {data.meta?.port ? ` · :${data.meta.port}` : ''}
          {data.meta?.external ? ' · external' : ''}
        </div>
      </div>
      <Handle type="source" position={Position.Right} className="!size-2 !border-0 !bg-zinc-400" />
    </div>
  );
}

const nodeTypes = { portless: PortlessNode };

function SourceBadge({ source }: { source: 'example' | 'imported' }) {
  return source === 'example' ? (
    <Badge variant="outline" className="border-amber-400 text-amber-700">
      Example
    </Badge>
  ) : (
    <Badge className="bg-emerald-600 hover:bg-emerald-600">Imported</Badge>
  );
}

// The selected project id lives in the URL hash (#projects/<id>) so a reload while viewing a project
// stays put and a project link is shareable. Ids contain '/' (project/env) — keep them literal.
function projectIdFromHash(): string | null {
  const m = window.location.hash.match(/^#\/?projects\/(.+)$/);
  return m ? decodeURIComponent(m[1]) : null;
}

// Projects = your declared projects (master-detail). The list is the honest inventory; clicking a
// project drills into its topology + spec. Seeded examples are labeled, never disguised as yours.
export function Projects() {
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [selected, setSelectedState] = useState<string | null>(projectIdFromHash);
  const [detail, setDetail] = useState<ProjectDetail | null>(null);
  const [offline, setOffline] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [yaml, setYaml] = useState(STARTER_SPEC);
  const [busy, setBusy] = useState(false);
  const [domainOpen, setDomainOpen] = useState(false);
  const [dHostname, setDHostname] = useState('');
  const [dService, setDService] = useState('');
  const [dRoute, setDRoute] = useState(false);
  const [dTunnel, setDTunnel] = useState('');
  const [tunnels, setTunnels] = useState<Array<{ name: string; id: string; status: string }>>([]);
  const [tunnelsState, setTunnelsState] = useState<'idle' | 'loading' | 'error' | 'ok'>('idle');
  const [dBusy, setDBusy] = useState(false);
  const [nodes, setNodes, onNodesChange] = useNodesState<Node<TopoNodeData>>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);

  // Selecting a project writes it to the hash (#projects/<id>); clearing returns to #projects. The
  // listener keeps state in sync with browser back/forward + manual edits.
  const setSelected = useCallback((id: string | null) => {
    window.location.hash = id ? `projects/${id}` : 'projects';
    setSelectedState(id);
  }, []);
  useEffect(() => {
    const onHash = () => setSelectedState(projectIdFromHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  function loadProjects() {
    return trpcQuery<ProjectSummary[]>('project.list')
      .then((list) => {
        setProjects(list);
        setOffline(false);
        return list;
      })
      .catch(() => setOffline(true));
  }
  useEffect(() => {
    loadProjects();
  }, []);

  // Load a project's spec detail + topology together so the graph is visible immediately. Reused
  // by the drill-in effect and after a domain change, so the view always reflects the live spec.
  const loadDetail = useCallback(
    (id: string) => {
      trpcQuery<ProjectDetail>('project.detail', { projectId: id }).then(setDetail).catch(() => setOffline(true));
      trpcQuery<TopoResponse>('project.topology', { projectId: id })
        .then((data) => {
          setNodes(
            data.nodes.map((n) => ({
              id: n.id,
              position: n.position,
              type: 'portless',
              data: { kind: n.kind, label: n.label, subtype: n.subtype, meta: n.meta },
            })),
          );
          setEdges(
            data.edges.map((e) => ({
              id: e.id,
              source: e.source,
              target: e.target,
              label: e.label,
              animated: e.kind === 'connects' || e.kind === 'ingress',
              style: {
                stroke: e.kind === 'ingress' ? '#f97316' : e.kind === 'connects' ? '#8b5cf6' : e.latencySensitive ? '#0ea5e9' : '#a1a1aa',
                strokeWidth: e.latencySensitive ? 2.5 : 1.5,
              },
              labelStyle: { fontSize: 11, fill: '#52525b' },
              labelBgStyle: { fill: '#fff', fillOpacity: 0.85 },
            })),
          );
        })
        .catch(() => setOffline(true));
    },
    [setNodes, setEdges],
  );

  useEffect(() => {
    if (!selected) {
      setDetail(null);
      setNodes([]);
      setEdges([]);
      return;
    }
    loadDetail(selected);
  }, [selected, loadDetail, setNodes, setEdges]);

  // Refresh both the detail view and the list (domain counts) after a spec change.
  async function refreshAfterDomainChange() {
    if (selected) loadDetail(selected);
    await loadProjects();
  }

  async function removeDomain(hostname: string) {
    if (!selected) return;
    if (!window.confirm(`Detach ${hostname} from this project?\n\nThis only edits the project spec — it does NOT delete the DNS record in Cloudflare.`)) return;
    type RemoveResult = { ok: boolean; errors?: Array<{ path: string; message: string }> };
    try {
      const res = await trpcMutation<RemoveResult>('project.removeDomain', { projectId: selected, hostname });
      if (res.ok) {
        toast.success(`Detached ${hostname}`);
        await refreshAfterDomainChange();
      } else {
        toast.error(res.errors?.map((e) => `${e.path}: ${e.message}`).join('; ') ?? 'Could not detach domain');
      }
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  async function deleteProject() {
    if (!selected || !detail) return;
    if (!window.confirm(`Delete project ${detail.project}/${detail.environment}?\n\nThis removes it from Portless. It does NOT tear down any Cloudflare DNS its domains may have routed.`)) return;
    try {
      await trpcMutation<{ ok: boolean }>('project.delete', { projectId: selected, confirm: true });
      toast.success(`Deleted ${detail.project}/${detail.environment}`);
      setSelected(null);
      await loadProjects();
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  function openDomainDialog() {
    setDHostname('');
    setDService(detail?.services[0]?.name ?? '');
    setDRoute(false);
    setDTunnel('');
    setTunnels([]);
    setTunnelsState('idle');
    setDomainOpen(true);
  }

  // Load the account's real Cloudflare tunnels so the user can pick which one to route the domain
  // at. Lazy: only when they opt into routing (most domain adds are spec-only).
  function loadTunnels() {
    setTunnelsState('loading');
    trpcQuery<{ ok: boolean; reason?: string; tunnels: Array<{ name: string; id: string; status: string }> }>('cloudflare.tunnels')
      .then((r) => {
        setTunnels(r.ok ? r.tunnels : []);
        setTunnelsState(r.ok ? 'ok' : 'error');
      })
      .catch(() => setTunnelsState('error'));
  }

  function toggleRoute(on: boolean) {
    setDRoute(on);
    if (on && tunnelsState === 'idle') loadTunnels();
  }

  async function submitDomain() {
    if (!selected) return;
    setDBusy(true);
    type AddResult = { ok: boolean; errors?: Array<{ path: string; message: string }>; route?: { ok: boolean; message: string } | null };
    try {
      const res = await trpcMutation<AddResult>('project.addDomain', {
        projectId: selected,
        hostname: dHostname.trim(),
        service: dService,
        route: dRoute,
        tunnel: dRoute ? dTunnel : undefined,
        confirm: dRoute, // routing mutates the real Cloudflare account; opting in IS the confirm
      });
      if (!res.ok) {
        toast.error(res.errors?.map((e) => `${e.path}: ${e.message}`).join('; ') ?? 'Could not add domain');
        return;
      }
      if (res.route && !res.route.ok) toast.warning(`Domain attached, but Cloudflare routing failed: ${res.route.message}`);
      else if (res.route?.ok) toast.success(`Added ${dHostname.trim()} · ${res.route.message}`);
      else toast.success(`Added ${dHostname.trim()}`);
      setDomainOpen(false);
      await refreshAfterDomainChange();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setDBusy(false);
    }
  }

  type ImportResult = { ok: boolean; id?: string; collision?: boolean; errors?: Array<{ path: string; message: string }> };

  async function runImport(replace: boolean): Promise<boolean> {
    const res = await trpcMutation<ImportResult>('project.import', { yaml, replace });
    if (res.ok) {
      toast.success(`${replace ? 'Replaced' : 'Imported'} ${res.id}`);
      setImportOpen(false);
      await loadProjects();
      setSelected(res.id ?? null); // drill straight into the project
      return true;
    }
    if (res.collision) {
      // Never silently clobber an existing project (or flip a seeded example) — confirm first.
      if (window.confirm(`Project ${res.id} already exists. Replace it?`)) return runImport(true);
      return false;
    }
    toast.error(res.errors?.map((e) => `${e.path}: ${e.message}`).join('; ') ?? 'Invalid spec');
    return false;
  }

  async function importProject() {
    setBusy(true);
    try {
      await runImport(false);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (offline) {
    return (
      <Card>
        <CardHeader className="text-center">
          <CardTitle>Control plane offline</CardTitle>
          <CardDescription>Start the API to load your projects.</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  // ---- Detail view ----
  if (selected && detail) {
    return (
      <div className="space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <Button variant="outline" size="sm" onClick={() => setSelected(null)}>
              <ArrowLeft className="size-4" /> Projects
            </Button>
            <div>
              <h2 className="flex items-center gap-2 text-xl font-semibold tracking-tight">
                {detail.project} <span className="text-muted-foreground font-normal">/ {detail.environment}</span>
                <SourceBadge source={detail.source} />
              </h2>
              <p className="text-muted-foreground text-sm">
                {detail.services.length} service{detail.services.length === 1 ? '' : 's'} · {detail.domains.length} domain
                {detail.domains.length === 1 ? '' : 's'}
                {detail.network ? ` · overlay ${detail.network.overlayCidr}` : ''}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-4">
            <Legend />
            <Button variant="ghost" size="sm" className="text-muted-foreground hover:text-destructive" onClick={deleteProject}>
              <Trash2 className="size-4" /> Delete
            </Button>
          </div>
        </div>

        {/* Topology is the anchor — visible immediately. */}
        <div className="h-[52vh] w-full overflow-hidden rounded-xl border">
          <ReactFlow
            key={selected}
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            nodeTypes={nodeTypes}
            fitView
            fitViewOptions={{ padding: 0.25 }}
            minZoom={0.3}
            proOptions={{ hideAttribution: true }}
          >
            <Background gap={20} color="#e4e4e7" />
            <Controls showInteractive={false} />
            <MiniMap
              position="top-right"
              zoomable
              pannable
              className="!m-3 rounded-md border shadow-sm"
              style={{ width: 150, height: 96 }}
              nodeColor={(n) => (n.data?.kind === 'ingress' ? '#f97316' : n.data?.kind === 'resource' ? '#8b5cf6' : '#18181b')}
            />
          </ReactFlow>
        </div>

        {/* Spec summary — explains what the graph means. All derived from the parsed portless.yaml. */}
        <div className="grid gap-5 lg:grid-cols-3">
          {/* min-w-0: let the grid item shrink below the table's intrinsic width on mobile, so the
              table's own overflow-x-auto scrolls instead of widening the whole page. */}
          <Card className="lg:col-span-2 min-w-0 py-0">
            <CardHeader className="px-6 pt-5 pb-0">
              <CardTitle className="text-base">Services</CardTitle>
            </CardHeader>
            <CardContent className="px-0 pt-3">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="pl-6">Service</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead>Replicas</TableHead>
                    <TableHead>Port</TableHead>
                    <TableHead>Resources</TableHead>
                    <TableHead className="pr-6">Connects to</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {detail.services.map((s) => (
                    <TableRow key={s.name}>
                      <TableCell className="pl-6 font-medium">
                        {s.name}
                        <div className="text-muted-foreground font-mono text-xs">{s.image}</div>
                      </TableCell>
                      <TableCell>
                        <Badge variant="secondary">{s.type}</Badge>
                      </TableCell>
                      <TableCell className="tabular-nums">{s.replicas}×</TableCell>
                      <TableCell className="tabular-nums">{s.port ?? '—'}</TableCell>
                      <TableCell className="text-muted-foreground text-xs">
                        {s.cpu}m cpu · {s.memoryMb}MB{s.healthPath ? ` · ${s.healthPath}` : ''}
                      </TableCell>
                      <TableCell className="pr-6">
                        <span className="flex flex-wrap gap-1">
                          {s.dependencies.map((d) => (
                            <Badge key={`d-${d}`} variant="outline">
                              {d}
                            </Badge>
                          ))}
                          {s.connections.map((c) => (
                            <Badge key={`c-${c.to}`} variant="outline" className="border-violet-300 text-violet-700">
                              {c.to}
                              {c.provider ? ` (${c.provider})` : ''}
                            </Badge>
                          ))}
                          {s.dependencies.length === 0 && s.connections.length === 0 && <span className="text-muted-foreground text-xs">—</span>}
                        </span>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>

          <div className="space-y-5">
            <Card>
              <CardHeader className="flex-row items-center justify-between space-y-0 pb-3">
                <CardTitle className="text-base">Domains</CardTitle>
                <Button variant="outline" size="sm" className="h-7" onClick={openDomainDialog}>
                  <Plus className="size-3.5" /> Add
                </Button>
              </CardHeader>
              <CardContent className="space-y-2">
                {detail.domains.length === 0 ? (
                  <p className="text-muted-foreground text-sm">
                    No public domains yet. Add one — Portless attaches it to the spec and can route it via a Cloudflare tunnel.
                  </p>
                ) : (
                  detail.domains.map((d) => (
                    <div key={d.hostname} className="flex items-center justify-between gap-2 text-sm">
                      <span className="min-w-0 truncate font-mono text-xs">{d.hostname}</span>
                      <span className="flex shrink-0 items-center gap-2">
                        <span className="text-muted-foreground text-xs">→ {d.service}</span>
                        <button
                          onClick={() => removeDomain(d.hostname)}
                          className="text-muted-foreground hover:text-destructive transition-colors"
                          title="Detach domain"
                          aria-label={`Detach ${d.hostname}`}
                        >
                          <Trash2 className="size-3.5" />
                        </button>
                      </span>
                    </div>
                  ))
                )}
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base">Network</CardTitle>
              </CardHeader>
              <CardContent className="text-sm">
                {detail.network ? (
                  <dl className="space-y-1">
                    <Row k="Provider" v={detail.network.provider} />
                    <Row k="Overlay CIDR" v={detail.network.overlayCidr} mono />
                    <Row k="Container subnets" v={detail.network.containerSubnetStrategy} mono />
                  </dl>
                ) : (
                  <p className="text-muted-foreground">Defaults (netmaker, 10.88.0.0/16).</p>
                )}
              </CardContent>
            </Card>
          </div>
        </div>

        <Dialog open={domainOpen} onOpenChange={(o) => !dBusy && setDomainOpen(o)}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Add a domain</DialogTitle>
              <DialogDescription>
                Attach a hostname to {detail.project}. Portless adds it to the spec; optionally it also routes the DNS at a Cloudflare tunnel
                so the name resolves to your private machine — no public IP needed.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4 py-2">
              <div className="space-y-1.5">
                <label className="text-sm font-medium">Hostname</label>
                <Input value={dHostname} onChange={(e) => setDHostname(e.target.value)} placeholder="app.example.com" autoFocus className="font-mono text-xs" />
              </div>
              <div className="space-y-1.5">
                <label className="text-sm font-medium">Routes to service</label>
                <select
                  value={dService}
                  onChange={(e) => setDService(e.target.value)}
                  className="border-input bg-transparent flex h-9 w-full rounded-md border px-3 py-1 text-sm shadow-xs outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
                >
                  {detail.services.map((s) => (
                    <option key={s.name} value={s.name}>
                      {s.name}
                      {s.port ? ` (:${s.port})` : ''}
                    </option>
                  ))}
                </select>
              </div>
              <label className="flex items-start gap-2.5 rounded-md border p-3 text-sm">
                <input type="checkbox" checked={dRoute} onChange={(e) => toggleRoute(e.target.checked)} className="mt-0.5 size-4" />
                <span>
                  <span className="font-medium">Route it now via Cloudflare</span>
                  <span className="text-muted-foreground block text-xs">
                    Creates a real DNS record (CNAME → the tunnel) in your Cloudflare account. Leave off to just declare the domain in the spec.
                  </span>
                </span>
              </label>
              {dRoute && (
                <div className="space-y-1.5">
                  <label className="text-sm font-medium">Cloudflare tunnel</label>
                  {tunnelsState === 'loading' && <p className="text-muted-foreground text-xs">Loading your tunnels…</p>}
                  {tunnelsState === 'error' && (
                    <p className="text-destructive text-xs">Could not list tunnels (cloudflared not installed or not logged in). The domain can still be added to the spec.</p>
                  )}
                  {tunnelsState === 'ok' && tunnels.length === 0 && (
                    <p className="text-muted-foreground text-xs">No tunnels found. Create one on the Cloudflare page first.</p>
                  )}
                  {tunnelsState === 'ok' && tunnels.length > 0 && (
                    <select
                      value={dTunnel}
                      onChange={(e) => setDTunnel(e.target.value)}
                      className="border-input bg-transparent flex h-9 w-full rounded-md border px-3 py-1 text-sm shadow-xs outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
                    >
                      <option value="" disabled>
                        Select a tunnel…
                      </option>
                      {tunnels.map((t) => (
                        <option key={t.id} value={t.name}>
                          {t.name} · {t.status}
                        </option>
                      ))}
                    </select>
                  )}
                </div>
              )}
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setDomainOpen(false)} disabled={dBusy}>
                Cancel
              </Button>
              <Button onClick={submitDomain} disabled={dBusy || !dHostname.trim() || !dService || (dRoute && !dTunnel)}>
                {dBusy ? 'Adding…' : dRoute ? 'Add & route' : 'Add domain'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    );
  }

  // ---- List view ----
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold tracking-tight">Projects</h2>
          <p className="text-muted-foreground text-sm">
            Your declared projects. Open one to see its topology and spec. Examples are seeded starters — labeled, not disguised as yours.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => setImportOpen(true)}>
          <Plus className="size-4" /> Import project
        </Button>
      </div>

      {projects.length === 0 ? (
        <Card>
          <CardHeader className="items-center text-center">
            <FolderOpen className="text-muted-foreground mb-1 size-7" />
            <CardTitle className="text-base">No projects yet</CardTitle>
            <CardDescription>Import a portless.yaml to define your first project. No sample rows are shown.</CardDescription>
          </CardHeader>
        </Card>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {projects.map((p) => (
            <button
              key={p.id}
              onClick={() => setSelected(p.id)}
              className="hover:border-ring focus-visible:ring-ring/50 group rounded-xl border bg-card p-4 text-left shadow-xs transition-colors focus-visible:ring-[3px] focus-visible:outline-none"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="truncate font-semibold">{p.project}</div>
                  <div className="text-muted-foreground text-xs">{p.environment}</div>
                </div>
                <SourceBadge source={p.source} />
              </div>
              <div className="text-muted-foreground mt-4 flex items-center gap-3 text-sm">
                <span className="inline-flex items-center gap-1">
                  <Server className="size-3.5" /> {p.services} service{p.services === 1 ? '' : 's'}
                </span>
                <span className="inline-flex items-center gap-1">
                  <Globe className="size-3.5" /> {p.domains} domain{p.domains === 1 ? '' : 's'}
                </span>
              </div>
            </button>
          ))}
        </div>
      )}

      <Dialog open={importOpen} onOpenChange={(o) => !busy && setImportOpen(o)}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Import a project</DialogTitle>
            <DialogDescription>
              Paste a portless.yaml spec. It parses into services, dependencies and domains, then opens as a new project with its topology.
            </DialogDescription>
          </DialogHeader>
          <Textarea value={yaml} onChange={(e) => setYaml(e.target.value)} spellCheck={false} className="h-80 font-mono text-xs" />
          <DialogFooter>
            <Button variant="outline" onClick={() => setImportOpen(false)} disabled={busy}>
              Cancel
            </Button>
            <Button onClick={importProject} disabled={busy || !yaml.trim()}>
              {busy ? 'Importing…' : 'Import'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function Row({ k, v, mono }: { k: string; v: string; mono?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <dt className="text-muted-foreground">{k}</dt>
      <dd className={mono ? 'font-mono text-xs' : ''}>{v}</dd>
    </div>
  );
}

function Legend() {
  const items = [
    { c: 'bg-orange-500', l: 'Ingress' },
    { c: 'bg-zinc-900', l: 'Service' },
    { c: 'bg-violet-500', l: 'External resource' },
  ];
  return (
    <div className="flex gap-4">
      {items.map((i) => (
        <span key={i.l} className="text-muted-foreground flex items-center gap-1.5 text-xs">
          <span className={`size-2.5 rounded-full ${i.c}`} />
          {i.l}
        </span>
      ))}
    </div>
  );
}
