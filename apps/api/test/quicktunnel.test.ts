import test from 'node:test';
import assert from 'node:assert/strict';
import { buildQuickTunnelArgs, parseQuickTunnelUrl, QuickTunnelManager } from '../src/runtime/quicktunnel.ts';

test('buildQuickTunnelArgs targets the local port (argv, no shell)', () => {
  assert.deepEqual(buildQuickTunnelArgs(8080), ['tunnel', '--url', 'http://127.0.0.1:8080']);
});

test('parseQuickTunnelUrl extracts the trycloudflare URL from cloudflared output', () => {
  const log = [
    '2026-06-22T08:49:03Z INF +-----------------------------------------------+',
    '2026-06-22T08:49:03Z INF |  Your quick Tunnel has been created! Visit it: |',
    '2026-06-22T08:49:03Z INF |  https://falling-ventures-opportunity.trycloudflare.com |',
    '2026-06-22T08:49:03Z INF +-----------------------------------------------+',
  ].join('\n');
  assert.equal(parseQuickTunnelUrl(log), 'https://falling-ventures-opportunity.trycloudflare.com');
  assert.equal(parseQuickTunnelUrl('Requesting new quick Tunnel...'), null); // not up yet
});

test('manager starts empty', () => {
  const m = new QuickTunnelManager();
  assert.deepEqual(m.list(), []);
  assert.equal(m.get('anything'), undefined);
});
