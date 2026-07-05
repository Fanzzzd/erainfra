// Deployment progress, polled by the CLI/dashboard. Deploys run in the background (a build takes
// minutes; Cloudflare kills proxied requests at ~100s, so a synchronous deploy endpoint could never
// work through the tunnel) — the mutation returns a deployId immediately and this store tracks it.
// ponytail: in-memory ring of the last 200 deploys; a hub restart forgets in-flight ones (they die
// with the process anyway — the CLI surfaces "deploy not found" and the user redeploys).
import { randomUUID } from 'node:crypto';

export type DeployStage = 'queued' | 'reading-spec' | 'building' | 'deploying' | 'linking' | 'done' | 'failed';

export interface Deployment {
  id: string;
  app: string;
  stage: DeployStage;
  detail: string; // human line for the current stage, e.g. "building web (2/3)"
  urls: string[];
  error?: string;
  startedAt: string;
  finishedAt?: string;
}

const MAX = 200;

export class DeploymentStore {
  private byId = new Map<string, Deployment>();

  create(app: string): Deployment {
    const d: Deployment = { id: randomUUID(), app, stage: 'queued', detail: 'queued', urls: [], startedAt: new Date().toISOString() };
    this.byId.set(d.id, d);
    while (this.byId.size > MAX) {
      const oldest = this.byId.keys().next().value!;
      this.byId.delete(oldest);
    }
    return d;
  }

  update(id: string, patch: Partial<Pick<Deployment, 'stage' | 'detail' | 'urls' | 'error'>>): void {
    const d = this.byId.get(id);
    if (!d) return;
    Object.assign(d, patch);
    if (patch.stage === 'done' || patch.stage === 'failed') d.finishedAt = new Date().toISOString();
  }

  get(id: string): Deployment | undefined {
    return this.byId.get(id);
  }

  list(limit = 20): Deployment[] {
    return [...this.byId.values()].slice(-limit).reverse();
  }
}

export const deployments = new DeploymentStore();
