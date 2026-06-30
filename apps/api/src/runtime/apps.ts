// Multi-service ("compose-like") apps: app -> {node, services[]}, recorded on every successful
// deployApp. An app's services run together on one node, sharing a per-app docker network so they
// reach each other by service name. Exposed services (those with a `route`) ALSO get a RouteStore
// entry — so the data plane and single-container path are untouched; this store only adds the grouping
// that deployApp/failover need to bring the whole set up together. Env/secrets are NOT stored here;
// they're re-fetched live from the SecretStore at deploy/failover (same as the single-container path).
// ponytail: single node per app, last-deploy-wins — same model as RouteStore, just a list of services.
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

function persistDefault(envVar: string | undefined): string | undefined {
  return (process.execArgv.includes('--test') || !!process.env.NODE_TEST_CONTEXT) ? undefined : (envVar ?? join(tmpdir(), 'portless-runtime', 'apps.json'));
}

export interface ServiceDeploy {
  name: string; // DNS name on the app network (e.g. "web", "db")
  image: string; // registry image ref, so failover can redeploy without a rebuild
  args: string[]; // extra docker run flags (-p, -v, ...)
  port?: number; // loopback port for the data plane (set together with route)
  route?: string; // external hostname label; absent = internal-only
}

export interface AppDeployment {
  node: string; // agent id running the app's containers
  services: ServiceDeploy[];
}

export class AppStore {
  private byApp = new Map<string, AppDeployment>();
  private persistPath?: string;

  constructor(persistPath: string | undefined = persistDefault(process.env.PORTLESS_APPS_FILE)) {
    this.persistPath = persistPath;
    this.load();
  }

  private load(): void {
    if (!this.persistPath || !existsSync(this.persistPath)) return;
    try {
      const raw = JSON.parse(readFileSync(this.persistPath, 'utf8')) as Record<string, AppDeployment>;
      for (const [app, dep] of Object.entries(raw)) if (dep && dep.node && Array.isArray(dep.services)) this.byApp.set(app, dep);
    } catch (e) {
      console.error('[apps] failed to load:', (e as Error).message);
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
      console.error('[apps] failed to persist:', (e as Error).message);
    }
  }

  set(app: string, dep: AppDeployment): void {
    this.byApp.set(app, dep);
    this.save();
  }

  get(app: string): AppDeployment | undefined {
    return this.byApp.get(app);
  }

  delete(app: string): boolean {
    const ok = this.byApp.delete(app);
    if (ok) this.save();
    return ok;
  }

  list(): Array<{ app: string } & AppDeployment> {
    return [...this.byApp].map(([app, dep]) => ({ app, ...dep }));
  }
}

export const appStore = new AppStore();
