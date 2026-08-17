// Minimal tRPC-over-HTTP client. ponytail: plain fetch instead of @trpc/client +
// react-query — queries are simple GETs and the dashboard only reads a handful.
// Auth is the portless_session cookie (set by /auth/login, sent automatically same-origin).
// A bearer token is only a fallback: localStorage (manual escape hatch) → VITE_PORTLESS_TOKEN
// (baked private builds) → owner-dev-token in dev so a fresh checkout works with zero setup.
// Both spellings of each, new first (ADR 0004 stage 1). The localStorage key is held by a browser
// that already has it and the Vite variable is baked into a build someone already runs, so neither
// may change in one release; nothing here writes either name, so a dashboard in the field reads
// exactly what it read before. No warning: this runs in a customer's browser console, where a
// deprecation notice reaches nobody who can act on it — the Hub's own log is where that belongs.
const TOKEN =
  localStorage.getItem("erainfra-token") ??
  localStorage.getItem("portless-token") ??
  import.meta.env.VITE_ERAINFRA_TOKEN ??
  import.meta.env.VITE_PORTLESS_TOKEN ??
  (import.meta.env.DEV ? "owner-dev-token" : "");
const AUTH_HEADERS: Record<string, string> = TOKEN ? { authorization: `Bearer ${TOKEN}` } : {};

export async function trpcQuery<T>(path: string, input?: unknown): Promise<T> {
  const qs = input === undefined ? "" : `?input=${encodeURIComponent(JSON.stringify(input))}`;
  const res = await fetch(`/trpc/${path}${qs}`, { headers: AUTH_HEADERS });
  const body = await res.json();
  if (!res.ok) throw new Error(body?.error?.message ?? `${path} -> ${res.status}`);
  return (body as { result: { data: T } }).result.data;
}

export async function trpcMutation<T>(path: string, input: unknown): Promise<T> {
  const res = await fetch(`/trpc/${path}`, {
    method: "POST",
    headers: { ...AUTH_HEADERS, "content-type": "application/json" },
    body: JSON.stringify(input ?? {}),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body?.error?.message ?? `${path} -> ${res.status}`);
  return (body as { result: { data: T } }).result.data;
}

// Upload a source tarball to POST /upload (not a tRPC route — it's raw bytes), reusing the same
// bearer token so the auth logic stays in one place. Returns the buildId you then pass to upload.deploy.
export async function uploadSource(file: Blob): Promise<{ buildId: string }> {
  const res = await fetch("/upload", {
    method: "POST",
    headers: { ...AUTH_HEADERS, "content-type": "application/gzip" },
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
  stage: "queued" | "reading-spec" | "building" | "deploying" | "linking" | "done" | "failed";
  detail: string;
  urls: string[];
  error?: string;
  startedAt: string;
  finishedAt?: string;
}

// Poll a deploy until it finishes; reports stage changes via onStage.
export async function waitForDeploy(
  deployId: string,
  onStage?: (d: Deployment) => void,
): Promise<Deployment> {
  for (;;) {
    const d = await trpcQuery<Deployment>("apps.status", { deployId });
    onStage?.(d);
    if (d.stage === "done" || d.stage === "failed") return d;
    await new Promise((r) => setTimeout(r, 2000));
  }
}

// ---- Account auth --------------------------------------------------------------------------

export interface AuthUser {
  id: string;
  name: string;
  roles: string[];
  email?: string;
}

async function authPost<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const out = await res.json();
  if (!res.ok) throw new Error(out?.error ?? `${path} -> ${res.status}`);
  return out as T;
}

export const authStatus = async (): Promise<{ setup: boolean }> =>
  (await fetch("/auth/status")).json();

// The logged-in identity, or null when there is no valid session/token.
export async function authMe(): Promise<AuthUser | null> {
  const res = await fetch("/auth/me", { headers: AUTH_HEADERS });
  return res.ok ? ((await res.json()) as AuthUser) : null;
}

export const login = (email: string, password: string) =>
  authPost<{ user: AuthUser }>("/auth/login", { email, password });
export const setupOwner = (email: string, password: string, name?: string) =>
  authPost<{ user: AuthUser }>("/auth/setup", { email, password, name });
export const logout = () => authPost<{ ok: boolean }>("/auth/logout", {});

export interface ApiTokenInfo {
  id: string;
  name: string;
  prefix: string;
  roles: string[];
  createdAt: string;
  lastUsedAt?: string;
}

export interface UserInfo {
  id: string;
  email: string;
  name: string;
  roles: string[];
  createdAt: string;
}

export interface SessionInfo {
  id: string;
  createdAt: string;
  lastSeenAt: string;
  userAgent?: string;
}

// ---- Chat archive ---------------------------------------------------------------------------

export interface ChatSession {
  id: string;
  source: "claude" | "codex";
  host: string;
  project?: string;
  title?: string;
  startedAt?: string;
  updatedAt?: string;
  messageCount: number;
}

export interface ChatMessage {
  seq: number;
  role: "user" | "assistant";
  model?: string;
  at?: string;
  text: string;
}

export interface ChatHit {
  session: ChatSession;
  seq: number;
  role: string;
  at?: string;
  snippet: string;
}
