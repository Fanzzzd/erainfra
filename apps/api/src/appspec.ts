import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import type { AppSpec, ServiceSpec, MachineRole } from '../../../packages/core/src/index.ts';

// On-disk portless.yaml schema (examples/portless.yaml). Kept separate from the
// internal AppSpec/ServiceSpec types so the file format can evolve independently.
const roleSchema = z.enum(['gateway', 'worker', 'database', 'edge', 'relay']);

// Bounds so a single spec can't blow up memory / the topology graph (defense in depth alongside
// the router's YAML byte cap). Generous but finite.
const serviceSchema = z.object({
  name: z.string().min(1).max(63),
  type: z.enum(['web', 'worker', 'cron', 'database']),
  image: z.string().min(1).max(256),
  replicas: z.number().int().positive().max(1000).default(1),
  port: z.number().int().positive().max(65535).optional(),
  resources: z.object({ cpu: z.number().positive(), memoryMb: z.number().positive() }),
  health: z.object({ path: z.string().startsWith('/').max(256) }).optional(),
  dependencies: z
    .array(z.object({ service: z.string().min(1).max(63), latencySensitive: z.boolean().optional() }))
    .max(50)
    .optional(),
  // External things this service connects to: object storage (R2/S3), a data platform, etc.
  connections: z
    .array(
      z.object({
        to: z.string().min(1).max(63),
        type: z.enum(['backend', 'object-storage', 'data-platform', 'database', 'cache', 'queue']),
        provider: z.string().max(63).optional(),
        external: z.boolean().optional(),
      }),
    )
    .max(50)
    .optional(),
  placement: z
    .object({
      requiredRoles: z.array(roleSchema).max(5).optional(),
      avoidRoles: z.array(roleSchema).max(5).optional(),
      sticky: z.boolean().optional(),
    })
    .optional(),
});

// Project IDs are `${project}/${environment}` (projects.ts). Forbid `/` (and whitespace) in
// both halves so distinct specs can't collapse to the same id and silently overwrite each other
// (e.g. `a/b`+`c` vs `a`+`b/c`).
const slug = z.string().min(1).max(63).regex(/^[a-z0-9][a-z0-9.-]*$/i, 'slug: letters, digits, dots and hyphens only');

export const appSpecFileSchema = z.object({
  project: slug,
  environment: slug,
  network: z
    .object({
      provider: z.string().max(63).default('netmaker'),
      overlayCidr: z.string().max(63).default('10.88.0.0/16'),
      containerSubnetStrategy: z.string().max(63).default('per-machine-/24'),
    })
    .optional(),
  services: z.array(serviceSchema).min(1).max(100),
  domains: z
    .array(
      z.object({
        hostname: z.string().min(1).max(253),
        service: z.string().min(1).max(63),
        ingress: z.enum(['cloudflare-tunnel']).default('cloudflare-tunnel'),
      }),
    )
    .max(100)
    .optional(),
});

export type AppSpecFile = z.infer<typeof appSpecFileSchema>;

export interface AppSpecIssue {
  path: string;
  message: string;
}

export type ParseResult =
  | { ok: true; value: AppSpecFile; warnings: AppSpecIssue[] }
  | { ok: false; errors: AppSpecIssue[] };

// Parse + validate raw YAML. Returns actionable, path-prefixed errors instead of throwing.
export function parseAppSpec(yamlText: string): ParseResult {
  let raw: unknown;
  try {
    raw = parseYaml(yamlText);
  } catch (err) {
    return { ok: false, errors: [{ path: '(root)', message: `invalid YAML: ${(err as Error).message}` }] };
  }

  const result = appSpecFileSchema.safeParse(raw);
  if (!result.success) {
    return {
      ok: false,
      errors: result.error.issues.map((i) => ({ path: i.path.join('.') || '(root)', message: i.message })),
    };
  }

  // Cross-field validation that Zod can't express alone.
  const warnings: AppSpecIssue[] = [];
  const names = new Set<string>();
  for (const svc of result.data.services) {
    if (names.has(svc.name)) {
      return { ok: false, errors: [{ path: `services.${svc.name}`, message: `duplicate service name: ${svc.name}` }] };
    }
    names.add(svc.name);
  }
  for (const svc of result.data.services) {
    for (const dep of svc.dependencies ?? []) {
      if (!names.has(dep.service)) {
        return {
          ok: false,
          errors: [{ path: `services.${svc.name}.dependencies`, message: `unknown dependency service: ${dep.service}` }],
        };
      }
    }
    if (svc.type === 'web' && !svc.port) {
      warnings.push({ path: `services.${svc.name}`, message: 'web service has no port; ingress/health may not work' });
    }
  }
  for (const dom of result.data.domains ?? []) {
    if (!names.has(dom.service)) {
      return { ok: false, errors: [{ path: `domains.${dom.hostname}`, message: `routes to unknown service: ${dom.service}` }] };
    }
  }

  return { ok: true, value: result.data, warnings };
}

// Normalize the on-disk file into the internal AppSpec/ServiceSpec used by the scheduler.
export function normalizeAppSpec(file: AppSpecFile): AppSpec {
  const services: ServiceSpec[] = file.services.map((svc) => ({
    name: svc.name,
    image: svc.image,
    type: svc.type,
    replicas: svc.replicas,
    port: svc.port,
    cpu: svc.resources.cpu,
    memoryMb: svc.resources.memoryMb,
    healthPath: svc.health?.path,
    dependencies: svc.dependencies,
    requiredRoles: svc.placement?.requiredRoles as MachineRole[] | undefined,
    avoidRoles: svc.placement?.avoidRoles as MachineRole[] | undefined,
  }));

  return {
    project: file.project,
    environment: file.environment,
    services,
    domains: file.domains?.map((d) => ({ hostname: d.hostname, service: d.service })),
  };
}

export interface ImportRecords {
  project: { name: string };
  environment: { name: string };
  services: Array<{
    name: string;
    type: string;
    image: string;
    replicas: number;
    port?: number;
    cpu: number;
    memoryMb: number;
    healthPath?: string;
    spec: ServiceSpec;
  }>;
  domains: Array<{ hostname: string; service: string; ingress: string }>;
}

// Map a validated spec file into insert-ready records mirroring the Drizzle tables.
// ponytail: returns records, doesn't write — wire to Postgres when the DB is live (M10).
export function importAppSpec(file: AppSpecFile): ImportRecords {
  const normalized = normalizeAppSpec(file);
  return {
    project: { name: file.project },
    environment: { name: file.environment },
    services: normalized.services.map((s) => ({
      name: s.name,
      type: s.type,
      image: s.image,
      replicas: s.replicas,
      port: s.port,
      cpu: s.cpu,
      memoryMb: s.memoryMb,
      healthPath: s.healthPath,
      spec: s,
    })),
    domains: (file.domains ?? []).map((d) => ({ hostname: d.hostname, service: d.service, ingress: d.ingress })),
  };
}
