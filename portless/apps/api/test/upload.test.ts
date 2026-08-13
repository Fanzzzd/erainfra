import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApiServer } from '../src/server.ts';

const AUTH = { authorization: 'Bearer owner-dev-token' }; // dev token → owner (has app.deploy) outside prod

test('source upload round-trips and is auth-gated', async () => {
  process.env.PORTLESS_BUILDS_DIR = mkdtempSync(join(tmpdir(), 'builds-'));
  const app = createApiServer();
  const tarball = Buffer.from('pretend-this-is-a-tar-gz\x00\x01\x02');
  try {
    // upload needs auth
    const noAuth = await app.inject({ method: 'POST', url: '/upload', headers: { 'content-type': 'application/gzip' }, payload: tarball });
    assert.equal(noAuth.statusCode, 401);

    // upload returns a build id
    const up = await app.inject({ method: 'POST', url: '/upload', headers: { ...AUTH, 'content-type': 'application/gzip' }, payload: tarball });
    assert.equal(up.statusCode, 201);
    const { buildId, bytes } = up.json();
    assert.match(buildId, /^[0-9a-f-]{36}$/);
    assert.equal(bytes, tarball.length);

    // the build agent fetches it back — byte-for-byte
    const got = await app.inject({ method: 'GET', url: `/builds/${buildId}/source.tgz`, headers: AUTH });
    assert.equal(got.statusCode, 200);
    assert.ok(got.rawPayload.equals(tarball));

    // fetch needs auth, rejects traversal-y / unknown ids
    assert.equal((await app.inject({ method: 'GET', url: `/builds/${buildId}/source.tgz` })).statusCode, 401);
    assert.equal((await app.inject({ method: 'GET', url: '/builds/..%2f..%2fetc/source.tgz', headers: AUTH })).statusCode, 400);
    assert.equal((await app.inject({ method: 'GET', url: '/builds/00000000-0000-0000-0000-000000000000/source.tgz', headers: AUTH })).statusCode, 404);

    // empty body is rejected
    assert.equal((await app.inject({ method: 'POST', url: '/upload', headers: { ...AUTH, 'content-type': 'application/gzip' }, payload: Buffer.alloc(0) })).statusCode, 400);
  } finally {
    await app.close();
    rmSync(process.env.PORTLESS_BUILDS_DIR!, { recursive: true, force: true });
    delete process.env.PORTLESS_BUILDS_DIR;
  }
});
