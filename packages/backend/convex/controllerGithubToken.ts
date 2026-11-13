// GitHub credentials for the controller that holds a Profile's lease (ADR 0014, decision 5).
//
// The controller's GitHub App key lives in this deployment, in CONTROLLER_GITHUB_APP_CLIENT_ID and
// CONTROLLER_GITHUB_APP_PRIVATE_KEY, and never leaves it. The holder asks for a token and gets a
// one-hour installation token, narrowed to the Profile's repository (or organization) and to the
// permissions the controller uses (docs/controllers.md, "GitHub permissions the controller needs").
//
// The controller's App is the one a dedicated host already holds as RC_GITHUB_APP_*. Moving its key
// into Convex moves the identity, not the privilege. Any Convex function can read an environment
// variable, so the rule is that no function returns the key or the App JWT, or sends either to a
// Worker: callers get only installation tokens (controllerApp below is the one reader). The same App
// also lends the control plane a token for its own calls (strandedJobs.ts) and for reading
// actions/runner's releases (github.ts).
//
// Pure apart from the injected fetch and clock: the HTTP route supplies both, and the tests mock
// GitHub with them. Web Crypto only, so it runs in Convex's default runtime and in the tests.

import { parseRegistrationScope, type RegistrationScope } from "./controllerHttp";

/** GitHub caps an App JWT at ten minutes; nine leaves room for clock skew. */
const JWT_LIFETIME_SECONDS = 9 * 60;
/** GitHub's advice: backdate `iat` by 60 seconds to allow for clock drift. */
const JWT_BACKDATE_SECONDS = 60;

export type MintResult =
  | { ok: true; token: string; expiresAt: number }
  | { ok: false; status: number; error: string };

export type MintRequest = {
  clientId: string;
  privateKey: string;
  githubConfigUrl: string;
  /** The controller publishes cache facts and needs the three repository reads they take. */
  cacheFacts: boolean;
  now: number;
  fetch: typeof fetch;
  /** Per-request bound; GITHUB_REQUEST_TIMEOUT_MS unless a test shortens it. */
  timeoutMs?: number;
  /**
   * The control plane's own calls (strandedJobs.ts) name the permissions they need instead of the
   * controller's set, and narrow an organization token to the one repository they act on.
   */
  permissions?: Permissions;
  repository?: string;
};

/**
 * How long one GitHub call may take, body included. Minting makes two, so a token request is
 * answered within about 20 seconds, inside the controller's 30-second fetch deadline
 * (githubscale/token.go).
 */
export const GITHUB_REQUEST_TIMEOUT_MS = 10_000;

/**
 * GitHub's REST base for a registration URL, by the scale-set client's rule (and the controller's
 * githubapi.APIURL): github.com and GHE.com tenants use the `api.` host, a GitHub Enterprise Server
 * serves the API under /api/v3 on its own host.
 */
export function githubApiBase(githubConfigUrl: string) {
  const url = new URL(githubConfigUrl.trim());
  const host = url.host.toLowerCase();
  const hosted =
    host === "github.com" ||
    host === "www.github.com" ||
    host === "github.localhost" ||
    host.endsWith(".ghe.com");
  if (!hosted) return `${url.protocol}//${url.host}/api/v3`;
  return `${url.protocol}//api.${host === "www.github.com" ? "github.com" : host}`;
}

export type Permissions = Record<string, "read" | "write">;

/**
 * The narrowest token that does the controller's job at this scope. Creating the scale set's
 * registration token needs Administration write on a repository and Self-hosted runners write on
 * an organization; everything else the scale-set client does goes through the Actions service
 * session that registration token buys. The cache facts read a workflow run, the repository and a
 * git ref, which need Actions, Metadata and Contents read, and only when the controller publishes
 * them. Asking for a permission the App lacks fails the whole request, which is why the cache reads
 * are asked for only by a controller that uses them.
 */
