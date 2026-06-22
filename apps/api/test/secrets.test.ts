import test from 'node:test';
import assert from 'node:assert/strict';
import { SecretStore, DevCipher } from '../src/runtime/secrets.ts';

test('stores ciphertext, never plaintext', () => {
  const s = new SecretStore();
  const v = s.set('DB_URL', 'postgres://secret');
  assert.notEqual(v.ciphertext, 'postgres://secret');
  assert.equal(s.get('DB_URL'), 'postgres://secret');
});

test('rotation keeps old versions and supports rollback', () => {
  const s = new SecretStore();
  s.set('API_KEY', 'k1');
  s.rotate('API_KEY', 'k2');
  assert.equal(s.get('API_KEY'), 'k2');
  assert.equal(s.versions('API_KEY').length, 2);
  s.rollback('API_KEY', 1);
  assert.equal(s.get('API_KEY'), 'k1');
});

test('re-setting an existing secret appends a version (never drops history)', () => {
  const s = new SecretStore();
  s.set('TOKEN', 'v1');
  s.set('TOKEN', 'v2'); // set again, not rotate
  assert.equal(s.get('TOKEN'), 'v2');
  assert.equal(s.versions('TOKEN').length, 2);
  s.rollback('TOKEN', 1);
  assert.equal(s.get('TOKEN'), 'v1');
});

test('backup/restore round-trips ciphertext', () => {
  const s = new SecretStore();
  s.set('A', 'alpha');
  s.rotate('A', 'beta');
  const backup = s.export();
  const restored = SecretStore.restore(backup, new DevCipher());
  assert.equal(restored.get('A'), 'beta');
  assert.equal(restored.versions('A').length, 2);
});
