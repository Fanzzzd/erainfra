// Standalone mesh links: "reach <provider-node>:<port> from <consumer-node>" as a persisted object,
// independent of any app (created via `portless link` or by the deploy pipeline's registry
// auto-links; app-declared `needs:` links stay in AppStore). Persisted so the link healer can
// re-establish them across hub/agent restarts.
import type { DatabaseSync } from "node:sqlite";
import { db } from "../db.ts";

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
    this.d
      .prepare(
        "INSERT INTO links (name, doc) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET doc = excluded.doc",
      )
      .run(link.name, JSON.stringify(link));
  }

  get(name: string): MeshLink | undefined {
    const r = this.d.prepare("SELECT doc FROM links WHERE name = ?").get(name) as
      | { doc: string }
      | undefined;
    return r && (JSON.parse(r.doc) as MeshLink);
  }

  delete(name: string): boolean {
    return this.d.prepare("DELETE FROM links WHERE name = ?").run(name).changes > 0;
  }

  list(): MeshLink[] {
    return (
      this.d.prepare("SELECT doc FROM links ORDER BY name").all() as unknown as Array<{
        doc: string;
      }>
    ).map((r) => JSON.parse(r.doc) as MeshLink);
  }
}

export const linkStore = new LinkStore();
