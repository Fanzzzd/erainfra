import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createApiServer } from '../src/server.ts';

const SECRET = 'hook-secret';
const sign = (body: string) => 'sha256=' + createHmac('sha256', SECRET).update(body).digest('hex');
const post = (app: ReturnType<typeof createApiServer>, body: string, headers: Record<string, string>) =>
  app.inject({ method: 'POST', url: '/webhook/github', headers: { 'content-type': 'application/json', ...headers }, payload: body });

test('github webhook verifies signature and routes events', async () => {
  process.env.PORTLESS_GH_WEBHOOK_SECRET = SECRET;
  const app = createApiServer();
  try {
    const push = JSON.stringify({ ref: 'refs/heads/main', after: 'deadbeef', repository: { full_name: 'nobody/none' } });

    // missing/bad signature → 401, never acts
    assert.equal((await post(app, push, { 'x-github-event': 'push' })).statusCode, 401);
    assert.equal((await post(app, push, { 'x-github-event': 'push', 'x-hub-signature-256': 'sha256=bad' })).statusCode, 401);

    // valid ping → pong
    const ping = await post(app, '{}', { 'x-github-event': 'ping', 'x-hub-signature-256': sign('{}') });
    assert.equal(ping.statusCode, 200);
    assert.equal(ping.json().pong, true);

    // valid push but no binding for the repo → acknowledged + ignored (does not 500)
    const res = await post(app, push, { 'x-github-event': 'push', 'x-hub-signature-256': sign(push) });
    assert.equal(res.statusCode, 200);
    assert.match(res.json().ignored, /no binding/);

    // non-branch push (tag) → ignored
    const tag = JSON.stringify({ ref: 'refs/tags/v1', repository: { full_name: 'nobody/none' } });
    const tagRes = await post(app, tag, { 'x-github-event': 'push', 'x-hub-signature-256': sign(tag) });
    assert.equal(tagRes.statusCode, 200);
    assert.match(tagRes.json().ignored, /non-branch/);
  } finally {
    await app.close();
    delete process.env.PORTLESS_GH_WEBHOOK_SECRET;
  }
});
