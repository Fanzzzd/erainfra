// Pure helpers for the GitHub App Manifest flow.
//
// Deliberately free of Convex imports so the unit tests can import it directly,
// the same way catalog.ts is imported. Everything here is a total function of
// its arguments: no clock reads, no environment reads, no database.

export const SETUP_STATE_TTL_MS = 15 * 60 * 1_000;

// The minimum GitHub App permissions Runner Center actually uses:
//
// - administration: write — POST /repos/{owner}/{repo}/actions/runners/generate-jitconfig
//   to create a JIT runner, and DELETE /repos/{owner}/{repo}/actions/runners/{id}
//   to remove one. Both live under repository Administration.
// - actions: read — what makes GitHub deliver workflow_job events.
//
// Narrower than the "Actions: Read and write" the hand-registration docs used
// to ask for, and unlike it, actually sufficient for the JIT endpoints.
export const APP_PERMISSIONS = {
  actions: "read",
  administration: "write",
} as const;

export const APP_EVENTS = ["workflow_job"] as const;

/**
 * Which credential path a deployment will use.
 *
 * - `manifest` — App credentials stored in the database by the Manifest flow.
 * - `envApp`   — App hand-registered through GITHUB_APP_ID / GITHUB_APP_PRIVATE_KEY.
 * - `pat`      — legacy GITHUB_PAT, kept only as a migration fallback.
 */
export type CredentialSource = "manifest" | "envApp" | "pat" | "none";

export type CredentialEnv = {
  appId: string | undefined;
  privateKey: string | undefined;
  pat: string | undefined;
};

function isNonEmpty(value: string | undefined): value is string {
  return value !== undefined && value.trim().length > 0;
}

function hasEnvApp(env: CredentialEnv) {
  return isNonEmpty(env.appId) && isNonEmpty(env.privateKey);
}

/**
 * Database-stored App credentials outrank the environment. The operator created
 * them later and deliberately, through the dashboard, so they win over anything
 * left in `convex env` — including a legacy PAT, which stays reachable purely as
 * a migration fallback for deployments that have not connected an App yet.
 */
export function resolveCredentialSource(
  hasStoredApp: boolean,
  env: CredentialEnv,
): CredentialSource {
  if (hasStoredApp) {
    return "manifest";
  }
  if (hasEnvApp(env)) {
    return "envApp";
  }
  if (isNonEmpty(env.pat)) {
    return "pat";
  }
  return "none";
}

/**
 * True when the operator can still usefully connect an App.
 *
 * Deliberately true for `pat` and `envApp`: a deployment running on the legacy
 * PAT must be able to migrate onto an App, and a hand-registered App may be
 * replaced by a managed one. Only a Manifest-created App hides the offer.
 */
export function canConnectApp(source: CredentialSource) {
  return source !== "manifest";
}

// Convex environment variables keep PEM newlines either literally or escaped.
export function normalizePrivateKey(privateKey: string) {
  return privateKey.includes("\\n") ? privateKey.replace(/\\n/g, "\n") : privateKey;
}

export type AppCredentialResult =
  | { ok: true; appId: number; privateKey: string; source: "manifest" | "envApp" }
  | { ok: false; error: string };

/**
 * Resolve the App credentials used to mint an installation token.
 *
 * Fails closed with an actionable message: a job that arrived with an
 * installation id can only be served by App auth, so there is no silent
 * downgrade to the PAT here.
 */
export function resolveAppCredentials(
  stored: { appId: number; privateKey: string } | null,
  env: Pick<CredentialEnv, "appId" | "privateKey">,
): AppCredentialResult {
  if (stored !== null) {
    if (!Number.isSafeInteger(stored.appId) || stored.appId <= 0) {
      return {
        ok: false,
        error:
          "The stored GitHub App record has an invalid app ID. Disconnect and reconnect the App from the dashboard.",
      };
    }
    if (stored.privateKey.trim().length === 0) {
      return {
        ok: false,
        error:
          "The stored GitHub App record has no private key. Disconnect and reconnect the App from the dashboard.",
      };
    }
    return {
      ok: true,
      appId: stored.appId,
      privateKey: normalizePrivateKey(stored.privateKey),
      source: "manifest",
    };
  }

  const { appId, privateKey } = env;
  if (!isNonEmpty(appId) && !isNonEmpty(privateKey)) {
    return {
      ok: false,
      error:
        "This job was delivered by a GitHub App installation, but no App credentials are configured. Connect a GitHub App from the dashboard, or set GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY.",
    };
  }
  if (!isNonEmpty(appId) || !/^[1-9]\d*$/.test(appId) || !Number.isSafeInteger(Number(appId))) {
    return {
      ok: false,
      error: "GITHUB_APP_ID must be a positive integer. Set it with `npx convex env set`.",
    };
  }
  if (!isNonEmpty(privateKey)) {
    return {
      ok: false,
      error:
        "GITHUB_APP_PRIVATE_KEY is not configured. Set it to the App's PEM with `npx convex env set`.",
    };
  }
  return {
    ok: true,
    appId: Number(appId),
    privateKey: normalizePrivateKey(privateKey),
    source: "envApp",
  };
}

