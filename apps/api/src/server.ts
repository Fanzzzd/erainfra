import './boot-env.ts'; // MUST be first: sets persist-path env defaults before router.ts builds its singletons
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import { fastifyTRPCPlugin, type CreateFastifyContextOptions } from '@trpc/server/adapters/fastify';
import { tmpdir } from 'node:os';
import { existsSync, readFileSync, mkdirSync, writeFileSync, createReadStream } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { appRouter } from './router.ts';
import type { Context } from './trpc.ts';
import { InMemoryAuditLog, FileAuditLog, type AuditLog } from './audit.ts';
import { defaultTokenStore, type TokenStore } from './auth.ts';
import { LocalRuntime } from './runtime/local.ts';
import { can } from './rbac.ts';
import { agentGateway } from './runtime/agents.ts';
import { githubAppConfig, verifyWebhook, parsePush } from './runtime/github.ts';
import { gitProjects, deployFromGit } from './runtime/gitdeploy.ts';

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
  // bodyLimit raised so drag-drop source uploads (tarballs) aren't capped at Fastify's 1MB default.
  // ponytail: 256MB cap, buffered in memory then written to disk — fine for a single-user PaaS; switch
  // to a streamed multipart upload if source bundles get large or uploads run concurrently.
  const app = Fastify({ logger: false, requestTimeout: 0, keepAliveTimeout: 0, bodyLimit: 256 * 1024 * 1024 });
  app.addHook('onClose', async () => runtime.stopAll());

  // Accept tarball uploads as a raw Buffer (drag-drop deploy sends the source as a gzipped tar).
  app.addContentTypeParser(['application/gzip', 'application/x-tar', 'application/octet-stream'], { parseAs: 'buffer' }, (_req, body, done) => done(null, body));

  // Drag-drop source ingestion: the dashboard POSTs a project's source as a .tar.gz; a build-capable
  // agent later fetches it back over the spine and builds it. Both routes need app.deploy. The build
  // id is a server-minted UUID, so the GET path can't be traversed.
  const buildsDir = process.env.PORTLESS_BUILDS_DIR ?? join(tmpdir(), 'portless-runtime', 'builds');
  const principalFor = (req: { headers: { authorization?: string | string[] } }) => {
    const p = tokens.resolve(bearerToken(req.headers.authorization));
    return p && can(p, 'app.deploy') ? p : undefined;
  };
  app.post('/upload', async (req, reply) => {
    if (!principalFor(req)) return reply.code(401).send({ error: 'unauthorized' });
    const body = req.body;
    if (!Buffer.isBuffer(body) || body.length === 0) return reply.code(400).send({ error: 'expected a non-empty tar.gz body (Content-Type: application/gzip)' });
    const buildId = randomUUID();
    mkdirSync(join(buildsDir, buildId), { recursive: true });
    writeFileSync(join(buildsDir, buildId, 'source.tgz'), body);
    return reply.code(201).send({ buildId, bytes: body.length });
  });
  app.get('/builds/:id/source.tgz', async (req, reply) => {
    if (!principalFor(req)) return reply.code(401).send({ error: 'unauthorized' });
    const { id } = req.params as { id: string };
    if (!/^[0-9a-f-]{36}$/.test(id)) return reply.code(400).send({ error: 'bad build id' });
    const f = join(buildsDir, id, 'source.tgz');
    if (!existsSync(f)) return reply.code(404).send({ error: 'no such build' });
    return reply.type('application/gzip').send(createReadStream(f));
  });

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

  // GitHub push-to-deploy webhook (the Vercel flow). Encapsulated so the raw-body parser (needed to
  // HMAC-verify the signature) doesn't affect tRPC's JSON parsing. On a verified push to a bound
  // repo+branch, it kicks off clone→build→deploy in the background and records the result.
  app.register(async (instance) => {
    instance.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));
    instance.post('/webhook/github', async (req, reply) => {
      const cfg = githubAppConfig();
      const raw = req.body as Buffer;
      if (!cfg.webhookSecret || !verifyWebhook(cfg.webhookSecret, raw, req.headers['x-hub-signature-256'] as string | undefined)) {
        return reply.code(401).send({ error: 'bad or missing signature' });
      }
      const event = req.headers['x-github-event'];
      if (event === 'ping') return reply.send({ ok: true, pong: true });
      if (event !== 'push') return reply.send({ ok: true, ignored: event });
      let push;
      try { push = parsePush(JSON.parse(raw.toString())); } catch { return reply.code(400).send({ error: 'bad json' }); }
      if (!push) return reply.send({ ok: true, ignored: 'non-branch push' });
      const binding = gitProjects.find(push.repo, push.branch);
      if (!binding) return reply.send({ ok: true, ignored: `no binding for ${push.repo}@${push.branch}` });
      // GitHub wants a fast 2xx — build+deploy run in the background; status is recorded on the binding.
      const proto = (req.headers['x-forwarded-proto'] as string | undefined) ?? 'https';
      const deployCfg = {
        registry: process.env.PORTLESS_REGISTRY ?? '127.0.0.1:5000',
        hubBase: process.env.PORTLESS_HUB_BASE ?? `${proto}://${req.headers.host}`,
        appId: cfg.appId,
        privateKey: cfg.privateKey,
      };
      void deployFromGit(binding, push.sha, push.installationId, deployCfg)
        .then((r) => gitProjects.setStatus(binding.id, { at: new Date().toISOString(), sha: push.sha, ok: r.ok, stage: r.stage, error: r.error }))
        .catch((e) => gitProjects.setStatus(binding.id, { at: new Date().toISOString(), sha: push.sha, ok: false, stage: 'build', error: (e as Error).message }));
      return reply.send({ ok: true, building: `${push.repo}@${push.sha.slice(0, 7)} → ${binding.name}` });
    });
  });

  // Public installer scripts: `curl -fsSL https://<hub>/mesh-node.sh | sh -s -- share 5432`, plus
  // registry.sh (image store) and image.sh (build/deploy). Unauthenticated by design — they carry
  // no secrets (install dumbpipe/zot, run share/connect/build/deploy). We template the served base
  // URL into each (the `<hub>` placeholder) so the commands they print point back at this hub.
  // Override the directory with PORTLESS_DEPLOY_DIR.
  const deployDir = process.env.PORTLESS_DEPLOY_DIR ?? join(import.meta.dirname, '../../../deploy');
  for (const script of ['mesh-node.sh', 'mesh-node.ps1', 'registry.sh', 'image.sh', 'agent.sh', 'agent.ps1']) {
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

  // Serve prebuilt agent binaries (populated by deploy/build-agents.sh) so agent.sh / agent.ps1 can
  // download the right one. Self-hosted distribution — no Docker Hub, no third-party release host.
  // The filename allowlist keeps this from becoming an arbitrary-file read.
  const agentBinDir = process.env.PORTLESS_AGENT_BIN_DIR ?? join(deployDir, 'bin');
  app.get('/agent-bin/:file', async (req, reply) => {
    const { file } = req.params as { file: string };
    if (!/^portless-agent-(linux|darwin|windows)-(amd64|arm64)(\.exe)?$/.test(file)) {
      return reply.code(400).type('text/plain').send('bad agent binary name\n');
    }
    const f = join(agentBinDir, file);
    if (!existsSync(f)) return reply.code(404).type('text/plain').send(`${file} not built — run deploy/build-agents.sh on the hub\n`);
    return reply.type('application/octet-stream').send(createReadStream(f));
  });

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
