import { registerStaticRoutes } from "@convex-dev/static-hosting";
import { httpRouter } from "convex/server";
import { auth } from "./auth";
import { components, internal } from "./_generated/api";
import { httpAction } from "./_generated/server";
import { renderManifestForm } from "./githubApp";
import { renderInstallScript } from "./installScript";

const http = httpRouter();
auth.addHttpRoutes(http);
registerStaticRoutes(http, components.staticHosting);

function jsonResponse(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

function bytesToHex(bytes: Uint8Array) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
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

async function verifySignature(
  secret: string,
  rawBody: ArrayBuffer,
  signature: string,
) {
  const match = /^sha256=([0-9a-f]{64})$/i.exec(signature);
  if (match === null) {
    return false;
  }

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = await crypto.subtle.sign("HMAC", key, rawBody);
  return timingSafeHexEqual(
    bytesToHex(new Uint8Array(digest)),
    match[1].toLowerCase(),
  );
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

  let labels: string[] | undefined;
  if (payload.labels !== undefined) {
    if (
      !Array.isArray(payload.labels) ||
      !payload.labels.every((label) => typeof label === "string")
    ) {
      return null;
    }
    labels = payload.labels
      .map((label) => label.trim())
      .filter((label) => label.length > 0);
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
    labels,
    maxSlots,
  };
}

function parseWorkflowJob(payload: unknown) {
  if (!isRecord(payload)) {
    return null;
  }
  const action = payload.action;
  if (
    action !== "queued" &&
    action !== "in_progress" &&
    action !== "completed"
  ) {
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
    typeof workflowJob.conclusion === "string"
      ? workflowJob.conclusion
      : undefined;

  return {
    action: action as "queued" | "in_progress" | "completed",
    ghJobId: workflowJob.id,
    githubInstallationId,
    repo: repository.full_name,
    workflowName,
    labels: workflowJob.labels as string[],
    conclusion,
  };
}

function parseManifestConversion(payload: unknown) {
  if (!isRecord(payload)) {
    return null;
  }
  const { id, slug, name, pem, webhook_secret: webhookSecret, html_url: htmlUrl } =
    payload;
  if (
    typeof id !== "number" ||
    !Number.isSafeInteger(id) ||
    id <= 0 ||
    typeof slug !== "string" ||
    slug.length === 0 ||
    typeof name !== "string" ||
    typeof pem !== "string" ||
    pem.length === 0 ||
    typeof webhookSecret !== "string" ||
    webhookSecret.length === 0 ||
    typeof htmlUrl !== "string"
  ) {
    return null;
  }
  return { appId: id, slug, name, privateKey: pem, webhookSecret, htmlUrl };
}

http.route({
  path: "/install",
  method: "GET",
  handler: httpAction(async (_ctx, request) => {
    const siteUrl = new URL(request.url).origin;
    return new Response(renderInstallScript(siteUrl), {
      status: 200,
      headers: { "Content-Type": "text/x-shellscript; charset=utf-8" },
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
          error:
            "Expected registrationToken, name, os, arch, and a positive integer cpus",
        },
        400,
      );
    }

    const result = await ctx.runMutation(
      internal.machines.registerAgent,
      registration,
    );
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

http.route({
  path: "/github/webhook",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const rawBody = await request.arrayBuffer();
    const signature = request.headers.get("X-Hub-Signature-256") ?? "";

    // Manifest-created App first, then the legacy env var for PAT and
    // hand-registered App setups.
    const storedSecret = await ctx.runQuery(internal.githubApp.webhookSecret, {});
    const envSecret = process.env.GITHUB_WEBHOOK_SECRET;
    const secret =
      storedSecret ??
      (envSecret !== undefined && envSecret.length > 0 ? envSecret : undefined);
    if (secret === undefined) {
      console.error("No webhook secret is configured");
      return new Response("Invalid signature", { status: 401 });
    }
    if (!(await verifySignature(secret, rawBody, signature))) {
      return new Response("Invalid signature", { status: 401 });
    }

    if (request.headers.get("X-GitHub-Event") !== "workflow_job") {
      return new Response("Ignored", { status: 200 });
    }

    let payload: unknown;
    try {
      payload = JSON.parse(new TextDecoder().decode(rawBody)) as unknown;
    } catch {
      return new Response("Invalid JSON", { status: 400 });
    }
    const event = parseWorkflowJob(payload);
    if (event === null) {
      return new Response("Ignored", { status: 200 });
    }

    await ctx.runMutation(internal.jobs.handleWorkflowJob, event);
    return new Response("OK", { status: 200 });
  }),
});

// Capacity probe for drop-in fallback. A cheap "router" job calls this and
// routes the real job to self-hosted labels or a GitHub-hosted fallback:
//   GET /runs-on?labels=rc-linux&fallback=ubuntu-latest
// → {"runs-on": ["self-hosted","rc-linux"]} or {"runs-on": "ubuntu-latest"}
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
    const fallback = url.searchParams.get("fallback") ?? "ubuntu-latest";
    if (labels.length === 0) {
      return jsonResponse({ error: "labels is required" }, 400);
    }

    const selfHostedLabels = labels.includes("self-hosted")
      ? labels
      : ["self-hosted", ...labels];
    const available = await ctx.runQuery(internal.machines.hasCapacity, {
      labels: selfHostedLabels,
    });
    return jsonResponse(
      { "runs-on": available ? selfHostedLabels : fallback },
      200,
    );
  }),
});

