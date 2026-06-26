import './boot-env.ts'; // MUST be first: sets persist-path env defaults before router.ts builds its singletons
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import { fastifyTRPCPlugin, type CreateFastifyContextOptions } from '@trpc/server/adapters/fastify';
import { tmpdir } from 'node:os';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { appRouter } from './router.ts';
import type { Context } from './trpc.ts';
import { InMemoryAuditLog, FileAuditLog, type AuditLog } from './audit.ts';
import { defaultTokenStore, type TokenStore } from './auth.ts';
import { LocalRuntime } from './runtime/local.ts';
import { can } from './rbac.ts';
import { agentGateway } from './runtime/agents.ts';

// Re-export so existing importers (and tests) keep working.
export { appRouter, type AppRouter } from './router.ts';

function bearerToken(authorization: string | string[] | undefined): string | undefined {
  const header = Array.isArray(authorization) ? authorization[0] : authorization;
  return header?.startsWith('Bearer ') ? header.slice(7) : undefined;
}

export function createApiServer(opts: { audit?: AuditLog; tokens?: TokenStore; runtime?: LocalRuntime; webDir?: string } = {}): FastifyInstance {
  const audit = opts.audit ?? new InMemoryAuditLog();
  // Fail-closed in production; dev tokens only outside production (see defaultTokenStore).
  const tokens = opts.tokens ?? defaultTokenStore();
  const runtime = opts.runtime ?? new LocalRuntime();
  // requestTimeout:0 disables Node's 5-min cap so long agent orchestrations aren't cut off.
  const app = Fastify({ logger: false, requestTimeout: 0, keepAliveTimeout: 0 });
  app.addHook('onClose', async () => runtime.stopAll());

  // REST liveness check kept for smoke tests / unauthenticated probes.
  app.get('/health', async () => ({ ok: true }));

  // Agent control channel (self-controlled, replaces dumbpipe): portless agents on remote NAT'd
  // boxes dial IN over WSS and the hub pushes them commands. Authed with the same bearer token;
  // agents need app.deploy (they execute deploys). The socket staying open is the presence signal.
  // Encapsulated so @fastify/websocket is fully loaded BEFORE the route is added — otherwise the
  // `{ websocket: true }` option is ignored and the upgrade just hangs.
  app.register(async (instance) => {
    await instance.register(fastifyWebsocket);
    instance.get('/agent', { websocket: true }, (socket, req) => {
      const principal = tokens.resolve(bearerToken(req.headers.authorization));
      if (!principal || !can(principal, 'app.deploy')) { try { socket.close(1008, 'unauthorized'); } catch { /* gone */ } return; }
      const s = { send: (d: string) => socket.send(d), close: () => socket.close() };
      socket.on('message', (data: Buffer) => agentGateway.onMessage(s, data.toString()));
      socket.on('close', () => agentGateway.onClose(s));
    });
  });

  // Public installer scripts: `curl -fsSL https://<hub>/mesh-node.sh | sh -s -- share 5432`, plus
  // registry.sh (image store) and image.sh (build/deploy). Unauthenticated by design — they carry
  // no secrets (install dumbpipe/zot, run share/connect/build/deploy). We template the served base
  // URL into each (the `<hub>` placeholder) so the commands they print point back at this hub.
  // Override the directory with PORTLESS_DEPLOY_DIR.
  const deployDir = process.env.PORTLESS_DEPLOY_DIR ?? join(import.meta.dirname, '../../../deploy');
  for (const script of ['mesh-node.sh', 'mesh-node.ps1', 'registry.sh', 'image.sh']) {
    const mime = script.endsWith('.ps1') ? 'text/plain; charset=utf-8' : 'text/x-shellscript; charset=utf-8';
    app.get(`/${script}`, async (req, reply) => {
      let body: string;
      try {
        body = readFileSync(join(deployDir, script), 'utf8');
      } catch {
        return reply.code(404).type('text/plain').send(`${script} not available on this server\n`);
      }
      const proto = (req.headers['x-forwarded-proto'] as string | undefined) ?? 'https';
      const base = `${proto}://${req.headers.host}`;
      return reply.type(mime).send(body.split('<hub>').join(base));
    });
  }

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

  // Single-origin production deploy: serve the built dashboard from the same origin as /trpc, so
  // one tunnel hostname covers both. The SPA uses hash routing, so static files + index at '/' are
  // enough (no catch-all rewrite). Only enabled when a build dir is configured AND exists; dev runs
  // the Vite server separately and leaves this off. PORTLESS_WEB_DIR defaults to the repo's web dist.
  const webDir = opts.webDir ?? process.env.PORTLESS_WEB_DIR;
  if (webDir && existsSync(webDir)) {
    app.register(fastifyStatic, { root: webDir, prefix: '/' });
  }

  return app;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT ?? process.env.PORTLESS_PORT ?? 8787);
  // Durable audit trail on disk so dangerous Cloudflare/deploy ops survive restarts.
  const auditFile = process.env.PORTLESS_AUDIT_FILE ?? join(tmpdir(), 'portless-runtime', 'audit.jsonl');
  // Bind loopback by default: behind a tunnel, cloudflared connects over localhost — nothing
  // public binds. Opt into LAN exposure with PORTLESS_BIND only when you mean it.
  const host = process.env.PORTLESS_BIND ?? '127.0.0.1';
  // Serve the built dashboard if present (single-origin prod deploy); default to the repo's dist.
  const webDir = process.env.PORTLESS_WEB_DIR ?? join(import.meta.dirname, '../../web/dist');
  createApiServer({ audit: new FileAuditLog(auditFile), webDir })
    .listen({ port, host })
    .then((address) => console.log(`Portless API listening on ${address}`))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
