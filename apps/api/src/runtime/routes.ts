// Where each app runs AND how it was deployed: app (container name) -> {node, image, port}, recorded
// on every successful deploy (git or upload). The reverse proxy reads `node` to find which agent holds
// an app; failover reads `image`/`port` to redeploy it elsewhere. This is THE deployment source of
// truth — upload deploys have no GitBinding, so routes can't be derived from bindings.
// ponytail: last-deploy-wins, single node per app. Multi-replica/round-robin is a list here later.
import type { DatabaseSync } from 'node:sqlite';
import { db } from '../db.ts';

export interface Deployment {
  node: string; // agent id running the container
  image: string; // registry image ref, so failover can redeploy without a rebuild
  port: number; // published/loopback port
}

interface Row { app: string; node: string; image: string; port: number }

export class RouteStore {
  private d: DatabaseSync;

  constructor(d: DatabaseSync = db) {
    this.d = d;
  }

  set(app: string, dep: Deployment): void {
    this.d.prepare('INSERT INTO routes (app, node, image, port) VALUES (?, ?, ?, ?) ON CONFLICT(app) DO UPDATE SET node = excluded.node, image = excluded.image, port = excluded.port')
      .run(app, dep.node, dep.image, dep.port);
  }

  // Which node holds the app (the proxy's lookup).
  node(app: string): string | undefined {
    return (this.d.prepare('SELECT node FROM routes WHERE app = ?').get(app) as { node: string } | undefined)?.node;
  }

  get(app: string): Deployment | undefined {
    const r = this.d.prepare('SELECT * FROM routes WHERE app = ?').get(app) as Row | undefined;
    return r && { node: r.node, image: r.image, port: Number(r.port) };
  }

  delete(app: string): boolean {
    return this.d.prepare('DELETE FROM routes WHERE app = ?').run(app).changes > 0;
  }

  list(): Array<{ app: string } & Deployment> {
    return (this.d.prepare('SELECT * FROM routes ORDER BY app').all() as unknown as Row[])
      .map((r) => ({ app: r.app, node: r.node, image: r.image, port: Number(r.port) }));
  }
}

export const routeStore = new RouteStore();
