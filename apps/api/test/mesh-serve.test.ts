import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApiServer } from '../src/server.ts';

test('GET /mesh-node.sh serves the script with the request URL templated in', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'meshsrv-'));
  const file = join(dir, 'mesh-node.sh');
  writeFileSync(file, '#!/bin/sh\nSELF_URL="<url>/mesh-node.sh"\n# curl <url>/mesh-node.sh | sh\n');
  process.env.PORTLESS_MESH_SCRIPT = file;
  const app = createApiServer();
  try {
    const res = await app.inject({ method: 'GET', url: '/mesh-node.sh', headers: { host: 'hub.example.com', 'x-forwarded-proto': 'https' } });
    assert.equal(res.statusCode, 200);
    assert.match(String(res.headers['content-type']), /x-shellscript/);
    assert.ok(res.body.includes('https://hub.example.com/mesh-node.sh')); // templated
    assert.ok(!res.body.includes('<url>/mesh-node.sh')); // every placeholder replaced
  } finally {
    await app.close();
    delete process.env.PORTLESS_MESH_SCRIPT;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('GET /mesh-node.sh is 404 when the script is absent', async () => {
  process.env.PORTLESS_MESH_SCRIPT = join(tmpdir(), 'no-such-mesh-node.sh');
  const app = createApiServer();
  try {
    const res = await app.inject({ method: 'GET', url: '/mesh-node.sh' });
    assert.equal(res.statusCode, 404);
  } finally {
    await app.close();
    delete process.env.PORTLESS_MESH_SCRIPT;
  }
});
