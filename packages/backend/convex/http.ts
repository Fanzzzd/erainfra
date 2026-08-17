import { registerStaticRoutes } from "@convex-dev/static-hosting";
import { httpRouter } from "convex/server";
import { AGENT_RELEASE } from "./agentRelease";
import { auth } from "./auth";
import { components, internal } from "./_generated/api";
import { httpAction } from "./_generated/server";
import { findImageLabel, IMAGE_CATALOG } from "./catalog";
import {
  controllerAuthorization,
  parseCancelAttempt,
  parseCompleteRunnerCleanup,
  parseCreateAttempt,
  parseJobCompleted,
  parseJobStarted,
  parseRegisterProfile,
} from "./controllerHttp";
import {
  describeSetupState,
  parseManifestConversion,
  renderManifestForm,
  resolveSiteUrl,
  type SetupStateStatus,
} from "./githubAppConfig";
import { renderInstallScript } from "./installScript";
import { renderPowerShellInstallScript } from "./installScriptPowerShell";

const http = httpRouter();
auth.addHttpRoutes(http);
registerStaticRoutes(http, components.staticHosting);

function jsonResponse(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

function controllerAuthFailure(request: Request) {
  const authStatus = controllerAuthorization(
    request.headers.get("Authorization"),
    process.env.CONTROLLER_TOKEN,
  );
  if (authStatus === "ok") {
    return null;
  }
  if (authStatus === "not-configured") {
    console.error("Controller API refused a request because CONTROLLER_TOKEN is not configured");
    return jsonResponse({ error: "Controller API is not configured" }, 503);
  }
  return jsonResponse({ error: "Unauthorized" }, 401);
}

async function requestJson(request: Request) {
  try {
    return { ok: true as const, payload: (await request.json()) as unknown };
  } catch {
    return { ok: false as const };
  }
}

function bytesToHex(bytes: Uint8Array) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function timingSafeHexEqual(left: string, right: string) {
  if (left.length !== 64 || right.length !== 64) {
    return false;
  }
  let mismatch = 0;
  for (let index = 0; index < 64; index += 1) {
    mismatch |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return mismatch === 0;
}

async function hmacHex(secret: string, rawBody: ArrayBuffer) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = await crypto.subtle.sign("HMAC", key, rawBody);
  return bytesToHex(new Uint8Array(digest));
}

// Accepts any configured secret. During a PAT-to-App migration both delivery
// paths are live at once — the App signs with the secret GitHub generated,
// while any remaining repository webhook still signs with
// GITHUB_WEBHOOK_SECRET. Both are operator-configured, so this is secret
// rotation rather than a weakening. Every candidate is checked even after a
// match so the work does not depend on which secret verified.
async function verifySignature(secrets: string[], rawBody: ArrayBuffer, signature: string) {
  const match = /^sha256=([0-9a-f]{64})$/i.exec(signature);
  if (match === null) {
    return false;
  }
  const expected = match[1].toLowerCase();

  let verified = false;
  for (const secret of secrets) {
    if (timingSafeHexEqual(await hmacHex(secret, rawBody), expected)) {
      verified = true;
    }
  }
  return verified;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseRegistrationRequest(payload: unknown) {
  if (!isRecord(payload)) {
    return null;
  }
  if (
    typeof payload.registrationToken !== "string" ||
    payload.registrationToken.length === 0 ||
    typeof payload.name !== "string" ||
    payload.name.trim().length === 0 ||
    (payload.os !== "linux" && payload.os !== "mac" && payload.os !== "win") ||
    typeof payload.arch !== "string" ||
    payload.arch.trim().length === 0 ||
    typeof payload.cpus !== "number" ||
    !Number.isInteger(payload.cpus) ||
    payload.cpus < 1
  ) {
    return null;
  }

  let memoryMiB: number | undefined;
  if (payload.memoryMiB !== undefined) {
    if (
      typeof payload.memoryMiB !== "number" ||
      !Number.isInteger(payload.memoryMiB) ||
      payload.memoryMiB < 256
    ) {
      return null;
    }
    memoryMiB = payload.memoryMiB;
  }

  let labels: string[] | undefined;
  if (payload.labels !== undefined) {
    if (
      !Array.isArray(payload.labels) ||
      !payload.labels.every((label) => typeof label === "string")
    ) {
      return null;
    }
    labels = payload.labels.map((label) => label.trim()).filter((label) => label.length > 0);
  }

  let maxSlots: number | undefined;
  if (payload.maxSlots !== undefined) {
    if (
      typeof payload.maxSlots !== "number" ||
      !Number.isInteger(payload.maxSlots) ||
      payload.maxSlots < 1
    ) {
      return null;
    }
    maxSlots = payload.maxSlots;
  }

  return {
    registrationToken: payload.registrationToken,
    name: payload.name,
    os: payload.os as "linux" | "mac" | "win",
    arch: payload.arch,
    cpus: payload.cpus,
    memoryMiB,
    labels,
    maxSlots,
  };
}

export function parseWorkflowJob(payload: unknown) {
  if (!isRecord(payload)) {
    return null;
  }
  const action = payload.action;
  if (action !== "queued" && action !== "in_progress" && action !== "completed") {
    return null;
  }
  const workflowJob = payload.workflow_job;
  const repository = payload.repository;
  if (!isRecord(workflowJob) || !isRecord(repository)) {
    return null;
  }

  let githubInstallationId: number | undefined;
  if (payload.installation !== undefined) {
    if (
      !isRecord(payload.installation) ||
      typeof payload.installation.id !== "number" ||
      !Number.isSafeInteger(payload.installation.id) ||
      payload.installation.id <= 0
    ) {
      return null;
    }
    githubInstallationId = payload.installation.id;
  }
  if (
    typeof workflowJob.id !== "number" ||
    typeof repository.full_name !== "string" ||
    !Array.isArray(workflowJob.labels) ||
    !workflowJob.labels.every((label) => typeof label === "string")
  ) {
    return null;
  }

  const workflowName =
    typeof workflowJob.workflow_name === "string"
      ? workflowJob.workflow_name
      : typeof workflowJob.name === "string"
        ? workflowJob.name
        : "Unknown workflow";
  const conclusion =
    typeof workflowJob.conclusion === "string" ? workflowJob.conclusion : undefined;
  const runnerName =
    typeof workflowJob.runner_name === "string" && workflowJob.runner_name.length > 0
      ? workflowJob.runner_name
      : undefined;
  // Absent or malformed `private` is treated as public: the repository policy
  // fails closed rather than trusting a payload we could not read.
  const repoIsPublic = repository.private !== true;

  return {
    action: action as "queued" | "in_progress" | "completed",
    ghJobId: workflowJob.id,
    githubInstallationId,
    repo: repository.full_name,
    repoIsPublic,
    workflowName,
    labels: workflowJob.labels as string[],
    runnerName,
    conclusion,
  };
}

// Any URL this deployment publishes — the agent installer's SITE_URL, and
// everything the GitHub App Manifest flow hands to GitHub — is built from the
// deployment's own configured origin, never from the request. See
// resolveSiteUrl for why that distinction matters.
function misconfiguredSiteUrlResponse(context: string, error: string) {
  console.error(`${context}: ${error}. Check the deployment's Convex configuration.`);
  return new Response(
    "This deployment has no canonical site URL configured. Check the Convex logs and try again.",
    {
      status: 500,
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-store",
      },
    },
  );
}

http.route({
  path: "/install",
  method: "GET",
  handler: httpAction(async () => {
    // The installer bakes this origin into the machine's agent config, so it
    // has to be the deployment's own, not whatever Host the request carried.
    // Failing closed is safe for the documented `curl -fsSL … | bash`: curl
    // aborts on 5xx and pipes nothing.
    const site = resolveSiteUrl(process.env.CONVEX_SITE_URL);
    if (!site.ok) {
      return misconfiguredSiteUrlResponse("Refusing to render the agent installer", site.error);
    }

    return new Response(renderInstallScript(site.siteUrl, AGENT_RELEASE), {
      status: 200,
      headers: { "Content-Type": "text/x-shellscript; charset=utf-8" },
    });
  }),
});

// The same installer for the machines that cannot run bash. A Node may be a Windows box, and the
// role is still chosen by a parameter on the script rather than on the URL, so this handler takes
// nothing from the request either. It carries no SITE_URL: a Node reports to the customer's Hub,
// which the operator passes with -Hub, and the only thing this deployment contributes is the
// pinned digest and the verification around it.
http.route({
  path: "/install.ps1",
  method: "GET",
  handler: httpAction(async () => {
    return new Response(renderPowerShellInstallScript(AGENT_RELEASE), {
      status: 200,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }),
});

http.route({
  path: "/agents/register",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    let payload: unknown;
    try {
      payload = await request.json();
    } catch {
      return jsonResponse({ error: "Invalid JSON" }, 400);
    }

    const registration = parseRegistrationRequest(payload);
    if (registration === null) {
      return jsonResponse(
        {
          error: "Expected registrationToken, name, os, arch, and a positive integer cpus",
        },
        400,
      );
    }

    const result = await ctx.runMutation(internal.machines.registerAgent, registration);
    if (!result.ok) {
      return jsonResponse({ error: result.error }, result.status);
    }

    const convexUrl = process.env.CONVEX_CLOUD_URL;
    if (convexUrl === undefined || convexUrl.length === 0) {
      console.error("CONVEX_CLOUD_URL is not available");
      return jsonResponse({ error: "Server configuration error" }, 500);
    }
    return jsonResponse({ machineToken: result.machineToken, convexUrl }, 201);
  }),
});

// The controller API is separate from both dashboard auth and Worker tokens.
// It is a machine-to-machine seam for the long-running official scale-set
// listener; every route fails closed when CONTROLLER_TOKEN is absent.
http.route({
  path: "/controller/profiles",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const unauthorized = controllerAuthFailure(request);
    if (unauthorized !== null) return unauthorized;

    const body = await requestJson(request);
    const profile = body.ok ? parseRegisterProfile(body.payload) : null;
    if (profile === null) {
      return jsonResponse({ error: "Invalid Profile" }, 400);
    }
    await ctx.runMutation(internal.controllerApi.registerProfile, profile);
    return new Response(null, { status: 204 });
  }),
});

