import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdtempSync, mkdirSync, symlinkSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { confineToAgentRoot } from '../src/router.ts';

function withRoot(root: string, fn: () => void) {
  const prev = process.env.PORTLESS_AGENT_ROOT;
  process.env.PORTLESS_AGENT_ROOT = root;
  try {
    fn();
  } finally {
    if (prev === undefined) delete process.env.PORTLESS_AGENT_ROOT;
    else process.env.PORTLESS_AGENT_ROOT = prev;
  }
}

test('confineToAgentRoot keeps an agent cwd inside the root', () => {
  withRoot('/srv/agent', () => {
    assert.equal(confineToAgentRoot(undefined), undefined);
    assert.equal(confineToAgentRoot('.'), '/srv/agent');
    assert.equal(confineToAgentRoot('sub/dir'), join('/srv/agent', 'sub/dir'));
  });
});

test('confineToAgentRoot rejects escape attempts (path traversal)', () => {
  withRoot('/srv/agent', () => {
    assert.throws(() => confineToAgentRoot('../../etc'), /inside the agent root/);
    assert.throws(() => confineToAgentRoot('/etc/passwd'), /inside the agent root/);
    assert.throws(() => confineToAgentRoot('/srv/agent-other'), /inside the agent root/); // prefix-but-not-child
  });
});

test('confineToAgentRoot rejects a symlink inside the root that points outside it', () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'portless-confine-')));
  const root = join(base, 'root');
  const outside = join(base, 'outside');
  mkdirSync(root);
  mkdirSync(outside);
  mkdirSync(join(root, 'ok'));
  symlinkSync(outside, join(root, 'escape')); // a symlink inside root → sibling dir outside root
  try {
    withRoot(root, () => {
      assert.equal(confineToAgentRoot('ok'), join(root, 'ok')); // real subdir is fine
      // Lexically `root/escape` looks inside root, but it resolves to `outside` — must be rejected.
      assert.throws(() => confineToAgentRoot('escape'), /inside the agent root/);
      assert.throws(() => confineToAgentRoot('escape/sub'), /inside the agent root/);
    });
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
