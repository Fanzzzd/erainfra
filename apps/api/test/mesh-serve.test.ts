import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApiServer } from '../src/server.ts';

test('serves an installer with <hub> templated to the request base URL', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'deploy-'));
  writeFileSync(join(dir, 'mesh-node.sh'), '#!/bin/sh\nSELF_URL="<hub>/mesh-node.sh"\n# curl <hub>/image.sh\n');
  process.env.PORTLESS_DEPLOY_DIR = dir;
  const app = createApiServer();
  try {
    const res = await app.inject({ method: 'GET', url: '/mesh-node.sh', headers: { host: 'hub.example.com', 'x-forwarded-proto': 'https' } });
    assert.equal(res.statusCode, 200);
    assert.match(String(res.headers['content-type']), /x-shellscript/);
    assert.ok(res.body.includes('https://hub.example.com/mesh-node.sh')); // base templated in
    assert.ok(res.body.includes('https://hub.example.com/image.sh'));     // cross-script refs too
    assert.ok(!res.body.includes('<hub>'));                               // every placeholder replaced
  } finally {
    await app.close();
    delete process.env.PORTLESS_DEPLOY_DIR;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a whitelisted installer whose file is absent is 404', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'deploy-'));
  // dir has no registry.sh
  process.env.PORTLESS_DEPLOY_DIR = dir;
  const app = createApiServer();
  try {
    const res = await app.inject({ method: 'GET', url: '/registry.sh' });
    assert.equal(res.statusCode, 404);
  } finally {
    await app.close();
    delete process.env.PORTLESS_DEPLOY_DIR;
    rmSync(dir, { recursive: true, force: true });
  }
});