http.route({
  path: "/controller/attempts",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    const unauthorized = controllerAuthFailure(request);
    if (unauthorized !== null) return unauthorized;

    const profile = new URL(request.url).searchParams.get("profile")?.trim() ?? "";
    if (profile.length === 0) {
      return jsonResponse({ error: "profile is required" }, 400);
    }
    const attempts = await ctx.runQuery(internal.controllerApi.listActiveAttempts, { profile });
    return jsonResponse({ attempts }, 200);
  }),
});

http.route({
  path: "/controller/attempts",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const unauthorized = controllerAuthFailure(request);
    if (unauthorized !== null) return unauthorized;

    const body = await requestJson(request);
    const attempt = body.ok ? parseCreateAttempt(body.payload) : null;
    if (attempt === null) {
      // Never reflect this payload: a valid-looking subset can contain JIT.
      return jsonResponse({ error: "Invalid Attempt" }, 400);
    }
    try {
      await ctx.runMutation(internal.controllerApi.createAttempt, attempt);
    } catch {
      return jsonResponse({ error: "Attempt conflicts with existing state" }, 409);
    }
    return new Response(null, { status: 204 });
  }),
});

http.route({
  path: "/controller/attempts/cancel",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const unauthorized = controllerAuthFailure(request);
    if (unauthorized !== null) return unauthorized;

    const body = await requestJson(request);
    const attempt = body.ok ? parseCancelAttempt(body.payload) : null;
    if (attempt === null) {
      return jsonResponse({ error: "Invalid cancellation" }, 400);
    }
    try {
      await ctx.runMutation(internal.controllerApi.cancelAttempt, attempt);
    } catch {
      return jsonResponse({ error: "Attempt is already running" }, 409);
    }
    return new Response(null, { status: 204 });
  }),
});

