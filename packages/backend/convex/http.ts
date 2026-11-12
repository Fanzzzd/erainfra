import { registerStaticRoutes } from "@convex-dev/static-hosting";
import { httpRouter } from "convex/server";

import { components, internal } from "./_generated/api";
import { httpAction } from "./_generated/server";
import { AGENT_RELEASE } from "./agentRelease";
import { auth } from "./auth";
import { findImageLabel, IMAGE_CATALOG } from "./catalog";
import { mintInstallationToken } from "./controllerGithubToken";
import {
  controllerAuthorization,
  LEASE_EPOCH_HEADER,
  parseCancelAttempt,
  parseCompleteRunnerCleanup,
  parseControllerHeartbeat,
  parseCreateAttempt,
  parseGitHubTokenRequest,
  parseJobCompleted,
  parseJobsAcquired,
  parseRunnerlessJobCompleted,
  parseJobStarted,
  parseLeaseEpoch,
  parseLeaseRequest,
  parseRegisterProfile,
} from "./controllerHttp";
import { LEASE_LOST_STATUS, refusalOf, type ControllerCaller } from "./controllerLease";

/** A Worker's machine token: 32 hex characters (machines.ts, apps/action-runner-agent/config.ts). */
const MACHINE_TOKEN_PATTERN = /^[0-9a-f]{32}$/i;
import {
  describeSetupState,
  parseManifestConversion,
  renderManifestForm,
  resolveSiteUrl,
  type SetupStateStatus,
} from "./githubAppConfig";
import { registerDeployRoutes } from "./infra/deployHttp";
import { parsePush, webhookSecretsFor } from "./infra/githubDeploy";
import { registerNodeRoutes } from "./infra/nodeHttp";
import { registerInfraRoutes } from "./infra/operatorRoutes";
import { registerRelayRoutes } from "./infra/relayAccess";
import { renderInstallScript } from "./installScript";
import { renderWindowsInstallScript } from "./installScriptPowerShell";
import { METRICS_CONTENT_TYPE } from "./metricsFormat";
import { authenticateBearer, registerOperatorRoutes } from "./operatorHttp";
import { registerTestRoutes } from "./operatorTestsHttp";
import { recordRouterDecision } from "./routerDecisions";

const http = httpRouter();
auth.addHttpRoutes(http);
registerStaticRoutes(http, components.staticHosting);
// The operator API under /api/v1, for the `erainfra` CLI (operatorHttp.ts), and its App
// deployment routes (infra/deployHttp.ts) and infrastructure-management routes (Nodes, Apps, env,
// links, log tails: infra/operatorRoutes.ts).
registerOperatorRoutes(http);
// JUnit results: GET /api/v1/tests and /api/v1/tests/flaky (operatorTestsHttp.ts).
registerTestRoutes(http);
registerDeployRoutes(http);
registerInfraRoutes(http);
registerNodeRoutes(http);
// POST /api/v1/relay/access, asked by a fleet relay before it relays for a client
// (infra/relayAccess.ts, deploy/infra/relay.sh).
registerRelayRoutes(http);

