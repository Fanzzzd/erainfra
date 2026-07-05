// Persistent host-port allocator. Every routed service (data-plane target) and every mesh link
// consumer needs a port on its node's host; apps must not collide, and an app must get the SAME
// ports back on redeploy (its containers' env bakes them in). Keyed by node + purpose.
// ponytail: linear scan in a fixed range, one JSON file — thousands of allocations before it matters.
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

const RANGE_START = 62000;
const RANGE_END = 63999;

function persistDefault(envVar: string | undefined): string | undefined {
  return (process.execArgv.includes('--test') || !!process.env.NODE_TEST_CONTEXT) ? undefined : (envVar ?? join(tmpdir(), 'portless-runtime', 'ports.json'));
}

export class PortAllocator {
  private byKey = new Map<string, number>(); // "<node>|<key>" -> port
  private persistPath?: string;

  constructor(persistPath: string | undefined = persistDefault(process.env.PORTLESS_PORTS_FILE)) {
    this.persistPath = persistPath;
    this.load();
  }

  private load(): void {
    if (!this.persistPath || !existsSync(this.persistPath)) return;
    try {
      const raw = JSON.parse(readFileSync(this.persistPath, 'utf8')) as Record<string, number>;
      for (const [k, v] of Object.entries(raw)) if (Number.isInteger(v)) this.byKey.set(k, v);
    } catch (e) {
      console.error('[ports] failed to load:', (e as Error).message);
    }
  }

  private save(): void {
    if (!this.persistPath) return;
    try {
      mkdirSync(dirname(this.persistPath), { recursive: true });
      const tmp = `${this.persistPath}.tmp`;
      writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.byKey), null, 2));
      renameSync(tmp, this.persistPath);
    } catch (e) {
      console.error('[ports] failed to persist:', (e as Error).message);
    }
  }

  // Stable per (node, key): repeat calls return the same port. Throws when the node's range is full.
  alloc(node: string, key: string): number {
    const k = `${node}|${key}`;
    const existing = this.byKey.get(k);
    if (existing) return existing;
    const used = new Set<number>();
    for (const [ek, p] of this.byKey) if (ek.startsWith(`${node}|`)) used.add(p);
    for (let p = RANGE_START; p <= RANGE_END; p++) {
      if (!used.has(p)) {
        this.byKey.set(k, p);
        this.save();
        return p;
      }
    }
    throw new Error(`no free ports on node ${node} (${RANGE_START}-${RANGE_END} all allocated)`);
  }

  // Free everything an app allocated (its keys are prefixed "<app>/") — called on app removal.
  releaseApp(app: string): void {
    let changed = false;
    for (const k of [...this.byKey.keys()]) {
      if (k.split('|')[1]?.startsWith(`${app}/`)) {
        this.byKey.delete(k);
        changed = true;
      }
    }
    if (changed) this.save();
  }
}

export const portAllocator = new PortAllocator();
