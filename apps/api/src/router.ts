import { z } from 'zod';
import { resolve, sep, dirname, basename } from 'node:path';
import { realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { TRPCError } from '@trpc/server';
import { router, publicProcedure, requirePermission } from './trpc.ts';
import { parseAppSpec, importAppSpec } from './appspec.ts';
import { buildTopology } from './topology.ts';
import { LocalCliOrchestrator } from './runtime/orchestrator.ts';
import { CloudflaredCli } from './runtime/cloudflared-cli.ts';
import { tcpProbe } from './runtime/netprobe.ts';
import { hostInfo } from './runtime/hostinfo.ts';
import { ProjectStore } from './projects.ts';
import { NetmakerNetworkProvider, InMemoryNetmakerClient } from './network/netmaker.ts';
import type { MachineRole } from '../../../packages/core/src/index.ts';

const orchestrator = new LocalCliOrchestrator();
const cloudflared = new CloudflaredCli();
const projects = new ProjectStore();
// Real fabric backend. Starts empty: the only node is THIS machine until the user
// enrolls peers, at which point each gets a real allocated WG IP + container subnet.
const fabric = new NetmakerNetworkProvider(new InMemoryNetmakerClient());
const MACHINE_ROLES = ['gateway', 'worker', 'database', 'edge', 'relay'] as const;
// Cap on a single pasted portless.yaml so import/validate/topology can't be flooded with a huge body.
const MAX_YAML_BYTES = 64_000;
import { APP_TEMPLATES, buildFromTemplate } from './runtime/local.ts';
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

// All THROWING preconditions for a real DNS route, with no side effect beyond a durable audit
// 'attempt' marker: the tunnel must be one of the account's real tunnels AND the audit log must be
// durable. Call this BEFORE any local state mutation, so a bad tunnel or non-durable audit can't
// half-apply (e.g. attach a domain to the spec locally while the route never happened).
async function preflightRoute(ctx: { principal: Principal; audit: AuditLog }, tunnel: string, hostname: string) {
  try {
    const tunnels = await cloudflared.tunnels();
    if (!tunnels.some((t) => t.name === tunnel || t.id === tunnel)) {
      throw new TRPCError({ code: 'BAD_REQUEST', message: `unknown tunnel "${tunnel}"` });
    }
  } catch (e) {
    if (e instanceof TRPCError) throw e;
    console.error('[cloudflare.routeDns] preflight', (e as Error).message);
    throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'could not verify the tunnel (see server logs)' });
  }
  requireDurableAudit(ctx, 'cloudflare.routeDns', `${hostname} -> ${tunnel}`); // fail closed before the real DNS change
}

// The actual DNS route (real Cloudflare account mutation: CNAME -> <id>.cfargotunnel.com). Returns
// a non-throwing result, so a failure here is a genuine cloudflared error AFTER preflightRoute
// already passed — the caller can surface it without rolling back local state.
async function performRoute(ctx: { principal: Principal; audit: AuditLog }, tunnel: string, hostname: string) {
  const target = `${hostname} -> ${tunnel}`;
  const res = await cloudflared.routeDns(tunnel, hostname);
  if (!res.ok) console.error('[cloudflare.routeDns]', res.output);
  const op = recordOp(ctx, { action: 'cloudflare.routeDns', target, outcome: res.ok ? 'success' : 'failure' });
  return { ok: res.ok, message: res.ok ? `routed ${hostname}` : 'route failed (see server logs)', ...op };
}

// A tunnel name or a UUID — not free-form, even though it's argv (never a shell).
const tunnelRef = z.string().regex(/^([a-z0-9][a-z0-9-]{0,62}|[0-9a-f-]{36})$/i, 'a tunnel name or id');
const hostnameRef = z.string().max(253).regex(/^([a-z0-9-]+\.)+[a-z]{2,}$/i, 'a valid hostname');