function jsonResponse(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

type ResolvedController =
  | { failure: Response }
  | { failure: null; caller: ControllerCaller; slot: "current" | "next" | "machine" };

/**
 * Who is calling a controller route. The shared CONTROLLER_TOKEN (or CONTROLLER_TOKEN_NEXT) is
 * checked here, in constant time. A bearer shaped like a Worker's machine token is passed on as a
 * machine caller and checked inside the mutation, together with the lease, because a machine token
 * is a controller credential only while its Worker holds the Profile's lease (ADR 0014). The lease
 * epoch rides in a header on every request once the controller holds the lease.
 */
function controllerCaller(request: Request): ResolvedController {
  const epoch = parseLeaseEpoch(request.headers.get(LEASE_EPOCH_HEADER));
  if (epoch === null) {
    return { failure: jsonResponse({ error: "Invalid lease epoch" }, 400) };
  }
  const authorization = request.headers.get("Authorization");
  const verdict = controllerAuthorization(
    authorization,
    process.env.CONTROLLER_TOKEN,
    process.env.CONTROLLER_TOKEN_NEXT,
  );
  if (verdict.status === "ok") {
    return {
      failure: null,
      caller: {
        kind: "controllerToken",
        slot: verdict.slot,
        ...(epoch === undefined ? {} : { epoch }),
      },
      slot: verdict.slot,
    };
  }
  const bearer = authorization?.startsWith("Bearer ") ? authorization.slice("Bearer ".length) : "";
  if (MACHINE_TOKEN_PATTERN.test(bearer)) {
    return {
      failure: null,
      caller: { kind: "machine", token: bearer, ...(epoch === undefined ? {} : { epoch }) },
      slot: "machine",
    };
  }
  if (verdict.status === "not-configured") {
    console.error("Controller API refused a request because CONTROLLER_TOKEN is not configured");
    return { failure: jsonResponse({ error: "Controller API is not configured" }, 503) };
  }
  return { failure: jsonResponse({ error: "Unauthorized" }, 401) };
}

/**
 * The response for a refused lease or credential, or null for any other error. A stale epoch gets
 * its own status, 412, which the controller reads as "you no longer hold this Profile": it closes
 * its session and goes back to standing by.
 */
function controllerRefusal(error: unknown) {
  const refusal = refusalOf(error);
  if (refusal === "lease") {
    return jsonResponse(
      { error: "This controller does not hold the Profile's lease", code: "lease-lost" },
      LEASE_LOST_STATUS,
    );
  }
  if (refusal === "unauthorized") return jsonResponse({ error: "Unauthorized" }, 401);
  if (refusal === "forbidden") {
    return jsonResponse({ error: "This credential may not do that" }, 403);
  }
  return null;
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

// The same installer for the machines that cannot run bash, and — since #49 — for both roles, the
// way /install carries both. The role is still chosen by a parameter on the script rather than on
// the URL, so this handler also takes nothing from the request.
//
// It resolves the site URL where it used to render without one. A Node genuinely needs no SITE_URL,
// because it reports to the customer's Hub; a Worker bakes this deployment's origin into its own
// configuration exactly as the bash installer does. Failing closed therefore now covers a Node
// install too — which is the right trade, because a deployment with no canonical origin cannot
// serve a working Worker command from its dashboard either.
http.route({
  path: "/install.ps1",
  method: "GET",
  handler: httpAction(async () => {
    const site = resolveSiteUrl(process.env.CONVEX_SITE_URL);
    if (!site.ok) {
      return misconfiguredSiteUrlResponse("Refusing to render the Windows installer", site.error);
    }

    return new Response(renderWindowsInstallScript(site.siteUrl, AGENT_RELEASE), {
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

// The controller API is separate from dashboard auth. It is a machine-to-machine seam for the
// long-running official scale-set listener. A controller authenticates with the shared
// CONTROLLER_TOKEN (or CONTROLLER_TOKEN_NEXT) on a dedicated host, or with its Worker's machine
// token on a Worker; the second is valid only while that Worker holds the Profile's lease. Every
// route that reads or writes a Profile's state checks the lease epoch the request carries
// (controllerLease.ts) and answers 412 to a stale one.

// The lease routes (ADR 0014). A controller asks for the lease, renews it every 10 s while it
// serves, and releases it when it stops. The answers carry the timings, so the constants live in
// controllerLease.ts alone.
http.route({
  path: "/controller/lease/acquire",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const resolved = controllerCaller(request);
    if (resolved.failure !== null) return resolved.failure;
    const body = await requestJson(request);
    const lease = body.ok ? parseLeaseRequest(body.payload) : null;
    if (lease === null) return jsonResponse({ error: "Invalid lease request" }, 400);
    try {
      const result = await ctx.runMutation(internal.controllerLease.acquire, {
        ...lease,
        caller: resolved.caller,
      });
      return jsonResponse(result, 200);
    } catch (error) {
      const refused = controllerRefusal(error);
      if (refused !== null) return refused;
      throw error;
    }
  }),
});

http.route({
  path: "/controller/lease/renew",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const resolved = controllerCaller(request);
    if (resolved.failure !== null) return resolved.failure;
    const body = await requestJson(request);
    const lease = body.ok ? parseLeaseRequest(body.payload) : null;
    if (lease === null) return jsonResponse({ error: "Invalid lease request" }, 400);
    try {
      const result = await ctx.runMutation(internal.controllerLease.renew, {
        profile: lease.profile,
        instance: lease.instance,
        caller: resolved.caller,
      });
      return jsonResponse(result, 200);
    } catch (error) {
      const refused = controllerRefusal(error);
      if (refused !== null) return refused;
      throw error;
    }
  }),
});

http.route({
  path: "/controller/lease/release",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const resolved = controllerCaller(request);
    if (resolved.failure !== null) return resolved.failure;
    const body = await requestJson(request);
    const lease = body.ok ? parseLeaseRequest(body.payload) : null;
    if (lease === null) return jsonResponse({ error: "Invalid lease request" }, 400);
    await ctx.runMutation(internal.controllerLease.release, {
      profile: lease.profile,
      instance: lease.instance,
      caller: resolved.caller,
    });
    return new Response(null, { status: 204 });
  }),
});

// A one-hour GitHub App installation token for the lease holder, scoped to the Profile's repository
// or organization (controllerGithubToken.ts). The App's private key never leaves this deployment.
http.route({
  path: "/controller/github-token",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const resolved = controllerCaller(request);
    if (resolved.failure !== null) return resolved.failure;
    const body = await requestJson(request);
    const wanted = body.ok ? parseGitHubTokenRequest(body.payload) : null;
    if (wanted === null) return jsonResponse({ error: "Invalid token request" }, 400);
    let target: { githubConfigUrl: string; cacheFacts: boolean } | null;
    try {
      target = await ctx.runQuery(internal.controllerLease.githubTokenTarget, {
        profile: wanted.profile,
        caller: resolved.caller,
      });
    } catch (error) {
      const refused = controllerRefusal(error);
      if (refused !== null) return refused;
      throw error;
    }
    if (target === null) {
      return jsonResponse({ error: "The Profile has no GitHub config URL registered" }, 409);
    }
    const clientId = process.env.CONTROLLER_GITHUB_APP_CLIENT_ID?.trim() ?? "";
    const privateKey = process.env.CONTROLLER_GITHUB_APP_PRIVATE_KEY?.trim() ?? "";
    if (clientId.length === 0 || privateKey.length === 0) {
      return jsonResponse(
        {
          error:
            "This deployment holds no controller GitHub App; set CONTROLLER_GITHUB_APP_CLIENT_ID and CONTROLLER_GITHUB_APP_PRIVATE_KEY",
        },
        503,
      );
    }
    const minted = await mintInstallationToken({
      clientId,
      privateKey,
      githubConfigUrl: target.githubConfigUrl,
      // The operator registered whether this Profile publishes cache facts. A Worker cannot
      // widen its repository permissions merely by asking for those reads.
      cacheFacts: wanted.cacheFacts && target.cacheFacts,
      now: Date.now(),
      fetch: (input, init) => fetch(input, init),
    });
    if (!minted.ok) {
      console.error(`Controller GitHub token for ${wanted.profile}: ${minted.error}`);
      return jsonResponse({ error: minted.error }, minted.status);
    }
    // Signing and GitHub's API calls run outside a transaction. Recheck after them: a lease that
    // expired during minting must not deliver credentials to its former holder.
    try {
      await ctx.runQuery(internal.controllerLease.githubTokenTarget, {
        profile: wanted.profile,
        caller: resolved.caller,
      });
    } catch (error) {
      const refused = controllerRefusal(error);
      if (refused !== null) return refused;
      throw error;
    }
    return new Response(JSON.stringify({ token: minted.token, expiresAt: minted.expiresAt }), {
      status: 200,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    });
  }),
});

