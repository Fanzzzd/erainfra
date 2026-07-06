import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Copy, KeyRound, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { trpcQuery, trpcMutation, type ApiTokenInfo, type AuthUser, type SessionInfo, type UserInfo } from '@/api';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

const when = (iso?: string) => (iso ? new Date(iso).toLocaleString() : '—');

function ChangeEmail({ me }: { me: AuthUser }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [current, setCurrent] = useState(me.email);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const r = await trpcMutation<{ user: { email: string } }>('account.changeEmail', { password, email });
      toast.success(`Email changed to ${r.user.email}`);
      setCurrent(r.user.email);
      setEmail('');
      setPassword('');
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Email</CardTitle>
        <CardDescription>You sign in with this address{current ? ` — currently ${current}` : ''}.</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} className="flex max-w-md flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="em-new">New email</Label>
            <Input id="em-new" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="em-pw">Current password</Label>
            <Input id="em-pw" type="password" required value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
          </div>
          <Button type="submit" disabled={busy} className="self-start">
            Change email
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

function ChangePassword() {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await trpcMutation('account.changePassword', { current, next });
      toast.success('Password changed — other sessions were signed out');
      setCurrent('');
      setNext('');
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Password</CardTitle>
        <CardDescription>Changing it signs out every other session.</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} className="flex max-w-md flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="pw-current">Current password</Label>
            <Input id="pw-current" type="password" required value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="pw-next">New password</Label>
            <Input id="pw-next" type="password" required minLength={8} value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" />
          </div>
          <Button type="submit" disabled={busy} className="self-start">
            Change password
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

