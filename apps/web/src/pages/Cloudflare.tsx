import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Cloud, CheckCircle2, XCircle, Plus, Link2, RefreshCw, Globe } from 'lucide-react';
import { trpcQuery, trpcMutation } from '@/api';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';

interface PendingMutation {
  title: string;
  body: string;
  phrase: string;
  successMsg: string;
  clearOnSuccess: () => void;
  run: () => Promise<{ ok: boolean; message?: string }>;
}

interface CfStatus {
  installed: boolean;
  authenticated: boolean;
  version: string | null;
  certPath: string;
}
interface CfTunnel {
  id: string;
  name: string;
  createdAt: string;
  connections: number;
  colos: string[];
  status: 'healthy' | 'inactive';
}
interface TunnelsResp {
  ok: boolean;
  reason?: string;
  tunnels: CfTunnel[];
}

export function Cloudflare() {
  const [status, setStatus] = useState<CfStatus | null>(null);
  const [resp, setResp] = useState<TunnelsResp | null>(null);
  const [loading, setLoading] = useState(true);
  const [newName, setNewName] = useState('');
  const [routeTunnel, setRouteTunnel] = useState('');
  const [hostname, setHostname] = useState('');
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<PendingMutation | null>(null);
  const [confirmText, setConfirmText] = useState('');

  async function refresh() {
    setLoading(true);
    try {
      const [s, t] = await Promise.all([trpcQuery<CfStatus>('cloudflare.status'), trpcQuery<TunnelsResp>('cloudflare.tunnels')]);
      setStatus(s);
      setResp(t);
      if (t.tunnels[0] && !routeTunnel) setRouteTunnel(t.tunnels[0].name);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Real-account mutations are gated behind a type-to-confirm dialog — a single click never
  // creates a tunnel or DNS record. requestX validates, then opens the dialog; confirmPending
  // runs the mutation only after the user re-types the exact name/hostname.
  function requestCreate() {
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(newName)) return toast.error('Name: lowercase letters, digits, dashes');
    setConfirmText('');
    setPending({
      title: 'Create Cloudflare tunnel',
      body: `This creates a real tunnel "${newName}" on your Cloudflare account.`,
      phrase: newName,
      successMsg: `Created tunnel ${newName}`,
      clearOnSuccess: () => setNewName(''),
      run: () => trpcMutation<{ ok: boolean; message?: string }>('cloudflare.createTunnel', { name: newName, confirm: true }),
    });
  }

  function requestRoute() {
    if (!routeTunnel) return toast.error('Pick a tunnel');
    if (!/^([a-z0-9-]+\.)+[a-z]{2,}$/i.test(hostname)) return toast.error('Enter a valid hostname');
    setConfirmText('');
    setPending({
      title: 'Route a domain through a tunnel',
      body: `This creates a real DNS record so ${hostname} resolves through "${routeTunnel}".`,
      phrase: hostname,
      successMsg: `${hostname} → ${routeTunnel}`,
      clearOnSuccess: () => setHostname(''),
      run: () => trpcMutation<{ ok: boolean; message?: string }>('cloudflare.routeDns', { tunnel: routeTunnel, hostname, confirm: true }),
    });
  }

  async function confirmPending() {
    if (!pending) return;
    setBusy(true);
    try {
      const res = await pending.run();
      toast[res.ok ? 'success' : 'error'](res.ok ? pending.successMsg : (res.message ?? 'failed (see server logs)'));
      if (res.ok) {
        pending.clearOnSuccess();
        refresh();
      }
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
      setPending(null);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold tracking-tight">Cloudflare</h2>
          <p className="text-muted-foreground text-sm">
            Public ingress for portless machines. Manages real Tunnels + DNS routes via your local <code>cloudflared</code> auth — no extra login.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={refresh} disabled={loading}>
          <RefreshCw className={loading ? 'animate-spin' : ''} /> Refresh
        </Button>
      </div>

      {/* Auth / install status, read straight off the local cloudflared. */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Cloud className="size-4" /> Local cloudflared
          </CardTitle>
          <CardDescription>{status?.certPath}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-6 text-sm">
          <StatusPill ok={!!status?.installed} label={status?.installed ? `installed · ${status.version}` : 'not installed'} />
          <StatusPill ok={!!status?.authenticated} label={status?.authenticated ? 'authenticated (cert.pem)' : 'not logged in'} />
          {!status?.authenticated && status?.installed && (
            <span className="text-muted-foreground">
              Run <code>cloudflared tunnel login</code> to authenticate.
            </span>
          )}
        </CardContent>
      </Card>

      {/* Real tunnels on this account. */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Tunnels</CardTitle>
          <CardDescription>
            {resp?.ok ? `${resp.tunnels.length} tunnels on your account` : (resp?.reason ?? 'Loading…')}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {resp?.ok && resp.tunnels.length > 0 ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Connections</TableHead>
                  <TableHead>Edge colos</TableHead>
                  <TableHead className="text-right">ID</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {resp.tunnels.map((t) => (
                  <TableRow key={t.id}>
                    <TableCell className="font-medium">{t.name}</TableCell>
                    <TableCell>
                      <Badge variant={t.status === 'healthy' ? 'default' : 'secondary'}>{t.status}</Badge>
                    </TableCell>
                    <TableCell>{t.connections}</TableCell>
                    <TableCell className="text-muted-foreground">{t.colos.join(', ') || '—'}</TableCell>
                    <TableCell className="text-muted-foreground text-right font-mono text-xs">{t.id.slice(0, 8)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <div className="text-muted-foreground py-8 text-center text-sm">{resp?.reason ?? 'No tunnels.'}</div>
          )}
        </CardContent>
      </Card>

      <div className="grid gap-6 md:grid-cols-2">
        {/* Create a real tunnel. */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Plus className="size-4" /> Create tunnel
            </CardTitle>
            <CardDescription>Provisions a new named tunnel on your Cloudflare account.</CardDescription>
          </CardHeader>
          <CardContent className="flex gap-2">
            <Input placeholder="my-tunnel" value={newName} onChange={(e) => setNewName(e.target.value)} disabled={busy || !status?.authenticated} />
            <Button onClick={requestCreate} disabled={busy || !newName || !status?.authenticated}>
              Create
            </Button>
          </CardContent>
        </Card>

        {/* Route a hostname to a tunnel — real DNS, the domain-management piece. */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Link2 className="size-4" /> Route a domain
            </CardTitle>
            <CardDescription>Creates a CNAME so a hostname resolves through a tunnel.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            <div className="flex gap-2">
              <select
                value={routeTunnel}
                onChange={(e) => setRouteTunnel(e.target.value)}
                disabled={busy || !status?.authenticated}
                className="border-input bg-background h-9 shrink-0 rounded-md border px-3 text-sm shadow-xs outline-none disabled:opacity-50"
              >
                {resp?.tunnels.map((t) => (
                  <option key={t.id} value={t.name}>
                    {t.name}
                  </option>
                ))}
              </select>
              <Input placeholder="shop.example.com" value={hostname} onChange={(e) => setHostname(e.target.value)} disabled={busy || !status?.authenticated} />
            </div>
            <Button className="w-full" onClick={requestRoute} disabled={busy || !hostname || !status?.authenticated}>
              <Globe /> Route {hostname || 'hostname'} → {routeTunnel || 'tunnel'}
            </Button>
          </CardContent>
        </Card>
      </div>

      {/* Type-to-confirm gate for real-account mutations. */}
      <Dialog open={!!pending} onOpenChange={(o) => !o && !busy && setPending(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{pending?.title}</DialogTitle>
            <DialogDescription>{pending?.body} This affects your real Cloudflare account.</DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <p className="text-sm">
              Type <code className="bg-muted rounded px-1 py-0.5 font-mono text-xs">{pending?.phrase}</code> to confirm:
            </p>
            <Input
              autoFocus
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
              placeholder={pending?.phrase}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && confirmText === pending?.phrase && !busy) confirmPending();
              }}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPending(null)} disabled={busy}>
              Cancel
            </Button>
            <Button onClick={confirmPending} disabled={busy || confirmText !== pending?.phrase}>
              {busy ? 'Working…' : 'Confirm'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function StatusPill({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span className="flex items-center gap-1.5">
      {ok ? <CheckCircle2 className="size-4 text-emerald-600" /> : <XCircle className="text-destructive size-4" />}
      {label}
    </span>
  );
}