http.route({
  path: "/controller/profiles",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const resolved = controllerCaller(request);
    if (resolved.failure !== null) return resolved.failure;

    const body = await requestJson(request);
    const profile = body.ok ? parseRegisterProfile(body.payload) : null;
    if (profile === null) {
      return jsonResponse({ error: "Invalid Profile" }, 400);
    }
    let result;
    try {
      result = await ctx.runMutation(internal.controllerApi.registerProfile, {
        ...profile,
        caller: resolved.caller,
      });
    } catch (error) {
      const refused = controllerRefusal(error);
      if (refused !== null) return refused;
      throw error;
    }
    if (result !== null) return jsonResponse({ error: result.conflict }, 409);
    return new Response(null, { status: 204 });
  }),
});

// A controller reports every 30 s and on every session change. This is the only signal that tells
// a dead controller from an idle fleet: a controller that is gone creates no Attempts at all.
http.route({
  path: "/controller/heartbeat",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const resolved = controllerCaller(request);
    if (resolved.failure !== null) return resolved.failure;

    const body = await requestJson(request);
    const heartbeat = body.ok ? parseControllerHeartbeat(body.payload) : null;
    if (
      heartbeat === null ||
      // A holder reports the epoch it holds in the body and fences with it in the header. They
      // must agree, or the report would describe one grant while being checked against another.
      (heartbeat.leaseRole === "holder" && heartbeat.leaseEpoch !== resolved.caller.epoch)
    ) {
      return jsonResponse({ error: "Invalid heartbeat" }, 400);
    }
    try {
      await ctx.runMutation(internal.controllerApi.recordHeartbeat, {
        ...heartbeat,
        tokenSlot: resolved.slot,
        caller: resolved.caller,
      });
    } catch (error) {
      const refused = controllerRefusal(error);
      if (refused !== null) return refused;
      throw error;
    }
    return new Response(null, { status: 204 });
  }),
});

