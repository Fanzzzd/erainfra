import { registerStaticRoutes } from "@convex-dev/static-hosting";
import { httpRouter } from "convex/server";
import { auth } from "./auth";
import { components, internal } from "./_generated/api";
import { httpAction } from "./_generated/server";

const http = httpRouter();
auth.addHttpRoutes(http);
registerStaticRoutes(http, components.staticHosting);

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
  return timingSafeHexEqual(
    bytesToHex(new Uint8Array(digest)),
    match[1].toLowerCase(),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
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
    repo: repository.full_name,
    workflowName,
    labels: workflowJob.labels as string[],
    conclusion,
  };
}

http.route({
  path: "/github/webhook",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const rawBody = await request.arrayBuffer();
    const signature = request.headers.get("X-Hub-Signature-256") ?? "";
    if (!(await verifySignature(rawBody, signature))) {
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
      return new Response(JSON.stringify({ error: "labels is required" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    const selfHostedLabels = labels.includes("self-hosted")
      ? labels
      : ["self-hosted", ...labels];
    const available = await ctx.runQuery(internal.machines.hasCapacity, {
      labels: selfHostedLabels,
    });
    return new Response(
      JSON.stringify({ "runs-on": available ? selfHostedLabels : fallback }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }),
});

export default http;