http.route({
  path: "/controller/runner-cleanups",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    const unauthorized = controllerAuthFailure(request);
    if (unauthorized !== null) return unauthorized;

    const profile = new URL(request.url).searchParams.get("profile")?.trim() ?? "";
    if (profile.length === 0) return jsonResponse({ error: "profile is required" }, 400);
    const cleanups = await ctx.runQuery(internal.controllerApi.listRunnerCleanups, { profile });
    return jsonResponse({ cleanups }, 200);
  }),
});

http.route({
  path: "/controller/runner-cleanups/complete",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const unauthorized = controllerAuthFailure(request);
    if (unauthorized !== null) return unauthorized;

    const body = await requestJson(request);
    const cleanup = body.ok ? parseCompleteRunnerCleanup(body.payload) : null;
    if (cleanup === null) return jsonResponse({ error: "Invalid runner cleanup" }, 400);
    const completed = await ctx.runMutation(internal.controllerApi.completeRunnerCleanup, cleanup);
    if (!completed) return jsonResponse({ error: "Unknown runner cleanup" }, 404);
    return new Response(null, { status: 204 });
  }),
});

http.route({
  path: "/controller/jobs/started",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const unauthorized = controllerAuthFailure(request);
    if (unauthorized !== null) return unauthorized;

    const body = await requestJson(request);
    const event = body.ok ? parseJobStarted(body.payload) : null;
    if (event === null) {
      return jsonResponse({ error: "Invalid JobStarted event" }, 400);
    }
    try {
      await ctx.runMutation(internal.controllerApi.markJobStarted, event);
    } catch {
      return jsonResponse({ error: "Unknown Attempt" }, 409);
    }
    return new Response(null, { status: 204 });
  }),
});

