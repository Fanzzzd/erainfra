import { z } from 'zod';
import { appRouter } from '../router.ts';
import { createCallerFactory } from '../trpc.ts';
import type { AuditLog } from '../audit.ts';
import type { Principal } from '../auth.ts';
import { LocalRuntime } from '../runtime/local.ts';

// MCP tools operate the Portless tRPC API only — never SSH or raw shell. RBAC, the
// dry-run/confirm safety envelope, and audit logging are all enforced by the API
// procedures the handlers call, so the tools inherit them for free.
const createCaller = createCallerFactory(appRouter);

export interface McpToolContext {
  principal: Principal;
  audit: AuditLog;
  runtime?: LocalRuntime;
}

export interface McpTool {
  name: string;
  description: string;
  dangerous: boolean;
  inputSchema: z.AnyZodObject;
  handler(ctx: McpToolContext, input: unknown): Promise<unknown>;
}

const empty = z.object({});
const dangerous = z.object({ app: z.string().min(1), dryRun: z.boolean().default(true), confirm: z.boolean().default(false) });

function tool<S extends z.AnyZodObject>(
  def: { name: string; description: string; dangerous?: boolean; inputSchema: S },
  run: (caller: ReturnType<typeof createCaller>, input: z.infer<S>) => Promise<unknown>,
): McpTool {
  return {
    name: def.name,
    description: def.description,
    dangerous: def.dangerous ?? false,
    inputSchema: def.inputSchema,
    async handler(ctx, raw) {
      const input = def.inputSchema.parse(raw ?? {});
      const caller = createCaller({ principal: ctx.principal, audit: ctx.audit, runtime: ctx.runtime ?? new LocalRuntime() });
      return run(caller, input as z.infer<S>);
    },
  };
}

export const tools: McpTool[] = [
  tool({ name: 'list_apps', description: 'List apps with their services and replica counts.', inputSchema: empty }, (c) =>
    c.app.list(),
  ),
  tool(
    { name: 'get_app_health', description: 'Get health status for an app.', inputSchema: z.object({ app: z.string().min(1) }) },
    (c, i) => c.app.health(i),
  ),
  tool(
    {
      name: 'get_logs',
      description: 'Get recent logs for an app/service.',
      inputSchema: z.object({ app: z.string().min(1), service: z.string().optional(), lines: z.number().int().positive().max(1000).optional() }),
    },
    (c, i) => c.app.logs({ app: i.app, service: i.service, lines: i.lines ?? 100 }),
  ),
  tool({ name: 'list_machines', description: 'List enrolled machines and their roles/addresses.', inputSchema: empty }, (c) =>
    c.machines.list(),
  ),
  tool({ name: 'get_network_matrix', description: 'Get the machine-to-machine network path matrix.', inputSchema: empty }, (c) =>
    c.network.matrix(),
  ),
  tool(
    {
      name: 'run_network_benchmark',
      description: 'Benchmark the network path between two machines.',
      inputSchema: z.object({ from: z.string().min(1), to: z.string().min(1) }),
    },
    (c, i) => c.network.benchmark(i),
  ),
  tool(
    {
      name: 'explain_failed_deployment',
      description: 'Explain why a recent deployment failed, from audited events.',
      inputSchema: z.object({ app: z.string().optional() }),
    },
    (c, i) => c.deployments.explain(i),
  ),
  // --- dangerous: dry-run by default, confirm:true required to go live ---
  tool({ name: 'deploy_app', description: 'Deploy an app. Dry-run unless confirm:true.', dangerous: true, inputSchema: dangerous }, (c, i) =>
    c.app.deploy(i),
  ),
  tool(
    {
      name: 'rollback_release',
      description: 'Roll back an app to a previous release. Dry-run unless confirm:true.',
      dangerous: true,
      inputSchema: dangerous.extend({ toRelease: z.string().optional() }),
    },
    (c, i) => c.app.rollback(i),
  ),
];

export const toolsByName: Map<string, McpTool> = new Map(tools.map((t) => [t.name, t]));

export function getTool(name: string): McpTool | undefined {
  return toolsByName.get(name);
}
