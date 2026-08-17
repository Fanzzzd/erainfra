import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createApiServer } from '../src/server.ts';

// server.ts anchors PORTLESS_DEPLOY_DIR / PORTLESS_CLI_FILE on its own directory, so mirror that
// anchor here rather than hardcoding a repo-root-relative path: if the module ever moves, the import
// above moves with it and these stay pointed at whatever server.ts itself would compute.
const serverDir = join(import.meta.dirname, '../src');
const DEPLOY_DIR = join(serverDir, '../../../deploy'); // server.ts's PORTLESS_DEPLOY_DIR default
const CLI_FILE = join(serverDir, '../../../packages/cli/portless.mjs'); // its PORTLESS_CLI_FILE default

// What a customer machine curls during onboarding. Both routes fail SOFT — a wrong path yields a 404
// carrying a plausible "not available on this server" message, never a boot error — so nothing else
// in this suite would notice a directory move that silently breaks node enrolment.
const INSTALLERS = ['agent.sh', 'agent.ps1', 'cli.sh', 'image.sh', 'registry.sh'];

test('the default installer paths resolve to real files and the routes serve them', async () => {
  delete process.env.PORTLESS_DEPLOY_DIR; // exercise the defaults, not whatever the shell exported
  delete process.env.PORTLESS_CLI_FILE;
  const app = createApiServer();
  try {
    assert.ok(existsSync(DEPLOY_DIR), `default deploy dir does not exist: ${DEPLOY_DIR}`);
    for (const script of INSTALLERS) {
      const onDisk = join(DEPLOY_DIR, script);
      assert.ok(existsSync(onDisk), `default deploy dir has no ${script}: ${onDisk}`);
      const res = await app.inject({ method: 'GET', url: `/${script}`, headers: { host: 'hub.example' } });
      assert.equal(res.statusCode, 200, `GET /${script} returned ${res.statusCode} — the default deploy dir no longer resolves`);
      assert.match(String(res.headers['content-type']), script.endsWith('.ps1') ? /text\/plain/ : /text\/x-shellscript/);
      // Each script carries `<hub>` placeholders that are templated to the serving origin; assert the
      // substitution really happened, so "200 with an untemplated body" can't pass for a served script.
      assert.ok(readFileSync(onDisk, 'utf8').includes('<hub>'), `${script} no longer has a <hub> placeholder to template`);
      assert.ok(res.body.includes('http://hub.example'), `${script} was served without its hub URL templated in`);
      assert.ok(!res.body.includes('<hub>'), `${script} was served with an untemplated <hub> left in it`);
    }

    // The CLI payload cli.sh downloads. Separate default path, so it breaks independently of the above.
    assert.ok(existsSync(CLI_FILE), `default CLI file does not exist: ${CLI_FILE}`);
    const cli = await app.inject({ method: 'GET', url: '/cli/portless.mjs' });
    assert.equal(cli.statusCode, 200, `GET /cli/portless.mjs returned ${cli.statusCode} — the default CLI path no longer resolves`);
    assert.match(String(cli.headers['content-type']), /text\/javascript/);
    assert.equal(cli.body, readFileSync(CLI_FILE, 'utf8'));
  } finally {
    await app.close();
  }
});

test('a broken installer path fails soft with a 404 — which is why the test above pins the defaults', async () => {
  process.env.PORTLESS_DEPLOY_DIR = join(DEPLOY_DIR, 'moved-away');
  process.env.PORTLESS_CLI_FILE = join(CLI_FILE, 'moved-away');
  const app = createApiServer();
  try {
    for (const script of INSTALLERS) {
      const res = await app.inject({ method: 'GET', url: `/${script}` });
      assert.equal(res.statusCode, 404); // no throw, no 5xx: invisible to any test that only boots the server
      assert.match(res.body, new RegExp(`^${script} not available on this server`));
    }
    const cli = await app.inject({ method: 'GET', url: '/cli/portless.mjs' });
    assert.equal(cli.statusCode, 404);
    assert.match(cli.body, /^cli not available on this server/);
  } finally {
    await app.close();
    delete process.env.PORTLESS_DEPLOY_DIR;
    delete process.env.PORTLESS_CLI_FILE;
  }
});
