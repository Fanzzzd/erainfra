import { useState, type FormEvent } from 'react';
import { login, setupOwner, type AuthUser } from '@/api';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

// Login and first-boot setup share one form: setup mode adds a name field and creates THE owner
// account; afterwards the same screen is a plain password login.
export function Login({ mode, onAuthed }: { mode: 'login' | 'setup'; onAuthed: (user: AuthUser) => void }) {
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const r = mode === 'setup' ? await setupOwner(email, password, name || undefined) : await login(email, password);
      onAuthed(r.user);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="bg-background flex min-h-screen items-center justify-center p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <div className="mb-2 flex items-center gap-2">
            <div className="bg-primary text-primary-foreground flex size-8 items-center justify-center rounded-md font-bold">P</div>
            <span className="text-sm font-semibold">Portless</span>
          </div>
          <CardTitle>{mode === 'setup' ? 'Create the owner account' : 'Sign in'}</CardTitle>
          <CardDescription>
            {mode === 'setup' ? 'First boot: this account will own the instance.' : 'Use your Portless account.'}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={submit} className="flex flex-col gap-4">
            {mode === 'setup' && (
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="name">Name</Label>
                <Input id="name" value={name} onChange={(e) => setName(e.target.value)} placeholder="optional" autoComplete="name" />
              </div>
            )}
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="email">Email</Label>
              <Input id="email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" autoFocus />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="password">Password</Label>
              <Input
                id="password"
                type="password"
                required
                minLength={mode === 'setup' ? 8 : 1}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete={mode === 'setup' ? 'new-password' : 'current-password'}
              />
            </div>
            {error && <p className="text-destructive text-sm">{error}</p>}
            <Button type="submit" disabled={busy}>
              {busy ? '…' : mode === 'setup' ? 'Create account' : 'Sign in'}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