http.route({
  path: "/controller/profiles/pause",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const resolved = controllerCaller(request);
    if (resolved.failure !== null) return resolved.failure;

    const body = await requestJson(request);
    const name =
      body.ok &&
      typeof body.payload === "object" &&
      body.payload !== null &&
      typeof (body.payload as { name?: unknown }).name === "string"
        ? (body.payload as { name: string }).name.trim()
        : "";
    if (!/^[A-Za-z0-9_.-]{1,64}$/.test(name)) {
      return jsonResponse({ error: "Invalid Profile" }, 400);
    }
    let found: boolean;
    try {
      found = await ctx.runMutation(internal.controllerApi.pauseProfile, {
        name,
        caller: resolved.caller,
      });
    } catch (error) {
      const refused = controllerRefusal(error);
      if (refused !== null) return refused;
      throw error;
    }
    return found
      ? new Response(null, { status: 204 })
      : jsonResponse({ error: "Unknown Profile" }, 404);
  }),
});

http.route({
  path: "/controller/attempts",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    const resolved = controllerCaller(request);
    if (resolved.failure !== null) return resolved.failure;

    const profile = new URL(request.url).searchParams.get("profile")?.trim() ?? "";
    if (profile.length === 0) {
      return jsonResponse({ error: "profile is required" }, 400);
    }
    try {
      const attempts = await ctx.runQuery(internal.controllerApi.listActiveAttempts, {
        profile,
        caller: resolved.caller,
      });
      return jsonResponse({ attempts }, 200);
    } catch (error) {
      const refused = controllerRefusal(error);
      if (refused !== null) return refused;
      throw error;
    }
  }),
});

http.route({
  path: "/controller/attempts",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const resolved = controllerCaller(request);
    if (resolved.failure !== null) return resolved.failure;

    const body = await requestJson(request);
    const attempt = body.ok ? parseCreateAttempt(body.payload) : null;
    if (attempt === null) {
      // Never reflect this payload: a valid-looking subset can contain JIT.
      return jsonResponse({ error: "Invalid Attempt" }, 400);
    }
    try {
      await ctx.runMutation(internal.controllerApi.createAttempt, {
        ...attempt,
        caller: resolved.caller,
      });
    } catch (error) {
      return (
        controllerRefusal(error) ??
        jsonResponse({ error: "Attempt conflicts with existing state" }, 409)
      );
    }
    return new Response(null, { status: 204 });
  }),
});

