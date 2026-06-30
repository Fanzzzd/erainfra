import { readdirSync, readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { stringify } from 'yaml';
import { parseAppSpec, type AppSpecFile } from './appspec.ts';

// Default persist path. Hard-disabled under the node test runner (--test) so tests stay hermetic
// no matter what env vars the developer has exported.
function persistDefault(envVar: string | undefined): string | undefined {
  return (process.execArgv.includes('--test') || !!process.env.NODE_TEST_CONTEXT) ? undefined : envVar;
}

// Project registry. Each project is a parsed portless.yaml AppSpec and has its own topology.
// Seeded from examples/*.yaml; user-imported projects are persisted to disk (when a persist path
// is configured) so they survive a control-plane restart.
export type ProjectSource = 'example' | 'imported';

export interface ProjectSummary {
  id: string; // `${project}/${environment}`
  project: string;
  environment: string;
  services: number;
  domains: number;
  // Honesty: 'example' = seeded starter spec from examples/*.yaml; 'imported' = user-supplied.
  source: ProjectSource;
}

function projectId(spec: AppSpecFile): string {
  return `${spec.project}/${spec.environment}`;
}

export class ProjectStore {
  static readonly MAX_PROJECTS = 200;
  private specs = new Map<string, AppSpecFile>();
  private sources = new Map<string, ProjectSource>();
  // Raw YAML for imported projects, kept so we can re-serialize them to the persist file.
  private importedYaml = new Map<string, string>();
  private persistPath?: string;

  // persistPath defaults to PORTLESS_PROJECTS_FILE (set at process start). Undefined => in-memory
  // only, which keeps tests hermetic. When set, imported projects are loaded on boot + saved on add.
  constructor(seeds: string[] = ProjectStore.discoverSeeds(), persistPath: string | undefined = persistDefault(process.env.PORTLESS_PROJECTS_FILE)) {
    this.persistPath = persistPath;
    for (const yaml of seeds) {
      const parsed = parseAppSpec(yaml);
      if (parsed.ok) {
        const id = projectId(parsed.value);
        this.specs.set(id, parsed.value);
        this.sources.set(id, 'example');
      }
    }
    this.loadPersisted(); // imported projects override a seeded example with the same id
  }

  private loadPersisted(): void {
    if (!this.persistPath || !existsSync(this.persistPath)) return;
    try {
      const raw = JSON.parse(readFileSync(this.persistPath, 'utf8')) as { imported?: string[] };
      for (const yaml of raw.imported ?? []) {
        const parsed = parseAppSpec(yaml);
        if (!parsed.ok) continue;
        const id = projectId(parsed.value);
        this.specs.set(id, parsed.value);
        this.sources.set(id, 'imported');
        this.importedYaml.set(id, yaml);
      }
    } catch (e) {
      console.error('[projects] failed to load persisted projects:', (e as Error).message);
    }
  }

  private save(): void {
    if (!this.persistPath) return;
    try {
      mkdirSync(dirname(this.persistPath), { recursive: true });
      // Atomic write: serialize to a temp file then rename, so a crash mid-write can't leave a
      // torn/invalid JSON that would silently drop all imported projects on the next boot.
      const tmp = `${this.persistPath}.tmp`;
      writeFileSync(tmp, JSON.stringify({ imported: [...this.importedYaml.values()] }, null, 2));
      renameSync(tmp, this.persistPath);
    } catch (e) {
      console.error('[projects] failed to persist projects:', (e as Error).message);
    }
  }

  // Read examples/*.yaml from disk. Used by the opt-in seed path and by tests that want known
  // sample specs; independent of the seed env flag so tests are deterministic.
  static exampleYamls(): string[] {
    try {
      const dir = fileURLToPath(new URL('../../../examples/', import.meta.url));
      return readdirSync(dir)
        .filter((f) => f.endsWith('.yaml'))
        .sort()
        .map((f) => readFileSync(join(dir, f), 'utf8'));
    } catch {
      return [];
    }
  }

  static discoverSeeds(): string[] {
    // Seeds are OFF by default so the dashboard only ever shows the user's real projects — the
    // abstract demo specs added no value (user feedback). Opt in with PORTLESS_SEED_EXAMPLES=1 for
    // a guided tour. ponytail: one env flag, not a demo-mode system.
    return process.env.PORTLESS_SEED_EXAMPLES === '1' ? ProjectStore.exampleYamls() : [];
  }

  list(): ProjectSummary[] {
    return [...this.specs.values()].map((s) => {
      const id = projectId(s);
      return {
        id,
        project: s.project,
        environment: s.environment,
        services: s.services.length,
        domains: s.domains?.length ?? 0,
        source: this.sources.get(id) ?? 'imported',
      };
    });
  }

  get(id: string): AppSpecFile | undefined {
    return this.specs.get(id);
  }

  sourceOf(id: string): ProjectSource {
    return this.sources.get(id) ?? 'imported';
  }

  // Full specs for every registered project (real imported/seeded apps, not a hardcoded sample).
  allSpecs(): AppSpecFile[] {
    return [...this.specs.values()];
  }

  first(): AppSpecFile | undefined {
    return this.specs.values().next().value;
  }

  // Import a project from raw YAML. Refuses to clobber an existing project (which would also
  // silently flip a seeded example to imported) unless replace:true is passed explicitly.
  add(
    yaml: string,
    opts: { replace?: boolean } = {},
  ):
    | { ok: true; id: string }
    | { ok: false; errors: Array<{ path: string; message: string }> }
    | { ok: false; collision: true; id: string } {
    const parsed = parseAppSpec(yaml);
    if (!parsed.ok) return { ok: false, errors: parsed.errors };
    const id = projectId(parsed.value);
    if (this.specs.has(id) && !opts.replace) return { ok: false, collision: true, id };
    // Quota: cap the in-memory registry so repeated imports can't grow it without bound.
    if (!this.specs.has(id) && this.specs.size >= ProjectStore.MAX_PROJECTS) {
      return { ok: false, errors: [{ path: '(root)', message: `project limit reached (${ProjectStore.MAX_PROJECTS})` }] };
    }
    this.specs.set(id, parsed.value);
    this.sources.set(id, 'imported');
    this.importedYaml.set(id, yaml);
    this.save();
    return { ok: true, id };
  }

  // Remove a project from the registry (and the persist file). Symmetric with add(). A seeded
  // example will re-appear on the next boot if PORTLESS_SEED_EXAMPLES=1 is still set — that's the
  // opt-in demo content, not user data; only imported projects are gone for good.
  remove(id: string): { ok: boolean } {
    if (!this.specs.has(id)) return { ok: false };
    this.specs.delete(id);
    this.sources.delete(id);
    this.importedYaml.delete(id);
    this.save();
    return { ok: true };
  }

  // Attach a public domain to a project and persist it. The spec is the source of truth, so we
  // re-serialize it and re-validate (which enforces the domain cap + that the target service
  // exists). A modified seeded example becomes 'imported' — you changed it, it's yours now.
  addDomain(
    id: string,
    domain: { hostname: string; service: string },
  ): { ok: true } | { ok: false; errors: Array<{ path: string; message: string }> } {
    const spec = this.specs.get(id);
    if (!spec) return { ok: false, errors: [{ path: id, message: 'unknown project' }] };
    if (!spec.services.some((s) => s.name === domain.service)) {
      return { ok: false, errors: [{ path: 'service', message: `unknown service: ${domain.service}` }] };
    }
    if ((spec.domains ?? []).some((d) => d.hostname.toLowerCase() === domain.hostname.toLowerCase())) {
      return { ok: false, errors: [{ path: 'hostname', message: `domain already attached: ${domain.hostname}` }] };
    }
    return this.replaceSpec(id, {
      ...spec,
      domains: [...(spec.domains ?? []), { hostname: domain.hostname, service: domain.service, ingress: 'cloudflare-tunnel' }],
    });
  }

  // Detach a domain from a project's spec. ponytail: only edits the spec — it does NOT delete the
  // CNAME from Cloudflare (that's a separate, harder-to-undo account mutation; leave it to the user).
  removeDomain(
    id: string,
    hostname: string,
  ): { ok: true } | { ok: false; errors: Array<{ path: string; message: string }> } {
    const spec = this.specs.get(id);
    if (!spec) return { ok: false, errors: [{ path: id, message: 'unknown project' }] };
    const remaining = (spec.domains ?? []).filter((d) => d.hostname.toLowerCase() !== hostname.toLowerCase());
    if (remaining.length === (spec.domains ?? []).length) {
      return { ok: false, errors: [{ path: 'hostname', message: `domain not attached: ${hostname}` }] };
    }
    return this.replaceSpec(id, { ...spec, domains: remaining });
  }

  // Persist a mutated spec: re-serialize → re-validate → store as imported. Re-validating first
  // means we never persist YAML that wouldn't load on reboot — if stringify ever produced something
  // parseAppSpec rejects, we return errors instead of saving garbage.
  // ponytail: this canonicalizes the spec — re-serializing drops YAML comments AND any unmodeled
  // keys (Zod already strips unknown keys at import, so those were inert; nothing functional is
  // lost). The dashboard never shows raw YAML back, so the canonicalization is invisible in practice.
  private replaceSpec(
    id: string,
    next: AppSpecFile,
  ): { ok: true } | { ok: false; errors: Array<{ path: string; message: string }> } {
    const yamlText = stringify(next);
    const parsed = parseAppSpec(yamlText);
    if (!parsed.ok) return { ok: false, errors: parsed.errors };
    this.specs.set(id, parsed.value);
    this.sources.set(id, 'imported');
    this.importedYaml.set(id, yamlText);
    this.save();
    return { ok: true };
  }
}
