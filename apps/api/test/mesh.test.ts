import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildShareArgs, buildConnectArgs, parseTicket, persistentSecret, MeshManager } from '../src/runtime/mesh.ts';

const TICKET =
  'endpointadpythoh2p5nxikduelkacsonorttagv3ffhw6gmkddrbvgfkugkxnosyasnmbfgnm4nbml6kbaaenuhi5dqom5c6l3bobztcljrfzzgk3dbpexg4mbonfzg62bonruw42zof4aqanuxvqzov7acaeambkakygr62aybaddbeaabupwqg';

test('buildShareArgs forwards a local port (argv, no shell)', () => {
  assert.deepEqual(buildShareArgs(5432), ['listen-tcp', '--host', '127.0.0.1:5432']);
});

test('buildConnectArgs dials a ticket onto a local port (argv, no shell)', () => {
  assert.deepEqual(buildConnectArgs(TICKET, 15432), ['connect-tcp', '--addr', '127.0.0.1:15432', TICKET]);
});

test('parseTicket extracts the ticket dumbpipe prints, not the secret key', () => {
  const stderr = [
    'using secret key 49125ef25025f2ff4b40cbf031d2ab679668d19b1e20679a98a171a2679ef673',
    "Forwarding incoming requests to '127.0.0.1:9999'.",
    'To connect, use e.g.:',
    `dumbpipe connect-tcp ${TICKET}`,
  ].join('\n');
  assert.equal(parseTicket(stderr), TICKET);
});

test('parseTicket is null until the ticket line appears', () => {
  assert.equal(parseTicket('using secret key 49125ef25025f2ff4b40cbf031d2ab67'), null);
  assert.equal(parseTicket(''), null);
});

test('persistentSecret is created once then reused (stable NodeId across restarts)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mesh-'));
  try {
    const first = persistentSecret('db', dir);
    assert.match(first, /^[0-9a-f]{64}$/); // 32-byte iroh secret
    assert.equal(persistentSecret('db', dir), first); // same name -> same identity
    assert.notEqual(persistentSecret('other', dir), first); // different name -> different identity
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('manager starts empty', () => {
  const m = new MeshManager();
  assert.deepEqual(m.list(), []);
  assert.equal(m.get('anything'), undefined);
});
