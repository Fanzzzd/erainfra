import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Plus, Trash2, Tag } from 'lucide-react';
import { trpcQuery, trpcMutation, type MachineRow } from '@/api';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';

const ROLES = ['gateway', 'worker', 'database', 'edge', 'relay'] as const;

function RoleToggles({ value, onChange }: { value: string[]; onChange: (next: string[]) => void }) {
  return (
    <div className="flex flex-wrap gap-2">
      {ROLES.map((r) => {
        const on = value.includes(r);
        return (
          <button
            key={r}
            type="button"
            onClick={() => onChange(on ? value.filter((x) => x !== r) : [...value, r])}
            className={`rounded-md border px-2.5 py-1 text-xs font-medium transition-colors ${
              on ? 'border-zinc-900 bg-zinc-900 text-white' : 'border-input text-muted-foreground hover:bg-muted'
            }`}
          >
            {r}
          </button>
        );
      })}
    </div>
  );
}

export function Machines() {
  const [machines, setMachines] = useState<MachineRow[]>([]);
  const [offline, setOffline] = useState(false);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState('');
  const [region, setRegion] = useState('');
  const [pubkey, setPubkey] = useState('');
  // Per-machine role assignment (roles are set after enrollment, not at enroll time).
  const [editing, setEditing] = useState<MachineRow | null>(null);
  const [editRoles, setEditRoles] = useState<string[]>([]);

  function refresh() {
    trpcQuery<MachineRow[]>('machines.list')
      .then((m) => {
        setMachines(m);
        setOffline(false);
      })
      .catch(() => setOffline(true));
  }
  useEffect(refresh, []);

  async function enroll() {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) return toast.error('Name: lowercase letters, digits, dashes');
    if (!region.trim()) return toast.error('Enter a region');
    if (!/^[A-Za-z0-9+/]{43}=$/.test(pubkey.trim())) return toast.error('WireGuard public key: 44-char base64 (run `wg genkey | wg pubkey`)');
    setBusy(true);
    try {
      const res = await trpcMutation<{ machine: { name: string; wgIp: string; containerSubnet: string } }>('machines.enroll', {
        name,
        region: region.trim(),
        publicKey: pubkey.trim(),
      });
      toast.success(`Enrolled ${res.machine.name} → ${res.machine.wgIp} (${res.machine.containerSubnet}). Assign roles from its row.`);
      setOpen(false);
      setName('');
      setRegion('');
      setPubkey('');
      refresh();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function saveRoles() {
    if (!editing) return;
    setBusy(true);
    try {
      await trpcMutation('machines.setRoles', { id: editing.id, roles: editRoles });
      toast.success(editRoles.length ? `${editing.name}: ${editRoles.join(', ')}` : `${editing.name}: roles cleared`);
      setEditing(null);
      refresh();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function revoke(m: MachineRow) {
    if (!window.confirm(`Revoke ${m.name} (${m.wgIp}) from the fabric?`)) return;
    try {
      await trpcMutation('machines.revoke', { id: m.id, confirm: true });
      toast.success(`Revoked ${m.name}`);
      refresh();
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold tracking-tight">Machines</h2>
          <p className="text-muted-foreground text-sm">
            This machine is real (read live from the OS). Enroll a peer — it gets a real WireGuard IP + container subnet — then assign it
            one or more roles.
          </p>
        </div>
        <Button onClick={() => setOpen(true)} disabled={offline}>
          <Plus className="size-4" /> Enroll machine
        </Button>
      </div>
      {offline ? (
        <Card>
          <CardHeader className="text-center">
            <CardTitle>Control plane offline</CardTitle>
            <CardDescription>Start the API to load the fabric.</CardDescription>
          </CardHeader>
        </Card>
      ) : (
        <Card className="py-0">
          <CardContent className="px-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-6">Machine</TableHead>
                  <TableHead>Roles</TableHead>
                  <TableHead>Region</TableHead>
                  <TableHead>WG IP</TableHead>
                  <TableHead>Container subnet</TableHead>
                  <TableHead className="pr-6">State</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {machines.map((m) => (
                  <TableRow key={m.id}>
                    <TableCell className="pl-6 font-medium">
                      <span className="flex items-center gap-2">
                        {m.name}
                        {m.kind === 'self' ? (
                          <Badge className="bg-emerald-600 hover:bg-emerald-600">this machine</Badge>
                        ) : (
                          <Badge variant="outline">enrolled</Badge>
                        )}
                      </span>
                    </TableCell>
                    <TableCell className="py-3">
                      <span className="flex flex-wrap items-center gap-1">
                        {m.roles?.length ? (
                          m.roles.map((r) => (
                            <Badge key={r} variant="secondary">
                              {r}
                            </Badge>
                          ))
                        ) : (
                          <span className="text-muted-foreground text-xs">unassigned</span>
                        )}
                        {m.kind === 'enrolled' && (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="text-muted-foreground h-6 px-1.5"
                            onClick={() => {
                              setEditing(m);
                              setEditRoles(m.roles ?? []);
                            }}
                          >
                            <Tag className="size-3.5" />
                          </Button>
                        )}
                      </span>
                    </TableCell>
                    <TableCell className="text-muted-foreground">{m.region}</TableCell>
                    <TableCell className="font-mono text-xs">{m.wgIp}</TableCell>
                    <TableCell className="font-mono text-xs">{m.containerSubnet}</TableCell>
                    <TableCell className="pr-6">
                      {m.kind === 'self' ? (
                        <Badge variant={m.online ? 'default' : 'secondary'}>{m.online ? 'online' : 'offline'}</Badge>
                      ) : (
                        <Button variant="ghost" size="sm" className="text-muted-foreground hover:text-red-600" onClick={() => revoke(m)}>
                          <Trash2 className="size-4" /> Revoke
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      {/* Enroll: identity + key only. Roles come later. */}
      <Dialog open={open} onOpenChange={(o) => !busy && setOpen(o)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Enroll a machine</DialogTitle>
            <DialogDescription>The fabric allocates a WireGuard IP (10.88.0.x) and container subnet (10.210.x.0/24). Assign roles afterward.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Name</label>
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="sg-worker-1" autoFocus />
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Region</label>
              <Input value={region} onChange={(e) => setRegion(e.target.value)} placeholder="sg / home / aws-ap-southeast-1" />
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium">WireGuard public key</label>
              <Input
                value={pubkey}
                onChange={(e) => setPubkey(e.target.value)}
                placeholder="run `wg genkey | wg pubkey` on the peer"
                className="font-mono text-xs"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)} disabled={busy}>
              Cancel
            </Button>
            <Button onClick={enroll} disabled={busy || !name || !region || !pubkey}>
              {busy ? 'Enrolling…' : 'Enroll'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Assign roles to an already-enrolled machine (multi-select). */}
      <Dialog open={!!editing} onOpenChange={(o) => !busy && !o && setEditing(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Roles for {editing?.name}</DialogTitle>
            <DialogDescription>A machine can carry several roles. Toggle them and save.</DialogDescription>
          </DialogHeader>
          <div className="py-2">
            <RoleToggles value={editRoles} onChange={setEditRoles} />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditing(null)} disabled={busy}>
              Cancel
            </Button>
            <Button onClick={saveRoles} disabled={busy}>
              {busy ? 'Saving…' : 'Save roles'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
