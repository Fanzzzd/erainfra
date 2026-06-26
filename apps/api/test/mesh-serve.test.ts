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

test('agent-bin serves allowlisted binaries and rejects anything else', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentbin-'));
  writeFileSync(join(dir, 'portless-agent-linux-amd64'), 'ELF-ish bytes');
  process.env.PORTLESS_AGENT_BIN_DIR = dir;
  const app = createApiServer();
  try {
    const ok = await app.inject({ method: 'GET', url: '/agent-bin/portless-agent-linux-amd64' });
    assert.equal(ok.statusCode, 200);
    assert.equal(ok.body, 'ELF-ish bytes');
    assert.match(String(ok.headers['content-type']), /octet-stream/);
    // built name but not present → 404 (points at build-agents.sh)
    assert.equal((await app.inject({ method: 'GET', url: '/agent-bin/portless-agent-windows-amd64.exe' })).statusCode, 404);
    // off-allowlist names and traversal → 400, never an arbitrary file read
    assert.equal((await app.inject({ method: 'GET', url: '/agent-bin/portless-agent-bogus' })).statusCode, 400);
    assert.equal((await app.inject({ method: 'GET', url: '/agent-bin/..%2f..%2fetc%2fpasswd' })).statusCode, 400);
  } finally {
    await app.close();
    delete process.env.PORTLESS_AGENT_BIN_DIR;
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
