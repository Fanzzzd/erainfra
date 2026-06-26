import { useCallback, useEffect, useState } from 'react';
import { RefreshCw, Server } from 'lucide-react';
import { trpcQuery, type AgentInfo } from '@/api';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

function since(iso: string): string {
  const s = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

// Nodes = the agent machines currently connected to this hub over the agent websocket. They're what
// git/upload deploys build and run on. Enroll one by running the agent install script with a token.
export function Nodes() {
  const [agents, setAgents] = useState<AgentInfo[]>([]);

  const refresh = useCallback(async () => {
    try {
      setAgents(await trpcQuery<AgentInfo[]>('agents.list'));
    } catch {
      // transient — keep the last good list; the global API indicator covers hard offline.
    }
  }, []);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 3000);
    return () => clearInterval(t);
  }, [refresh]);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-semibold tracking-tight">Nodes</h2>
          <p className="text-muted-foreground text-sm">Agent machines connected to this hub — where your apps build and run.</p>
        </div>
        <Button variant="outline" size="sm" onClick={refresh}>
          <RefreshCw /> Refresh
        </Button>
      </div>

      {agents.length === 0 ? (
        <Card>
          <CardHeader className="items-center text-center">
            <Server className="text-muted-foreground mx-auto mb-2 size-8" />
            <CardTitle>No nodes connected</CardTitle>
            <CardDescription>Enroll a machine as an agent so portless can build and run your apps on it.</CardDescription>
          </CardHeader>
          <CardContent className="flex justify-center">
            <pre className="bg-muted overflow-auto rounded-md p-4 text-xs leading-relaxed">curl &lt;hub&gt;/agent.sh | sh -s -- --token &lt;token&gt;</pre>
          </CardContent>
        </Card>
      ) : (
        <Card className="py-0">
          <CardContent className="px-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-6">Name</TableHead>
                  <TableHead>Version</TableHead>
                  <TableHead>Roles</TableHead>
                  <TableHead className="pr-6">Connected</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {agents.map((a) => (
                  <TableRow key={a.id}>
                    <TableCell className="pl-6 font-medium">{a.id}</TableCell>
                    <TableCell className="text-muted-foreground tabular-nums">{a.version ?? '—'}</TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-1">
                        {a.roles.length ? (
                          a.roles.map((r) => (
                            <Badge key={r} variant="secondary">
                              {r}
                            </Badge>
                          ))
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="text-muted-foreground tabular-nums pr-6">{since(a.connectedAt)} ago</TableCell>
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
