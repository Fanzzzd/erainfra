// Deployment routes on the operator API (/api/v1, ADR 0011). Same API tokens and response rules as
// the fleet routes in operatorHttp.ts: `read` lists and reads, `admin` uploads and deploys, and every
// mutating request is written to the durable audit log in the transaction that acts on it.
//
//   POST /api/v1/deployments/uploads   admin  → 201 {uploadUrl}; POST the .tar.gz there
//   POST /api/v1/deployments           admin  → 202 {deployment}
//   GET  /api/v1/deployments?app=&limit=  read → {deployments}
//   GET  /api/v1/deployments/<id>      read   → {deployment}
//
// A deploy request is one of:
//   {"app":"web","upload":"<storageId from the upload>","port":3000?,"buildNode":"a"?,"node":"b"?}
//   {"app":"web","repo":"owner/name","branch":"main"?,"sha":"<40 hex>"?, ...}
// Either may add "adopt":["web-api", ...]: unlabelled containers this deploy replaces although they
// lack the Hub's shape (docs/infra-management.md, "Names and ownership").
import type { HttpRouter } from "convex/server";
import { internal } from "../_generated/api";
import { httpAction, type ActionCtx } from "../_generated/server";
import type { ApiTokenScope } from "../apiTokenPolicy";
import { API_PREFIX, apiError, apiJson, authenticateBearer } from "../operatorHttp";

const MAX_REQUEST_BYTES = 16 * 1024;
const DEPLOY_FIELDS = new Set([
  "app",
  "upload",
  "repo",
  "branch",
  "sha",
  "port",
  "buildNode",
  "node",
  "adopt",
]);

function route(
  needed: ApiTokenScope,
  handler: (ctx: ActionCtx, request: Request, actor: string) => Promise<Response>,
) {
  return httpAction(async (ctx, request) => {
    const auth = await authenticateBearer(ctx, request, needed);
    if (!auth.ok) {
      if (auth.reason === "forbidden")
        return apiError(
          403,
          "forbidden",
          needed === "admin"
            ? "This route needs an admin token"
            : "This route needs a read or admin token",
        );
      return apiError(
        401,
        "unauthorized",
        "Send a valid API token as Authorization: Bearer <token>",
      );
    }
    return await handler(ctx, request, `token:${auth.caller.name}`);
  });
}

async function readBody(request: Request): Promise<Record<string, unknown> | null> {
  const text = await request.text();
  if (text.length > MAX_REQUEST_BYTES) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

const optionalString = (value: unknown) =>
  value === undefined ? undefined : typeof value === "string" ? value : null;

export function registerDeployRoutes(http: HttpRouter) {
  http.route({
    path: `${API_PREFIX}/deployments/uploads`,
    method: "POST",
    handler: route("admin", async (ctx, _request, actor) => {
      const { uploadUrl } = await ctx.runMutation(internal.infra.deployApi.createUpload, {
        actor,
      });
      return apiJson(
        {
          uploadUrl,
          // What to do next, so a script needs no other documentation.
          next: 'POST the gzipped tarball to uploadUrl; send the storageId it returns as "upload"',
        },
        201,
      );
    }),
  });

  http.route({
    path: `${API_PREFIX}/deployments`,
    method: "POST",
    handler: route("admin", async (ctx, request, actor) => {
      const body = await readBody(request);
      if (body === null) return apiError(400, "invalid_request", "Send a JSON object");
      const unknown = Object.keys(body).find((key) => !DEPLOY_FIELDS.has(key));
      if (unknown !== undefined)
        return apiError(400, "invalid_request", `unknown field ${unknown}`);
      const strings: Record<string, string | undefined> = {};
      for (const key of ["app", "upload", "repo", "branch", "sha", "buildNode", "node"]) {
        const value = optionalString(body[key]);
        if (value === null) return apiError(400, "invalid_request", `${key} must be a string`);
        strings[key] = value;
      }
      if (strings.app === undefined) return apiError(400, "invalid_request", "app is required");
      if (body.port !== undefined && typeof body.port !== "number")
        return apiError(400, "invalid_request", "port must be a number");
      if (
        body.adopt !== undefined &&
        (!Array.isArray(body.adopt) || body.adopt.some((name) => typeof name !== "string"))
      )
        return apiError(400, "invalid_request", "adopt must be an array of container names");
      const started = await ctx.runMutation(internal.infra.deployApi.start, {
        actor,
        app: strings.app,
        ...Object.fromEntries(
          Object.entries(strings).filter(([key, value]) => key !== "app" && value !== undefined),
        ),
        ...(body.port === undefined ? {} : { port: body.port as number }),
        ...(body.adopt === undefined ? {} : { adopt: body.adopt as string[] }),
      });
      if (!started.ok) return apiError(400, "invalid_request", started.error);
      const deployment = await ctx.runQuery(internal.infra.deployApi.get, {
        id: started.deploymentId,
      });
      return apiJson({ deployment }, 202);
    }),
  });

  http.route({
    path: `${API_PREFIX}/deployments`,
    method: "GET",
    handler: route("read", async (ctx, request) => {
      const params = new URL(request.url).searchParams;
      for (const key of params.keys())
        if (key !== "app" && key !== "limit")
          return apiError(400, "invalid_request", `unknown parameter ${key}`);
      const app = params.get("app") ?? undefined;
      if (app !== undefined && !/^[a-z0-9][a-z0-9-]{0,62}$/.test(app))
        return apiError(400, "invalid_request", "app is not an App name");
      const limitParam = params.get("limit");
      const limit = limitParam === null ? 20 : Number(limitParam);
      if (!/^[0-9]{1,3}$/.test(limitParam ?? "20") || limit < 1 || limit > 100)
        return apiError(400, "invalid_request", "limit must be an integer from 1 to 100");
      const deployments = await ctx.runQuery(internal.infra.deployApi.list, {
        ...(app === undefined ? {} : { app }),
        limit,
      });
      return apiJson({ deployments }, 200);
    }),
  });

  http.route({
    pathPrefix: `${API_PREFIX}/deployments/`,
    method: "GET",
    handler: route("read", async (ctx, request) => {
      const id = decodeURIComponent(
        new URL(request.url).pathname.slice(`${API_PREFIX}/deployments/`.length),
      );
      const deployment =
        id.length === 0 || id.includes("/")
          ? null
          : await ctx.runQuery(internal.infra.deployApi.get, { id });
      if (deployment === null) return apiError(404, "not_found", "No deployment has that id");
      return apiJson({ deployment }, 200);
    }),
  });
}
