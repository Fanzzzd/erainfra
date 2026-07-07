// The AI-conversation archive: ingest (idempotent replace), listing, FTS5 search with snippets,
// and the permission wall (operator/viewer tokens must see nothing — transcripts are sensitive).
import test from 'node:test';
import assert from 'node:assert/strict';
import { ChatStore, ftsQuery } from '../src/runtime/chats.ts';
import { createDb } from '../src/db.ts';
import { createApiServer } from '../src/server.ts';
import { StaticTokenStore } from '../src/auth.ts';

const meta = (id: string, over: Record<string, unknown> = {}) =>
  ({ id, source: 'claude' as const, host: 'mac', project: '/Users/me/code/portless', title: 'fix the tunnel', startedAt: '2026-07-01T00:00:00Z', updatedAt: '2026-07-01T01:00:00Z', ...over });

test('chat store: replace is idempotent, list/messages/search work', () => {
  const s = new ChatStore(createDb(':memory:'));
  s.replaceSession(meta('s1'), [
    { seq: 0, role: 'user', at: '2026-07-01T00:00:00Z', text: 'how do I configure the cloudflare tunnel?' },
    { seq: 1, role: 'assistant', model: 'claude-fable-5', text: 'Use cloudflared with a named tunnel and a config file.' },
  ]);
  s.replaceSession(meta('s2', { source: 'codex', project: '/Users/me/code/blog', title: 'blog css' }), [
    { seq: 0, role: 'user', text: 'center a div with css grid' },
    { seq: 1, role: 'assistant', model: 'gpt-5.5', text: 'place-items: center on the grid container.' },
  ]);

  // replace: re-ingesting s1 with more messages must not duplicate anything
  s.replaceSession(meta('s1'), [
    { seq: 0, role: 'user', text: 'how do I configure the cloudflare tunnel?' },
    { seq: 1, role: 'assistant', model: 'claude-fable-5', text: 'Use cloudflared with a named tunnel and a config file.' },
    { seq: 2, role: 'user', text: 'and the DNS route?' },
  ]);
  assert.equal(s.get('s1')?.messageCount, 3);
  assert.equal(s.messages('s1').length, 3);
  assert.deepEqual(s.stats(), { sessions: 2, messages: 5 });

  // list + filters
  assert.equal(s.listSessions().length, 2);
  assert.equal(s.listSessions({ source: 'codex' })[0].id, 's2');
  assert.equal(s.listSessions({ project: 'portless' })[0].id, 's1');

  // FTS search finds the right message with a snippet, ranked
  const hits = s.search('cloudflare tunnel');
  assert.ok(hits.length >= 1);
  assert.equal(hits[0].session.id, 's1');
  assert.match(hits[0].snippet, /\[cloudflare\]|\[tunnel\]/);
  assert.equal(s.search('css grid')[0].session.id, 's2');
  assert.equal(s.search('zzz-no-such-term').length, 0);

  // remove drops messages and the index
  assert.ok(s.remove('s2'));
  assert.equal(s.search('css grid').length, 0);
  assert.equal(s.listSessions().length, 1);
});

test('ftsQuery neutralizes MATCH syntax', () => {
  assert.equal(ftsQuery('hello world'), '"hello" "world"');
  assert.equal(ftsQuery('a"b OR *'), '"a""b" "OR" "*"'); // operators become literals
  assert.equal(ftsQuery('  '), '');
});

test('http: chat endpoints are walled off from operator/viewer tokens', async () => {
  const app = createApiServer({
    tokens: new StaticTokenStore({
      'owner-t': { id: 'u1', name: 'o', roles: ['owner'] },
      'operator-t': { id: 'u2', name: 'op', roles: ['operator'] },
      'viewer-t': { id: 'u3', name: 'v', roles: ['viewer'] },
    }),
  });
  try {
    const ingest = (token: string) =>
      app.inject({
        method: 'POST',
        url: '/trpc/chats.ingest',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        payload: JSON.stringify({ session: meta('h1'), messages: [{ seq: 0, role: 'user', text: 'secret sauce recipe' }] }),
      });
    assert.equal((await ingest('operator-t')).statusCode, 403); // node tokens cannot write
    assert.equal((await ingest('owner-t')).statusCode, 200);

    const search = (token: string) => app.inject({ method: 'GET', url: `/trpc/chats.search?input=${encodeURIComponent(JSON.stringify({ q: 'secret sauce' }))}`, headers: { authorization: `Bearer ${token}` } });
    assert.equal((await search('viewer-t')).statusCode, 403); // read is also walled
    assert.equal((await search('operator-t')).statusCode, 403);
    const ok = await search('owner-t');
    assert.equal(ok.statusCode, 200);
    const hits = (ok.json() as { result: { data: Array<{ session: { id: string } }> } }).result.data;
    assert.equal(hits[0].session.id, 'h1');
  } finally {
    await app.close();
  }
});
