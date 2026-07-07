// Standalone mesh links: "reach <provider-node>:<port> from <consumer-node>" as a first-class,
// persisted object — independent of any app. This is the user-facing "machine + port" wiring
// (registry distribution, a DB on another box, LocalAI on the GPU box, …). App-declared links
// (portless.yaml `needs:`) stay in AppStore; these are the ad-hoc ones created via `portless link`
// or by the deploy pipeline (registry auto-links). Persisted so they survive hub restarts and are
// re-established by the link healer when agents come back.
import type { DatabaseSync } from 'node:sqlite';
import { db } from '../db.ts';

export interface MeshLink {
  name: string; // link id (same on both nodes; re-share replaces)
  provider: string; // node that HAS the service
  providerPort: number; // the service's loopback port on the provider node
  consumer: string; // node that WANTS the service
  localPort: number; // port the link is surfaced on, on the consumer node (127.0.0.1:<localPort>)
  createdBy?: string; // 'user' (portless link) or 'deploy' (registry auto-link) — for display only
}

export class LinkStore {
  private d: DatabaseSync;

  constructor(d: DatabaseSync = db) {
    this.d = d;
  }

  set(link: MeshLink): void {
    this.d.prepare('INSERT INTO links (name, doc) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET doc = excluded.doc')
      .run(link.name, JSON.stringify(link));
  }

  get(name: string): MeshLink | undefined {
    const r = this.d.prepare('SELECT doc FROM links WHERE name = ?').get(name) as { doc: string } | undefined;
    return r && (JSON.parse(r.doc) as MeshLink);
  }

  delete(name: string): boolean {
    return this.d.prepare('DELETE FROM links WHERE name = ?').run(name).changes > 0;
  }

  list(): MeshLink[] {
    return (this.d.prepare('SELECT doc FROM links ORDER BY name').all() as unknown as Array<{ doc: string }>)
      .map((r) => JSON.parse(r.doc) as MeshLink);
  }
}

export const linkStore = new LinkStore();
