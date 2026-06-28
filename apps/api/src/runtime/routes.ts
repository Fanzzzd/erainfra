// Where each app runs: app (container name) -> node (agent id), recorded on every successful deploy
// (git or upload). The reverse proxy reads it to find which agent holds an app. This is THE routing
// source of truth — upload deploys have no GitBinding, so routes can't be derived from bindings.
// ponytail: last-deploy-wins, single node per app. Multi-replica/round-robin is a list here later.
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

function persistDefault(envVar: string | undefined): string | undefined {
  return process.execArgv.includes('--test') ? undefined : (envVar ?? join(tmpdir(), 'portless-runtime', 'routes.json'));
}

export class RouteStore {
  private byApp = new Map<string, string>(); // app -> node (agent id)
  private persistPath?: string;

  constructor(persistPath: string | undefined = persistDefault(process.env.PORTLESS_ROUTES_FILE)) {
    this.persistPath = persistPath;
    this.load();
  }

  private load(): void {
    if (!this.persistPath || !existsSync(this.persistPath)) return;
    try {
      const raw = JSON.parse(readFileSync(this.persistPath, 'utf8')) as Record<string, string>;
      for (const [app, node] of Object.entries(raw)) this.byApp.set(app, node);
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

  set(app: string, node: string): void {
    this.byApp.set(app, node);
    this.save();
  }

  node(app: string): string | undefined {
    return this.byApp.get(app);
  }

  delete(app: string): boolean {
    const ok = this.byApp.delete(app);
    if (ok) this.save();
    return ok;
  }

  list(): Array<{ app: string; node: string }> {
    return [...this.byApp].map(([app, node]) => ({ app, node }));
  }
}

export const routeStore = new RouteStore();