// Shared safety envelope for dangerous, mutating ops (non-negotiable #10):
// dry-run by default, confirm:true required to go live, every call audited.
function runDangerousOp(
  ctx: { principal: Principal; audit: AuditLog },
  action: string,
  target: string,
  dryRun: boolean,
  confirm: boolean,
) {
  if (!dryRun && !confirm) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: `confirm:true required for a non-dry-run ${action}` });
  }
  const entry = ctx.audit.record({ actor: ctx.principal.id, action, target, outcome: 'success', dryRun });
  // Honesty: this is the audited safety envelope, but cluster scheduling (Nomad/Consul) is not
  // wired on this control plane — so a live call is recorded, not actually scheduled. Real
  // single-machine deploys go through `local.deploy`, which launches a real process.
  return {
    accepted: true,
    dryRun,
    auditId: entry.id,
    auditDurable: ctx.audit.lastWriteDurable(), // false ⇒ the durable audit write failed (gap)
    status: dryRun ? ('validated' as const) : ('recorded-no-cluster' as const),
    note: dryRun
      ? undefined
      : 'Recorded + audited, but not scheduled: the Nomad/Consul cluster is not running on this control plane. Use local.deploy for a real deploy on this machine.',
  };
}

const dangerousInput = z.object({
  app: z.string().min(1),
  dryRun: z.boolean().default(true),
  confirm: z.boolean().default(false),
});

// Canonicalize the existing portion of a path (resolving symlinks), re-appending any
// not-yet-created trailing components. Lets us symlink-check a cwd that doesn't exist yet.
function realpathExisting(p: string): string {
  const tail: string[] = [];
  let cur = p;
  for (;;) {
    try {
      const real = realpathSync(cur);
      return tail.length ? resolve(real, ...tail) : real;
    } catch {
      const parent = dirname(cur);
      if (parent === cur) return p; // hit the filesystem root without finding an existing prefix
      tail.unshift(basename(cur));
      cur = parent;
    }
  }
}

// Confine an agent's working directory to the configured agent root (default: the control
// plane's cwd) so a caller can't point a local AI CLI at arbitrary host paths. Returns the
// resolved absolute path, or undefined when no cwd was requested. Resolves symlinks so a
// symlink *inside* the root can't redirect the cwd outside it (lexical prefix checks miss that).
export function confineToAgentRoot(cwd: string | undefined): string | undefined {
  if (!cwd) return undefined;
  const root = realpathExisting(resolve(process.env.PORTLESS_AGENT_ROOT ?? process.cwd()));
  const resolved = resolve(root, cwd);
  const real = realpathExisting(resolved);
  if (real !== root && !real.startsWith(root + sep)) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'cwd must be inside the agent root' });
  }
  return real;
}

