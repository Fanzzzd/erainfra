import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { router, publicProcedure, requirePermission } from './trpc.ts';
import { agentGateway } from './runtime/agents.ts';
import { dataGateway } from './runtime/dataplane.ts';
import { gitProjects, startGitDeploy, startUploadDeploy } from './runtime/gitdeploy.ts';
import { deployments } from './runtime/deployments.ts';
import { removeApp, establishLink } from './runtime/appdeploy.ts';
import { linkStore } from './runtime/links.ts';
import { githubAppConfig } from './runtime/github.ts';
import { secretStore } from './runtime/secrets.ts';
import { routeStore } from './runtime/routes.ts';
import { appStore } from './runtime/apps.ts';
import { backupConfig, backupNow, listBackups } from './runtime/backup.ts';
import { userStore } from './runtime/users.ts';
import { sessionStore } from './runtime/sessions.ts';
import { apiTokenStore } from './runtime/apitokens.ts';
import type { AuditLog } from './audit.ts';
import type { Principal } from './auth.ts';

// Record an audited op and return the audit id + whether it was durably persisted, so EVERY
// dangerous mutator surfaces an audit gap to the caller instead of hiding it behind success.
function recordOp(ctx: { principal: Principal; audit: AuditLog }, entry: { action: string; target: string; outcome: 'success' | 'failure'; dryRun?: boolean }) {
  const e = ctx.audit.record({ actor: ctx.principal.id, ...entry });
  return { auditId: e.id, auditDurable: ctx.audit.lastWriteDurable() };
}

// Fail closed: durably record an 'attempt' BEFORE an irreversible external side effect (e.g. a
// real Cloudflare account mutation). If the audit log can't be persisted, refuse — we will not
// take an unauditable dangerous action. Returns nothing; throws when the durable write failed.
function requireDurableAudit(ctx: { principal: Principal; audit: AuditLog }, action: string, target: string) {
  ctx.audit.record({ actor: ctx.principal.id, action, target, outcome: 'attempt' });
  if (!ctx.audit.lastWriteDurable()) {
    throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'refusing: audit trail is not durable, cannot safely record this action' });
  }
}