http.route({
  path: "/controller/jobs/completed",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const unauthorized = controllerAuthFailure(request);
    if (unauthorized !== null) return unauthorized;

    const body = await requestJson(request);
    const event = body.ok ? parseJobCompleted(body.payload) : null;
    if (event === null) {
      return jsonResponse({ error: "Invalid JobCompleted event" }, 400);
    }
    try {
      await ctx.runMutation(internal.controllerApi.markJobCompleted, event);
    } catch {
      return jsonResponse({ error: "Unknown Attempt" }, 409);
    }
    return new Response(null, { status: 204 });
  }),
});

// Verify, record, acknowledge. GitHub marks any response slower than 10s as a
// failed delivery and never retries it on its own, so the handler does the
// minimum here and leaves the real work to a scheduled mutation. The delivery
// row is keyed by X-GitHub-Delivery, which also makes a redelivery a no-op.
http.route({
  path: "/github/webhook",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const rawBody = await request.arrayBuffer();
    const signature = request.headers.get("X-Hub-Signature-256") ?? "";

    // A Manifest-created App's secret outranks the environment, but both are
    // offered so deliveries keep verifying mid-migration.
    const storedSecret = await ctx.runQuery(internal.githubApp.webhookSecret, {});
    const envSecret = process.env.GITHUB_WEBHOOK_SECRET;
    const secrets = [
      ...(storedSecret === null ? [] : [storedSecret]),
      ...(envSecret !== undefined && envSecret.length > 0 ? [envSecret] : []),
    ];
    if (secrets.length === 0) {
      console.error(
        "Rejecting webhook: no secret is configured. Connect a GitHub App from the dashboard, or set GITHUB_WEBHOOK_SECRET.",
      );
      return new Response("Invalid signature", { status: 401 });
    }
    if (!(await verifySignature(secrets, rawBody, signature))) {
      return new Response("Invalid signature", { status: 401 });
    }

    const event = request.headers.get("X-GitHub-Event") ?? "";
    if (event !== "workflow_job") {
      return new Response("Ignored", { status: 200 });
    }

    const deliveryId = request.headers.get("X-GitHub-Delivery") ?? "";
    if (deliveryId.length === 0) {
      return new Response("Missing X-GitHub-Delivery", { status: 400 });
    }

    let payload: unknown;
    try {
      payload = JSON.parse(new TextDecoder().decode(rawBody)) as unknown;
    } catch {
      return new Response("Invalid JSON", { status: 400 });
    }
    const workflowJob = parseWorkflowJob(payload);
    if (workflowJob === null) {
      return new Response("Ignored", { status: 200 });
    }

    const { duplicate } = await ctx.runMutation(internal.webhooks.recordDelivery, {
      deliveryId,
      event,
      workflowJob,
    });
    return new Response(duplicate ? "Duplicate" : "Accepted", { status: 202 });
  }),
});

// The requested image label doubles as the GitHub-hosted fallback when
// GitHub offers it (ubuntu-22.04, macos-15, windows-2022, …); otherwise fall
// back to the latest hosted runner for the catalog OS.
const LATEST_HOSTED_RUNNER_BY_OS = {
  linux: "ubuntu-latest",
  mac: "macos-latest",
  win: "windows-latest",
} as const;

function defaultGitHubHostedFallback(labels: string[]) {
  const imageLabel = findImageLabel(labels);
  if (imageLabel !== undefined && /^(ubuntu|macos|windows)-\d/.test(imageLabel)) {
    return imageLabel;
  }
  const os = imageLabel === undefined ? "linux" : IMAGE_CATALOG[imageLabel].os;
  return LATEST_HOSTED_RUNNER_BY_OS[os];
}