http.route({
  path: "/controller/attempts/cancel",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const resolved = controllerCaller(request);
    if (resolved.failure !== null) return resolved.failure;

    const body = await requestJson(request);
    const attempt = body.ok ? parseCancelAttempt(body.payload) : null;
    if (attempt === null) {
      return jsonResponse({ error: "Invalid cancellation" }, 400);
    }
    try {
      await ctx.runMutation(internal.controllerApi.cancelAttempt, {
        ...attempt,
        caller: resolved.caller,
      });
    } catch (error) {
      return controllerRefusal(error) ?? jsonResponse({ error: "Attempt is already running" }, 409);
    }
    return new Response(null, { status: 204 });
  }),
});

http.route({
  path: "/controller/runner-cleanups",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    const resolved = controllerCaller(request);
    if (resolved.failure !== null) return resolved.failure;

    const profile = new URL(request.url).searchParams.get("profile")?.trim() ?? "";
    if (profile.length === 0) return jsonResponse({ error: "profile is required" }, 400);
    try {
      const cleanups = await ctx.runQuery(internal.controllerApi.listRunnerCleanups, {
        profile,
        caller: resolved.caller,
      });
      return jsonResponse({ cleanups }, 200);
    } catch (error) {
      const refused = controllerRefusal(error);
      if (refused !== null) return refused;
      throw error;
    }
  }),
});

http.route({
  path: "/controller/runner-cleanups/complete",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const resolved = controllerCaller(request);
    if (resolved.failure !== null) return resolved.failure;

    const body = await requestJson(request);
    const cleanup = body.ok ? parseCompleteRunnerCleanup(body.payload) : null;
    if (cleanup === null) return jsonResponse({ error: "Invalid runner cleanup" }, 400);
    let completed: boolean;
    try {
      completed = await ctx.runMutation(internal.controllerApi.completeRunnerCleanup, {
        ...cleanup,
        caller: resolved.caller,
      });
    } catch (error) {
      const refused = controllerRefusal(error);
      if (refused !== null) return refused;
      throw error;
    }
    if (!completed) return jsonResponse({ error: "Unknown runner cleanup" }, 404);
    return new Response(null, { status: 204 });
  }),
});

// Jobs the controller acquired, with the workflow run each waits in (strandedJobs.ts). A
// controller that predates this route never calls it; one that calls an older deployment gets a
// 404 and only logs it.
http.route({
  path: "/controller/jobs/acquired",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const resolved = controllerCaller(request);
    if (resolved.failure !== null) return resolved.failure;

    const body = await requestJson(request);
    const report = body.ok ? parseJobsAcquired(body.payload) : null;
    if (report === null) return jsonResponse({ error: "Invalid acquired jobs report" }, 400);
    try {
      await ctx.runMutation(internal.controllerApi.recordJobsAcquired, {
        ...report,
        caller: resolved.caller,
      });
    } catch (error) {
      return controllerRefusal(error) ?? jsonResponse({ error: "Unknown Profile" }, 409);
    }
    return new Response(null, { status: 204 });
  }),
});

http.route({
  path: "/controller/jobs/started",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const resolved = controllerCaller(request);
    if (resolved.failure !== null) return resolved.failure;

    const body = await requestJson(request);
    const event = body.ok ? parseJobStarted(body.payload) : null;
    if (event === null) {
      return jsonResponse({ error: "Invalid JobStarted event" }, 400);
    }
    try {
      await ctx.runMutation(internal.controllerApi.markJobStarted, {
        ...event,
        caller: resolved.caller,
      });
    } catch (error) {
      return controllerRefusal(error) ?? jsonResponse({ error: "Unknown Attempt" }, 409);
    }
    return new Response(null, { status: 204 });
  }),
});

