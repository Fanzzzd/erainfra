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
  tool({ name: 'list_processes', description: 'List processes running on this machine, with their public URL if published.', inputSchema: empty }, (c) =>
    c.local.list(),
  ),
  // --- dangerous: dry-run by default, confirm:true required to go live ---
  tool(
    {
      name: 'deploy_app',
      description: 'Launch a real process on this machine from a template. Dry-run unless confirm:true.',
      dangerous: true,
      inputSchema: z.object({
        name: z.string().min(1),
        template: z.string().min(1),
        port: z.number().int().min(1024).max(65535),
        dryRun: z.boolean().default(true),
        confirm: z.boolean().default(false),
      }),
    },
    (c, i) => c.local.deploy(i),
  ),
  tool(
    {
      name: 'publish_app',
      description: 'Expose a running app on a public https URL via a Cloudflare quick tunnel. Requires confirm:true.',
      dangerous: true,
      inputSchema: z.object({ name: z.string().min(1), confirm: z.boolean().default(false) }),
    },
    (c, i) => c.local.publish(i),
  ),
];

export const toolsByName: Map<string, McpTool> = new Map(tools.map((t) => [t.name, t]));

export function getTool(name: string): McpTool | undefined {
  return toolsByName.get(name);
}
