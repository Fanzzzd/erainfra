// GitHub for push-to-deploy, as the Hub's apps/hub/src/runtime/github.ts did it: the operator's own
// GitHub App sends push webhooks and lends the build Node a short-lived token to clone a private
// repository. The App is configured in the Convex environment under the names the Hub reads:
//
//   ERAINFRA_GH_APP_ID          the App's id (or client id)
//   ERAINFRA_GH_APP_KEY         its private key, PEM (literal newlines or \n-escaped)
//   ERAINFRA_GH_WEBHOOK_SECRET  its webhook secret; the App's webhook URL is <site>/github/webhook
//
// It is not the CI App the dashboard's Manifest flow creates: that App has no Contents permission
// and does not subscribe to `push`, and widening it would grant the CI webhook path permissions it
// does not use. A deployment with no deploy App still deploys public repositories, unauthenticated.
//
// The token is minted per build step, after the Node proved it holds the step's live claim, and is
// narrowed to the one repository and to Contents read. It is never stored in Convex; the Node
// keeps it in a child process's environment for the clone and nowhere else.
import { appJwt, GITHUB_REQUEST_TIMEOUT_MS } from "../controllerGithubToken";

export type DeployAppConfig = { appId: string; privateKey: string } | null;

export function deployAppConfig(env: Record<string, string | undefined>): DeployAppConfig {
  const appId = env.ERAINFRA_GH_APP_ID?.trim();
  const privateKey = env.ERAINFRA_GH_APP_KEY;
  if (!appId || !privateKey) return null;
  return { appId, privateKey };
}

const present = (value: string | null | undefined): value is string =>
  value !== null && value !== undefined && value.length > 0;

/**
 * The secrets a delivery of `event` may be signed with, chosen before verification. A `push`
 * deploys, so only the deploy App's secret signs it; a `workflow_job` queues CI work, so only the
 * CI App's secrets (the Manifest record, then GITHUB_WEBHOOK_SECRET) sign it. Any other event is
 * acknowledged and ignored, so either App's secret may sign it (GitHub's `ping` comes from both).
 */
export function webhookSecretsFor(
  event: string,
  configured: { ciStored: string | null; ciEnv?: string; deploy?: string },
): string[] {
  const ci = [configured.ciStored, configured.ciEnv].filter(present);
  const deploy = [configured.deploy].filter(present);
  if (event === "push") return deploy;
  if (event === "workflow_job") return ci;
  return [...ci, ...deploy];
}

export type PushEvent = { repo: string; branch: string; sha: string };

/** What a deploy needs from a push event; null for a tag, a branch deletion or a malformed body. */
export function parsePush(body: unknown): PushEvent | null {
  const b = body as {
    ref?: unknown;
    after?: unknown;
    deleted?: unknown;
    repository?: { full_name?: unknown };
  } | null;
  const repo = b?.repository?.full_name;
  const ref = b?.ref;
  if (
    typeof repo !== "string" ||
    !/^[\w.-]+\/[\w.-]+$/.test(repo) ||
    typeof ref !== "string" ||
    !ref.startsWith("refs/heads/") ||
    b?.deleted === true
  )
    return null;
  const branch = ref.slice("refs/heads/".length);
  if (branch.length === 0 || branch.length > 255) return null;
  return { repo, branch, sha: typeof b?.after === "string" ? b.after : "" };
}

export type RepoTokenResult =
  | { ok: true; token: string }
  | { ok: false; reason: "not-installed" | "unavailable"; status: number };

async function call(
  fetchImpl: typeof fetch,
  method: "GET" | "POST",
  url: string,
  jwt: string,
  body?: unknown,
) {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), GITHUB_REQUEST_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, {
      method,
      signal: abort.signal,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${jwt}`,
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "erainfra-control-plane",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    let payload: unknown = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }
    return { status: response.status, payload };
  } catch {
    // The request carried the App JWT; its error is not passed on.
    return { status: 0, payload: null };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * A one-hour installation token that can read one repository's contents and nothing else.
 * `not-installed` means the App is not installed on that repository, which for a public repository
 * is fine: the build clones without a token.
 */
export async function mintRepoReadToken(input: {
  app: NonNullable<DeployAppConfig>;
  repo: string;
  now: number;
  fetch: typeof fetch;
}): Promise<RepoTokenResult> {
  const [owner, name] = input.repo.split("/");
  let jwt: string;
  try {
    jwt = await appJwt(input.app.appId, input.app.privateKey, input.now);
  } catch {
    return { ok: false, reason: "unavailable", status: 503 };
  }
  const api = "https://api.github.com";
  const installation = await call(
    input.fetch,
    "GET",
    `${api}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/installation`,
    jwt,
  );
  if (installation.status === 404) return { ok: false, reason: "not-installed", status: 404 };
  const installationId = (installation.payload as { id?: unknown } | null)?.id;
  if (installation.status !== 200 || typeof installationId !== "number")
    return { ok: false, reason: "unavailable", status: installation.status };
  const minted = await call(
    input.fetch,
    "POST",
    `${api}/app/installations/${installationId}/access_tokens`,
    jwt,
    { repositories: [name], permissions: { contents: "read" } },
  );
  const token = (minted.payload as { token?: unknown } | null)?.token;
  if (minted.status !== 201 || typeof token !== "string")
    return { ok: false, reason: "unavailable", status: minted.status };
  return { ok: true, token };
}
