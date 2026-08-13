// Persistent host-port allocator. Every routed service (data-plane target) and every mesh link
// consumer needs a port on its node's host; apps must not collide, and an app must get the SAME
// ports back on redeploy (its containers' env bakes them in). Keyed by node + purpose.
// ponytail: linear scan in a fixed range — thousands of allocations before it matters.
import type { DatabaseSync } from 'node:sqlite';
import { db } from '../db.ts';

const RANGE_START = 62000;
const RANGE_END = 63999;

export class PortAllocator {
  private d: DatabaseSync;

  constructor(d: DatabaseSync = db) {
    this.d = d;
  }

  // Stable per (node, key): repeat calls return the same port. Throws when the node's range is full.
  alloc(node: string, key: string): number {
    const existing = this.d.prepare('SELECT port FROM ports WHERE node = ? AND key = ?').get(node, key) as { port: number } | undefined;
    if (existing) return Number(existing.port);
    const used = new Set((this.d.prepare('SELECT port FROM ports WHERE node = ?').all(node) as unknown as Array<{ port: number }>).map((r) => Number(r.port)));
    for (let p = RANGE_START; p <= RANGE_END; p++) {
      if (!used.has(p)) {
        this.d.prepare('INSERT INTO ports (node, key, port) VALUES (?, ?, ?)').run(node, key, p);
        return p;
      }
    }
    throw new Error(`no free ports on node ${node} (${RANGE_START}-${RANGE_END} all allocated)`);
  }

  // Free everything an app allocated (its keys are prefixed "<app>/") — called on app removal.
  // App names can't contain LIKE wildcards ([a-z0-9-] only), so the pattern is literal.
  releaseApp(app: string): void {
    this.d.prepare("DELETE FROM ports WHERE key LIKE ? || '/%'").run(app);
  }
}

export const portAllocator = new PortAllocator();
