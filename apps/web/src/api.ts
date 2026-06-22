// Minimal tRPC-over-HTTP client. ponytail: plain fetch instead of @trpc/client +
// react-query — queries are simple GETs and the dashboard only reads a handful.
// The token is read from VITE_PORTLESS_TOKEN. The convenient 'owner-dev-token' fallback applies
// ONLY in dev builds — a production bundle never ships a privileged default token.
// NOTE: bundling any bearer token in client JS is a dev posture; real deployments should move to
// server-side/session auth (the API already fails closed in production without dev tokens).
const TOKEN = import.meta.env.VITE_PORTLESS_TOKEN ?? (import.meta.env.DEV ? 'owner-dev-token' : '');

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

export interface LocalProc {
  name: string;
  pid: number;
  port?: number;
  healthPath?: string;
  status: 'running' | 'exited';
  startedAt: string;
  command: string;
  logFile: string;
  publicUrl?: string | null; // set when the app is published via a Cloudflare quick tunnel
}

export interface Template {
  id: string;
  label: string;
  description: string;
}

export interface AppRow {
  project: string;
  environment: string;
  services: Array<{ name: string; type: string; replicas: number; image: string }>;
}