export const appRouter = router({
  health: publicProcedure.query(() => ({ ok: true })),

  audit: router({
    list: requirePermission('audit.read')
      .input(z.object({ limit: z.number().int().positive().max(500).optional() }))
      .query(({ ctx, input }) => ctx.audit.list(input.limit)),
  }),

  appspec: router({
    // Validate a portless.yaml and (on success) return the import records. Read-only.
    validate: requirePermission('app.read')
      .input(z.object({ yaml: z.string().min(1).max(MAX_YAML_BYTES) }))
      .query(({ input }) => {
        const result = parseAppSpec(input.yaml);
        if (!result.ok) return { ok: false as const, errors: result.errors };
        return { ok: true as const, warnings: result.warnings, records: importAppSpec(result.value) };
      }),
  }),

  app: router({
    // Real registry of defined projects (imported via project.import / seeded from examples),
    // not a single hardcoded sample.
    list: requirePermission('app.read').query(() =>
      projects.allSpecs().map((s) => ({
        project: s.project,
        environment: s.environment,
        services: s.services.map((x) => ({ name: x.name, type: x.type, replicas: x.replicas ?? 1, image: x.image })),
      })),
    ),

    // Real health: if a process by this name runs on THIS machine, do a real HTTP health
    // check via the runtime. Otherwise it's a cluster app — say so honestly (no fake "healthy").
    health: requirePermission('app.read')
      .input(z.object({ app: z.string().min(1) }))
      .query(async ({ ctx, input }) => {
        const proc = ctx.runtime.get(input.app);
        if (proc) {
          const status = await ctx.runtime.health(input.app);
          return { app: input.app, source: 'local-runtime' as const, status, pid: proc.pid, port: proc.port, startedAt: proc.startedAt };
        }
        return {
          app: input.app,
          source: 'cluster' as const,
          status: 'unknown' as const,
          note: `No local process named "${input.app}". Per-service health requires the Consul-connected fabric, which is not running on this machine.`,
        };
      }),

    // Real logs from the runtime's on-disk log file when the app runs locally.
    logs: requirePermission('app.read')
      .input(z.object({ app: z.string().min(1), service: z.string().optional(), lines: z.number().int().positive().max(1000).default(100) }))
      .query(({ ctx, input }) => {
        const proc = ctx.runtime.get(input.app);
        if (proc) {
          return { app: input.app, source: 'local-runtime' as const, logFile: proc.logFile, lines: ctx.runtime.logs(input.app, input.lines) };
        }
        return {
          app: input.app,
          source: 'cluster' as const,
          lines: [] as string[],
          note: `No local process named "${input.app}". Cluster logs stream from Nomad alloc logs, which needs the fabric (not running here).`,
        };
      }),

    // Dangerous, RBAC-gated, dry-run-by-default, confirm-required, audited.
    deploy: requirePermission('app.deploy')
      .input(dangerousInput)
      .mutation(({ ctx, input }) => runDangerousOp(ctx, 'app.deploy', input.app, input.dryRun, input.confirm)),

    rollback: requirePermission('app.rollback')
      .input(dangerousInput.extend({ toRelease: z.string().optional() }))
      .mutation(({ ctx, input }) =>
        runDangerousOp(ctx, 'app.rollback', `${input.app}${input.toRelease ? `@${input.toRelease}` : ''}`, input.dryRun, input.confirm),
      ),
  }),

  // Each project/app has its OWN topology (services, ingress, external resources like R2/S3/data-platform).
  project: router({
    list: requirePermission('app.read').query(() => projects.list()),

    // Full per-project detail for the drill-in view: services (with resources/health/deps/
    // connections), domains, network overlay, and whether it's a seeded example or user-imported.
    detail: requirePermission('app.read')
      .input(z.object({ projectId: z.string().min(1).max(127) }))
      .query(({ input }) => {
        const spec = projects.get(input.projectId);
        if (!spec) throw new TRPCError({ code: 'NOT_FOUND', message: `unknown project: ${input.projectId}` });
        return {
          id: input.projectId,
          project: spec.project,
          environment: spec.environment,
          source: projects.sourceOf(input.projectId),
          network: spec.network ?? null,
          services: spec.services.map((s) => ({
            name: s.name,
            type: s.type,
            image: s.image,
            replicas: s.replicas,
            port: s.port ?? null,
            cpu: s.resources.cpu,
            memoryMb: s.resources.memoryMb,
            healthPath: s.health?.path ?? null,
            dependencies: (s.dependencies ?? []).map((d) => d.service),
            connections: (s.connections ?? []).map((c) => ({ to: c.to, type: c.type, provider: c.provider ?? null, external: !!c.external })),
            requiredRoles: s.placement?.requiredRoles ?? [],
            avoidRoles: s.placement?.avoidRoles ?? [],
          })),
          domains: (spec.domains ?? []).map((d) => ({ hostname: d.hostname, service: d.service, ingress: d.ingress })),
        };
      }),

    topology: requirePermission('app.read')
      .input(z.object({ projectId: z.string().max(127).optional(), yaml: z.string().max(MAX_YAML_BYTES).optional() }).optional())
      .query(({ input }) => {
        if (input?.yaml) {
          const parsed = parseAppSpec(input.yaml);
          if (!parsed.ok) {
            throw new TRPCError({ code: 'BAD_REQUEST', message: parsed.errors.map((e) => `${e.path}: ${e.message}`).join('; ') });
          }
          return buildTopology(parsed.value);
        }
        const spec = input?.projectId ? projects.get(input.projectId) : projects.first();
        if (!spec) throw new TRPCError({ code: 'NOT_FOUND', message: `unknown project: ${input?.projectId ?? '(none)'}` });
        return buildTopology(spec);
      }),

    import: requirePermission('app.deploy')
      .input(z.object({ yaml: z.string().min(1).max(MAX_YAML_BYTES), replace: z.boolean().default(false) }))
      .mutation(({ ctx, input }) => {
        const res = projects.add(input.yaml, { replace: input.replace });
        if (!res.ok) {
          if ('collision' in res) return { ok: false as const, collision: true as const, id: res.id };
          return { ok: false as const, errors: res.errors };
        }
        const op = recordOp(ctx, { action: 'project.import', target: res.id, outcome: 'success' });
        return { ok: true as const, id: res.id, ...op };
      }),

    // Attach a domain to a project. Always updates the project spec (persisted, reflected in the
    // topology). When route:true it ALSO auto-handles the Cloudflare side — routing the hostname's
    // DNS at the chosen tunnel — which is a real account mutation, so it requires confirm:true.
    addDomain: requirePermission('app.deploy')
      .input(
        z.object({
          projectId: z.string().min(1).max(127),
          hostname: hostnameRef,
          service: z.string().min(1).max(63),
          route: z.boolean().default(false),
          tunnel: tunnelRef.optional(),
          confirm: z.boolean().default(false),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        // Run ALL throwing preconditions — confirm, tunnel present, tunnel exists, durable audit —
        // BEFORE mutating the spec, so a bad tunnel can't leave the domain attached while reporting
        // an error (the half-apply a dogfood pass caught). After this, only performRoute remains,
        // and it returns a non-throwing result, so the spec + DNS stay consistent.
        if (input.route) {
          if (!input.confirm) throw new TRPCError({ code: 'BAD_REQUEST', message: 'confirm:true required to route the domain via Cloudflare' });
          if (!input.tunnel) throw new TRPCError({ code: 'BAD_REQUEST', message: 'tunnel required to route this domain' });
          await preflightRoute(ctx, input.tunnel, input.hostname);
        }
        const res = projects.addDomain(input.projectId, { hostname: input.hostname, service: input.service });
        if (!res.ok) return { ok: false as const, errors: res.errors };
        const op = recordOp(ctx, { action: 'project.addDomain', target: `${input.projectId}:${input.hostname}`, outcome: 'success' });
        const route = input.route ? await performRoute(ctx, input.tunnel!, input.hostname) : null;
        return { ok: true as const, ...op, route: route ? { ok: route.ok, message: route.message } : null };
      }),

    removeDomain: requirePermission('app.deploy')
      .input(z.object({ projectId: z.string().min(1).max(127), hostname: z.string().min(1).max(253) }))
      .mutation(({ ctx, input }) => {
        const res = projects.removeDomain(input.projectId, input.hostname);
        if (!res.ok) return { ok: false as const, errors: res.errors };
        const op = recordOp(ctx, { action: 'project.removeDomain', target: `${input.projectId}:${input.hostname}`, outcome: 'success' });
        return { ok: true as const, ...op };
      }),

    // Remove a project from the registry. Destructive + irreversible (drops the persisted spec),
    // so confirm:true is required and it's audited. ponytail: only touches Portless's own registry —
    // it does NOT tear down any Cloudflare DNS the project's domains may have routed.
    delete: requirePermission('app.deploy')
      .input(z.object({ projectId: z.string().min(1).max(127), confirm: z.boolean().default(false) }))
      .mutation(({ ctx, input }) => {
        if (!input.confirm) throw new TRPCError({ code: 'BAD_REQUEST', message: 'confirm:true required to delete a project' });
        const res = projects.remove(input.projectId);
        if (!res.ok) {
          recordOp(ctx, { action: 'project.delete', target: input.projectId, outcome: 'failure' });
          throw new TRPCError({ code: 'NOT_FOUND', message: `unknown project: ${input.projectId}` });
        }
        const op = recordOp(ctx, { action: 'project.delete', target: input.projectId, outcome: 'success' });
        return { ok: true as const, ...op };
      }),
  }),

  machines: router({
    // The first node is THIS real machine (read live from the OS); the rest are peers the
    // user has enrolled into the fabric, each with a real allocated WG IP + container subnet.
    list: requirePermission('machine.read').query(async () => {
      const h = hostInfo();
      const self = {
        id: 'this-machine',
        name: h.hostname,
        roles: ['gateway', 'worker'] as MachineRole[],
        region: `local · ${h.platform}/${h.arch} · ${h.cpus}cpu/${h.memoryGb}GB`,
        wgIp: h.lanIp ?? '—',
        containerSubnet: '—',
        online: true,
        kind: 'self' as const,
      };
      const enrolled = (await fabric.listMachines()).map((m) => ({
        id: m.id,
        name: m.name,
        roles: m.roles,
        region: m.region,
        wgIp: m.wgIp,
        containerSubnet: m.containerSubnet,
        online: true,
        kind: 'enrolled' as const,
      }));
      return [self, ...enrolled];
    }),

    // Enroll a peer into the fabric. The provider allocates a WG IP (10.88.0.x) and a
    // container subnet (10.210.x.0/24) — real allocation. The publicKey is a real WireGuard
    // key (the node-agent runs `wg genkey | wg pubkey`): without it the peer can't join, so we
    // require it rather than stamping a placeholder that would yield an unusable node.
    enroll: requirePermission('machine.enroll')
      .input(
        z.object({
          name: z
            .string()
            .min(1)
            .max(63)
            .regex(/^[a-z0-9][a-z0-9-]*$/, 'lowercase letters, digits and hyphens only'),
          // Roles are assigned after enrollment, so they're optional here (a machine can have many).
          roles: z.array(z.enum(MACHINE_ROLES)).default([]),
          region: z.string().min(1).max(63),
          publicKey: z.string().regex(/^[A-Za-z0-9+/]{43}=$/, 'WireGuard public key: 44-char base64 (wg genkey | wg pubkey)'),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        try {
          const machine = await fabric.enrollMachine({
            name: input.name,
            roles: input.roles,
            region: input.region,
            publicKey: input.publicKey,
          });
          const op = recordOp(ctx, { action: 'machine.enroll', target: machine.id, outcome: 'success' });
          return { machine, ...op };
        } catch (err) {
          recordOp(ctx, { action: 'machine.enroll', target: input.name, outcome: 'failure' });
          throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'machine enrollment failed' });
        }
      }),

    // Assign/replace a machine's roles after enrollment. A machine can carry several; an empty
    // array clears them. ponytail: full replace, not add/remove deltas — the UI sends the new set.
    setRoles: requirePermission('machine.enroll')
      .input(z.object({ id: z.string().min(1), roles: z.array(z.enum(MACHINE_ROLES)) }))
      .mutation(async ({ ctx, input }) => {
        try {
          const machine = await fabric.setRoles(input.id, input.roles);
          const op = recordOp(ctx, { action: 'machine.setRoles', target: input.id, outcome: 'success' });
          return { machine, ...op };
        } catch (err) {
          recordOp(ctx, { action: 'machine.setRoles', target: input.id, outcome: 'failure' });
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'unknown machine' });
        }
      }),

    revoke: requirePermission('machine.enroll')
      .input(z.object({ id: z.string().min(1), confirm: z.boolean().default(false) }))
      .mutation(async ({ ctx, input }) => {
        if (!input.confirm) throw new TRPCError({ code: 'BAD_REQUEST', message: 'confirm:true required to revoke a machine' });
        try {
          await fabric.revokeMachine(input.id);
        } catch (err) {
          recordOp(ctx, { action: 'machine.revoke', target: input.id, outcome: 'failure' });
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'machine revocation failed (unknown or backend error)' });
        }
        const op = recordOp(ctx, { action: 'machine.revoke', target: input.id, outcome: 'success' });
        return { revoked: true as const, ...op };
      }),
  }),

  network: router({
    // Real measured paths from the fabric provider. Empty until the node-agent records probes
    // between enrolled peers — honest rather than a hardcoded demo matrix.
    matrix: requirePermission('network.read').query(() => fabric.pathMatrix()),

    // Real measurement: attempt an actual TCP handshake to the peer's WireGuard endpoint and
    // time it. From a laptop most fabric endpoints are unreachable — we report that honestly
    // rather than inventing a latency, alongside the best known path for reference.
    benchmark: requirePermission('network.benchmark')
      .input(z.object({ from: z.string().min(1), to: z.string().min(1) }))
      .query(async ({ input }) => {
        const path = await fabric.bestPath(input.from, input.to);
        let live = null;
        if (path?.endpoint) {
          const [host, portStr] = path.endpoint.split(':');
          live = await tcpProbe(host, Number(portStr) || 51820);
        }
        return { from: input.from, to: input.to, modeledPath: path ?? null, live };
      }),
  }),

  // Real local runtime — manage actual running projects on THIS machine.
  local: router({
    templates: requirePermission('app.read').query(() =>
      APP_TEMPLATES.map((t) => ({ id: t.id, label: t.label, description: t.description })),
    ),

    list: requirePermission('app.read').query(({ ctx }) => ctx.runtime.list()),

    logs: requirePermission('app.read')
      .input(z.object({ name: z.string().min(1), lines: z.number().int().positive().max(1000).default(100) }))
      .query(({ ctx, input }) => ({ name: input.name, lines: ctx.runtime.logs(input.name, input.lines) })),

    health: requirePermission('app.read')
      .input(z.object({ name: z.string().min(1) }))
      .query(({ ctx, input }) => ctx.runtime.health(input.name)),

    // Dangerous: actually launches a process. Dry-run by default, confirm to run, audited.
    deploy: requirePermission('app.deploy')
      .input(
        z.object({
          name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/, 'lowercase alphanumeric + dashes'),
          template: z.string().min(1),
          port: z.number().int().min(1024).max(65535),
          dryRun: z.boolean().default(true),
          confirm: z.boolean().default(false),
        }),
      )
      .mutation(({ ctx, input }) => {
        if (!input.dryRun && !input.confirm) {
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'confirm:true required to actually launch the process' });
        }
        const spec = buildFromTemplate(input.template, input.name, input.port);
        if (input.dryRun) {
          const op = recordOp(ctx, { action: 'local.deploy', target: input.name, outcome: 'success', dryRun: true });
          return { dryRun: true as const, plan: { name: spec.name, command: spec.command, args: spec.args, port: spec.port }, ...op };
        }
        requireDurableAudit(ctx, 'local.deploy', input.name); // fail closed before launching the real process
        const proc = ctx.runtime.deploy(spec);
        const op = recordOp(ctx, { action: 'local.deploy', target: input.name, outcome: 'success', dryRun: false });
        return { dryRun: false as const, process: proc, ...op };
      }),

    stop: requirePermission('app.deploy')
      .input(z.object({ name: z.string().min(1), confirm: z.boolean().default(false) }))
      .mutation(async ({ ctx, input }) => {
        if (!input.confirm) throw new TRPCError({ code: 'BAD_REQUEST', message: 'confirm:true required to stop a process' });
        requireDurableAudit(ctx, 'local.stop', input.name); // fail closed before killing the real process
        await ctx.runtime.stop(input.name);
        const op = recordOp(ctx, { action: 'local.stop', target: input.name, outcome: 'success' });
        return { stopped: true, ...op };
      }),

    // Clear an EXITED process from the list (completes the deploy→stop→clear lifecycle). Not
    // dangerous — it only forgets a record of an already-dead process, never touches a live one.
    forget: requirePermission('app.deploy')
      .input(z.object({ name: z.string().min(1) }))
      .mutation(({ ctx, input }) => {
        const ok = ctx.runtime.forget(input.name);
        if (!ok) throw new TRPCError({ code: 'BAD_REQUEST', message: 'cannot clear: process is running or unknown' });
        recordOp(ctx, { action: 'local.forget', target: input.name, outcome: 'success' });
        return { ok: true as const };
      }),
  }),

  // AI orchestration via local Codex / Claude Code CLIs (reusing their local auth).
  orchestrate: router({
    agents: requirePermission('app.read').query(() => orchestrator.available()),

    // agent.run (admin/owner only): running a local AI CLI can read host files/env, so it is
    // gated above operator and its cwd is confined to the agent root.
    run: requirePermission('agent.run')
      .input(
        z.object({
          agent: z.enum(['codex', 'claude']),
          task: z.string().min(1).max(4000),
          mode: z.enum(['plan', 'execute']).default('plan'),
          confirm: z.boolean().default(false),
          cwd: z.string().max(1024).optional(),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        // plan = read-only and safe; execute can modify files, so it requires confirmation.
        if (input.mode === 'execute' && !input.confirm) {
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'confirm:true required to run an agent in execute mode' });
        }
        const cwd = confineToAgentRoot(input.cwd);
        const result = await orchestrator.run({ agent: input.agent, task: input.task, mode: input.mode, cwd });
        // Audit a task HASH, not the text: tasks can contain secrets and audit.read is granted to
        // viewers — the prompt itself must not leak to read-only users.
        const taskHash = createHash('sha256').update(input.task).digest('hex').slice(0, 12);
        const op = recordOp(ctx, {
          action: `orchestrate.${input.agent}`,
          target: `task:${taskHash}`,
          outcome: result.ok ? 'success' : 'failure',
          dryRun: input.mode === 'plan',
        });
        return { ...result, ...op };
      }),
  }),

  // Real Cloudflare Tunnel + domain management via the local `cloudflared` CLI, reusing the
  // account origin cert (~/.cloudflared/cert.pem) — no separate login. Reads are safe; create
  // tunnel / route DNS are mutating, so they require confirm:true and are audited.
  cloudflare: router({
    status: requirePermission('network.read').query(() => cloudflared.status()),

    tunnels: requirePermission('network.read').query(async ({ ctx }) => {
      const status = await cloudflared.status();
      if (!status.installed) return { ok: false as const, reason: 'cloudflared not installed', tunnels: [] };
      if (!status.authenticated) return { ok: false as const, reason: 'not logged in (no cert.pem)', tunnels: [] };
      try {
        return { ok: true as const, tunnels: await cloudflared.tunnels() };
      } catch (e) {
        // Raw cloudflared errors can leak account IDs / API URLs — log server-side, return generic.
        console.error('[cloudflare.tunnels]', (e as Error).message);
        ctx.audit.record({ actor: ctx.principal.id, action: 'cloudflare.tunnels', target: 'list', outcome: 'failure' });
        return { ok: false as const, reason: 'failed to list tunnels (see server logs)', tunnels: [] };
      }
    }),

    // ponytail: no `info` endpoint — raw `cloudflared tunnel info` leaks connector IPs/IDs to
    // any reader and the dashboard doesn't need it. Re-add with a sanitized projection if a
    // tunnel-detail view ever calls for it.

    createTunnel: requirePermission('app.deploy')
      .input(z.object({ name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/, 'lowercase alphanumeric + dashes'), confirm: z.boolean().default(false) }))
      .mutation(async ({ ctx, input }) => {
        if (!input.confirm) throw new TRPCError({ code: 'BAD_REQUEST', message: 'confirm:true required to create a tunnel' });
        try {
          // Idempotency: don't create a second tunnel with the same name on a double-submit.
          if (await cloudflared.exists(input.name)) {
            throw new TRPCError({ code: 'CONFLICT', message: `a tunnel named "${input.name}" already exists` });
          }
        } catch (e) {
          if (e instanceof TRPCError) throw e;
          console.error('[cloudflare.createTunnel] preflight', (e as Error).message); // raw may leak account ids
          throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'could not verify existing tunnels (see server logs)' });
        }
        // Fail closed: refuse the real account mutation if we can't durably audit it first.
        requireDurableAudit(ctx, 'cloudflare.createTunnel', input.name);
        const res = await cloudflared.create(input.name);
        if (!res.ok) console.error('[cloudflare.createTunnel]', res.output); // sanitize: keep raw server-side only
        const op = recordOp(ctx, { action: 'cloudflare.createTunnel', target: input.name, outcome: res.ok ? 'success' : 'failure' });
        return { ok: res.ok, message: res.ok ? `created tunnel ${input.name}` : 'create failed (see server logs)', ...op };
      }),

    routeDns: requirePermission('app.deploy')
      .input(z.object({ tunnel: tunnelRef, hostname: hostnameRef, confirm: z.boolean().default(false) }))
      .mutation(async ({ ctx, input }) => {
        if (!input.confirm) throw new TRPCError({ code: 'BAD_REQUEST', message: 'confirm:true required to create a DNS route' });
        await preflightRoute(ctx, input.tunnel, input.hostname);
        return performRoute(ctx, input.tunnel, input.hostname);
      }),
  }),

  deployments: router({
    // explain_failed_deployment backing: summarize recent audited deploy/rollback events.
    explain: requirePermission('app.read')
      .input(z.object({ app: z.string().optional() }).optional())
      .query(({ ctx, input }) => {
        const app = input?.app;
        // Real explanation built from the audit trail: every deploy/rollback is recorded with
        // actor, outcome and dry-run flag, so we can reconstruct what actually happened.
        const events = ctx.audit
          .list(50)
          .filter((e) => e.action.startsWith('app.') && (!app || e.target === app || (e.target?.startsWith(`${app}@`) ?? false)));
        const failures = events.filter((e) => e.outcome === 'failure');
        const lastLive = events.find((e) => !e.dryRun);
        const timeline = events.map((e) => `${e.at} · ${e.actor} · ${e.action} ${e.target} → ${e.outcome}${e.dryRun ? ' (dry-run)' : ''}`);
        return {
          app,
          summary:
            events.length === 0
              ? `No deploy/rollback activity recorded${app ? ` for ${app}` : ''}.`
              : `${events.length} event(s), ${failures.length} failure(s). Last live action: ${lastLive ? `${lastLive.action} ${lastLive.target} (${lastLive.outcome})` : 'none (all dry-run)'}.`,
          failures,
          timeline,
        };
      }),
  }),
});

export type AppRouter = typeof appRouter;
