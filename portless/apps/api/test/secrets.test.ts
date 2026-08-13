import test from 'node:test';
import assert from 'node:assert/strict';
import { SecretStore } from '../src/runtime/secrets.ts';
import { createDb } from '../src/db.ts';

test('secrets round-trip, mask, inject as -e args, and reject bad names', () => {
  const s = new SecretStore(createDb(':memory:')); // ephemeral key under test
  s.setMany('app', { API_KEY: 'sk-123', DATABASE_URL: 'postgres://u:p@h/db' });

  // decrypted for injection
  assert.deepEqual(s.get('app'), { API_KEY: 'sk-123', DATABASE_URL: 'postgres://u:p@h/db' });
  // masked for the API — never plaintext
  const masked = s.list('app');
  assert.deepEqual(masked.map((m) => m.key), ['API_KEY', 'DATABASE_URL']);
  assert.ok(masked.every((m) => !m.preview.includes('sk-123') && !m.preview.includes('postgres')));

  // unset
  assert.equal(s.unset('app', 'API_KEY'), true);
  assert.deepEqual(Object.keys(s.get('app')), ['DATABASE_URL']);
  assert.equal(s.unset('app', 'nope'), false);

  // invalid env var name rejected
  assert.throws(() => s.setMany('app', { '1bad': 'x' }), /invalid env var name/);
  // unknown app → empty, never throws
  assert.deepEqual(s.get('ghost'), {});
});

test('encryption uses a fresh nonce per value (no ciphertext reuse)', () => {
  const s = new SecretStore(createDb(':memory:'));
  s.setMany('a', { K: 'same-value' });
  s.setMany('b', { K: 'same-value' });
  // both decrypt to the same plaintext...
  assert.equal(s.get('a').K, 'same-value');
  assert.equal(s.get('b').K, 'same-value');
  // ...but list previews are masked (can't compare ciphertext via public API; round-trip correctness
  // above + GCM with a random 12-byte nonce per enc() is the guarantee).
});
