import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { tools, type McpToolContext } from './tools.ts';
import { FileAuditLog } from '../audit.ts';
import { defaultTokenStore } from '../auth.ts';
import { LocalRuntime } from '../runtime/local.ts';

// Thin stdio MCP server exposing the Portless tool registry. The identity comes from
// PORTLESS_MCP_TOKEN (bearer); dangerous tools still go through the API's RBAC +
// dry-run/confirm + audit envelope. ponytail: best-effort adapter, not unit-tested —
// the registry in tools.ts is the tested surface.
export function buildMcpServer(): McpServer {
  // Durable, shared audit trail (same file as the HTTP server) and fail-closed auth: in
  // production the bundled owner token is refused unless PORTLESS_MCP_TOKEN / PORTLESS_DEV_AUTH
  // is set, matching the HTTP entrypoint (no auth-bypass via the MCP door).
  const audit = new FileAuditLog(process.env.PORTLESS_AUDIT_FILE ?? join(tmpdir(), 'portless-runtime', 'audit.jsonl'));
  const principal = defaultTokenStore().resolve(process.env.PORTLESS_MCP_TOKEN ?? 'owner-dev-token');
  if (!principal) throw new Error('PORTLESS_MCP_TOKEN did not resolve to a principal (production requires a real token)');
  const ctx: McpToolContext = { principal, audit, runtime: new LocalRuntime() };

  const server = new McpServer({ name: 'portless', version: '0.1.0' });
  for (const t of tools) {
    server.registerTool(
      t.name,
      { description: t.description, inputSchema: t.inputSchema.shape },
      async (args: unknown) => {
        const result = await t.handler(ctx, args);
        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      },
    );
  }
  return server;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  buildMcpServer()
    .connect(new StdioServerTransport())
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
