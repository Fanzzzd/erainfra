import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultTokenStore } from '../src/auth.ts';

// Snapshot/restore the env bits defaultTokenStore reads.
function withEnv(env: Record<string, string | undefined>, fn: () => void) {
  const keys = ['NODE_ENV', 'PORTLESS_DEV_AUTH', 'PORTLESS_DEV_TOKENS'];
  const prev = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  try {
    for (const k of keys) {
      if (env[k] === undefined) delete process.env[k];
      else process.env[k] = env[k];
    }
    fn();
  } finally {
    for (const k of keys) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k]!;
    }
  }
}

test('dev tokens work outside production (local dev default)', () => {
  withEnv({ NODE_ENV: undefined, PORTLESS_DEV_AUTH: undefined, PORTLESS_DEV_TOKENS: undefined }, () => {
    assert.equal(defaultTokenStore().resolve('owner-dev-token')?.roles[0], 'owner');
  });
});

test('production fails closed: bundled dev tokens are refused', () => {
  withEnv({ NODE_ENV: 'production', PORTLESS_DEV_AUTH: undefined, PORTLESS_DEV_TOKENS: undefined }, () => {
    assert.equal(defaultTokenStore().resolve('owner-dev-token'), null);
  });
});

test('production opt-in (PORTLESS_DEV_AUTH=1) re-enables dev tokens', () => {
  withEnv({ NODE_ENV: 'production', PORTLESS_DEV_AUTH: '1', PORTLESS_DEV_TOKENS: undefined }, () => {
    assert.equal(defaultTokenStore().resolve('owner-dev-token')?.roles[0], 'owner');
  });
});

test('explicit PORTLESS_DEV_TOKENS overrides everything', () => {
  withEnv({ NODE_ENV: 'production', PORTLESS_DEV_TOKENS: JSON.stringify({ 'real-tok': { id: 'u1', name: 'Real', roles: ['admin'] } }) }, () => {
    const store = defaultTokenStore();
    assert.equal(store.resolve('real-tok')?.roles[0], 'admin');
    assert.equal(store.resolve('owner-dev-token'), null);
  });
});
