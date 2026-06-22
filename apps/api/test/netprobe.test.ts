import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { tcpProbe } from '../src/runtime/netprobe.ts';

test('tcpProbe measures a real handshake to a listening port', async () => {
  const server = createServer();
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  try {
    const res = await tcpProbe('127.0.0.1', port);
    assert.equal(res.reachable, true);
    assert.ok(res.rttMs !== null && res.rttMs >= 0);
  } finally {
    server.close();
  }
});

test('tcpProbe reports unreachable honestly (no invented latency)', async () => {
  // 127.0.0.1:1 is not listening; connect refuses fast.
  const res = await tcpProbe('127.0.0.1', 1, 1000);
  assert.equal(res.reachable, false);
  assert.equal(res.rttMs, null);
  assert.ok(res.error);
});