function ApiTokens() {
  const [tokens, setTokens] = useState<ApiTokenInfo[]>([]);
  const [name, setName] = useState('');
  const [role, setRole] = useState('operator');
  // A freshly minted token value — shown exactly once, never retrievable again.
  const [minted, setMinted] = useState<{ name: string; token: string } | null>(null);

  const refresh = useCallback(() => trpcQuery<ApiTokenInfo[]>('account.tokens.list').then(setTokens).catch(() => {}), []);
  useEffect(() => { refresh(); }, [refresh]);

  const create = async (e: FormEvent) => {
    e.preventDefault();
    try {
      const r = await trpcMutation<{ token: string; record: ApiTokenInfo }>('account.tokens.create', { name, role });
      setMinted({ name: r.record.name, token: r.token });
      setName('');
      refresh();
    } catch (err) {
      toast.error((err as Error).message);
    }
  };

  const revoke = async (t: ApiTokenInfo) => {
    if (!window.confirm(`Revoke "${t.name}"? Anything using it loses access immediately.`)) return;
    try {
      await trpcMutation('account.tokens.revoke', { id: t.id });
      toast.success(`Revoked ${t.name}`);
      refresh();
    } catch (err) {
      toast.error((err as Error).message);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>API tokens</CardTitle>
        <CardDescription>Bearer credentials for the CLI, node enrollment, and CI. The value is shown once at creation.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <form onSubmit={create} className="flex flex-wrap items-end gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="tok-name">Name</Label>
            <Input id="tok-name" required value={name} onChange={(e) => setName(e.target.value)} placeholder="node my-server" className="w-56" />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="tok-role">Role</Label>
            <select
              id="tok-role"
              value={role}
              onChange={(e) => setRole(e.target.value)}
              className="border-input bg-transparent h-9 rounded-md border px-3 text-sm shadow-xs"
            >
              <option value="operator">operator (deploy + agents)</option>
              <option value="viewer">viewer (read-only)</option>
              <option value="admin">admin</option>
              <option value="owner">owner</option>
            </select>
          </div>
          <Button type="submit">
            <KeyRound /> Create token
          </Button>
        </form>

        {minted && (
          <div className="bg-muted flex items-center justify-between gap-3 rounded-md p-3">
            <div className="min-w-0">
              <div className="text-sm font-medium">{minted.name} — copy it now, it won't be shown again</div>
              <code className="text-muted-foreground block truncate text-xs">{minted.token}</code>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => navigator.clipboard.writeText(minted.token).then(() => toast.success('Copied'))}
            >
              <Copy /> Copy
            </Button>
          </div>
        )}

        {tokens.length > 0 && (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Token</TableHead>
                <TableHead>Role</TableHead>
                <TableHead>Last used</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {tokens.map((t) => (
                <TableRow key={t.id}>
                  <TableCell className="font-medium">{t.name}</TableCell>
                  <TableCell className="text-muted-foreground font-mono text-xs">{t.prefix}…</TableCell>
                  <TableCell>
                    <Badge variant="secondary">{t.roles.join(', ')}</Badge>
                  </TableCell>
                  <TableCell className="text-muted-foreground text-xs">{when(t.lastUsedAt)}</TableCell>
                  <TableCell className="text-right">
                    <Button variant="ghost" size="sm" onClick={() => revoke(t)}>
                      <Trash2 className="text-destructive" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

function Users({ me }: { me: AuthUser }) {
  const [users, setUsers] = useState<UserInfo[]>([]);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState('viewer');

  const refresh = useCallback(() => trpcQuery<UserInfo[]>('account.users.list').then(setUsers).catch(() => {}), []);
  useEffect(() => { refresh(); }, [refresh]);

  const create = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await trpcMutation('account.users.create', { email, password, role });
      toast.success(`Added ${email}`);
      setEmail('');
      setPassword('');
      refresh();
    } catch (err) {
      toast.error((err as Error).message);
    }
  };

  const remove = async (u: UserInfo) => {
    if (!window.confirm(`Remove ${u.email}? Their sessions end immediately.`)) return;
    try {
      await trpcMutation('account.users.remove', { id: u.id, confirm: true });
      toast.success(`Removed ${u.email}`);
      refresh();
    } catch (err) {
      toast.error((err as Error).message);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Users</CardTitle>
        <CardDescription>Accounts that can sign in to this hub.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <form onSubmit={create} className="flex flex-wrap items-end gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="u-email">Email</Label>
            <Input id="u-email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} className="w-56" />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="u-pw">Password</Label>
            <Input id="u-pw" type="password" required minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} className="w-44" autoComplete="new-password" />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="u-role">Role</Label>
            <select
              id="u-role"
              value={role}
              onChange={(e) => setRole(e.target.value)}
              className="border-input bg-transparent h-9 rounded-md border px-3 text-sm shadow-xs"
            >
              <option value="viewer">viewer</option>
              <option value="operator">operator</option>
              <option value="admin">admin</option>
              <option value="owner">owner</option>
            </select>
          </div>
          <Button type="submit">Add user</Button>
        </form>

        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Email</TableHead>
              <TableHead>Role</TableHead>
              <TableHead>Created</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {users.map((u) => (
              <TableRow key={u.id}>
                <TableCell className="font-medium">
                  {u.name}
                  {u.id === me.id && <span className="text-muted-foreground ml-1 text-xs">(you)</span>}
                </TableCell>
                <TableCell className="text-muted-foreground">{u.email}</TableCell>
                <TableCell>
                  <Badge variant="secondary">{u.roles.join(', ')}</Badge>
                </TableCell>
                <TableCell className="text-muted-foreground text-xs">{when(u.createdAt)}</TableCell>
                <TableCell className="text-right">
                  {u.id !== me.id && (
                    <Button variant="ghost" size="sm" onClick={() => remove(u)}>
                      <Trash2 className="text-destructive" />
                    </Button>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

function Sessions() {
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const refresh = useCallback(() => trpcQuery<SessionInfo[]>('account.sessions.list').then(setSessions).catch(() => {}), []);
  useEffect(() => { refresh(); }, [refresh]);

  const revoke = async (id: string) => {
    try {
      await trpcMutation('account.sessions.revoke', { id });
      refresh();
    } catch (err) {
      toast.error((err as Error).message);
    }
  };

  if (sessions.length === 0) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Sessions</CardTitle>
        <CardDescription>Browsers currently signed in as you.</CardDescription>
      </CardHeader>
      <CardContent className="px-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="pl-6">Browser</TableHead>
              <TableHead>Signed in</TableHead>
              <TableHead>Last active</TableHead>
              <TableHead className="pr-6" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {sessions.map((s) => (
              <TableRow key={s.id}>
                <TableCell className="text-muted-foreground max-w-md truncate pl-6 text-xs">{s.userAgent ?? 'unknown'}</TableCell>
                <TableCell className="text-muted-foreground text-xs">{when(s.createdAt)}</TableCell>
                <TableCell className="text-muted-foreground text-xs">{when(s.lastSeenAt)}</TableCell>
                <TableCell className="pr-6 text-right">
                  <Button variant="ghost" size="sm" onClick={() => revoke(s.id)}>
                    <Trash2 className="text-destructive" />
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

export function Settings({ me }: { me: AuthUser }) {
  // API-token principals never reach the dashboard (no cookie), so `me` is always a real user.
  const isAdmin = me.roles.includes('owner') || me.roles.includes('admin');
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold tracking-tight">Settings</h2>
        <p className="text-muted-foreground text-sm">
          Signed in as {me.name} · {me.roles.join(', ')}
        </p>
      </div>
      <ChangeEmail me={me} />
      <ChangePassword />
      <Sessions />
      {isAdmin && <ApiTokens />}
      {isAdmin && <Users me={me} />}
    </div>
  );
}
