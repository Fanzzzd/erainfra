import test from 'node:test';
import assert from 'node:assert/strict';
import { failoverNode, type FailoverDeps } from '../src/runtime/failover.ts';
import { RouteStore } from '../src/runtime/routes.ts';

// A fake gateway: `present` is the set of connected agent ids; `sent` records deploy commands.
function fakeDeps(present: string[], opts: { fail?: Set<string> } = {}) {
  const routes = new RouteStore(undefined); // in-memory
  const sent: Array<{ to: string; cmd: any }> = [];
  const gateway: FailoverDeps['gateway'] = {
    get: (id) => (present.includes(id) ? ({ id, version: null, roles: [], connectedAt: '' }) : undefined),
    list: () => present.map((id) => ({ id, version: null, roles: ['worker'], connectedAt: '' })),
    send: async (to, cmd) => { sent.push({ to, cmd }); return { ok: !opts.fail?.has(to) }; },
    onDisconnect: () => {},
  };
  const secrets: FailoverDeps['secrets'] = { get: (app) => ({ APP: app }) };
  return { deps: { gateway, routes, secrets, log: () => {} } as FailoverDeps, routes, sent };
}

test('failover redeploys stranded apps onto a survivor and flips the route', async () => {
  const { deps, routes, sent } = fakeDeps(['nodeA', 'nodeB']);
  routes.set('web', { node: 'nodeA', image: 'reg/web:1', port: 8080 });
  routes.set('api', { node: 'nodeA', image: 'reg/api:1', port: 8081 });
  routes.set('other', { node: 'nodeB', image: 'reg/other:1', port: 8082 }); // not on the lost node

  // nodeA is gone (not in present) → take over its apps
  const present = ['nodeB'];
  deps.gateway.get = (id) => (present.includes(id) ? ({ id, version: null, roles: [], connectedAt: '' }) : undefined);
  deps.gateway.list = () => present.map((id) => ({ id, version: null, roles: ['worker'], connectedAt: '' }));

  const res = await failoverNode('nodeA', deps);
  assert.equal(res.length, 2); // web + api, not other
  assert.ok(res.every((r) => r.ok && r.to === 'nodeB'));
  // routes flipped to the survivor
  assert.equal(routes.node('web'), 'nodeB');
  assert.equal(routes.node('api'), 'nodeB');
  assert.equal(routes.node('other'), 'nodeB'); // untouched (already there)
  // deploy commands carried the recorded image/port + re-injected secrets
  const web = sent.find((s) => s.cmd.name === 'web')!;
  assert.equal(web.to, 'nodeB');
  assert.equal(web.cmd.image, 'reg/web:1');
  assert.equal(web.cmd.port, 8080);
  assert.deepEqual(web.cmd.env, { APP: 'web' });
});

test('no-op when the lost node reconnected within the grace window', async () => {
  const { deps, routes, sent } = fakeDeps(['nodeA']); // nodeA present again
  routes.set('web', { node: 'nodeA', image: 'reg/web:1', port: 8080 });
  const res = await failoverNode('nodeA', deps);
  assert.equal(res.length, 0);
  assert.equal(sent.length, 0); // didn't redeploy a node that's actually up
});

test('reports failure when no surviving node can take over', async () => {
  const { deps, routes } = fakeDeps([]); // nothing else connected
  routes.set('web', { node: 'nodeA', image: 'reg/web:1', port: 8080 });
  const res = await failoverNode('nodeA', deps);
  assert.equal(res.length, 1);
  assert.equal(res[0].ok, false);
  assert.match(res[0].error!, /no surviving node/);
});
