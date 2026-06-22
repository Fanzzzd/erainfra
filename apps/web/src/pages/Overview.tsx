import { useEffect, useState, type ReactNode } from 'react';
import { Boxes, Rocket, Cloud, Globe, ArrowRight } from 'lucide-react';
import { trpcQuery, type LocalProc } from '@/api';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';

interface TunnelsResp {
  ok: boolean;
  tunnels: Array<{ status: 'healthy' | 'inactive' }>;
}

export function Overview() {
  const [procs, setProcs] = useState<LocalProc[]>([]);
  const [projects, setProjects] = useState<Array<{ id: string; source: 'example' | 'imported' }>>([]);
  const [tunnels, setTunnels] = useState<TunnelsResp | null>(null);
  const [offline, setOffline] = useState(false);

  useEffect(() => {
    // Fast local metrics first so the page paints immediately.
    Promise.all([
      trpcQuery<LocalProc[]>('local.list'),
      trpcQuery<Array<{ id: string; source: 'example' | 'imported' }>>('project.list'),
    ])
      .then(([p, pr]) => {
        setProcs(p);
        setProjects(pr);
      })
      .catch(() => setOffline(true));
    // Tunnels shell out to `cloudflared` (~1-2s) — load separately so they don't block the rest.
    trpcQuery<TunnelsResp>('cloudflare.tunnels')
      .then(setTunnels)
      .catch(() => {});
    const t = setInterval(() => trpcQuery<LocalProc[]>('local.list').then(setProcs).catch(() => {}), 4000);
    return () => clearInterval(t);
  }, []);

  const running = procs.filter((p) => p.status === 'running').length;
  // Show total tunnels with a "healthy" (live-connector) sub-count: "0 healthy" out of N reads as
  // "configured but idle", not the alarming "Healthy tunnels: 0" when the user actually has tunnels.
  const totalTunnels = tunnels?.ok ? tunnels.tunnels.length : 0;
  const healthyTunnels = tunnels?.ok ? tunnels.tunnels.filter((t) => t.status === 'healthy').length : 0;
  // Apps currently exposed on a public URL via a quick tunnel — the "live on the internet" count.
  const published = procs.filter((p) => p.publicUrl).length;
  // Honesty: "your" projects are the imported ones; seeded examples are counted separately.
  const importedProjects = projects.filter((p) => p.source === 'imported').length;
  const exampleProjects = projects.length - importedProjects;

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold tracking-tight">Overview</h2>
        <p className="text-muted-foreground text-sm">A private PaaS for machines with no public IP — manage everything from here.</p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Metric icon={<Boxes className="size-4" />} label="Running processes" value={running} />
        <Metric
          icon={<Rocket className="size-4" />}
          label="Your projects"
          value={importedProjects}
          hint={exampleProjects ? `+${exampleProjects} example${exampleProjects === 1 ? '' : 's'}` : undefined}
        />
        <Metric
          icon={<Cloud className="size-4" />}
          label="Tunnels"
          value={totalTunnels}
          hint={tunnels?.ok ? `${healthyTunnels} healthy` : undefined}
        />
        <Metric icon={<Globe className="size-4" />} label="Published" value={published} hint={published ? 'live on the internet' : undefined} />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{importedProjects === 0 && running === 0 ? 'Get started' : 'Quick actions'}</CardTitle>
          <CardDescription>
            {offline
              ? 'The control plane is offline. Run `npm run api:dev` to manage real processes.'
              : importedProjects === 0
                ? 'Declare a project from a portless.yaml (services, domains, topology), or deploy a real process on this machine.'
                : 'Jump to your declared projects, or the real processes running on this machine.'}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          {/* Nav is hash-based now, so navigate directly — no prop drilling. */}
          <Button onClick={() => (window.location.hash = 'projects')}>
            {importedProjects === 0 ? 'Import a project' : 'Projects'} <ArrowRight />
          </Button>
          <Button variant="outline" onClick={() => (window.location.hash = 'apps')}>
            {running === 0 ? 'Deploy an app' : 'Apps'}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}

function Metric(props: { icon: ReactNode; label: string; value: number; hint?: string }) {
  return (
    <Card>
      <CardHeader>
        <CardDescription className="flex items-center gap-2">
          {props.icon}
          {props.label}
        </CardDescription>
        <CardTitle className="text-3xl tabular-nums">
          {props.value}
          {props.hint && <span className="text-muted-foreground ml-2 text-xs font-normal">{props.hint}</span>}
        </CardTitle>
      </CardHeader>
    </Card>
  );
}
