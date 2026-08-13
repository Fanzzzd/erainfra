import test from 'node:test';
import assert from 'node:assert/strict';
import { failoverNode, type FailoverDeps } from '../src/runtime/failover.ts';
import { RouteStore } from '../src/runtime/routes.ts';
import { AppStore } from '../src/runtime/apps.ts';
import { createDb } from '../src/db.ts';

// A fake gateway: `present` is the set of connected agent ids; `sent` records deploy commands.
function fakeDeps(present: string[], opts: { fail?: Set<string> } = {}) {
  const routes = new RouteStore(createDb(':memory:'));
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

test('a multi-service app fails over as a group; its routes are not redeployed individually', async () => {
  const { deps, routes, sent } = fakeDeps(['nodeB']);
  const apps = new AppStore(createDb(':memory:'));
  deps.apps = apps;
  // "flight" app on nodeA: web (exposed) + db (internal). The exposed service also has a route entry.
  apps.set('flight', {
    node: 'nodeA',
    services: [
      { name: 'web', image: 'reg/flight-web:1', args: ['-p', '127.0.0.1:3000:3000'], port: 3000, route: 'flight' },
      { name: 'db', image: 'postgres:16', args: [] },
    ],
  });
  routes.set('flight', { node: 'nodeA', image: 'reg/flight-web:1', port: 3000 }); // web's ingress route
  routes.set('solo', { node: 'nodeA', image: 'reg/solo:1', port: 9000 }); // a genuine single-container app

  const res = await failoverNode('nodeA', deps);
  assert.equal(res.length, 2); // the flight group + the solo app
  assert.ok(res.every((r) => r.ok && r.to === 'nodeB'));

  // the group went over via ONE deployApp carrying all services...
  const appCmd = sent.find((s) => s.cmd.cmd === 'deployApp');
  assert.ok(appCmd, 'expected a deployApp command');
  assert.equal(appCmd!.cmd.app, 'flight');
  assert.equal(appCmd!.cmd.services.length, 2);
  // ...and the exposed route "flight" was NOT also redeployed as a lone container
  assert.equal(sent.filter((s) => s.cmd.cmd === 'deploy' && s.cmd.name === 'flight').length, 0);
  // the genuine single-container app WAS redeployed individually
  assert.ok(sent.some((s) => s.cmd.cmd === 'deploy' && s.cmd.name === 'solo'));
  // appStore + routes flipped to the survivor
  assert.equal(apps.get('flight')!.node, 'nodeB');
  assert.equal(routes.node('flight'), 'nodeB');
  assert.equal(routes.node('solo'), 'nodeB');
});

test('reports failure when no surviving node can take over', async () => {
  const { deps, routes } = fakeDeps([]); // nothing else connected
  routes.set('web', { node: 'nodeA', image: 'reg/web:1', port: 8080 });
  const res = await failoverNode('nodeA', deps);
  assert.equal(res.length, 1);
  assert.equal(res[0].ok, false);
  assert.match(res[0].error!, /no surviving node/);
});
