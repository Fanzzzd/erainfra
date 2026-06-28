import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GitProjectStore, deployFromGit, deployFromUpload, type GitBinding } from '../src/runtime/gitdeploy.ts';

const sampleBind = { repo: 'Owner/Repo', branch: 'main', buildNode: 'bn', deployNode: 'dn', name: 'app', port: 8080 };

test('bindings persist across a reload (config must survive a hub restart)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gp-'));
  const file = join(dir, 'git-projects.json');
  try {
    const a = new GitProjectStore(file);
    assert.ok(a.bind(sampleBind).ok);
    // a fresh store reading the same file sees the binding (proves save+load)
    const b = new GitProjectStore(file);
    assert.equal(b.find('owner/repo', 'main')?.name, 'app');
    assert.equal(b.list().length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('store binds, finds case-insensitively, dedupes, and unbinds', () => {
  const s = new GitProjectStore(undefined); // in-memory
  const r = s.bind(sampleBind);
  assert.ok(r.ok && r.binding.id);
  // find is case-insensitive on the repo
  assert.equal(s.find('owner/repo', 'main')?.name, 'app');
  assert.equal(s.find('owner/repo', 'dev'), undefined); // branch must match
  // no double-binding the same repo+branch
  const dup = s.bind(sampleBind);
  assert.equal(dup.ok, false);
  const id = (r as { binding: GitBinding }).binding.id;
  assert.equal(s.unbind(id).ok, true);
  assert.equal(s.list().length, 0);
});

test('deployFromGit builds then deploys, with correct image/args (fake gateway)', async () => {
  const calls: Array<{ id: string; cmd: Record<string, unknown> }> = [];
  const gw = { send: async (id: string, cmd: Record<string, unknown>) => { calls.push({ id, cmd }); return { ok: true, output: cmd.cmd as string }; } };
  const b: GitBinding = { id: '1', ...sampleBind, repo: 'o/r' };
  const r = await deployFromGit(b, 'abcdef1234567890', undefined, { registry: 'reg:5000', hubBase: 'http://hub' }, gw);

  assert.equal(r.ok, true);
  assert.equal(r.stage, 'deploy');
  assert.equal(r.image, 'reg:5000/app:abcdef123456'); // sha truncated to 12

  assert.equal(calls[0].id, 'bn');
  assert.equal(calls[0].cmd.cmd, 'build');
  assert.equal(calls[0].cmd.repoUrl, 'https://github.com/o/r.git'); // public clone (no token configured)
  assert.equal(calls[0].cmd.tag, 'app:abcdef123456');
  assert.equal(calls[0].cmd.registry, 'reg:5000');

  assert.equal(calls[1].id, 'dn');
  assert.equal(calls[1].cmd.cmd, 'deploy');
  assert.equal(calls[1].cmd.image, 'reg:5000/app:abcdef123456');
  assert.deepEqual(calls[1].cmd.args, ['-e', 'PORT=8080', '-p', '8080:8080']);
});

test('deployFromUpload builds from the uploaded tarball then deploys', async () => {
  const calls: Array<{ id: string; cmd: Record<string, unknown> }> = [];
  const gw = { send: async (id: string, cmd: Record<string, unknown>) => { calls.push({ id, cmd }); return { ok: true }; } };
  const id = '11111111-1111-1111-1111-111111111111';
  const r = await deployFromUpload(id, { buildNode: 'bn', deployNode: 'dn', name: 'app', port: 9000 }, { registry: 'reg:5000', hubBase: 'http://hub' }, gw);
  assert.equal(r.ok, true);
  assert.equal(calls[0].cmd.cmd, 'build');
  assert.equal(calls[0].cmd.tarUrl, `http://hub/builds/${id}/source.tgz`);
  assert.equal(calls[0].cmd.repoUrl, undefined); // tar source, not git
  assert.equal(calls[1].cmd.cmd, 'deploy');
  assert.deepEqual(calls[1].cmd.args, ['-e', 'PORT=9000', '-p', '9000:9000']);
});

test('deployFromGit short-circuits when the build fails (no deploy)', async () => {
  const calls: string[] = [];
  const gw = { send: async (_id: string, cmd: Record<string, unknown>) => { calls.push(cmd.cmd as string); return cmd.cmd === 'build' ? { ok: false, error: 'boom' } : { ok: true }; } };
  const b: GitBinding = { id: '1', ...sampleBind, repo: 'o/r' };
  const r = await deployFromGit(b, 'x', undefined, { registry: 'r', hubBase: 'h' }, gw);
  assert.equal(r.ok, false);
  assert.equal(r.stage, 'build');
  assert.equal(r.error, 'boom');
  assert.deepEqual(calls, ['build']); // deploy never attempted
});