export function tokenPermissions(scope: RegistrationScope, cacheFacts: boolean): Permissions {
  const base: Permissions =
    scope.kind === "organization"
      ? { organization_self_hosted_runners: "write" }
      : { administration: "write" };
  return cacheFacts ? { ...base, actions: "read", contents: "read", metadata: "read" } : base;
}

function base64Url(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlJson(value: unknown) {
  return base64Url(new TextEncoder().encode(JSON.stringify(value)));
}

function derLength(length: number) {
  if (length < 0x80) return [length];
  const bytes: number[] = [];
  for (let rest = length; rest > 0; rest >>= 8) bytes.unshift(rest & 0xff);
  return [0x80 | bytes.length, ...bytes];
}

function derSequence(tag: number, content: Uint8Array) {
  return new Uint8Array([tag, ...derLength(content.length), ...content]);
}

/**
 * Wraps a PKCS#1 RSAPrivateKey, which is what GitHub hands out ("BEGIN RSA PRIVATE KEY"), in the
 * PKCS#8 PrivateKeyInfo that Web Crypto imports: version 0, the rsaEncryption algorithm identifier,
 * and the PKCS#1 key as an octet string.
 */
function pkcs1ToPkcs8(pkcs1: Uint8Array) {
  const version = [0x02, 0x01, 0x00];
  const rsaEncryption = [
    0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00,
  ];
  const octets = derSequence(0x04, pkcs1);
  return derSequence(0x30, new Uint8Array([...version, ...rsaEncryption, ...octets]));
}

function pemBody(pem: string, label: string) {
  const match = new RegExp(`-----BEGIN ${label}-----([\\s\\S]*?)-----END ${label}-----`).exec(pem);
  if (match === null) return null;
  const binary = atob(match[1].replace(/\s+/g, ""));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

/** Environment variables flatten newlines in some tools; accept the escaped form too. */
export function normalizePrivateKey(privateKey: string) {
  return privateKey.includes("\\n") ? privateKey.replace(/\\n/g, "\n") : privateKey;
}

export type ControllerApp = { clientId: string; privateKey: string };

/** The controller's App as this deployment's environment holds it, or null if either half is unset. */
export function controllerApp(env: Record<string, string | undefined>): ControllerApp | null {
  const clientId = env.CONTROLLER_GITHUB_APP_CLIENT_ID?.trim() ?? "";
  const privateKey = env.CONTROLLER_GITHUB_APP_PRIVATE_KEY?.trim() ?? "";
  if (clientId.length === 0 || privateKey.length === 0) return null;
  return { clientId, privateKey };
}

async function importAppKey(privateKey: string) {
  const pem = normalizePrivateKey(privateKey);
  const pkcs8 = pemBody(pem, "PRIVATE KEY");
  const pkcs1 = pkcs8 === null ? pemBody(pem, "RSA PRIVATE KEY") : null;
  const der = pkcs8 ?? (pkcs1 === null ? null : pkcs1ToPkcs8(pkcs1));
  if (der === null) throw new Error("not a PEM RSA private key");
  return await crypto.subtle.importKey(
    "pkcs8",
    der,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

/** A GitHub App JWT (RS256), signed with the App's key. GitHub accepts the client ID as `iss`. */
export async function appJwt(clientId: string, privateKey: string, now: number) {
  const key = await importAppKey(privateKey);
  const issuedAt = Math.floor(now / 1000) - JWT_BACKDATE_SECONDS;
  const signingInput = `${base64UrlJson({ alg: "RS256", typ: "JWT" })}.${base64UrlJson({
    iat: issuedAt,
    exp: issuedAt + JWT_BACKDATE_SECONDS + JWT_LIFETIME_SECONDS,
    iss: clientId,
  })}`;
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(signingInput),
  );
  return `${signingInput}.${base64Url(new Uint8Array(signature))}`;
}

function failure(status: number, error: string): MintResult {
  return { ok: false, status, error };
}

export async function githubJson(
  request: Pick<MintRequest, "fetch" | "timeoutMs">,
  method: "GET" | "POST",
  url: string,
  bearer: string,
  body?: unknown,
) {
  // Each call, including reading its body, is bounded: the HTTP action holds a controller's lease
  // request open while it waits, and a GitHub stall must end as a refusal the controller retries,
  // not as a request that outlives the lease it was made under.
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), request.timeoutMs ?? GITHUB_REQUEST_TIMEOUT_MS);
  try {
    const response = await request.fetch(url, {
      method,
      signal: abort.signal,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${bearer}`,
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
    // A network failure or the timeout. The error is not passed on: it could describe the
    // request, which carried the App JWT.
    return { status: 0, payload: { message: "no answer from GitHub in time" } };
  } finally {
    clearTimeout(timer);
  }
}

function githubMessage(payload: unknown) {
  return typeof payload === "object" &&
    payload !== null &&
    typeof (payload as { message?: unknown }).message === "string"
    ? (payload as { message: string }).message.slice(0, 300)
    : "no message";
}

/**
 * Finds the App's installation for the Profile's repository or organization and mints a token
 * scoped to it. GitHub's answer is passed through as a 502 with GitHub's status and message, never
 * with the request, which carried the JWT.
 */
export async function mintInstallationToken(request: MintRequest): Promise<MintResult> {
  const scope = parseRegistrationScope(request.githubConfigUrl);
  if (scope === null) return failure(422, "The Profile's GitHub config URL is not valid");
  if (scope.kind === "enterprise") {
    // GitHub: "You cannot authenticate using a GitHub App for runners at the enterprise level."
    return failure(
      422,
      "A GitHub App cannot register enterprise runners; serve this Profile from a dedicated controller host with RC_GITHUB_TOKEN",
    );
  }
  let jwt: string;
  try {
    jwt = await appJwt(request.clientId, request.privateKey, request.now);
  } catch {
    return failure(503, "CONTROLLER_GITHUB_APP_PRIVATE_KEY is not a PEM RSA private key");
  }
  const api = githubApiBase(request.githubConfigUrl);
  const installationPath =
    scope.kind === "repository"
      ? `/repos/${encodeURIComponent(scope.owner)}/${encodeURIComponent(scope.repository)}/installation`
      : `/orgs/${encodeURIComponent(scope.organization)}/installation`;
  const installation = await githubJson(request, "GET", api + installationPath, jwt);
  const installationId = (installation.payload as { id?: unknown } | null)?.id;
  if (installation.status === 0) {
    return failure(504, "GitHub did not answer the installation lookup in time");
  }
  if (installation.status !== 200 || typeof installationId !== "number") {
    return failure(
      502,
      `GitHub answered ${installation.status} looking up the App's installation for ${request.githubConfigUrl}: ${githubMessage(installation.payload)}`,
    );
  }
  const minted = await githubJson(
    request,
    "POST",
    `${api}/app/installations/${installationId}/access_tokens`,
    jwt,
    {
      ...(scope.kind === "repository"
        ? { repositories: [scope.repository] }
        : request.repository === undefined
          ? {}
          : { repositories: [request.repository] }),
      permissions: request.permissions ?? tokenPermissions(scope, request.cacheFacts),
    },
  );
  const token = (minted.payload as { token?: unknown } | null)?.token;
  const expiresAt = Date.parse(
    String((minted.payload as { expires_at?: unknown } | null)?.expires_at),
  );
  if (minted.status === 0) {
    return failure(504, "GitHub did not answer the installation token request in time");
  }
  if (minted.status !== 201 || typeof token !== "string" || !Number.isFinite(expiresAt)) {
    return failure(
      502,
      `GitHub answered ${minted.status} minting an installation token: ${githubMessage(minted.payload)}`,
    );
  }
  return { ok: true, token, expiresAt };
}
