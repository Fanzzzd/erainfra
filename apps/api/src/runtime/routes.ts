// Where each app runs AND how it was deployed: app (container name) -> {node, image, port}, recorded
// on every successful deploy (git or upload). The reverse proxy reads `node` to find which agent holds
// an app; failover reads `image`/`port` to redeploy it elsewhere. This is THE deployment source of
// truth — upload deploys have no GitBinding, so routes can't be derived from bindings.
// ponytail: last-deploy-wins, single node per app. Multi-replica/round-robin is a list here later.
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

function persistDefault(envVar: string | undefined): string | undefined {
  return process.execArgv.includes('--test') ? undefined : (envVar ?? join(tmpdir(), 'portless-runtime', 'routes.json'));
}

export interface Deployment {
  node: string; // agent id running the container
  image: string; // registry image ref, so failover can redeploy without a rebuild
  port: number; // published/loopback port
}

export class RouteStore {
  private byApp = new Map<string, Deployment>();
  private persistPath?: string;

  constructor(persistPath: string | undefined = persistDefault(process.env.PORTLESS_ROUTES_FILE)) {
    this.persistPath = persistPath;
    this.load();
  }

  private load(): void {
    if (!this.persistPath || !existsSync(this.persistPath)) return;
    try {
      const raw = JSON.parse(readFileSync(this.persistPath, 'utf8')) as Record<string, Deployment>;
      for (const [app, dep] of Object.entries(raw)) if (dep && dep.node) this.byApp.set(app, dep);
    } catch (e) {
      console.error('[routes] failed to load:', (e as Error).message);
    }
  }

  private save(): void {
    if (!this.persistPath) return;
    try {
      mkdirSync(dirname(this.persistPath), { recursive: true });
      const tmp = `${this.persistPath}.tmp`;
      writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.byApp), null, 2));
      renameSync(tmp, this.persistPath);
    } catch (e) {
      console.error('[routes] failed to persist:', (e as Error).message);
    }
  }

  set(app: string, dep: Deployment): void {
    this.byApp.set(app, dep);
    this.save();
  }

  // Which node holds the app (the proxy's lookup).
  node(app: string): string | undefined {
    return this.byApp.get(app)?.node;
  }

  get(app: string): Deployment | undefined {
    return this.byApp.get(app);
  }

  delete(app: string): boolean {
    const ok = this.byApp.delete(app);
    if (ok) this.save();
    return ok;
  }

  list(): Array<{ app: string } & Deployment> {
    return [...this.byApp].map(([app, dep]) => ({ app, ...dep }));
  }
}

export const routeStore = new RouteStore();
