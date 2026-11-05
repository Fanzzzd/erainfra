// Push-to-deploy bindings on the operator API (/api/v1, ADR 0011), with the same tokens and
// response rules as the other infrastructure routes (operatorRoutes.ts): `read` lists, `admin`
// binds and unbinds, and every change, accepted or refused, is audited with the token's name.
//
//   GET    /api/v1/git/bindings                              read   {bindings}
//   POST   /api/v1/git/bindings                              admin  {repo, branch, app, buildNode?, deployNode?, port?} → 201 {binding}
//   DELETE /api/v1/git/bindings?repo=<owner/name>&branch=<b> admin  → {binding}
//
// A branch may contain `/` (`release/1.2`), so a binding is named by query parameters, never by
// path segments that a proxy or a client could re-split or normalise.
import type { HttpRouter } from "convex/server";
import { internal } from "../_generated/api";
import { API_PREFIX, apiError, apiJson, operatorRoute } from "../operatorHttp";
import type { BindingView } from "./git";

const PATH = `${API_PREFIX}/git/bindings`;
const MAX_REQUEST_BYTES = 64 * 1024;

const iso = (ms: number) => new Date(ms).toISOString();

export function bindingJson(binding: BindingView) {
  return {
    id: binding._id,
    repo: binding.repo,
    branch: binding.branch,
    app: binding.app,
    buildNode: binding.buildNode,
    deployNode: binding.deployNode,
    port: binding.port ?? null,
    createdAt: iso(binding.createdAt),
    lastStatus:
      binding.lastStatus === null
        ? null
        : {
            at: iso(binding.lastStatus.at),
            sha: binding.lastStatus.sha,
            ok: binding.lastStatus.ok,
            stage: binding.lastStatus.stage,
            error: binding.lastStatus.error ?? null,
          },
  };
}

const BIND_FIELDS = {
  repo: "string",
  branch: "string",
  app: "string",
  buildNode: "string",
  deployNode: "string",
  port: "number",
} as const;
type BindBody = {
  repo: string;
  branch: string;
  app: string;
  buildNode?: string;
  deployNode?: string;
  port?: number;
};

/**
 * The bind body, or why it is refused. Unknown fields and wrong types are a 400, not a silent
 * drop, as on the other infrastructure routes.
 */
async function bindBody(request: Request): Promise<BindBody | string> {
  const text = await request.text();
  if (text.length > MAX_REQUEST_BYTES) return "The request body is too large";
  let body: unknown;
  try {
    body = JSON.parse(text === "" ? "{}" : text);
  } catch {
    return "Send a JSON object";
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) return "Send a JSON object";
  const record = body as Record<string, unknown>;
  for (const [key, value] of Object.entries(record)) {
    if (!(key in BIND_FIELDS)) return `unknown field ${key}`;
    const want = BIND_FIELDS[key as keyof typeof BIND_FIELDS];
    if (typeof value !== want) return `${key} must be a ${want}`;
  }
  for (const key of ["repo", "branch", "app"]) {
    if (record[key] === undefined) return `${key} is required`;
  }
  return record as BindBody;
}

/** A refusal becomes a 404 for something that is not there, 409 for a clash, otherwise 400. */
function refused(error: string) {
  return /^No (Node named|binding for)/.test(error)
    ? apiError(404, "not_found", error)
    : /^(Already bound|Binding limit reached)/.test(error)
      ? apiError(409, "conflict", error)
      : apiError(400, "invalid_request", error);
}

function unknownParameter(request: Request, allowed: string[]) {
  for (const key of new URL(request.url).searchParams.keys()) {
    if (!allowed.includes(key)) return apiError(400, "invalid_request", `unknown parameter ${key}`);
  }
  return null;
}

export function registerGitRoutes(http: HttpRouter) {
  http.route({
    path: PATH,
    method: "GET",
    handler: operatorRoute("read", async (ctx, request, caller) => {
      const bad = unknownParameter(request, []);
      if (bad !== null) return bad;
      const bindings = await ctx.runQuery(internal.infra.operatorGit.apiBindings, { caller });
      return apiJson({ bindings: bindings.map(bindingJson) }, 200);
    }),
  });

  http.route({
    path: PATH,
    method: "POST",
    handler: operatorRoute("admin", async (ctx, request, caller) => {
      const bad = unknownParameter(request, []);
      if (bad !== null) return bad;
      const body = await bindBody(request);
      if (typeof body === "string") return apiError(400, "invalid_request", body);
      const result = await ctx.runMutation(internal.infra.operatorGit.apiBind, {
        caller,
        repo: body.repo,
        branch: body.branch,
        app: body.app,
        ...(body.buildNode === undefined ? {} : { buildNode: body.buildNode }),
        ...(body.deployNode === undefined ? {} : { deployNode: body.deployNode }),
        ...(body.port === undefined ? {} : { port: body.port }),
      });
      return result.ok
        ? apiJson({ binding: bindingJson(result.value) }, 201)
        : refused(result.error);
    }),
  });

  http.route({
    path: PATH,
    method: "DELETE",
    handler: operatorRoute("admin", async (ctx, request, caller) => {
      const bad = unknownParameter(request, ["repo", "branch"]);
      if (bad !== null) return bad;
      const params = new URL(request.url).searchParams;
      const repo = params.get("repo");
      const branch = params.get("branch");
      if (
        repo === null ||
        branch === null ||
        params.getAll("repo").length > 1 ||
        params.getAll("branch").length > 1
      )
        return apiError(
          400,
          "invalid_request",
          "Name the binding with ?repo=<owner/name>&branch=<branch>",
        );
      const result = await ctx.runMutation(internal.infra.operatorGit.apiUnbind, {
        caller,
        repo,
        branch,
      });
      return result.ok ? apiJson({ binding: result.value }, 200) : refused(result.error);
    }),
  });
}
