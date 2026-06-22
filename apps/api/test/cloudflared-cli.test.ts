import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCloudflaredArgs, parseTunnelList, originCertPath } from '../src/runtime/cloudflared-cli.ts';

test('builds argv for each cloudflared op (never a shell string)', () => {
  assert.deepEqual(buildCloudflaredArgs({ op: 'list' }), ['tunnel', 'list', '--output', 'json']);
  assert.deepEqual(buildCloudflaredArgs({ op: 'create', name: 'demo-shop' }), ['tunnel', 'create', 'demo-shop']);
  assert.deepEqual(buildCloudflaredArgs({ op: 'routeDns', tunnel: 'demo-shop', hostname: 'shop.example.com' }), [
    'tunnel',
    'route',
    'dns',
    'demo-shop',
    'shop.example.com',
  ]);
});

test('parseTunnelList maps real cloudflared json; healthy iff it has live connections', () => {
  const raw = JSON.stringify([
    {
      id: '7fff9b8c-6686-47db-9612-7c41e13c4d3e',
      name: 'aws-sg-proxy',
      created_at: '2026-04-13T11:20:02Z',
      connections: [
        { colo_name: 'sin19', opened_at: '2026-06-11T14:06:16Z' },
        { colo_name: 'sin07', opened_at: '2026-06-11T14:06:16Z' },
        { colo_name: 'sin19', opened_at: '2026-06-11T14:06:16Z' },
      ],
    },
    { id: 'abc', name: 'dormant', created_at: '2026-01-01T00:00:00Z', connections: null },
  ]);
  const t = parseTunnelList(raw);
  assert.equal(t.length, 2);
  assert.equal(t[0].name, 'aws-sg-proxy');
  assert.equal(t[0].connections, 3);
  assert.deepEqual(t[0].colos, ['sin19', 'sin07']); // deduped, order preserved
  assert.equal(t[0].status, 'healthy');
  assert.equal(t[1].status, 'inactive');
  assert.equal(t[1].connections, 0);
});

test('parseTunnelList throws on malformed output instead of masking it as zero tunnels', () => {
  assert.throws(() => parseTunnelList('{"error":"not an array"}'), /expected a JSON array/);
  assert.throws(() => parseTunnelList('not json at all'), SyntaxError);
  // Garbage entries (missing id/name) are dropped, not crashed on.
  const t = parseTunnelList('[{"id":"a","name":"ok","connections":[]},{"nope":true}]');
  assert.equal(t.length, 1);
  assert.equal(t[0].name, 'ok');
});

test('originCertPath honours TUNNEL_ORIGIN_CERT, else ~/.cloudflared/cert.pem', () => {
  const prev = process.env.TUNNEL_ORIGIN_CERT;
  process.env.TUNNEL_ORIGIN_CERT = '/tmp/custom-cert.pem';
  assert.equal(originCertPath(), '/tmp/custom-cert.pem');
  delete process.env.TUNNEL_ORIGIN_CERT;
  assert.ok(originCertPath().endsWith('/.cloudflared/cert.pem'));
  if (prev) process.env.TUNNEL_ORIGIN_CERT = prev;
});
