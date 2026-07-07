import { useEffect, useState } from 'react';
import { LayoutDashboard, LogOut, MessageSquare, Server, Rocket, Settings as SettingsIcon } from 'lucide-react';
import { authMe, authStatus, logout, trpcQuery, type AuthUser } from '@/api';
import { cn } from '@/lib/utils';
import { Overview } from '@/pages/Overview';
import { Nodes } from '@/pages/Nodes';
import { Deploy } from '@/pages/Deploy';
import { Login } from '@/pages/Login';
import { Settings } from '@/pages/Settings';
import { Chats } from '@/pages/Chats';

type View = 'overview' | 'deploy' | 'nodes' | 'chats' | 'settings';

const NAV: Array<{ id: View; label: string; icon: typeof Server }> = [
  { id: 'overview', label: 'Overview', icon: LayoutDashboard },
  { id: 'deploy', label: 'Deploy', icon: Rocket },
  { id: 'nodes', label: 'Nodes', icon: Server },
  { id: 'chats', label: 'Chats', icon: MessageSquare },
  { id: 'settings', label: 'Settings', icon: SettingsIcon },
];

// Reload-safe / shareable nav via the URL hash. ponytail: a hash, not a router dep — the app is a
// flat set of pages. Unknown/empty hash falls back to overview.
function viewFromHash(): View {
  const seg = window.location.hash.replace(/^#\/?/, '').split('/')[0];
  return NAV.some((n) => n.id === seg) ? (seg as View) : 'overview';
}

// Auth gate state: resolving the session → first-boot setup → login form → the app.
type Auth = { kind: 'loading' } | { kind: 'setup' } | { kind: 'login' } | { kind: 'ready'; user: AuthUser };

export function App() {
  const [view, setView] = useState<View>(viewFromHash);
  const [live, setLive] = useState(false);
  const [auth, setAuth] = useState<Auth>({ kind: 'loading' });

  useEffect(() => {
    (async () => {
      try {
        const me = await authMe();
        if (me) return setAuth({ kind: 'ready', user: me });
        const { setup } = await authStatus();
        setAuth(setup ? { kind: 'setup' } : { kind: 'login' });
      } catch {
        setAuth({ kind: 'login' }); // API unreachable — the login screen will surface the error
      }
    })();
  }, []);

  // Keep state in sync with the hash so reload, deep links, and browser back/forward all work.
  useEffect(() => {
    const onHash = () => setView(viewFromHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  const go = (id: View) => {
    window.location.hash = id; // fires hashchange -> setView; set directly too for an instant switch
    setView(id);
  };

  useEffect(() => {
    if (auth.kind !== 'ready') return;
    const ping = () =>
      trpcQuery('agents.list')
        .then(() => setLive(true))
        .catch((e) => {
          setLive(false);
          // Session expired/revoked mid-visit → back to the login screen instead of a dead UI.
          if (/UNAUTHORIZED|401/.test((e as Error).message)) setAuth({ kind: 'login' });
        });
    ping();
    const t = setInterval(ping, 5000);
    return () => clearInterval(t);
  }, [auth.kind]);

  const signOut = async () => {
    try {
      await logout();
    } finally {
      setAuth({ kind: 'login' });
    }
  };

  if (auth.kind === 'loading') return <div className="bg-background min-h-screen" />;
  if (auth.kind !== 'ready') return <Login mode={auth.kind} onAuthed={(user) => setAuth({ kind: 'ready', user })} />;

  return (
    <div className="bg-background text-foreground min-h-screen">
      <div className="mx-auto flex min-h-screen max-w-7xl">
        {/* Sidebar */}
        <aside className="bg-sidebar text-sidebar-foreground sticky top-0 hidden h-screen w-60 shrink-0 flex-col border-r p-4 md:flex">
          <div className="flex items-center gap-2 px-2 py-3">
            <div className="bg-primary text-primary-foreground flex size-8 items-center justify-center rounded-md font-bold">P</div>
            <div>
              <div className="text-sm font-semibold leading-tight">Portless</div>
              <div className="text-muted-foreground text-xs">Private PaaS</div>
            </div>
          </div>
          <nav className="mt-4 flex flex-col gap-1">
            {NAV.map((item) => {
              const Icon = item.icon;
              const active = view === item.id;
              return (
                <button
                  key={item.id}
                  onClick={() => go(item.id)}
                  className={cn(
                    'flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors',
                    active ? 'bg-sidebar-accent text-sidebar-accent-foreground' : 'text-muted-foreground hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground',
                  )}
                >
                  <Icon className="size-4" />
                  {item.label}
                </button>
              );
            })}
          </nav>
          <div className="mt-auto space-y-3 px-3">
            <div className="flex items-center gap-2 text-xs">
              <span className={cn('size-2 rounded-full', live ? 'bg-emerald-500' : 'bg-zinc-300')} />
              <span className="text-muted-foreground">{live ? 'API connected' : 'API offline'}</span>
            </div>
            <button
              onClick={signOut}
              className="text-muted-foreground hover:text-foreground flex items-center gap-2 text-xs transition-colors"
              title={auth.user.name}
            >
              <LogOut className="size-3.5" />
              Sign out ({auth.user.name})
            </button>
          </div>
        </aside>

        {/* Main */}
        <div className="flex min-w-0 flex-1 flex-col">
          {/* Mobile top nav */}
          <div className="flex gap-1 overflow-x-auto border-b p-2 md:hidden">
            {NAV.map((item) => (
              <button
                key={item.id}
                onClick={() => go(item.id)}
                className={cn('rounded-md px-3 py-1.5 text-sm', view === item.id ? 'bg-accent font-medium' : 'text-muted-foreground')}
              >
                {item.label}
              </button>
            ))}
          </div>

          <main className="flex-1 p-6 lg:p-8">
            {view === 'overview' && <Overview />}
            {view === 'deploy' && <Deploy />}
            {view === 'nodes' && <Nodes />}
            {view === 'chats' && <Chats />}
            {view === 'settings' && <Settings me={auth.user} />}
          </main>
        </div>
      </div>
    </div>
  );
}
