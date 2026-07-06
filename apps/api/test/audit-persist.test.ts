import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteAuditLog } from '../src/audit.ts';
import { createDb } from '../src/db.ts';

test('SqliteAuditLog persists across instances (survives a restart) and keeps id sequence', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'audit-')), 'portless.db');

  const first = new SqliteAuditLog(createDb(file));
  first.record({ actor: 'u-owner', action: 'agents.deploy', target: 'demo', outcome: 'success' });
  first.record({ actor: 'u-owner', action: 'app.deploy', target: 'demo', outcome: 'success', dryRun: true });

  // New instance on the SAME file == process restart: entries reload, ids don't collide.
  const reborn = new SqliteAuditLog(createDb(file));
  const entries = reborn.list();
  assert.equal(entries.length, 2);
  assert.equal(entries[0].action, 'app.deploy'); // most-recent first
  assert.equal(entries[0].dryRun, true);
  const next = reborn.record({ actor: 'u-owner', action: 'routes.remove', target: 'x.example.com', outcome: 'success' });
  assert.equal(next.id, 'a-3'); // AUTOINCREMENT continued past the reloaded a-1/a-2
  assert.equal(reborn.list().length, 3);
});

test('SqliteAuditLog flags a non-durable write instead of silently swallowing it', () => {
  // Close the DB underneath the log so the INSERT fails. record() must not throw and must
  // report the write as non-durable.
  const d = createDb(':memory:');
  const log = new SqliteAuditLog(d);
  assert.equal(log.lastWriteDurable(), true); // nothing written yet
  d.close();
  const entry = log.record({ actor: 'u-owner', action: 'app.deploy', target: 'demo', outcome: 'success' });
  assert.equal(entry.id, 'a-unpersisted'); // still returned to the caller
  assert.equal(log.lastWriteDurable(), false); // but the durable write failed loudly
});
