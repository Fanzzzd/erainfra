import './boot-env.ts'; // MUST be first: sets persist-path env defaults before router.ts builds its singletons
import Fastify, { type FastifyInstance } from 'fastify';
import { fastifyTRPCPlugin, type CreateFastifyContextOptions } from '@trpc/server/adapters/fastify';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appRouter } from './router.ts';
import type { Context } from './trpc.ts';
import { InMemoryAuditLog, FileAuditLog, type AuditLog } from './audit.ts';
import { defaultTokenStore, type TokenStore } from './auth.ts';
import { LocalRuntime } from './runtime/local.ts';

// Re-export so existing importers (and tests) keep working.
export { appRouter, type AppRouter } from './router.ts';

function bearerToken(authorization: string | string[] | undefined): string | undefined {
  const header = Array.isArray(authorization) ? authorization[0] : authorization;
  return header?.startsWith('Bearer ') ? header.slice(7) : undefined;
}

export function createApiServer(opts: { audit?: AuditLog; tokens?: TokenStore; runtime?: LocalRuntime } = {}): FastifyInstance {
  const audit = opts.audit ?? new InMemoryAuditLog();
  // Fail-closed in production; dev tokens only outside production (see defaultTokenStore).
  const tokens = opts.tokens ?? defaultTokenStore();
  const runtime = opts.runtime ?? new LocalRuntime();
  // requestTimeout:0 disables Node's 5-min cap so long agent orchestrations aren't cut off.
  const app = Fastify({ logger: false, requestTimeout: 0, keepAliveTimeout: 0 });
  app.addHook('onClose', async () => runtime.stopAll());

  // REST liveness check kept for smoke tests / unauthenticated probes.
  app.get('/health', async () => ({ ok: true }));

  app.register(fastifyTRPCPlugin, {
    prefix: '/trpc',
    trpcOptions: {
      router: appRouter,
      createContext: ({ req }: CreateFastifyContextOptions): Context => ({
        principal: tokens.resolve(bearerToken(req.headers.authorization)),
        audit,
        runtime,
      }),
    },
  });

  return app;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT ?? process.env.PORTLESS_PORT ?? 8787);
  // Durable audit trail on disk so dangerous Cloudflare/deploy ops survive restarts.
  const auditFile = process.env.PORTLESS_AUDIT_FILE ?? join(tmpdir(), 'portless-runtime', 'audit.jsonl');
  // Bind loopback by default: the browser ships a bearer token, so a 0.0.0.0 bind would let
  // anyone on the LAN call mutating routes as that principal. Opt into LAN exposure explicitly.
  const host = process.env.PORTLESS_BIND ?? '127.0.0.1';
  createApiServer({ audit: new FileAuditLog(auditFile) })
    .listen({ port, host })
    .then((address) => console.log(`Portless API listening on ${address}`))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
