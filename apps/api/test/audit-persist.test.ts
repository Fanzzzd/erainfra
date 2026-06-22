import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileAuditLog } from '../src/audit.ts';

test('FileAuditLog persists across instances (survives a restart) and keeps id sequence', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'audit-')), 'audit.jsonl');

  const first = new FileAuditLog(file);
  first.record({ actor: 'u-owner', action: 'cloudflare.createTunnel', target: 'demo', outcome: 'success' });
  first.record({ actor: 'u-owner', action: 'app.deploy', target: 'demo', outcome: 'success', dryRun: true });

  // New instance on the SAME file == process restart: entries reload, ids don't collide.
  const reborn = new FileAuditLog(file);
  const entries = reborn.list();
  assert.equal(entries.length, 2);
  assert.equal(entries[0].action, 'app.deploy'); // most-recent first
  const next = reborn.record({ actor: 'u-owner', action: 'cloudflare.routeDns', target: 'x.example.com', outcome: 'success' });
  assert.equal(next.id, 'a-3'); // sequence continued past the reloaded a-1/a-2
  assert.equal(reborn.list().length, 3);
});

test('FileAuditLog flags a non-durable write instead of silently swallowing it', { skip: process.getuid?.() === 0 ? 'root bypasses file perms' : false }, () => {
  // Make the audit file read-only so appendFileSync fails (EACCES). record() must not throw,
  // must keep the in-memory entry, and must report the write as non-durable.
  const file = join(mkdtempSync(join(tmpdir(), 'audit-ro-')), 'audit.jsonl');
  writeFileSync(file, '');
  chmodSync(file, 0o444);
  const log = new FileAuditLog(file); // constructor reads the empty file fine
  assert.equal(log.lastWriteDurable(), true); // nothing written yet
  const entry = log.record({ actor: 'u-owner', action: 'app.deploy', target: 'demo', outcome: 'success' });
  assert.equal(entry.id, 'a-1'); // still recorded in memory
  assert.equal(log.lastWriteDurable(), false); // but the durable write failed loudly
});
