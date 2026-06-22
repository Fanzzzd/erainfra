import { useEffect, useState } from 'react';
import { trpcQuery, type PathRow } from '@/api';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

// Lower rank = preferred path (matches the control-plane priority order).
const RANK: Record<string, number> = {
  'same-machine': 0,
  'lan-direct': 1,
  'public-ipv6-direct': 2,
  'public-ipv4-direct': 3,
  'nat-punched-direct': 4,
  'regional-relay': 5,
  'cloudflare-mesh-fallback': 6,
};

export function Fabric() {
  const [paths, setPaths] = useState<PathRow[]>([]);
  const [offline, setOffline] = useState(false);

  useEffect(() => {
    trpcQuery<PathRow[]>('network.matrix').then(setPaths).catch(() => setOffline(true));
  }, []);

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold tracking-tight">Network fabric</h2>
        <p className="text-muted-foreground text-sm">
          Machine-to-machine paths (Portless prefers direct kernel WireGuard; relays and Cloudflare are last resort). Populated from real
          probes recorded by the node-agent between enrolled peers — <code>network.benchmark</code> does a live TCP handshake on demand.
        </p>
      </div>
      {offline ? (
        <Card>
          <CardHeader className="text-center">
            <CardTitle>Control plane offline</CardTitle>
            <CardDescription>Start the API to load the path matrix.</CardDescription>
          </CardHeader>
        </Card>
      ) : (
        <Card className="py-0">
          <CardContent className="px-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-6">From</TableHead>
                  <TableHead>To</TableHead>
                  <TableHead>Active path</TableHead>
                  <TableHead>RTT</TableHead>
                  <TableHead className="pr-6">Throughput</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {paths.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={5} className="text-muted-foreground py-8 text-center">
                      No fabric paths measured yet. Enroll peers on the Machines page; the node-agent records paths between them as it
                      probes.
                    </TableCell>
                  </TableRow>
                )}
                {paths.map((p, i) => {
                  const direct = (RANK[p.kind] ?? 9) <= 4;
                  return (
                    <TableRow key={i}>
                      <TableCell className="pl-6 font-mono text-xs">{p.from}</TableCell>
                      <TableCell className="font-mono text-xs">{p.to}</TableCell>
                      <TableCell>
                        <Badge variant={direct ? 'default' : 'destructive'}>{p.kind}</Badge>
                      </TableCell>
                      <TableCell className="tabular-nums">{p.rttMs} ms</TableCell>
                      <TableCell className="tabular-nums pr-6">{p.throughputMbps} Mbps</TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
