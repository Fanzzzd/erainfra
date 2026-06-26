// Git push-to-deploy (the Vercel flow): a binding ties a GitHub repo+branch to a build node, a
// deploy node, and a container name/port. A push webhook (or a manual trigger) runs the pipeline:
// clone the repo at the commit ON the build node (reusing image.sh = Dockerfile-or-nixpacks), push
// to your registry, then deploy on the deploy node. Self-hosted end to end.
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { agentGateway, type AgentGateway } from './agents.ts';
import { cloneUrl, installationToken } from './github.ts';

// Hermetic under the node test runner no matter the env (mirrors ProjectStore).
function persistDefault(envVar: string | undefined): string | undefined {
  return process.execArgv.includes('--test') ? undefined : envVar;
}

export interface GitBinding {
  id: string;
  repo: string; // "owner/name"
  branch: string;
  buildNode: string; // agent id that clones + builds
  deployNode: string; // agent id that runs the container
  name: string; // container name (lowercase-dash)
  port: number; // app listens on PORT=<port>, published host:container
  lastStatus?: { at: string; sha: string; ok: boolean; stage: string; error?: string };
}

export type DeployConfig = { registry: string; hubBase: string; appId?: string; privateKey?: string };
export type DeployResult = { ok: boolean; stage: 'build' | 'deploy'; image: string; output?: string; error?: string };

export class GitProjectStore {
  static readonly MAX = 200;
  private byId = new Map<string, GitBinding>();
  private persistPath?: string;

  constructor(persistPath: string | undefined = persistDefault(process.env.PORTLESS_GIT_PROJECTS_FILE)) {
    this.persistPath = persistPath;
    this.load();
  }

  private load(): void {
    if (!this.persistPath || !existsSync(this.persistPath)) return;
    try {
      const raw = JSON.parse(readFileSync(this.persistPath, 'utf8')) as { bindings?: GitBinding[] };
      for (const b of raw.bindings ?? []) this.byId.set(b.id, b);
    } catch (e) {
      console.error('[gitdeploy] failed to load bindings:', (e as Error).message);
    }
  }

  private save(): void {
    if (!this.persistPath) return;
    try {
      mkdirSync(dirname(this.persistPath), { recursive: true });
      const tmp = `${this.persistPath}.tmp`;
      writeFileSync(tmp, JSON.stringify({ bindings: [...this.byId.values()] }, null, 2));
      renameSync(tmp, this.persistPath);
    } catch (e) {
      console.error('[gitdeploy] failed to persist bindings:', (e as Error).message);
    }
  }

  list(): GitBinding[] {
    return [...this.byId.values()];
  }

  get(id: string): GitBinding | undefined {
    return this.byId.get(id);
  }

  // First binding matching a repo+branch (what a push webhook looks up). Repo match is case-insensitive.
  find(repo: string, branch: string): GitBinding | undefined {
    return [...this.byId.values()].find((b) => b.repo.toLowerCase() === repo.toLowerCase() && b.branch === branch);
  }

  bind(b: Omit<GitBinding, 'id' | 'lastStatus'>): { ok: true; binding: GitBinding } | { ok: false; error: string } {
    if (this.byId.size >= GitProjectStore.MAX) return { ok: false, error: `binding limit reached (${GitProjectStore.MAX})` };
    if (this.find(b.repo, b.branch)) return { ok: false, error: `already bound: ${b.repo}@${b.branch}` };
    const binding: GitBinding = { ...b, id: randomUUID() };
    this.byId.set(binding.id, binding);
    this.save();
    return { ok: true, binding };
  }

  unbind(id: string): { ok: boolean } {
    const ok = this.byId.delete(id);
    if (ok) this.save();
    return { ok };
  }

  setStatus(id: string, status: GitBinding['lastStatus']): void {
    const b = this.byId.get(id);
    if (b) { b.lastStatus = status; this.save(); }
  }
}

// Run the pipeline for one commit. Mints a short-lived GitHub App token when configured + an
// installation id is known (private repos); public repos clone tokenless.
export async function deployFromGit(
  b: GitBinding,
  sha: string,
  installationId: number | undefined,
  cfg: DeployConfig,
  gw: Pick<AgentGateway, 'send'> = agentGateway,
): Promise<DeployResult> {
  let token: string | undefined;
  if (cfg.appId && cfg.privateKey && installationId) {
    token = await installationToken(cfg.appId, cfg.privateKey, installationId);
  }
  const tag = `${b.name}:${(sha || 'latest').slice(0, 12)}`;
  const image = `${cfg.registry}/${tag}`;
  const build = await gw.send(
    b.buildNode,
    { cmd: 'build', repoUrl: cloneUrl(b.repo, token), ref: b.branch, registry: cfg.registry, tag, hubBase: cfg.hubBase },
    300_000,
  );
  if (!build.ok) return { ok: false, stage: 'build', image, output: build.output, error: build.error };
  const args = ['-e', `PORT=${b.port}`, '-p', `${b.port}:${b.port}`];
  const deploy = await gw.send(b.deployNode, { cmd: 'deploy', image, name: b.name, args }, 180_000);
  return { ok: deploy.ok, stage: 'deploy', image, output: deploy.output, error: deploy.error };
}

// Default store singleton (mirrors the other runtime singletons).
export const gitProjects = new GitProjectStore();