// Capacity probe for drop-in fallback. A cheap "router" job calls this and
// routes the real job to self-hosted labels or a GitHub-hosted fallback:
//   GET /runs-on?labels=rc-linux&fallback=ubuntu-latest
// → {"runs-on": ["self-hosted","rc-linux"]} or {"runs-on": "ubuntu-latest"}
// The fallback defaults to the requested image label when GitHub hosts it
// (e.g. macos-15), else the latest hosted runner for that OS.
// Read-only, unauthenticated by design: it leaks only "capacity yes/no".
http.route({
  path: "/runs-on",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    const url = new URL(request.url);
    const labels = (url.searchParams.get("labels") ?? "")
      .split(",")
      .map((label) => label.trim())
      .filter((label) => label.length > 0);
    if (labels.length === 0) {
      return jsonResponse({ error: "labels is required" }, 400);
    }
    const fallback = url.searchParams.get("fallback") ?? defaultGitHubHostedFallback(labels);

    const selfHostedLabels = labels.includes("self-hosted") ? labels : ["self-hosted", ...labels];
    const available = await ctx.runQuery(internal.machines.hasCapacity, {
      labels: selfHostedLabels,
    });
    return jsonResponse({ "runs-on": available ? selfHostedLabels : fallback }, 200);
  }),
});

// Step 1 of the GitHub App Manifest flow. The dashboard mints a single-use
// state and sends the operator here; GitHub only accepts a manifest as a form
// POST, so this returns a self-submitting form rather than a redirect.
http.route({
  path: "/github/app/new",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    const site = resolveSiteUrl(process.env.CONVEX_SITE_URL);
    if (!site.ok) {
      return misconfiguredSiteUrlResponse("Refusing to build a GitHub App manifest", site.error);
    }

    const url = new URL(request.url);
    const state = url.searchParams.get("state") ?? "";
    const org = url.searchParams.get("org") ?? undefined;

    const stateStatus = await ctx.runQuery(internal.githubApp.setupStateStatus, { state });
    if (stateStatus !== "valid") {
      return new Response(describeSetupState(stateStatus), {
        status: 400,
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "Cache-Control": "no-store",
        },
      });
    }

    return new Response(renderManifestForm(site.siteUrl, state, org), {
      status: 200,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
      },
    });
  }),
});

const SETUP_ERROR_REASON: Record<Exclude<SetupStateStatus, "valid">, string> = {
  unknown: "state_unknown",
  consumed: "state_consumed",
  expired: "state_expired",
};

// Step 3 of the Manifest flow: exchange the temporary code for the App's id,
// client id, private key, and webhook secret, then hand the operator back to
// the dashboard. The code is single-use and expires one hour after step 1.
http.route({
  path: "/github/app/callback",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    // Resolved before the state is consumed: a misconfigured deployment must
    // not burn the operator's single-use setup state on a request it cannot
    // finish, and the redirect target itself has to be trusted.
    const site = resolveSiteUrl(process.env.CONVEX_SITE_URL);
    if (!site.ok) {
      return misconfiguredSiteUrlResponse("Cannot complete GitHub App setup", site.error);
    }

    const url = new URL(request.url);
    const dashboard = (params: string) =>
      new Response(null, {
        status: 302,
        headers: { Location: `${site.siteUrl}/?${params}`, "Cache-Control": "no-store" },
      });

    const code = url.searchParams.get("code") ?? "";
    const state = url.searchParams.get("state") ?? "";
    if (code.length === 0) {
      return dashboard("setup=error&reason=missing_code");
    }

    const stateStatus = await ctx.runMutation(internal.githubApp.consumeSetupState, { state });
    if (stateStatus !== "valid") {
      return dashboard(`setup=error&reason=${SETUP_ERROR_REASON[stateStatus]}`);
    }

    const response = await fetch(
      `https://api.github.com/app-manifests/${encodeURIComponent(code)}/conversions`,
      {
        method: "POST",
        headers: {
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "erainfra",
        },
      },
    );
    if (!response.ok) {
      // Status only: a conversion response body carries the private key and
      // webhook secret, so it must never reach the logs.
      console.error(
        `GitHub App manifest conversion failed with HTTP ${response.status}. The setup code is single-use and expires one hour after it is issued; start again from the dashboard.`,
      );
      return dashboard("setup=error&reason=conversion_failed");
    }

    let payload: unknown = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }
    const credentials = parseManifestConversion(payload);
    if (credentials === null) {
      console.error("GitHub App manifest conversion returned unexpected fields");
      return dashboard("setup=error&reason=conversion_failed");
    }

    await ctx.runMutation(internal.githubApp.store, credentials);
    return dashboard("setup=created");
  }),
});

export default http;
