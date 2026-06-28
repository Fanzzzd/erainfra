// Git push-to-deploy (the Vercel flow): a binding ties a GitHub repo+branch to a build node, a
// deploy node, and a container name/port. A push webhook (or a manual trigger) runs the pipeline:
// clone the repo at the commit ON the build node (reusing image.sh = Dockerfile-or-nixpacks), push
// to your registry, then deploy on the deploy node. Self-hosted end to end.
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { agentGateway, type AgentGateway } from './agents.ts';
import { cloneUrl, installationToken } from './github.ts';
import { secretStore } from './secrets.ts';
import { routeStore } from './routes.ts';

// Persist by default (a binding is config, not session state — it must survive a hub restart like
// routes/secrets/projects do). Hermetic (in-memory) only under the node test runner.
function persistDefault(envVar: string | undefined): string | undefined {
  return process.execArgv.includes('--test') ? undefined : (envVar ?? join(tmpdir(), 'portless-runtime', 'git-projects.json'));
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

export type DeploySpec = { buildNode: string; deployNode: string; name: string; port: number };

// Shared pipeline core: build a source on the build node (git or tar), then deploy on the deploy node.
async function buildAndDeploy(
  buildFields: Record<string, unknown>,
  spec: DeploySpec,
  sha: string,
  cfg: DeployConfig,
  gw: Pick<AgentGateway, 'send'>,
): Promise<DeployResult> {
  const tag = `${spec.name}:${(sha || 'latest').slice(0, 12)}`;
  const image = `${cfg.registry}/${tag}`;
  const build = await gw.send(spec.buildNode, { cmd: 'build', ...buildFields, registry: cfg.registry, tag, hubBase: cfg.hubBase }, 300_000);
  if (!build.ok) return { ok: false, stage: 'build', image, output: build.output, error: build.error };
  // Secrets ride as a map (the agent writes them to a 0600 --env-file, never argv); PORT goes in args
  // AFTER --env-file so the platform port always wins over a user-set PORT. `port` lets the agent
  // record app->port for the data plane to proxy to (loopback, agent-chosen target).
  const args = ['-e', `PORT=${spec.port}`, '-p', `${spec.port}:${spec.port}`];
  const deploy = await gw.send(spec.deployNode, { cmd: 'deploy', image, name: spec.name, args, env: secretStore.get(spec.name), port: spec.port }, 180_000);
  if (deploy.ok) routeStore.set(spec.name, { node: spec.deployNode, image, port: spec.port }); // ingress + failover record
  return { ok: deploy.ok, stage: 'deploy', image, output: deploy.output, error: deploy.error };
}

// Git push-to-deploy. Mints a short-lived GitHub App token when configured + an installation id is
// known (private repos); public repos clone tokenless.
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
  return buildAndDeploy({ repoUrl: cloneUrl(b.repo, token), ref: b.branch }, b, sha, cfg, gw);
}

// Drag-drop deploy: build from a previously uploaded tarball (POST /upload → buildId). The build node
// fetches the tarball from the hub with its own token (the /builds route is app.deploy-gated).
export async function deployFromUpload(
  buildId: string,
  spec: DeploySpec,
  cfg: DeployConfig,
  gw: Pick<AgentGateway, 'send'> = agentGateway,
): Promise<DeployResult> {
  return buildAndDeploy({ tarUrl: `${cfg.hubBase}/builds/${buildId}/source.tgz` }, spec, buildId, cfg, gw);
}

// Default store singleton (mirrors the other runtime singletons).
export const gitProjects = new GitProjectStore();
