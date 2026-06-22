import test from 'node:test';
import assert from 'node:assert/strict';
import { getTool, tools } from '../src/mcp/tools.ts';
import { appRouter } from '../src/router.ts';
import { createCallerFactory } from '../src/trpc.ts';
import { LocalRuntime } from '../src/runtime/local.ts';
import { InMemoryAuditLog } from '../src/audit.ts';
import type { Principal } from '../src/auth.ts';

const owner: Principal = { id: 'u-owner', name: 'Owner', roles: ['owner'] };
const viewer: Principal = { id: 'u-viewer', name: 'Viewer', roles: ['viewer'] };

function ctx(principal: Principal) {
  return { principal, audit: new InMemoryAuditLog() };
}

test('exposes the 9 documented MCP tools', () => {
  const names = tools.map((t) => t.name).sort();
  assert.deepEqual(names, [
    'deploy_app',
    'explain_failed_deployment',
    'get_app_health',
    'get_logs',
    'get_network_matrix',
    'list_apps',
    'list_machines',
    'rollback_release',
    'run_network_benchmark',
  ]);
});

test('unknown tool is not resolvable', () => {
  assert.equal(getTool('exec_shell'), undefined);
});

test('list_apps reads through the API (real project registry, empty until imported)', async () => {
  // No seeded demos: the registry starts empty. Import one through the API and list_apps must
  // surface it — proving the tool reads the real registry, not a hardcoded sample.
  const before = (await getTool('list_apps')!.handler(ctx(owner), {})) as Array<{ project: string }>;
  assert.ok(Array.isArray(before));
  const direct = createCallerFactory(appRouter)({ principal: owner, audit: new InMemoryAuditLog(), runtime: new LocalRuntime() });
  await direct.project.import({
    yaml: 'project: mcptest\nenvironment: prod\nservices:\n  - name: api\n    type: web\n    image: i\n    port: 80\n    resources: { cpu: 1, memoryMb: 1 }\n',
  });
  const after = (await getTool('list_apps')!.handler(ctx(owner), {})) as Array<{ project: string }>;
  assert.ok(after.some((a) => a.project === 'mcptest'));
});

// The deploy/confirm/rollback ENVELOPE (dry-run, confirm:true, audit) is the router's logic,
// fully covered by trpc.test. Here we only prove the MCP adapter threads ctx.principal so RBAC
// is inherited "for free" — one representative check is enough.
test('viewer cannot deploy via MCP (adapter threads RBAC through to the API)', async () => {
  await assert.rejects(() => getTool('deploy_app')!.handler(ctx(viewer), { app: 'demo/prod' }), /permission/);
});

test('dangerous tools are flagged', () => {
  assert.equal(getTool('deploy_app')!.dangerous, true);
  assert.equal(getTool('rollback_release')!.dangerous, true);
  assert.equal(getTool('list_apps')!.dangerous, false);
});