/**
 * Lifecycle of the single-use CSRF state that ties GitHub's unauthenticated
 * redirect back to the dashboard session that started the flow.
 */
export type SetupStateStatus = "valid" | "unknown" | "consumed" | "expired";

export function evaluateSetupState(
  setup: { createdAt: number; usedAt?: number } | null | undefined,
  now: number,
): SetupStateStatus {
  if (setup === null || setup === undefined) {
    return "unknown";
  }
  if (setup.usedAt !== undefined) {
    return "consumed";
  }
  if (now - setup.createdAt > SETUP_STATE_TTL_MS) {
    return "expired";
  }
  return "valid";
}

export function describeSetupState(status: SetupStateStatus) {
  switch (status) {
    case "valid":
      return "";
    case "consumed":
      return "This setup link was already used. Start again from the dashboard.";
    case "expired":
      return "This setup link expired. Start again from the dashboard.";
    default:
      return "This setup link is not valid. Start again from the dashboard.";
  }
}

/** A setup row is disposable once it has been used or has aged out. */
export function isSetupStateCollectable(
  setup: { createdAt: number; usedAt?: number },
  now: number,
) {
  return evaluateSetupState(setup, now) !== "valid";
}

export function buildManifest(siteUrl: string) {
  return {
    name: "Runner Center",
    url: siteUrl,
    hook_attributes: { url: `${siteUrl}/github/webhook`, active: true },
    redirect_url: `${siteUrl}/github/app/callback`,
    public: false,
    default_permissions: APP_PERMISSIONS,
    default_events: APP_EVENTS,
  };
}

export function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function manifestFormAction(org: string | undefined) {
  return org === undefined || org.trim().length === 0
    ? "https://github.com/settings/apps/new"
    : `https://github.com/organizations/${encodeURIComponent(org.trim())}/settings/apps/new`;
}

/**
 * GitHub only accepts a manifest as a form POST, so the browser gets a
 * self-submitting form rather than a redirect. Carries no secrets: the manifest
 * is a request for an App, and the state is single-use.
 */
export function renderManifestForm(siteUrl: string, state: string, org: string | undefined) {
  const action = manifestFormAction(org);
  const manifest = escapeHtml(JSON.stringify(buildManifest(siteUrl)));

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Creating your GitHub App…</title>
<style>
body{background:#0a0a0b;color:#a1a1aa;font:14px/1.5 ui-sans-serif,system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0}
button{background:#18181b;color:#e4e4e7;border:1px solid rgba(255,255,255,.14);border-radius:6px;padding:8px 14px;font:inherit;cursor:pointer}
</style>
</head>
<body>
<form id="manifest-form" method="post" action="${escapeHtml(action)}?state=${encodeURIComponent(state)}">
<input type="hidden" name="manifest" value="${manifest}" />
<noscript><p>Continue to GitHub to create the app.</p></noscript>
<button type="submit">Continue to GitHub</button>
</form>
<script>document.getElementById('manifest-form').submit();</script>
</body>
</html>`;
}

export type ManifestCredentials = {
  appId: number;
  clientId: string;
  slug: string;
  name: string;
  privateKey: string;
  webhookSecret: string;
  htmlUrl: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Validate GitHub's app-manifest conversion response.
 *
 * `client_secret` is intentionally not read or stored: Runner Center performs no
 * OAuth user flow, so keeping it would be a liability with no use.
 */
export function parseManifestConversion(payload: unknown): ManifestCredentials | null {
  if (!isRecord(payload)) {
    return null;
  }
  const {
    id,
    slug,
    name,
    pem,
    client_id: clientId,
    webhook_secret: webhookSecret,
    html_url: htmlUrl,
  } = payload;
  if (
    typeof id !== "number" ||
    !Number.isSafeInteger(id) ||
    id <= 0 ||
    typeof slug !== "string" ||
    slug.length === 0 ||
    typeof name !== "string" ||
    name.length === 0 ||
    typeof clientId !== "string" ||
    clientId.length === 0 ||
    typeof pem !== "string" ||
    pem.length === 0 ||
    typeof webhookSecret !== "string" ||
    webhookSecret.length === 0 ||
    typeof htmlUrl !== "string"
  ) {
    return null;
  }
  return { appId: id, clientId, slug, name, privateKey: pem, webhookSecret, htmlUrl };
}

export type StoredAppDoc = {
  appId: number;
  clientId: string;
  slug: string;
  name: string;
  privateKey: string;
  webhookSecret: string;
  htmlUrl: string;
  createdAt: number;
};

export type AppSummary = {
  appId: number;
  clientId: string;
  name: string;
  htmlUrl: string;
  installUrl: string;
  createdAt: number;
};

/**
 * Project a stored App down to the fields that are safe to hand a client.
 *
 * The private key and webhook secret are never part of the result — this is the
 * only shape any client-facing query is allowed to return. The client ID is
 * public by design (GitHub shows it on the App page).
 */
export function toAppSummary(app: StoredAppDoc): AppSummary {
  return {
    appId: app.appId,
    clientId: app.clientId,
    name: app.name,
    htmlUrl: app.htmlUrl,
    installUrl: `https://github.com/apps/${app.slug}/installations/new`,
    createdAt: app.createdAt,
  };
}