// Step 1 of the GitHub App Manifest flow. The dashboard mints a single-use
// state and sends the operator here; GitHub only accepts the manifest as a
// form POST, so this returns a self-submitting form.
http.route({
  path: "/github/app/new",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    const url = new URL(request.url);
    const state = url.searchParams.get("state") ?? "";
    const orgParam = url.searchParams.get("org")?.trim();
    const org =
      orgParam === undefined || orgParam.length === 0 ? undefined : orgParam;

    const pending = await ctx.runQuery(internal.githubApp.isSetupStatePending, {
      state,
    });
    if (!pending) {
      return new Response(
        "This setup link is invalid or has expired. Start again from the dashboard.",
        { status: 400, headers: { "Content-Type": "text/plain; charset=utf-8" } },
      );
    }

    return new Response(renderManifestForm(url.origin, state, org), {
      status: 200,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
      },
    });
  }),
});

// Step 3 of the Manifest flow: exchange the temporary code for the App's id,
// private key, and webhook secret, then hand the operator back to the
// dashboard. The code is single-use and expires one hour after step 1.
http.route({
  path: "/github/app/callback",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    const url = new URL(request.url);
    const dashboard = (params: string) =>
      new Response(null, {
        status: 302,
        headers: { Location: `${url.origin}/?${params}`, "Cache-Control": "no-store" },
      });

    const code = url.searchParams.get("code") ?? "";
    const state = url.searchParams.get("state") ?? "";
    if (code.length === 0) {
      return dashboard("setup=error&reason=missing_code");
    }
    const consumed = await ctx.runMutation(
      internal.githubApp.consumeSetupState,
      { state },
    );
    if (!consumed) {
      return dashboard("setup=error&reason=invalid_state");
    }

    const response = await fetch(
      `https://api.github.com/app-manifests/${encodeURIComponent(code)}/conversions`,
      {
        method: "POST",
        headers: {
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "runner-center",
        },
      },
    );
    if (!response.ok) {
      console.error(
        `GitHub App manifest conversion failed: ${response.status} ${await response.text()}`,
      );
      return dashboard("setup=error&reason=conversion_failed");
    }

    const credentials = parseManifestConversion(await response.json());
    if (credentials === null) {
      console.error("GitHub App manifest conversion returned unexpected fields");
      return dashboard("setup=error&reason=conversion_failed");
    }

    await ctx.runMutation(internal.githubApp.store, credentials);
    return dashboard("setup=created");
  }),
});

export default http;
