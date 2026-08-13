import test from 'node:test';
import assert from 'node:assert/strict';
import { establishLink, ensureRegistryLinks } from '../src/runtime/appdeploy.ts';
import { LinkStore, linkStore } from '../src/runtime/links.ts';
import { createDb } from '../src/db.ts';

// A fake gateway: `present` = connected agent ids; meshShare replies with a ticket, everything else ok.
function fakeGw(present: string[], opts: { failShare?: boolean; failConnect?: boolean } = {}) {
  const sent: Array<{ to: string; cmd: any }> = [];
  const gw = {
    list: () => present.map((id) => ({ id, version: null, roles: ['worker'] as any, connectedAt: '' })),
    send: async (to: string, cmd: any) => {
      sent.push({ to, cmd });
      if (cmd.cmd === 'meshShare') return opts.failShare ? { ok: false, error: 'share boom' } : { ok: true, output: 'TICKET-abc\n' };
      if (cmd.cmd === 'meshConnect') return opts.failConnect ? { ok: false, error: 'connect boom' } : { ok: true, output: '127.0.0.1:9999' };
      return { ok: true };
    },
  };
  return { gw: gw as any, sent };
}

const LINK = { name: 'db-link', provider: 'boxa', providerPort: 5432, consumer: 'boxb', localPort: 15432 };

test('LinkStore round-trips and replaces by name', () => {
  const store = new LinkStore(createDb(':memory:'));
  store.set({ ...LINK });
  assert.deepEqual(store.get('db-link'), LINK);
  store.set({ ...LINK, localPort: 25432 });
  assert.equal(store.get('db-link')!.localPort, 25432);
  assert.equal(store.list().length, 1);
  assert.equal(store.delete('db-link'), true);
  assert.equal(store.get('db-link'), undefined);
});

test('establishLink shares on the provider then connects the consumer with the ticket', async () => {
  const { gw, sent } = fakeGw(['boxa', 'boxb']);
  await establishLink(LINK, gw);
  assert.deepEqual(sent.map((s) => [s.to, s.cmd.cmd]), [['boxa', 'meshShare'], ['boxb', 'meshConnect']]);
  assert.equal(sent[0].cmd.port, 5432);
  assert.equal(sent[1].cmd.ticket, 'TICKET-abc'); // trimmed
  assert.equal(sent[1].cmd.port, 15432);
});

test('establishLink refuses when either node is offline and surfaces agent errors', async () => {
  await assert.rejects(() => establishLink(LINK, fakeGw(['boxa']).gw), /node offline/);
  await assert.rejects(() => establishLink(LINK, fakeGw(['boxa', 'boxb'], { failShare: true }).gw), /share boom/);
  await assert.rejects(() => establishLink(LINK, fakeGw(['boxa', 'boxb'], { failConnect: true }).gw), /connect boom/);
});

test('ensureRegistryLinks wires every remote node to the registry and persists the links', async (t) => {
  process.env.PORTLESS_REGISTRY_NODE = 'hub-box';
  t.after(() => delete process.env.PORTLESS_REGISTRY_NODE);
  const { gw, sent } = fakeGw(['hub-box', 'far-box']);
  const err = await ensureRegistryLinks(['hub-box', 'far-box', 'far-box'], '127.0.0.1:61050', gw);
  assert.equal(err, null);
  // hub-box (co-located) is skipped; far-box deduped to one link.
  assert.deepEqual(sent.map((s) => [s.to, s.cmd.cmd]), [['hub-box', 'meshShare'], ['far-box', 'meshConnect']]);
  const stored = linkStore.get('registry-far-box');
  assert.deepEqual(stored, { name: 'registry-far-box', provider: 'hub-box', providerPort: 61050, consumer: 'far-box', localPort: 61050, createdBy: 'deploy' });
  linkStore.delete('registry-far-box');
});

test('ensureRegistryLinks is a no-op for co-located deploys and for unconfigured single-box setups', async (t) => {
  process.env.PORTLESS_REGISTRY_NODE = 'hub-box';
  t.after(() => delete process.env.PORTLESS_REGISTRY_NODE);
  const local = fakeGw(['hub-box']);
  assert.equal(await ensureRegistryLinks(['hub-box'], '127.0.0.1:61050', local.gw), null);
  assert.equal(local.sent.length, 0);

  // Unset = the pre-mesh single-box behavior: don't guess, don't wire, don't fail.
  delete process.env.PORTLESS_REGISTRY_NODE;
  const unset = fakeGw(['far-box']);
  assert.equal(await ensureRegistryLinks(['far-box'], '127.0.0.1:61050', unset.gw), null);
  assert.equal(unset.sent.length, 0);
});
