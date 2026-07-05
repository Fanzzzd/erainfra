import { useEffect, useState, type ReactNode } from 'react';
import { Server, Globe, Boxes, ArrowRight } from 'lucide-react';
import { trpcQuery, type AgentInfo, type RouteInfo } from '@/api';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';

export function Overview() {
  const [nodes, setNodes] = useState<AgentInfo[]>([]);
  const [routes, setRoutes] = useState<RouteInfo[]>([]);
  const [offline, setOffline] = useState(false);

  useEffect(() => {
    const load = () =>
      Promise.all([trpcQuery<AgentInfo[]>('agents.list'), trpcQuery<RouteInfo[]>('routes.list')])
        .then(([n, r]) => {
          setNodes(n);
          setRoutes(r);
          setOffline(false);
        })
        .catch(() => setOffline(true));
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, []);

  const online = routes.filter((r) => r.online).length;

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold tracking-tight">Overview</h2>
        <p className="text-muted-foreground text-sm">A private PaaS for machines with no public IP — manage everything from here.</p>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <Metric icon={<Server className="size-4" />} label="Nodes" value={nodes.length} hint={nodes.length ? 'connected' : undefined} />
        <Metric icon={<Boxes className="size-4" />} label="Apps" value={routes.length} />
        <Metric icon={<Globe className="size-4" />} label="Online" value={online} hint={online ? 'serving traffic' : undefined} />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{routes.length === 0 ? 'Get started' : 'Quick actions'}</CardTitle>
          <CardDescription>
            {offline
              ? 'The control plane is offline.'
              : nodes.length === 0
                ? 'Enroll a machine first: run the one-line agent installer on any Linux box (see Nodes).'
                : routes.length === 0
                  ? 'Deploy your first app — bind a GitHub repo or upload a folder, or run `portless deploy` from a project directory.'
                  : 'Bind repos, redeploy, or manage the apps below.'}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          <Button onClick={() => (window.location.hash = 'deploy')}>
            Deploy <ArrowRight />
          </Button>
          <Button variant="outline" onClick={() => (window.location.hash = 'nodes')}>
            Nodes
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
