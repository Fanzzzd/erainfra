import { existsSync, mkdirSync, readFileSync, appendFileSync } from 'node:fs';
import { dirname } from 'node:path';

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

// In-memory ring buffer — used by tests. Production uses FileAuditLog (durable). Both back
// the `audit_log` Drizzle table seam for when the API runs against Postgres.
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

// Durable audit log: append-only JSONL on disk, reloaded on startup so the trail survives
// restarts (dangerous Cloudflare/deploy ops must stay auditable across crashes). ponytail:
// JSONL append, not a DB — swap for the Postgres audit_log table when wired.
export class FileAuditLog implements AuditLog {
  private entries: AuditEntry[] = [];
  private seq = 0;
  private file: string;
  private durable = true;

  constructor(file: string) {
    this.file = file;
    mkdirSync(dirname(file), { recursive: true });
    if (existsSync(file)) {
      for (const line of readFileSync(file, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try {
          const e = JSON.parse(line) as AuditEntry;
          this.entries.push(e);
          const n = Number(String(e.id).replace(/^a-/, ''));
          if (Number.isFinite(n) && n > this.seq) this.seq = n;
        } catch {
          /* skip a corrupt line rather than lose the whole trail */
        }
      }
    }
  }

  record(entry: Omit<AuditEntry, 'id' | 'at'>): AuditEntry {
    const full: AuditEntry = { id: `a-${++this.seq}`, at: new Date().toISOString(), ...entry };
    this.entries.push(full);
    try {
      appendFileSync(this.file, JSON.stringify(full) + '\n');
      this.durable = true;
    } catch (e) {
      // Never block the request on a disk hiccup, but a swallowed failure would mean a
      // dangerous op "succeeds" with no durable trail — so make it LOUD and remember it.
      this.durable = false;
      console.error(`[audit] FAILED to persist entry ${full.id} (${full.action} ${full.target ?? ''}):`, (e as Error).message);
    }
    return full;
  }

  // Last write durable? Lets callers/health checks detect a broken audit trail.
  lastWriteDurable(): boolean {
    return this.durable;
  }

  list(limit = 100): AuditEntry[] {
    return this.entries.slice(-limit).reverse();
  }
}
