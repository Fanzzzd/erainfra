import type { DatabaseSync } from 'node:sqlite';
import { db } from './db.ts';

export type AuditOutcome = 'allow' | 'deny' | 'success' | 'failure' | 'attempt';

export interface AuditEntry {
  id: string;
  at: string;
  actor: string;
  action: string;
  target?: string;
  outcome: AuditOutcome;
  dryRun?: boolean;
  meta?: Record<string, unknown>;
}

export interface AuditLog {
  record(entry: Omit<AuditEntry, 'id' | 'at'>): AuditEntry;
  list(limit?: number): AuditEntry[];
  // Was the most recent record() durably persisted? Lets dangerous-op handlers surface an
  // audit gap to the caller instead of silently returning success.
  lastWriteDurable(): boolean;
}

// In-memory ring buffer — used by tests. Production uses SqliteAuditLog (durable).
export class InMemoryAuditLog implements AuditLog {
  private entries: AuditEntry[] = [];
  private seq = 0;

  record(entry: Omit<AuditEntry, 'id' | 'at'>): AuditEntry {
    const full: AuditEntry = { id: `a-${++this.seq}`, at: new Date().toISOString(), ...entry };
    this.entries.push(full);
    return full;
  }

  // Most recent first.
  list(limit = 100): AuditEntry[] {
    return this.entries.slice(-limit).reverse();
  }

  // In-memory is always "durable" within the process lifetime.
  lastWriteDurable(): boolean {
    return true;
  }
}

// Durable audit log: a table in the control-plane SQLite DB, so the trail survives restarts and
// is queryable (per-actor/action filtering when needed). record() must never throw into the
// request path — a failed write flips lastWriteDurable() so dangerous-op handlers can refuse.
export class SqliteAuditLog implements AuditLog {
  private durable = true;

  private d: DatabaseSync;

  constructor(d: DatabaseSync = db) {
    this.d = d;
  }

  record(entry: Omit<AuditEntry, 'id' | 'at'>): AuditEntry {
    const at = new Date().toISOString();
    try {
      const r = this.d.prepare('INSERT INTO audit (at, actor, action, target, outcome, dry_run, meta) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(at, entry.actor, entry.action, entry.target ?? null, entry.outcome, entry.dryRun ? 1 : 0, entry.meta ? JSON.stringify(entry.meta) : null);
      this.durable = true;
      return { id: `a-${r.lastInsertRowid}`, at, ...entry };
    } catch (e) {
      // Never block the request on a write hiccup, but a swallowed failure would mean a dangerous
      // op "succeeds" with no durable trail — so make it LOUD and remember it.
      this.durable = false;
      console.error(`[audit] FAILED to persist (${entry.action} ${entry.target ?? ''}):`, (e as Error).message);
      return { id: 'a-unpersisted', at, ...entry };
    }
  }

  lastWriteDurable(): boolean {
    return this.durable;
  }

  list(limit = 100): AuditEntry[] {
    const rows = this.d.prepare('SELECT * FROM audit ORDER BY seq DESC LIMIT ?').all(limit) as unknown as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: `a-${r.seq}`,
      at: String(r.at),
      actor: String(r.actor),
      action: String(r.action),
      target: r.target == null ? undefined : String(r.target),
      outcome: String(r.outcome) as AuditOutcome,
      dryRun: r.dry_run ? true : undefined,
      meta: r.meta ? (JSON.parse(String(r.meta)) as Record<string, unknown>) : undefined,
    }));
  }
}
