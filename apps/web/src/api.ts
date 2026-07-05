// Minimal tRPC-over-HTTP client. ponytail: plain fetch instead of @trpc/client +
// react-query — queries are simple GETs and the dashboard only reads a handful.
// Token resolution, in order: localStorage (runtime, survives rebuilds, never in the bundle) →
// VITE_PORTLESS_TOKEN (build-time, only for private/Access-protected deployments) → dev fallback.
// A public production bundle ships NO token: the user is prompted once and it lands in localStorage.
// ponytail: prompt()+localStorage is the whole login UI; swap for sessions/OIDC when multi-user.
function resolveToken(): string {
  const stored = localStorage.getItem('portless-token');
  if (stored) return stored;
  const baked = import.meta.env.VITE_PORTLESS_TOKEN ?? (import.meta.env.DEV ? 'owner-dev-token' : '');
  if (baked) return baked;
  const entered = window.prompt('Portless access token:')?.trim() ?? '';
  if (entered) localStorage.setItem('portless-token', entered);
  return entered;
}
const TOKEN = resolveToken();

export async function trpcQuery<T>(path: string, input?: unknown): Promise<T> {
  const qs = input === undefined ? '' : `?input=${encodeURIComponent(JSON.stringify(input))}`;
  const res = await fetch(`/trpc/${path}${qs}`, { headers: { authorization: `Bearer ${TOKEN}` } });
  const body = await res.json();
  if (!res.ok) throw new Error(body?.error?.message ?? `${path} -> ${res.status}`);
  return (body as { result: { data: T } }).result.data;
}

export async function trpcMutation<T>(path: string, input: unknown): Promise<T> {
  const res = await fetch(`/trpc/${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify(input ?? {}),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body?.error?.message ?? `${path} -> ${res.status}`);
  return (body as { result: { data: T } }).result.data;
}

// Upload a source tarball to POST /upload (not a tRPC route — it's raw bytes), reusing the same
// bearer token so the auth logic stays in one place. Returns the buildId you then pass to upload.deploy.
export async function uploadSource(file: Blob): Promise<{ buildId: string }> {
  const res = await fetch('/upload', {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/gzip' },
    body: file,
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body?.error?.message ?? body?.error ?? `upload -> ${res.status}`);
  return body as { buildId: string };
}

export interface AgentInfo {
  id: string;
  version: string | null;
  roles: string[];
  connectedAt: string;
}

// A deployed app (the routing/failover record), with its live wildcard URL and whether it's serving.
export interface RouteInfo {
  app: string;
  node: string;
  port: number;
  online: boolean;
  nodeConnected: boolean;
  url: string | null;
}

// Masked env var: the API never returns the value.
export interface EnvVar {
  key: string;
  preview: string;
}

export interface GitBinding {
  id: string;
  repo: string;
  branch: string;
  buildNode?: string; // absent = first connected node at deploy time
  deployNode?: string;
  name: string;
  port?: number; // only for repos with no portless.yaml
  lastStatus?: { at: string; sha: string; ok: boolean; stage: string; error?: string };
}

// Progress of a background deploy (poll apps.status with the deployId from upload.deploy/git.deployNow).
export interface Deployment {
  id: string;
  app: string;
  stage: 'queued' | 'reading-spec' | 'building' | 'deploying' | 'linking' | 'done' | 'failed';
  detail: string;
  urls: string[];
  error?: string;
  startedAt: string;
  finishedAt?: string;
}

// Poll a deploy until it finishes; reports stage changes via onStage.
export async function waitForDeploy(deployId: string, onStage?: (d: Deployment) => void): Promise<Deployment> {
  for (;;) {
    const d = await trpcQuery<Deployment>('apps.status', { deployId });
    onStage?.(d);
    if (d.stage === 'done' || d.stage === 'failed') return d;
    await new Promise((r) => setTimeout(r, 2000));
  }
}
