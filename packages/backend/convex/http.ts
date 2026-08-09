import { registerStaticRoutes } from "@convex-dev/static-hosting";
import { httpRouter } from "convex/server";
import { auth } from "./auth";
import { components, internal } from "./_generated/api";
import { httpAction } from "./_generated/server";
import { findImageLabel, IMAGE_CATALOG } from "./catalog";
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

async function verifySignature(rawBody: ArrayBuffer, signature: string) {
  const secret = process.env.GITHUB_WEBHOOK_SECRET;
  if (secret === undefined || secret.length === 0) {
    console.error("GITHUB_WEBHOOK_SECRET is not configured");
    return false;
  }
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
  return timingSafeHexEqual(bytesToHex(new Uint8Array(digest)), match[1].toLowerCase());
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
    labels,
    maxSlots,
  };
}

function parseWorkflowJob(payload: unknown) {
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
    conclusion,
  };
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
    if (!(await verifySignature(rawBody, signature))) {
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

export default http;
