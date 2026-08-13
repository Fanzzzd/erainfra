// Multi-service ("compose-like") apps: app -> {node, services[]}, recorded on every successful
// deployApp. An app's services run together on one node, sharing a per-app docker network so they
// reach each other by service name. Exposed services (those with a `route`) ALSO get a RouteStore
// entry — so the data plane and single-container path are untouched; this store only adds the grouping
// that deployApp/failover need to bring the whole set up together. Env/secrets are NOT stored here;
// they're re-fetched live from the SecretStore at deploy/failover (same as the single-container path).
// Stored as one JSON doc per app (nested services/links), with the node lifted into a column for
// filtering. ponytail: single node per app, last-deploy-wins.
import type { DatabaseSync } from 'node:sqlite';
import { db } from '../db.ts';

export interface ServiceDeploy {
  name: string; // DNS name on the app network (e.g. "web", "db")
  image: string; // registry image ref, so failover can redeploy without a rebuild
  args: string[]; // extra docker run flags (-p, -v, ...)
  port?: number; // loopback HOST port for the data plane (set together with route)
  route?: string; // external hostname label; absent = internal-only
  node?: string; // agent this service runs on (multi-node apps); absent = the app's primary node
  env?: Record<string, string>; // PLAIN env (PORT, injected needs, spec env) — secrets are re-fetched live, never stored here
}

// A cross-node dependency wired over the mesh. Persisted so links survive hub restarts and are
// re-established when agents come back (see appdeploy.ensureAppLinks / installLinkHealer).
export interface AppLink {
  name: string; // mesh link id (same on both nodes; re-share replaces)
  need: string; // the depended-on service
  provider: string; // node that runs `need`
  providerPort: number; // need's loopback host port on the provider node
  consumer: string; // node whose services depend on it
  localPort: number; // port the link is surfaced on, on the consumer node
}

export interface AppDeployment {
  node: string; // agent id running the app's containers
  services: ServiceDeploy[];
  links?: AppLink[];
}

export class AppStore {
  private d: DatabaseSync;

  constructor(d: DatabaseSync = db) {
    this.d = d;
  }

  set(app: string, dep: AppDeployment): void {
    this.d.prepare('INSERT INTO apps (app, node, doc) VALUES (?, ?, ?) ON CONFLICT(app) DO UPDATE SET node = excluded.node, doc = excluded.doc')
      .run(app, dep.node, JSON.stringify(dep));
  }

  get(app: string): AppDeployment | undefined {
    const r = this.d.prepare('SELECT doc FROM apps WHERE app = ?').get(app) as { doc: string } | undefined;
    return r && (JSON.parse(r.doc) as AppDeployment);
  }

  delete(app: string): boolean {
    return this.d.prepare('DELETE FROM apps WHERE app = ?').run(app).changes > 0;
  }

  list(): Array<{ app: string } & AppDeployment> {
    return (this.d.prepare('SELECT app, doc FROM apps ORDER BY app').all() as unknown as Array<{ app: string; doc: string }>)
      .map((r) => ({ app: r.app, ...(JSON.parse(r.doc) as AppDeployment) }));
  }
}

export const appStore = new AppStore();