http.route({
  path: "/controller/jobs/completed",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const resolved = controllerCaller(request);
    if (resolved.failure !== null) return resolved.failure;

    const body = await requestJson(request);
    const runnerless = body.ok ? parseRunnerlessJobCompleted(body.payload) : null;
    if (runnerless !== null) {
      // A job cancelled before any Runner took it: nothing to record, but the caller must still
      // hold the Profile's lease, so a stale holder learns it lost it here as on every write.
      try {
        await ctx.runMutation(internal.controllerApi.acknowledgeRunnerlessJobCompleted, {
          ...runnerless,
          caller: resolved.caller,
        });
      } catch (error) {
        return controllerRefusal(error) ?? jsonResponse({ error: "Unknown Profile" }, 409);
      }
      return new Response(null, { status: 204 });
    }
    const event = body.ok ? parseJobCompleted(body.payload) : null;
    if (event === null) {
      return jsonResponse({ error: "Invalid JobCompleted event" }, 400);
    }
    try {
      await ctx.runMutation(internal.controllerApi.markJobCompleted, {
        ...event,
        caller: resolved.caller,
      });
    } catch (error) {
      return controllerRefusal(error) ?? jsonResponse({ error: "Unknown Attempt" }, 409);
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

    // One secret per purpose (infra/githubDeploy.ts, webhookSecretsFor): the event type picks the
    // secrets before anything is verified, so a holder of the CI App's secret cannot sign a push
    // that deploys, and a holder of the deploy App's secret cannot queue a job. A Manifest-created
    // CI App's secret outranks the environment, but both are offered so deliveries keep verifying
    // mid-migration.
    const event = request.headers.get("X-GitHub-Event") ?? "";
    const storedSecret = await ctx.runQuery(internal.githubApp.webhookSecret, {});
    const secrets = webhookSecretsFor(event, {
      ciStored: storedSecret,
      ciEnv: process.env.GITHUB_WEBHOOK_SECRET,
      deploy: process.env.ERAINFRA_GH_WEBHOOK_SECRET,
    });
    if (secrets.length === 0) {
      console.error(
        event === "push"
          ? "Rejecting push webhook: ERAINFRA_GH_WEBHOOK_SECRET is not set (docs/infra-management.md, Push-to-deploy)."
          : "Rejecting webhook: no secret is configured. Connect a GitHub App from the dashboard, or set GITHUB_WEBHOOK_SECRET.",
      );
      return new Response("Invalid signature", { status: 401 });
    }
    if (!(await verifySignature(secrets, rawBody, signature))) {
      return new Response("Invalid signature", { status: 401 });
    }

    if (event !== "workflow_job" && event !== "push") {
      return new Response("Ignored", { status: 200 });
    }

    const deliveryId = request.headers.get("X-GitHub-Delivery") ?? "";
    if (deliveryId.length === 0 || deliveryId.length > 200) {
      return new Response("Missing X-GitHub-Delivery", { status: 400 });
    }

    let payload: unknown;
    try {
      payload = JSON.parse(new TextDecoder().decode(rawBody)) as unknown;
    } catch {
      return new Response("Invalid JSON", { status: 400 });
    }

    // Push-to-deploy (infra/git.ts). The delivery row and the run it queues commit together,
    // keyed by X-GitHub-Delivery, so a redelivery deploys nothing a second time.
    if (event === "push") {
      const push = parsePush(payload);
      if (push === null) return new Response("Ignored", { status: 200 });
      const accepted = await ctx.runMutation(internal.infra.git.acceptPush, {
        deliveryId,
        ...push,
      });
      return new Response(accepted.outcome === "duplicate" ? "Duplicate" : "Accepted", {
        status: 202,
      });
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

const HOSTED_RUNNER_BY_EXECUTOR = {
  docker: "ubuntu-latest",
  firecracker: "ubuntu-latest",
  tart: "macos-latest",
  hyperv: "windows-latest",
} as const;

// A runs-on label as GitHub-hosted, larger-runner and scale-set names spell
// them. The probe echoes `fallback` back, so it accepts nothing else.
const RUNS_ON_LABEL = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
// The optional `repo=OWNER/NAME` the router stores with each decision, in GitHub's name alphabet.
const RUNS_ON_REPO = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/;

function runsOnResponse(label: string | string[]) {
  return new Response(JSON.stringify({ "runs-on": label }), {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      // The answer is only true now; no proxy or client may reuse it.
      "Cache-Control": "no-store",
    },
  });
}

// Capacity probe for drop-in fallback. A router job at the top of a workflow
// calls it and sends the real jobs to the fleet or to a GitHub-hosted fallback:
//   GET /runs-on?profile=rc-linux-js&fallback=ubuntu-24.04
// → {"runs-on": "rc-linux-js"} or {"runs-on": "ubuntu-24.04"}
// The Profile is the answer when a job sent to it now would start without
// waiting (routing.profileRoute has the rule). `fallback` defaults to the
// latest GitHub-hosted runner for the Profile's OS.
//
// Unauthenticated on purpose. A router job runs on pull requests from forks,
// which receive no secrets, so a token here would either be missing exactly
// when routing matters or have to be committed to the workflow. The response
// is one label, the Profile's own name or the caller's fallback, so an
// anonymous caller learns only whether that Profile has room now. The probe
// makes no GitHub API call, so callers cannot spend the App's rate limit, and
// its reads are index-bounded by live work and Worker count. Fallback reasons
// go to the deployment log, not to the caller. Each answer is stored as a
// routerDecisions row, with the optional `repo=OWNER/NAME` the caller sent.
//
// The legacy form `?labels=rc-linux[,…]` still answers from the pre-Profile
// `machines`/`jobs` path (machines.hasCapacity), which webhook-intake jobs
// still use.
http.route({
  path: "/runs-on",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    const url = new URL(request.url);
    const repo = url.searchParams.get("repo") ?? undefined;
    if (repo !== undefined && !RUNS_ON_REPO.test(repo)) {
      return jsonResponse({ error: "repo must be OWNER/NAME" }, 400);
    }
    const profile = url.searchParams.get("profile");
    if (profile !== null) {
      if (url.searchParams.has("labels")) {
        return jsonResponse({ error: "use either profile or labels, not both" }, 400);
      }
      const fallbackParam = url.searchParams.get("fallback");
      if (!RUNS_ON_LABEL.test(profile)) {
        return jsonResponse({ error: "profile is not a valid runs-on label" }, 400);
      }
      if (fallbackParam !== null && !RUNS_ON_LABEL.test(fallbackParam)) {
        return jsonResponse({ error: "fallback is not a valid runs-on label" }, 400);
      }
      const decision = await ctx.runQuery(internal.routing.profileRoute, { profile });
      if (decision.route === "profile") {
        await recordRouterDecision(ctx, { profile, answer: profile, route: "profile", repo });
        return runsOnResponse(profile);
      }
      const fallback =
        fallbackParam ?? HOSTED_RUNNER_BY_EXECUTOR[decision.executor ?? "firecracker"];
      console.info(`/runs-on: Profile ${profile} → ${fallback} (${decision.reason})`);
      await recordRouterDecision(ctx, {
        profile,
        answer: fallback,
        route: "fallback",
        reason: decision.reason,
        repo,
      });
      return runsOnResponse(fallback);
    }

    const labels = (url.searchParams.get("labels") ?? "")
      .split(",")
      .map((label) => label.trim())
      .filter((label) => label.length > 0);
    if (labels.length === 0) {
      return jsonResponse({ error: "profile or labels is required" }, 400);
    }
    const fallback = url.searchParams.get("fallback") ?? defaultGitHubHostedFallback(labels);

    const selfHostedLabels = labels.includes("self-hosted") ? labels : ["self-hosted", ...labels];
    const available = await ctx.runQuery(internal.machines.hasCapacity, {
      labels: selfHostedLabels,
    });
    const answer = available ? selfHostedLabels : fallback;
    await recordRouterDecision(ctx, {
      labels: selfHostedLabels,
      answer,
      route: available ? "profile" : "fallback",
      repo,
    });
    return jsonResponse({ "runs-on": answer }, 200);
  }),
});

// Prometheus scrape endpoint. Authenticated with a dashboard-minted API token of any scope
// (apiTokens.ts); a `metrics` token can do nothing else. The exposition names every Worker and
// Profile, which is fleet inventory, not public data. A refusal says nothing about why, so a
// revoked token and a guessed one look the same.
function metricsUnauthorized() {
  return new Response("Unauthorized\n", {
    status: 401,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "WWW-Authenticate": 'Bearer realm="erainfra-metrics"',
      "Cache-Control": "no-store",
    },
  });
}

http.route({
  path: "/metrics",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    const scraper = await authenticateBearer(ctx, request, "metrics");
    if (!scraper.ok) return metricsUnauthorized();
    return new Response(await ctx.runQuery(internal.metrics.exposition, {}), {
      status: 200,
      headers: { "Content-Type": METRICS_CONTENT_TYPE, "Cache-Control": "no-store" },
    });
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
