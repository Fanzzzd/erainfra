import test from 'node:test';
import assert from 'node:assert/strict';
import { LocalRuntime, buildFromTemplate, APP_TEMPLATES } from '../src/runtime/local.ts';

// A free-ish high port for the test server.
const PORT = 8911 + Math.floor((Date.now() % 1000) / 10);

test('templates render to argv (no shell)', () => {
  assert.ok(APP_TEMPLATES.length >= 1);
  const spec = buildFromTemplate('static-web', 'demo', PORT);
  assert.equal(spec.name, 'demo');
  assert.ok(Array.isArray(spec.args));
  assert.equal(spec.port, PORT);
});

test('deploy launches a REAL process that serves health, logs, then stops', async () => {
  const rt = new LocalRuntime();
  try {
    const spec = buildFromTemplate('static-web', 'it-demo', PORT);
    const proc = rt.deploy(spec);
    assert.ok(proc.pid > 0);
    assert.equal(proc.status, 'running');
    assert.equal(rt.list().length, 1);
    assert.equal(rt.forget('it-demo'), false, 'must not forget a running process');

    // Wait for the server to bind, then real HTTP health check.
    let health: string = 'critical';
    for (let i = 0; i < 30; i++) {
      health = await rt.health('it-demo');
      if (health === 'passing') break;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.equal(health, 'passing', 'expected the launched process to pass health');

    const logs = rt.logs('it-demo');
    assert.ok(logs.some((l) => l.includes('listening')), `logs: ${logs.join('|')}`);

    await rt.stop('it-demo');
    assert.equal(rt.get('it-demo')?.status, 'exited');
    assert.equal(await rt.health('it-demo'), 'critical');

    // forget clears the exited record (completes deploy→stop→clear); a second forget is a no-op.
    assert.equal(rt.forget('it-demo'), true);
    assert.equal(rt.get('it-demo'), undefined);
    assert.equal(rt.list().length, 0);
    assert.equal(rt.forget('it-demo'), false);
  } finally {
    await rt.stopAll();
  }
});

test('rejects invalid names', () => {
  const rt = new LocalRuntime();
  assert.throws(() => rt.deploy({ name: 'Bad Name!', command: 'true' }), /invalid name/);
});
