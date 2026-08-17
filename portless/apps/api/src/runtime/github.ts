// GitHub App integration — the Vercel model: install an app on your repos, get push webhooks +
// short-lived tokens to clone private repos. No third-party service; it's YOUR app. Uses only Node
// stdlib crypto (no extra deps): RS256 JWT for the app, HMAC-SHA256 to verify webhooks.
import { createSign, createHmac, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";

const b64url = (b: Buffer | string) => Buffer.from(b).toString("base64url");

// App JWT (RS256), used to mint installation tokens. iat backdated 60s for clock skew; 9-min expiry.
export function appJwt(
  appId: string,
  privateKeyPem: string,
  now = Math.floor(Date.now() / 1000),
): string {
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = b64url(JSON.stringify({ iat: now - 60, exp: now + 540, iss: appId }));
  const data = `${header}.${payload}`;
  const sig = createSign("RSA-SHA256").update(data).sign(privateKeyPem).toString("base64url");
  return `${data}.${sig}`;
}

// Exchange the app JWT for an installation access token (clones private repos, expires ~1h).
export async function installationToken(
  appId: string,
  privateKeyPem: string,
  installationId: number | string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const jwt = appJwt(appId, privateKeyPem);
  const res = await fetchImpl(
    `https://api.github.com/app/installations/${installationId}/access_tokens`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "portless",
      },
    },
  );
  if (!res.ok) throw new Error(`installation token failed: ${res.status} ${await res.text()}`);
  return ((await res.json()) as { token: string }).token;
}

// Verify a GitHub webhook delivery (X-Hub-Signature-256) against the raw body. Timing-safe.
export function verifyWebhook(
  secret: string,
  rawBody: Buffer | string,
  signature: string | undefined,
): boolean {
  if (!signature) return false;
  const expected = "sha256=" + createHmac("sha256", secret).update(rawBody).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
}

export type PushEvent = { repo: string; branch: string; sha: string; installationId?: number };

// Extract what a deploy needs from a push event; null for non-branch pushes (tags, deletes) we skip.
export function parsePush(body: unknown): PushEvent | null {
  const b = body as {
    ref?: string;
    after?: string;
    repository?: { full_name?: string };
    installation?: { id?: number };
    deleted?: boolean;
  };
  const repo = b?.repository?.full_name;
  const ref = b?.ref;
  if (
    typeof repo !== "string" ||
    typeof ref !== "string" ||
    !ref.startsWith("refs/heads/") ||
    b?.deleted
  )
    return null;
  return {
    repo,
    branch: ref.slice("refs/heads/".length),
    sha: typeof b.after === "string" ? b.after : "",
    installationId: b?.installation?.id,
  };
}

// Authenticated clone URL (token embedded). Without a token, the public https URL.
export function cloneUrl(repo: string, token?: string): string {
  return token
    ? `https://x-access-token:${token}@github.com/${repo}.git`
    : `https://github.com/${repo}.git`;
}

export type GithubAppConfig = { appId?: string; webhookSecret?: string; privateKey?: string };

// App config from env: PORTLESS_GH_APP_ID, PORTLESS_GH_WEBHOOK_SECRET, and the PEM via
// PORTLESS_GH_APP_KEY (literal or \n-escaped) or PORTLESS_GH_APP_KEY_FILE (path).
export function githubAppConfig(): GithubAppConfig {
  const appId = process.env.PORTLESS_GH_APP_ID;
  const webhookSecret = process.env.PORTLESS_GH_WEBHOOK_SECRET;
  let privateKey = process.env.PORTLESS_GH_APP_KEY;
  if (privateKey?.includes("\\n")) privateKey = privateKey.replace(/\\n/g, "\n");
  if (!privateKey && process.env.PORTLESS_GH_APP_KEY_FILE) {
    try {
      privateKey = readFileSync(process.env.PORTLESS_GH_APP_KEY_FILE, "utf8");
    } catch {
      /* not present */
    }
  }
  return { appId, webhookSecret, privateKey };
}
