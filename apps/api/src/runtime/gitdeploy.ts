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
import { deployments } from './deployments.ts';
import { runDeploy, type PipelineResult } from './appdeploy.ts';

// Persist by default (a binding is config, not session state — it must survive a hub restart like
// routes/secrets/projects do). Hermetic (in-memory) only under the node test runner.
function persistDefault(envVar: string | undefined): string | undefined {
  return (process.execArgv.includes('--test') || !!process.env.NODE_TEST_CONTEXT) ? undefined : (envVar ?? join(tmpdir(), 'portless-runtime', 'git-projects.json'));
}

export interface GitBinding {
  id: string;
  repo: string; // "owner/name"
  branch: string;
  buildNode?: string; // agent id that clones + builds (default: first connected node)
  deployNode?: string; // default node for the app's services (default: first connected node)
  name: string; // app name (lowercase-dash)
  port?: number; // only for repos with NO portless.yaml: the single service's container port
  lastStatus?: { at: string; sha: string; ok: boolean; stage: string; error?: string };
}

export type DeployConfig = { registry: string; hubBase: string; appId?: string; privateKey?: string };

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

// Resolve a node preference to a connected agent: the preference itself if given, else the first
// connected node. "One box" is the common case — make it zero-config.
function resolveNode(pref: string | undefined, gw: Pick<AgentGateway, 'list'>): string {
  if (pref) return pref;
  const first = gw.list()[0];
  if (!first) throw new Error('no nodes connected — enroll one with agent.sh first');
  return first.id;
}

export type StartedDeploy = { deployId: string; done: Promise<PipelineResult> };

// Git push-to-deploy. Mints a short-lived GitHub App token when configured + an installation id is
// known (private repos); public repos clone tokenless. Returns immediately with a deployId; the
// pipeline runs in the background (poll apps.status).
export function startGitDeploy(
  b: GitBinding,
  sha: string,
  installationId: number | undefined,
  cfg: DeployConfig,
  gw: Pick<AgentGateway, 'send' | 'list'> = agentGateway,
): StartedDeploy {
  const d = deployments.create(b.name);
  const done = (async () => {
    let token: string | undefined;
    if (cfg.appId && cfg.privateKey && installationId) {
      token = await installationToken(cfg.appId, cfg.privateKey, installationId);
    }
    return runDeploy(d.id, { repoUrl: cloneUrl(b.repo, token), ref: b.branch }, {
      app: b.name,
      port: b.port,
      buildNode: resolveNode(b.buildNode, gw),
      defaultNode: resolveNode(b.deployNode, gw),
      registry: cfg.registry,
      hubBase: cfg.hubBase,
      sha,
    }, gw);
  })().catch((e): PipelineResult => {
    deployments.update(d.id, { stage: 'failed', detail: 'deploying', error: (e as Error).message });
    return { ok: false, stage: 'deploying', urls: [], error: (e as Error).message };
  });
  return { deployId: d.id, done };
}

// Upload deploy: build from a previously uploaded tarball (POST /upload → buildId). The build node
// fetches the tarball from the hub with its own token (the /builds route is app.deploy-gated).
export function startUploadDeploy(
  buildId: string,
  opts: { app: string; port?: number; buildNode?: string; node?: string },
  cfg: DeployConfig,
  gw: Pick<AgentGateway, 'send' | 'list'> = agentGateway,
): StartedDeploy {
  const d = deployments.create(opts.app);
  const done = runDeploy(d.id, { tarUrl: `${cfg.hubBase}/builds/${buildId}/source.tgz` }, {
    app: opts.app,
    port: opts.port,
    buildNode: resolveNode(opts.buildNode, gw),
    defaultNode: resolveNode(opts.node, gw),
    registry: cfg.registry,
    hubBase: cfg.hubBase,
    sha: buildId,
  }, gw).catch((e): PipelineResult => {
    deployments.update(d.id, { stage: 'failed', detail: 'deploying', error: (e as Error).message });
    return { ok: false, stage: 'deploying', urls: [], error: (e as Error).message };
  });
  return { deployId: d.id, done };
}

// Default store singleton (mirrors the other runtime singletons).
export const gitProjects = new GitProjectStore();
