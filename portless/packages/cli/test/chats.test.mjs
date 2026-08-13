// Transcript parsers against fixture lines in the REAL on-disk formats (captured 2026-07 from
// ~/.claude/projects and ~/.codex/sessions). `portless chats parse <file>` is the same code path
// sync uses, so this covers ingestion end to end minus the network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../portless.mjs', import.meta.url));
const parse = (file) => {
  const r = spawnSync(process.execPath, [CLI, 'chats', 'parse', file], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
};

test('claude parser: keeps human prompts + assistant text, skips tools/thinking/meta', () => {
  const dir = mkdtempSync(join(tmpdir(), 'chats-'));
  const f = join(dir, 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl');
  writeFileSync(f, [
    JSON.stringify({ type: 'mode', sessionId: 'x' }),
    JSON.stringify({ type: 'user', cwd: '/Users/me/code/app', timestamp: '2026-07-01T10:00:00Z', message: { role: 'user', content: 'fix the login bug' } }),
    JSON.stringify({ type: 'assistant', timestamp: '2026-07-01T10:00:05Z', message: { role: 'assistant', model: 'claude-fable-5', content: [{ type: 'thinking', thinking: 'hmm' }, { type: 'text', text: 'Looking at auth.ts now.' }] } }),
    JSON.stringify({ type: 'assistant', timestamp: '2026-07-01T10:00:06Z', message: { role: 'assistant', model: 'claude-fable-5', content: [{ type: 'tool_use', id: 't1', name: 'Read', input: {} }] } }),
    JSON.stringify({ type: 'user', timestamp: '2026-07-01T10:00:07Z', message: { role: 'user', content: [{ tool_use_id: 't1', type: 'tool_result', content: 'file contents' }] } }),
    JSON.stringify({ type: 'user', timestamp: '2026-07-01T10:00:08Z', message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] } }),
    JSON.stringify({ type: 'user', timestamp: '2026-07-01T10:01:00Z', message: { role: 'user', content: 'thanks, deploy it' } }),
  ].join('\n'));
  try {
    const { session, messages } = parse(f);
    assert.equal(session.id, 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
    assert.equal(session.source, 'claude');
    assert.equal(session.project, '/Users/me/code/app');
    assert.equal(session.title, 'fix the login bug');
    assert.deepEqual(messages.map((m) => m.role), ['user', 'assistant', 'user']);
    assert.equal(messages[1].text, 'Looking at auth.ts now.');
    assert.equal(messages[1].model, 'claude-fable-5');
    assert.equal(messages[2].text, 'thanks, deploy it');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('codex parser: keeps user/assistant messages, skips developer + scaffolding', () => {
  const dir = mkdtempSync(join(tmpdir(), 'chats-'));
  const f = join(dir, 'rollout-2026-07-01T10-00-00-0123456789ab.jsonl');
  writeFileSync(f, [
    JSON.stringify({ timestamp: '2026-07-01T10:00:00Z', type: 'session_meta', payload: { id: 'sess-codex-1', timestamp: '2026-07-01T10:00:00Z', cwd: '/Users/me/code/blog' } }),
    JSON.stringify({ timestamp: '2026-07-01T10:00:01Z', type: 'response_item', payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: '<permissions instructions>...' }] } }),
    JSON.stringify({ timestamp: '2026-07-01T10:00:01Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '# AGENTS.md instructions\n\nblah' }] } }),
    JSON.stringify({ timestamp: '2026-07-01T10:00:02Z', type: 'turn_context', payload: { model: 'gpt-5.5', cwd: '/Users/me/code/blog' } }),
    JSON.stringify({ timestamp: '2026-07-01T10:00:03Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'center a div please' }] } }),
    JSON.stringify({ timestamp: '2026-07-01T10:00:09Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Use place-items: center.' }] } }),
    JSON.stringify({ timestamp: '2026-07-01T10:00:10Z', type: 'event_msg', payload: { type: 'user_message', message: 'center a div please' } }),
  ].join('\n'));
  try {
    const { session, messages } = parse(f);
    assert.equal(session.id, 'sess-codex-1');
    assert.equal(session.source, 'codex');
    assert.equal(session.project, '/Users/me/code/blog');
    assert.equal(session.title, 'center a div please');
    assert.deepEqual(messages.map((m) => m.role), ['user', 'assistant']); // event_msg duplicate NOT double-counted
    assert.equal(messages[1].model, 'gpt-5.5');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