export const appRouter = router({
  health: publicProcedure.query(() => ({ ok: true })),

  audit: router({
    list: requirePermission('audit.read')
      .input(z.object({ limit: z.number().int().positive().max(500).optional() }))
      .query(({ ctx, input }) => ctx.audit.list(input.limit)),
  }),


  // Agents: remote boxes that dialed into the hub over WSS (the self-controlled control channel that
  // replaces dumbpipe). The hub pushes them commands — deploy a container, run a command — and awaits
  // the reply. Both mutators are confirm-gated + durably audited (they execute on a real machine).
  agents: router({
    list: requirePermission('app.read').query(() => agentGateway.list()),

    // Deploy a container on an agent: it docker-pulls from the registry and docker-runs it.
    deploy: requirePermission('app.deploy')
      .input(
        z.object({
          agentId: z.string().min(1),
          image: z.string().min(1).max(512),
          name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/, 'lowercase alphanumeric + dashes'),
          args: z.array(z.string().max(256)).max(64).default([]),
          port: z.number().int().min(1).max(65535).optional(), // set to register a wildcard-domain ingress route
          confirm: z.boolean().default(false),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        if (!input.confirm) throw new TRPCError({ code: 'BAD_REQUEST', message: 'confirm:true required to deploy to an agent' });
        requireDurableAudit(ctx, 'agents.deploy', `${input.agentId}: ${input.image}`);
        try {
          // Secrets (keyed by container name) ride as a map → agent writes a 0600 --env-file, not argv.
          const reply = await agentGateway.send(input.agentId, { cmd: 'deploy', image: input.image, name: input.name, args: input.args, env: secretStore.get(input.name), port: input.port }, 180_000);
          if (reply.ok && input.port) routeStore.set(input.name, { node: input.agentId, image: input.image, port: input.port }); // ingress + failover record
          const op = recordOp(ctx, { action: 'agents.deploy', target: `${input.agentId}:${input.name}`, outcome: reply.ok ? 'success' : 'failure' });
          return { ...reply, ...op };
        } catch (e) {
          recordOp(ctx, { action: 'agents.deploy', target: input.agentId, outcome: 'failure' });
          throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: (e as Error).message });
        }
      }),

    // Deploy a multi-service ("compose-like") app across one or more agents. Services on the SAME node
    // share a per-app docker network (so they reach each other by service name); a service's `node`
    // places it elsewhere (default: agentId). Each exposed service (one with a `route`) gets a
    // wildcard-domain ingress route from its own node — reusing the single-container data plane
    // unchanged. Cross-node service-to-service links (e.g. backend→db) are NOT set up here — that's the
    // mesh (see agents.linkService). Secrets are injected per service: app-level (keyed by the app
    // name) merged with per-service overrides (keyed by `<app>-<service>`), never persisted, never argv.
    deployApp: requirePermission('app.deploy')
      .input(
        z.object({
          agentId: z.string().min(1), // default node for services that don't pin their own
          app: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/, 'lowercase alphanumeric + dashes'),
          services: z
            .array(
              z.object({
                name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/, 'lowercase alphanumeric + dashes'),
                image: z.string().min(1).max(512),
                args: z.array(z.string().max(256)).max(64).default([]),
                port: z.number().int().min(1).max(65535).optional(),
                route: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/).optional(), // exposed service: its Args must publish `port`
                node: z.string().min(1).optional(), // which agent runs this service (default: agentId)
              }),
            )
            .min(1)
            .max(20),
          confirm: z.boolean().default(false),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        if (!input.confirm) throw new TRPCError({ code: 'BAD_REQUEST', message: 'confirm:true required to deploy an app to an agent' });
        const names = input.services.map((s) => s.name);
        if (new Set(names).size !== names.length) throw new TRPCError({ code: 'BAD_REQUEST', message: 'service names must be unique within the app' });
        const routes = input.services.filter((s) => s.route).map((s) => s.route!);
        if (new Set(routes).size !== routes.length) throw new TRPCError({ code: 'BAD_REQUEST', message: 'service routes must be unique within the app' });
        for (const s of input.services) if (s.route && !s.port) throw new TRPCError({ code: 'BAD_REQUEST', message: `service "${s.name}" has a route but no port` });
        // Resolve each service's node, then group so each node gets ONE deployApp with just its services.
        const placed = input.services.map((s) => ({ ...s, node: s.node ?? input.agentId }));
        const connected = new Set(agentGateway.list().map((a) => a.id));
        for (const n of new Set(placed.map((s) => s.node))) if (!connected.has(n)) throw new TRPCError({ code: 'BAD_REQUEST', message: `node "${n}" is not connected` });
        requireDurableAudit(ctx, 'agents.deployApp', `${input.app}: ${input.services.length} svc across ${new Set(placed.map((s) => s.node)).size} node(s)`);
        try {
          const byNode = new Map<string, typeof placed>();
          for (const s of placed) (byNode.get(s.node) ?? byNode.set(s.node, []).get(s.node)!).push(s);
          const results: Array<{ node: string; ok: boolean; output?: string; error?: string }> = [];
          for (const [node, svcs] of byNode) {
            const services = svcs.map((s) => ({ name: s.name, image: s.image, args: s.args, port: s.port, route: s.route, env: { ...secretStore.get(input.app), ...secretStore.get(`${input.app}-${s.name}`) } }));
            const reply = await agentGateway.send(node, { cmd: 'deployApp', app: input.app, services }, 300_000);
            results.push({ node, ok: reply.ok, output: reply.output, error: reply.error });
          }
          const ok = results.every((r) => r.ok);
          if (ok) {
            appStore.set(input.app, { node: input.agentId, services: placed.map((s) => ({ name: s.name, image: s.image, args: s.args, port: s.port, route: s.route, node: s.node })) });
            for (const s of placed) if (s.route && s.port) routeStore.set(s.route, { node: s.node, image: s.image, port: s.port });
          }
          const op = recordOp(ctx, { action: 'agents.deployApp', target: `${input.app}`, outcome: ok ? 'success' : 'failure' });
          return { ok, results, ...op };
        } catch (e) {
          recordOp(ctx, { action: 'agents.deployApp', target: input.app, outcome: 'failure' });
          throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: (e as Error).message });
        }
      }),

    // Wire a service on one node to a service on ANOTHER node over the mesh (dumbpipe/iroh), so e.g. a
    // backend can reach its database with no public IP and without exposing the DB on a domain. The
    // hub only brokers the ticket: the provider node `share`s its loopback port (→ ticket), the
    // consumer node `connect`s it (→ a local port bound on all the node's interfaces). Data then flows
    // P2P node-to-node, not through the hub. Returns the address the consumer's containers use
    // (host.docker.internal:<localPort> with --add-host host.docker.internal:host-gateway).
    linkService: requirePermission('app.deploy')
      .input(
        z.object({
          name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/, 'lowercase alphanumeric + dashes'), // stable link id
          provider: z.string().min(1), // node that HAS the service
          providerPort: z.number().int().min(1).max(65535), // the service's loopback port on the provider node
          consumer: z.string().min(1), // node that WANTS the service
          localPort: z.number().int().min(1).max(65535), // local port the link is surfaced on, on the consumer node
          confirm: z.boolean().default(false),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        if (!input.confirm) throw new TRPCError({ code: 'BAD_REQUEST', message: 'confirm:true required to link a service across the mesh' });
        const connected = new Set(agentGateway.list().map((a) => a.id));
        for (const n of [input.provider, input.consumer]) if (!connected.has(n)) throw new TRPCError({ code: 'BAD_REQUEST', message: `node "${n}" is not connected` });
        requireDurableAudit(ctx, 'agents.linkService', `${input.name}: ${input.provider}:${input.providerPort} → ${input.consumer}:${input.localPort}`);
        try {
          const share = await agentGateway.send(input.provider, { cmd: 'meshShare', name: input.name, port: input.providerPort }, 60_000);
          if (!share.ok || !share.output) throw new Error(`provider share failed: ${share.error ?? 'no ticket returned'}`);
          // The ticket is a capability to reach the service — kept hub-internal, never returned to the caller.
          const conn = await agentGateway.send(input.consumer, { cmd: 'meshConnect', name: input.name, ticket: share.output.trim(), port: input.localPort }, 60_000);
          if (!conn.ok) throw new Error(`consumer connect failed: ${conn.error}`);
          const op = recordOp(ctx, { action: 'agents.linkService', target: input.name, outcome: 'success' });
          return { ok: true, address: `host.docker.internal:${input.localPort}`, localAddress: (conn.output ?? '').trim(), ...op };
        } catch (e) {
          recordOp(ctx, { action: 'agents.linkService', target: input.name, outcome: 'failure' });
          throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: (e as Error).message });
        }
      }),

    // Run a command on an agent (debug/ops; the container path above is the normal one).
    run: requirePermission('app.deploy')
      .input(z.object({ agentId: z.string().min(1), argv: z.array(z.string().min(1)).min(1).max(64), confirm: z.boolean().default(false) }))
      .mutation(async ({ ctx, input }) => {
        if (!input.confirm) throw new TRPCError({ code: 'BAD_REQUEST', message: 'confirm:true required to run a command on an agent' });
        requireDurableAudit(ctx, 'agents.run', `${input.agentId}: ${input.argv.join(' ')}`);
        try {
          const reply = await agentGateway.send(input.agentId, { cmd: 'exec', argv: input.argv });
          const op = recordOp(ctx, { action: 'agents.run', target: input.agentId, outcome: reply.ok ? 'success' : 'failure' });
          return { ...reply, ...op };
        } catch (e) {
          recordOp(ctx, { action: 'agents.run', target: input.agentId, outcome: 'failure' });
          throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: (e as Error).message });
        }
      }),
  }),

  // Standalone mesh links: reach <provider-node>:<port> from <consumer-node> at 127.0.0.1:<localPort>,
  // node-to-node over iroh (dumbpipe) — no public IP, no tunnel, no per-app spec. Links are persisted
  // and healed across agent/hub restarts (installLinkHealer). This is the user-facing "machine+port"
  // internal wiring; app-declared `needs:` links live with their app instead.
  mesh: router({
    list: requirePermission('app.read').query(() => {
      const connected = new Set(agentGateway.list().map((a) => a.id));
      return linkStore.list().map((l) => ({ ...l, online: connected.has(l.provider) && connected.has(l.consumer) }));
    }),

    link: requirePermission('app.deploy')
      .input(
        z.object({
          name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/, 'lowercase alphanumeric + dashes').optional(),
          provider: z.string().min(1), // node that HAS the service
          providerPort: z.number().int().min(1).max(65535),
          consumer: z.string().min(1), // node that WANTS the service
          localPort: z.number().int().min(1).max(65535).optional(), // default: same as providerPort
          confirm: z.boolean().default(false),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        if (!input.confirm) throw new TRPCError({ code: 'BAD_REQUEST', message: 'confirm:true required to create a mesh link' });
        const localPort = input.localPort ?? input.providerPort;
        const name = input.name ?? `${input.provider}-${input.providerPort}-${input.consumer}`.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 63);
        const link = { name, provider: input.provider, providerPort: input.providerPort, consumer: input.consumer, localPort, createdBy: 'user' as const };
        const existing = linkStore.get(name);
        if (existing && (existing.provider !== link.provider || existing.providerPort !== link.providerPort || existing.consumer !== link.consumer)) {
          throw new TRPCError({ code: 'BAD_REQUEST', message: `link "${name}" already exists (${existing.provider}:${existing.providerPort} → ${existing.consumer}) — unlink it first or pick another --name` });
        }
        requireDurableAudit(ctx, 'mesh.link', `${name}: ${input.provider}:${input.providerPort} → ${input.consumer}:${localPort}`);
        try {
          await establishLink(link);
          linkStore.set(link);
          const op = recordOp(ctx, { action: 'mesh.link', target: name, outcome: 'success' });
          return { ok: true, name, address: `127.0.0.1:${localPort}`, containerAddress: `host.docker.internal:${localPort}`, ...op };
        } catch (e) {
          recordOp(ctx, { action: 'mesh.link', target: name, outcome: 'failure' });
          throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: (e as Error).message });
        }
      }),

    unlink: requirePermission('app.deploy')
      .input(z.object({ name: z.string().min(1).max(63), confirm: z.boolean().default(false) }))
      .mutation(async ({ ctx, input }) => {
        if (!input.confirm) throw new TRPCError({ code: 'BAD_REQUEST', message: 'confirm:true required to remove a mesh link' });
        const link = linkStore.get(input.name);
        if (!link) throw new TRPCError({ code: 'NOT_FOUND', message: `no such link: ${input.name}` });
        requireDurableAudit(ctx, 'mesh.unlink', input.name);
        // Best-effort teardown on both ends (a node may be offline); the store forgets it either way,
        // so the healer stops resurrecting it.
        await agentGateway.send(link.provider, { cmd: 'meshDrop', name: link.name }, 30_000).catch(() => {});
        await agentGateway.send(link.consumer, { cmd: 'meshDrop', name: link.name }, 30_000).catch(() => {});
        linkStore.delete(link.name);
        const op = recordOp(ctx, { action: 'mesh.unlink', target: input.name, outcome: 'success' });
        return { ok: true, ...op };
      }),
  }),

  // Git push-to-deploy (the Vercel flow): bind a repo+branch to build/deploy nodes; a GitHub webhook
  // (see /webhook/github) or git.deployNow runs clone→build→deploy. deployNow is also the manual
  // "redeploy" button and what verification drives.
  git: router({
    list: requirePermission('app.read').query(() => gitProjects.list()),

    bind: requirePermission('app.deploy')
      .input(
        z.object({
          repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/, 'owner/name'),
          branch: z.string().min(1).max(255).default('main'),
          buildNode: z.string().min(1).optional(), // default: first connected node
          deployNode: z.string().min(1).optional(),
          name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/, 'lowercase alphanumeric + dashes'),
          port: z.number().int().min(1).max(65535).optional(), // only for repos with no portless.yaml
          confirm: z.boolean().default(false),
        }),
      )
      .mutation(({ ctx, input }) => {
        if (!input.confirm) throw new TRPCError({ code: 'BAD_REQUEST', message: 'confirm:true required to bind a repo' });
        const res = gitProjects.bind(input);
        if (!res.ok) throw new TRPCError({ code: 'BAD_REQUEST', message: res.error });
        const op = recordOp(ctx, { action: 'git.bind', target: `${input.repo}@${input.branch}`, outcome: 'success' });
        return { ...res.binding, ...op };
      }),

    unbind: requirePermission('app.deploy')
      .input(z.object({ id: z.string().min(1), confirm: z.boolean().default(false) }))
      .mutation(({ ctx, input }) => {
        if (!input.confirm) throw new TRPCError({ code: 'BAD_REQUEST', message: 'confirm:true required to unbind' });
        const res = gitProjects.unbind(input.id);
        if (!res.ok) throw new TRPCError({ code: 'NOT_FOUND', message: 'no such binding' });
        const op = recordOp(ctx, { action: 'git.unbind', target: input.id, outcome: 'success' });
        return { ...res, ...op };
      }),

    // Manual deploy of a binding's current branch (the "Redeploy" button). Returns a deployId
    // immediately — builds take minutes and Cloudflare cuts tunneled requests at ~100s, so the
    // pipeline runs in the background; poll apps.status. Audits repo+sha, never the clone token.
    deployNow: requirePermission('app.deploy')
      .input(z.object({ id: z.string().min(1), sha: z.string().max(64).default(''), confirm: z.boolean().default(false) }))
      .mutation(async ({ ctx, input }) => {
        if (!input.confirm) throw new TRPCError({ code: 'BAD_REQUEST', message: 'confirm:true required to deploy' });
        const binding = gitProjects.get(input.id);
        if (!binding) throw new TRPCError({ code: 'NOT_FOUND', message: 'no such binding' });
        const hubBase = process.env.PORTLESS_HUB_BASE;
        if (!hubBase) throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'set PORTLESS_HUB_BASE (the hub url your build agents can reach) to deploy' });
        requireDurableAudit(ctx, 'git.deployNow', `${binding.repo}@${binding.branch}`);
        const { appId, privateKey } = githubAppConfig();
        try {
          const started = startGitDeploy(binding, input.sha, undefined, { registry: process.env.PORTLESS_REGISTRY ?? '127.0.0.1:5000', hubBase, appId, privateKey });
          void started.done.then((r) => gitProjects.setStatus(binding.id, { at: new Date().toISOString(), sha: input.sha, ok: r.ok, stage: r.stage, error: r.error }));
          const op = recordOp(ctx, { action: 'git.deployNow', target: `${binding.repo}:${binding.name}`, outcome: 'success' });
          return { deployId: started.deployId, app: binding.name, ...op };
        } catch (e) {
          recordOp(ctx, { action: 'git.deployNow', target: binding.repo, outcome: 'failure' });
          throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: (e as Error).message });
        }
      }),
  }),

  // Per-app environment variables / secrets (encrypted at rest), injected into the container on the
  // next deploy. Values are write-only over the API — list returns masked previews, never plaintext.
  env: router({
    list: requirePermission('app.read')
      .input(z.object({ app: z.string().min(1).max(63) }))
      .query(({ input }) => secretStore.list(input.app)),

    set: requirePermission('app.deploy')
      .input(z.object({ app: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/), vars: z.record(z.string().min(1).max(256), z.string().max(32768)) }))
      .mutation(({ ctx, input }) => {
        const keys = Object.keys(input.vars);
        if (keys.length === 0) throw new TRPCError({ code: 'BAD_REQUEST', message: 'no vars given' });
        try {
          secretStore.setMany(input.app, input.vars);
        } catch (e) {
          throw new TRPCError({ code: 'BAD_REQUEST', message: (e as Error).message });
        }
        // Audit the KEYS, never the values.
        const op = recordOp(ctx, { action: 'env.set', target: `${input.app}: ${keys.join(',')}`, outcome: 'success' });
        return { ok: true, keys, ...op };
      }),

    unset: requirePermission('app.deploy')
      .input(z.object({ app: z.string().min(1).max(63), key: z.string().min(1).max(256) }))
      .mutation(({ ctx, input }) => {
        const ok = secretStore.unset(input.app, input.key);
        if (!ok) throw new TRPCError({ code: 'NOT_FOUND', message: 'no such var' });
        const op = recordOp(ctx, { action: 'env.unset', target: `${input.app}: ${input.key}`, outcome: 'success' });
        return { ok, ...op };
      }),
  }),

  // Deployed apps = the routing/failover source of truth (app -> {node, image, port}), written on
  // every git/upload deploy. Surfaces each app's live URL (wildcard domain) and whether it's online.
  routes: router({
    list: requirePermission('app.read').query(() => {
      const domain = process.env.PORTLESS_APP_DOMAIN;
      return routeStore.list().map((r) => ({
        app: r.app,
        node: r.node,
        port: r.port,
        online: dataGateway.isConnected(r.node), // data channel open = actually serving traffic
        nodeConnected: !!agentGateway.get(r.node),
        url: domain ? `https://${r.app}.${domain}` : null,
      }));
    }),

    // Stop an app and forget its route(s). Delegates to the group-aware removal, so removing a
    // route label of a multi-service app tears down the whole app.
    remove: requirePermission('app.deploy')
      .input(z.object({ app: z.string().min(1).max(63), confirm: z.boolean().default(false) }))
      .mutation(async ({ ctx, input }) => {
        if (!input.confirm) throw new TRPCError({ code: 'BAD_REQUEST', message: 'confirm:true required to remove an app' });
        requireDurableAudit(ctx, 'routes.remove', input.app);
        try {
          const r = await removeApp(input.app);
          const op = recordOp(ctx, { action: 'routes.remove', target: input.app, outcome: 'success' });
          return { ...r, ...op };
        } catch (e) {
          recordOp(ctx, { action: 'routes.remove', target: input.app, outcome: 'failure' });
          throw new TRPCError({ code: 'NOT_FOUND', message: (e as Error).message });
        }
      }),
  }),

  // Control-plane backup to your own S3 (routes, secrets, bindings, audit). Config (endpoint/bucket)
  // is reported but keys never are; backup.now uploads a state tarball.
  backup: router({
    config: requirePermission('app.read').query(() => {
      const cfg = backupConfig();
      return cfg ? { configured: true as const, endpoint: cfg.endpoint, bucket: cfg.bucket, prefix: cfg.prefix } : { configured: false as const };
    }),

    now: requirePermission('app.deploy')
      .input(z.object({ confirm: z.boolean().default(false) }))
      .mutation(async ({ ctx, input }) => {
        if (!input.confirm) throw new TRPCError({ code: 'BAD_REQUEST', message: 'confirm:true required to back up' });
        const cfg = backupConfig();
        if (!cfg) throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'backup not configured — set PORTLESS_BACKUP_S3_ENDPOINT/_BUCKET/_ACCESS_KEY/_SECRET_KEY' });
        requireDurableAudit(ctx, 'backup.now', cfg.bucket);
        try {
          const r = await backupNow(cfg);
          const op = recordOp(ctx, { action: 'backup.now', target: r.key, outcome: 'success' });
          return { ok: true, ...r, ...op };
        } catch (e) {
          recordOp(ctx, { action: 'backup.now', target: cfg.bucket, outcome: 'failure' });
          throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: (e as Error).message });
        }
      }),

    list: requirePermission('app.read').query(async () => {
      const cfg = backupConfig();
      if (!cfg) return [];
      return listBackups(cfg);
    }),
  }),

  // Drag-drop / CLI deploy: source is first uploaded via POST /upload (returns a buildId), then this
  // kicks off the pipeline — spec read, builds, placement, routes, links — in the background.
  // Returns a deployId to poll via apps.status. Nodes default to the first connected agent.
  upload: router({
    deploy: requirePermission('app.deploy')
      .input(
        z.object({
          buildId: z.string().regex(/^[0-9a-f-]{36}$/, 'a buildId from POST /upload'),
          app: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/, 'lowercase alphanumeric + dashes'),
          port: z.number().int().min(1).max(65535).optional(), // only for sources with no portless.yaml
          buildNode: z.string().min(1).optional(),
          node: z.string().min(1).optional(),
          confirm: z.boolean().default(false),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        if (!input.confirm) throw new TRPCError({ code: 'BAD_REQUEST', message: 'confirm:true required to deploy' });
        const hubBase = process.env.PORTLESS_HUB_BASE;
        if (!hubBase) throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'set PORTLESS_HUB_BASE (the hub url your build nodes can reach) to deploy' });
        requireDurableAudit(ctx, 'upload.deploy', `${input.buildId}: ${input.app}`);
        try {
          const started = startUploadDeploy(input.buildId, input, { registry: process.env.PORTLESS_REGISTRY ?? '127.0.0.1:5000', hubBase });
          const op = recordOp(ctx, { action: 'upload.deploy', target: input.app, outcome: 'success' });
          return { deployId: started.deployId, app: input.app, ...op };
        } catch (e) {
          recordOp(ctx, { action: 'upload.deploy', target: input.app, outcome: 'failure' });
          throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: (e as Error).message });
        }
      }),
  }),

  // Deployed apps as the user thinks of them: the multi-service group + its live URLs + deploy
  // progress + logs. This (not raw agents.*) is what the CLI and MCP speak.
  apps: router({
    // Every deployed app with services, nodes, URLs, and liveness.
    list: requirePermission('app.read').query(() => {
      const domain = process.env.PORTLESS_APP_DOMAIN;
      const grouped = appStore.list().map((g) => ({
        app: g.app,
        services: g.services.map((s) => ({
          name: s.name,
          node: s.node ?? g.node,
          image: s.image,
          route: s.route ?? null,
          url: s.route && domain ? `https://${s.route}.${domain}` : null,
          online: !!s.route && dataGateway.isConnected(s.node ?? g.node),
        })),
        links: (g.links ?? []).map((l) => ({ need: l.need, provider: l.provider, consumer: l.consumer })),
      }));
      // Legacy single-container routes that aren't part of any group.
      const groupedRoutes = new Set(grouped.flatMap((g) => g.services.map((s) => s.route)).filter(Boolean));
      const singles = routeStore
        .list()
        .filter((r) => !groupedRoutes.has(r.app))
        .map((r) => ({
          app: r.app,
          services: [{ name: r.app, node: r.node, image: r.image ?? '', route: r.app, url: domain ? `https://${r.app}.${domain}` : null, online: dataGateway.isConnected(r.node) }],
          links: [] as Array<{ need: string; provider: string; consumer: string }>,
        }));
      return [...grouped, ...singles];
    }),

    // Progress of one deploy (by the deployId returned from upload.deploy / git.deployNow).
    status: requirePermission('app.read')
      .input(z.object({ deployId: z.string().min(1) }))
      .query(({ input }) => {
        const d = deployments.get(input.deployId);
        if (!d) throw new TRPCError({ code: 'NOT_FOUND', message: 'no such deploy (hub restarted? redeploy)' });
        return d;
      }),

    recent: requirePermission('app.read')
      .input(z.object({ app: z.string().optional(), limit: z.number().int().min(1).max(200).default(20) }).optional())
      .query(({ input }) => deployments.list(input?.limit ?? 20, input?.app)),

    // Tail a service's container logs from its node. Read-only but runs docker on the node.
    logs: requirePermission('app.read')
      .input(z.object({ app: z.string().min(1).max(63), service: z.string().max(63).optional(), lines: z.number().int().positive().max(1000).default(100) }))
      .query(async ({ input }) => {
        const group = appStore.get(input.app);
        let node: string, container: string;
        if (group) {
          const svc = input.service
            ? group.services.find((s) => s.name === input.service)
            : group.services.find((s) => s.route) ?? group.services[0];
          if (!svc) throw new TRPCError({ code: 'NOT_FOUND', message: `no such service in ${input.app}` });
          node = svc.node ?? group.node;
          container = `${input.app}-${svc.name}`;
        } else {
          const dep = routeStore.get(input.app);
          if (!dep) throw new TRPCError({ code: 'NOT_FOUND', message: 'no such app' });
          node = dep.node;
          container = input.app;
        }
        const reply = await agentGateway.send(node, { cmd: 'exec', argv: ['docker', 'logs', '--tail', String(input.lines), container] }, 30_000);
        if (!reply.ok) throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: reply.error ?? 'logs failed' });
        return { app: input.app, container, node, output: reply.output ?? '' };
      }),

    // Tear an app down everywhere: containers, network, mesh links, routes, port allocations.
    remove: requirePermission('app.deploy')
      .input(z.object({ app: z.string().min(1).max(63), confirm: z.boolean().default(false) }))
      .mutation(async ({ ctx, input }) => {
        if (!input.confirm) throw new TRPCError({ code: 'BAD_REQUEST', message: 'confirm:true required to remove an app' });
        requireDurableAudit(ctx, 'apps.remove', input.app);
        try {
          const r = await removeApp(input.app);
          const op = recordOp(ctx, { action: 'apps.remove', target: input.app, outcome: 'success' });
          return { ...r, ...op };
        } catch (e) {
          recordOp(ctx, { action: 'apps.remove', target: input.app, outcome: 'failure' });
          throw new TRPCError({ code: 'NOT_FOUND', message: (e as Error).message });
        }
      }),
  }),

  // Accounts, sessions, and API tokens — the credential surface. Reads/self-service need only a
  // login; creating or revoking credentials (users, tokens) is account.admin (owner/admin).
  account: router({
    me: requirePermission('app.read').query(({ ctx }) => ({ id: ctx.principal.id, name: ctx.principal.name, roles: ctx.principal.roles })),

    // Change YOUR email (requires the password — a stolen cookie must not re-anchor the account).
    changeEmail: requirePermission('app.read')
      .input(z.object({ password: z.string().min(1).max(1024), email: z.string().min(3).max(254) }))
      .mutation(({ ctx, input }) => {
        const user = userStore.get(ctx.principal.id);
        if (!user) throw new TRPCError({ code: 'BAD_REQUEST', message: 'email change requires a user session (not an API token)' });
        if (!userStore.verify(user.email, input.password)) {
          recordOp(ctx, { action: 'account.changeEmail', target: user.email, outcome: 'failure' });
          throw new TRPCError({ code: 'UNAUTHORIZED', message: 'password is wrong' });
        }
        const r = userStore.updateEmail(user.id, input.email);
        if (!r.ok) throw new TRPCError({ code: 'BAD_REQUEST', message: r.error });
        const op = recordOp(ctx, { action: 'account.changeEmail', target: `${user.email} -> ${r.user.email}`, outcome: 'success' });
        return { user: r.user, ...op };
      }),

    // Change YOUR password (requires the current one) and drop every other session.
    changePassword: requirePermission('app.read')
      .input(z.object({ current: z.string().min(1).max(1024), next: z.string().min(8).max(1024) }))
      .mutation(({ ctx, input }) => {
        const user = userStore.get(ctx.principal.id);
        if (!user) throw new TRPCError({ code: 'BAD_REQUEST', message: 'password change requires a user session (not an API token)' });
        if (!userStore.verify(user.email, input.current)) {
          recordOp(ctx, { action: 'account.changePassword', target: user.email, outcome: 'failure' });
          throw new TRPCError({ code: 'UNAUTHORIZED', message: 'current password is wrong' });
        }
        const r = userStore.setPassword(user.id, input.next);
        if (!r.ok) throw new TRPCError({ code: 'BAD_REQUEST', message: r.error });
        sessionStore.revokeAllForUser(user.id); // stolen cookies die with the old password
        const op = recordOp(ctx, { action: 'account.changePassword', target: user.email, outcome: 'success' });
        return { ok: true, ...op };
      }),

    sessions: router({
      list: requirePermission('app.read').query(({ ctx }) => sessionStore.listForUser(ctx.principal.id)),
      revoke: requirePermission('app.read')
        .input(z.object({ id: z.string().min(1) }))
        .mutation(({ ctx, input }) => {
          // You can only revoke your own sessions (admins reset via user removal / password change).
          const mine = sessionStore.listForUser(ctx.principal.id).some((s) => s.id === input.id);
          if (!mine || !sessionStore.revokeById(input.id)) throw new TRPCError({ code: 'NOT_FOUND', message: 'no such session' });
          recordOp(ctx, { action: 'account.sessions.revoke', target: input.id, outcome: 'success' });
          return { ok: true };
        }),
    }),

    tokens: router({
      list: requirePermission('account.admin').query(() => apiTokenStore.list()),
      // Create an API token (CLI / node enrollment / CI). The token value is returned exactly once.
      create: requirePermission('account.admin')
        .input(z.object({ name: z.string().min(1).max(64), role: z.enum(['owner', 'admin', 'operator', 'viewer']).default('operator') }))
        .mutation(({ ctx, input }) => {
          requireDurableAudit(ctx, 'account.tokens.create', `${input.name} (${input.role})`);
          const { token, record } = apiTokenStore.create({ name: input.name, roles: [input.role], createdBy: ctx.principal.id });
          const op = recordOp(ctx, { action: 'account.tokens.create', target: record.name, outcome: 'success' });
          return { token, record, ...op };
        }),
      revoke: requirePermission('account.admin')
        .input(z.object({ id: z.string().min(1) }))
        .mutation(({ ctx, input }) => {
          if (!apiTokenStore.revoke(input.id)) throw new TRPCError({ code: 'NOT_FOUND', message: 'no such token' });
          const op = recordOp(ctx, { action: 'account.tokens.revoke', target: input.id, outcome: 'success' });
          return { ok: true, ...op };
        }),
    }),

    users: router({
      list: requirePermission('account.admin').query(() => userStore.list()),
      create: requirePermission('account.admin')
        .input(z.object({
          email: z.string().min(3).max(254),
          password: z.string().min(8).max(1024),
          name: z.string().max(64).optional(),
          role: z.enum(['owner', 'admin', 'operator', 'viewer']).default('viewer'),
        }))
        .mutation(({ ctx, input }) => {
          const r = userStore.create({ email: input.email, password: input.password, name: input.name, roles: [input.role] });
          if (!r.ok) throw new TRPCError({ code: 'BAD_REQUEST', message: r.error });
          const op = recordOp(ctx, { action: 'account.users.create', target: r.user.email, outcome: 'success' });
          return { user: r.user, ...op };
        }),
      remove: requirePermission('account.admin')
        .input(z.object({ id: z.string().min(1), confirm: z.boolean().default(false) }))
        .mutation(({ ctx, input }) => {
          if (!input.confirm) throw new TRPCError({ code: 'BAD_REQUEST', message: 'confirm:true required to remove a user' });
          if (input.id === ctx.principal.id) throw new TRPCError({ code: 'BAD_REQUEST', message: 'cannot remove yourself' });
          const r = userStore.remove(input.id);
          if (!r.ok) throw new TRPCError({ code: 'BAD_REQUEST', message: r.error });
          sessionStore.revokeAllForUser(input.id);
          const op = recordOp(ctx, { action: 'account.users.remove', target: input.id, outcome: 'success' });
          return { ok: true, ...op };
        }),
    }),
  }),
});

export type AppRouter = typeof appRouter;
