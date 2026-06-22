import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAgentCommand, scrubEnv } from '../src/runtime/orchestrator.ts';

test('codex command: plan is read-only, execute is workspace-write', () => {
  const plan = buildAgentCommand({ agent: 'codex', task: 'review the repo', mode: 'plan' });
  assert.equal(plan.cmd, 'codex');
  assert.ok(plan.args.includes('exec'));
  assert.deepEqual(plan.args.slice(plan.args.indexOf('-s'), plan.args.indexOf('-s') + 2), ['-s', 'read-only']);
  assert.equal(plan.args.at(-1), 'review the repo');

  const exec = buildAgentCommand({ agent: 'codex', task: 't', mode: 'execute' });
  assert.ok(exec.args.includes('workspace-write'));
});

test('claude command: plan uses --permission-mode plan (no edits)', () => {
  const plan = buildAgentCommand({ agent: 'claude', task: 'list services', mode: 'plan' });
  assert.equal(plan.cmd, 'claude');
  assert.deepEqual(plan.args.slice(0, 2), ['-p', 'list services']);
  assert.ok(plan.args.includes('plan'));

  const exec = buildAgentCommand({ agent: 'claude', task: 't', mode: 'execute' });
  assert.ok(exec.args.includes('acceptEdits'));
});

test('codex command honors cwd', () => {
  const c = buildAgentCommand({ agent: 'codex', task: 't', mode: 'plan', cwd: '/tmp/x' });
  assert.deepEqual(c.args.slice(c.args.indexOf('-C'), c.args.indexOf('-C') + 2), ['-C', '/tmp/x']);
});

test('scrubEnv strips secrets but keeps benign vars an agent needs', () => {
  const cleaned = scrubEnv({
    PATH: '/usr/bin',
    HOME: '/Users/x',
    CLOUDFLARE_API_TOKEN: 'cf-secret',
    AWS_SECRET_ACCESS_KEY: 'aws-secret',
    PORTLESS_DEV_TOKENS: '{"t":1}',
    GITHUB_TOKEN: 'ghp_x',
    MY_PASSWORD: 'hunter2',
    SESSION_ID: 'abc',
    LANG: 'en_US.UTF-8',
  });
  assert.equal(cleaned.PATH, '/usr/bin'); // agent needs these
  assert.equal(cleaned.HOME, '/Users/x');
  assert.equal(cleaned.LANG, 'en_US.UTF-8');
  for (const k of ['CLOUDFLARE_API_TOKEN', 'AWS_SECRET_ACCESS_KEY', 'PORTLESS_DEV_TOKENS', 'GITHUB_TOKEN', 'MY_PASSWORD', 'SESSION_ID']) {
    assert.equal(cleaned[k], undefined, `${k} must be scrubbed`);
  }
});
