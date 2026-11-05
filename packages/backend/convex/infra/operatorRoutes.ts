// Infrastructure routes on the operator API (/api/v1, ADR 0011): Nodes, Apps, env, standalone
// links and log tails. Same API tokens and response rules as the fleet routes (operatorHttp.ts)
// and the deployment routes (deployHttp.ts): `read` lists and reads, `admin` changes things and
// reads log tails, and every change, accepted or refused, is in the audit log with the token's
// name as the actor.
//
//   GET    /api/v1/nodes                          read   {nodes}
//   POST   /api/v1/nodes                          admin  {name} → 201 {node, credential}
//   POST   /api/v1/nodes/<name>/revoke            admin  {credential?} → {node, revoked}
//   POST   /api/v1/nodes/<name>/endpoint/reset    admin  → {node}
//   PUT    /api/v1/nodes/<name>/roles             admin  {roles} → {node, placementRoles}
//   GET    /api/v1/apps                           read   {apps}
//   GET    /api/v1/apps/<app>                     read   {app}
//   DELETE /api/v1/apps/<app>                     admin  → 202 {removal}
//   GET    /api/v1/apps/<app>/env                 read   {env}, names and a mask only
//   PUT    /api/v1/apps/<app>/env                 admin  {vars, service?} → {names}
//   DELETE /api/v1/apps/<app>/env/<NAME>          admin  ?service= → {removed}
//   GET    /api/v1/links                          read   {links}
//   POST   /api/v1/links                          admin  {provider, providerPort, consumer, localPort?, name?} → 201
//   DELETE /api/v1/links/<name>                   admin  → {link}
//   POST   /api/v1/logs                           admin  {app, service?, lines?} | {node, unit, lines?} → 202
//   GET    /api/v1/logs/<id>                      admin  202 pending, 200 once (then gone), 404
//
// The Node API (/api/v1/nodes/<verb>, nodeHttp.ts) shares the /api/v1/nodes prefix. Its routes
// are exact paths, which Convex matches before a prefix, and none of them is a path above; it
// takes Node credentials only, and these routes take API tokens only.
import type { HttpRouter } from "convex/server";
import { internal } from "../_generated/api";
import { httpAction, type ActionCtx } from "../_generated/server";
import type { ApiTokenScope } from "../apiTokenPolicy";
import {
  API_PREFIX,
  apiError,
  apiJson,
  authorized,
  operatorRoute,
  type Caller,
} from "../operatorHttp";
import type { AppView, LinkView, NodeView } from "./operator";

const MAX_REQUEST_BYTES = 64 * 1024;

const iso = (ms: number | null | undefined) =>
  ms === null || ms === undefined ? null : new Date(ms).toISOString();

export function nodeJson(node: NodeView) {
  return {
    ...node,
    lastSeenAt: iso(node.lastSeenAt),
    createdAt: iso(node.createdAt),
    endpoint: { ...node.endpoint, provenAt: iso(node.endpoint.provenAt) },
    credentials: node.credentials.map((c) => ({
      ...c,
      createdAt: iso(c.createdAt),
      revokedAt: iso(c.revokedAt),
    })),
  };
}

type Run = { startedAt: number; finishedAt: number | null };
const runJson = <T extends Run>(run: T) => ({
  ...run,
  startedAt: iso(run.startedAt),
  finishedAt: iso(run.finishedAt),
});

export function appJson<T extends AppView>(app: T) {
  const extra = app as T & { deployments?: Run[] };
  return {
    ...app,
    updatedAt: iso(app.updatedAt),
    lastDeployment: app.lastDeployment === null ? null : runJson(app.lastDeployment),
    ...(extra.deployments === undefined ? {} : { deployments: extra.deployments.map(runJson) }),
  };
}

export function linkJson(link: LinkView) {
  return link;
}

async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  const text = await request.text();
  if (text.length > MAX_REQUEST_BYTES) return null;
  try {
    const parsed: unknown = JSON.parse(text === "" ? "{}" : text);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** Field checks for a JSON body: unknown fields and wrong types are a 400, not a silent drop. */
function fields(
  body: Record<string, unknown>,
  spec: Record<string, "string" | "number" | "object">,
  required: string[] = [],
): { ok: true } | { ok: false; error: string } {
  for (const key of Object.keys(body)) {
    if (!(key in spec)) return { ok: false, error: `unknown field ${key}` };
    const want = spec[key];
    const value = body[key];
    const ok =
      want === "object"
        ? value !== null && typeof value === "object" && !Array.isArray(value)
        : typeof value === want;
    if (!ok)
      return {
        ok: false,
        error: `${key} must be ${want === "object" ? "an object" : `a ${want}`}`,
      };
  }
  for (const key of required) {
    if (body[key] === undefined) return { ok: false, error: `${key} is required` };
  }
  return { ok: true };
}

function noQuery(request: Request, allowed: string[] = []) {
  for (const key of new URL(request.url).searchParams.keys()) {
    if (!allowed.includes(key)) return apiError(400, "invalid_request", `unknown parameter ${key}`);
  }
  return null;
}

/** The path below `prefix`, split on `/` and decoded; null if a segment is empty. */
function segments(request: Request, prefix: string) {
  const rest = new URL(request.url).pathname.slice(prefix.length);
  const parts = rest.split("/").map((p) => {
    try {
      return decodeURIComponent(p);
    } catch {
      return "";
    }
  });
  return parts.some((p) => p.length === 0 || p.includes("/")) ? null : parts;
}

/** A refusal from a change becomes a 400, or a 404 when it names something that is not there. */
function refused(error: string) {
  return /^No (Node|App|standalone link) named|has no credential/.test(error)
    ? apiError(404, "not_found", error)
    : /in progress|queue is full/.test(error)
      ? apiError(409, "conflict", error)
      : apiError(400, "invalid_request", error);
}

type Handler = (ctx: ActionCtx, request: Request, caller: Caller) => Promise<Response>;

/**
 * A prefix route whose scope depends on the rest of the path. `pick` returns the scope and the
 * handler, or null for a path that is not a route (404 before any token check, like the API's
 * catch-all).
 */
function prefixRoute(
  prefix: string,
  pick: (parts: string[]) => { needed: ApiTokenScope; handler: Handler } | null,
) {
  return httpAction(async (ctx, request) => {
    const parts = segments(request, prefix);
    const route = parts === null ? null : pick(parts);
    if (route === null) return apiError(404, "not_found", "No such API route");
    return await authorized(ctx, request, route.needed, route.handler);
  });
}

export function registerInfraRoutes(http: HttpRouter) {
  // ---- Nodes
  http.route({
    path: `${API_PREFIX}/nodes`,
    method: "GET",
    handler: operatorRoute("read", async (ctx, request, caller) => {
      const bad = noQuery(request);
      if (bad !== null) return bad;
      const nodes = await ctx.runQuery(internal.infra.operator.apiNodes, { caller });
      return apiJson({ nodes: nodes.map(nodeJson) }, 200);
    }),
  });

  http.route({
    path: `${API_PREFIX}/nodes`,
    method: "POST",
    handler: operatorRoute("admin", async (ctx, request, caller) => {
      const body = await readJson(request);
      if (body === null) return apiError(400, "invalid_request", "Send a JSON object");
      const check = fields(body, { name: "string" }, ["name"]);
      if (!check.ok) return apiError(400, "invalid_request", check.error);
      const result = await ctx.runMutation(internal.infra.operator.apiEnroll, {
        caller,
        name: body.name as string,
      });
      if (!result.ok) return refused(result.error);
      return apiJson(
        {
          node: { id: result.value.nodeId, name: result.value.name },
          // Shown once. Store it on the Node in a 0600 file (docs/infra-management.md).
          credential: result.value.credential,
        },
        201,
      );
    }),
  });

  http.route({
    pathPrefix: `${API_PREFIX}/nodes/`,
    method: "POST",
    handler: prefixRoute(`${API_PREFIX}/nodes/`, (parts) => {
      const [node, ...action] = parts;
      switch (action.join("/")) {
        case "revoke":
          return {
            needed: "admin",
            handler: async (ctx, request, caller) => {
              const body = await readJson(request);
              if (body === null) return apiError(400, "invalid_request", "Send a JSON object");
              const check = fields(body, { credential: "string" });
              if (!check.ok) return apiError(400, "invalid_request", check.error);
              const result = await ctx.runMutation(internal.infra.operator.apiRevoke, {
                caller,
                node,
                ...(body.credential === undefined ? {} : { credential: body.credential as string }),
              });
              return result.ok ? apiJson(result.value, 200) : refused(result.error);
            },
          };
        case "endpoint/reset":
          return {
            needed: "admin",
            handler: async (ctx, _request, caller) => {
              const result = await ctx.runMutation(internal.infra.operator.apiResetEndpoint, {
                caller,
                node,
              });
              return result.ok ? apiJson(result.value, 200) : refused(result.error);
            },
          };
      }
      return null;
    }),
  });

  http.route({
    pathPrefix: `${API_PREFIX}/nodes/`,
    method: "PUT",
    handler: prefixRoute(`${API_PREFIX}/nodes/`, ([node, ...action]) =>
      action.join("/") !== "roles"
        ? null
        : {
            needed: "admin",
            handler: async (ctx, request, caller) => {
              const body = await readJson(request);
              if (body === null) return apiError(400, "invalid_request", "Send a JSON object");
              const roles = body.roles;
              if (
                Object.keys(body).some((key) => key !== "roles") ||
                !Array.isArray(roles) ||
                roles.length > 4 ||
                roles.some((role) => typeof role !== "string")
              )
                return apiError(400, "invalid_request", "Send {roles: [placement role, ...]}");
              const result = await ctx.runMutation(internal.infra.operator.apiSetRoles, {
                caller,
                node,
                roles: roles as string[],
              });
              return result.ok ? apiJson(result.value, 200) : refused(result.error);
            },
          },
    ),
  });

  // ---- Apps and env
  http.route({
    path: `${API_PREFIX}/apps`,
    method: "GET",
    handler: operatorRoute("read", async (ctx, request, caller) => {
      const bad = noQuery(request);
      if (bad !== null) return bad;
      const apps = await ctx.runQuery(internal.infra.operator.apiApps, { caller });
      return apiJson({ apps: apps.map(appJson) }, 200);
    }),
  });

  http.route({
    pathPrefix: `${API_PREFIX}/apps/`,
    method: "GET",
    handler: prefixRoute(`${API_PREFIX}/apps/`, ([app, ...rest]) => {
      if (rest.length === 0)
        return {
          needed: "read",
          handler: async (ctx, request, caller) => {
            const bad = noQuery(request);
            if (bad !== null) return bad;
            const view = await ctx.runQuery(internal.infra.operator.apiApp, { caller, app });
            if (view === null) return apiError(404, "not_found", `No App named ${app}`);
            return apiJson({ app: appJson(view) }, 200);
          },
        };
      if (rest.length === 1 && rest[0] === "env")
        return {
          needed: "read",
          handler: async (ctx, request, caller) => {
            const bad = noQuery(request);
            if (bad !== null) return bad;
            if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(app))
              return apiError(400, "invalid_request", "app is not an App name");
            const env = await ctx.runQuery(internal.infra.operator.apiEnv, { caller, app });
            return apiJson({ app, env }, 200);
          },
        };
      return null;
    }),
  });

  http.route({
    pathPrefix: `${API_PREFIX}/apps/`,
    method: "PUT",
    handler: prefixRoute(`${API_PREFIX}/apps/`, ([app, ...rest]) => {
      if (rest.length !== 1 || rest[0] !== "env") return null;
      return {
        needed: "admin",
        handler: async (ctx, request, caller) => {
          const body = await readJson(request);
          if (body === null) return apiError(400, "invalid_request", "Send a JSON object");
          const check = fields(body, { vars: "object", service: "string" }, ["vars"]);
          if (!check.ok) return apiError(400, "invalid_request", check.error);
          const vars = body.vars as Record<string, unknown>;
          if (Object.values(vars).some((value) => typeof value !== "string"))
            return apiError(400, "invalid_request", "every value in vars must be a string");
          const result = await ctx.runMutation(internal.infra.operator.apiSetEnv, {
            caller,
            app,
            vars: vars as Record<string, string>,
            ...(body.service === undefined ? {} : { service: body.service as string }),
          });
          return result.ok ? apiJson({ app, ...result.value }, 200) : refused(result.error);
        },
      };
    }),
  });

  http.route({
    pathPrefix: `${API_PREFIX}/apps/`,
    method: "DELETE",
    handler: prefixRoute(`${API_PREFIX}/apps/`, ([app, ...rest]) => {
      if (rest.length === 0)
        return {
          needed: "admin",
          handler: async (ctx, request, caller) => {
            const bad = noQuery(request);
            if (bad !== null) return bad;
            const result = await ctx.runMutation(internal.infra.operator.apiRemoveApp, {
              caller,
              app,
            });
            // Accepted, not done: each Node removes its containers when it next polls.
            return result.ok ? apiJson({ removal: result.value }, 202) : refused(result.error);
          },
        };
      if (rest.length === 2 && rest[0] === "env")
        return {
          needed: "admin",
          handler: async (ctx, request, caller) => {
            const bad = noQuery(request, ["service"]);
            if (bad !== null) return bad;
            const service = new URL(request.url).searchParams.get("service");
            const result = await ctx.runMutation(internal.infra.operator.apiUnsetEnv, {
              caller,
              app,
              name: rest[1],
              ...(service === null ? {} : { service }),
            });
            return result.ok
              ? apiJson({ app, name: rest[1], ...result.value }, 200)
              : refused(result.error);
          },
        };
      return null;
    }),
  });

  // ---- Links
  http.route({
    path: `${API_PREFIX}/links`,
    method: "GET",
    handler: operatorRoute("read", async (ctx, request, caller) => {
      const bad = noQuery(request);
      if (bad !== null) return bad;
      const links = await ctx.runQuery(internal.infra.operator.apiLinks, { caller });
      return apiJson({ links: links.map(linkJson) }, 200);
    }),
  });

  http.route({
    path: `${API_PREFIX}/links`,
    method: "POST",
    handler: operatorRoute("admin", async (ctx, request, caller) => {
      const body = await readJson(request);
      if (body === null) return apiError(400, "invalid_request", "Send a JSON object");
      const check = fields(
        body,
        {
          name: "string",
          provider: "string",
          providerPort: "number",
          consumer: "string",
          localPort: "number",
        },
        ["provider", "providerPort", "consumer"],
      );
      if (!check.ok) return apiError(400, "invalid_request", check.error);
      const result = await ctx.runMutation(internal.infra.operator.apiLink, {
        caller,
        provider: body.provider as string,
        providerPort: body.providerPort as number,
        consumer: body.consumer as string,
        ...(body.name === undefined ? {} : { name: body.name as string }),
        ...(body.localPort === undefined ? {} : { localPort: body.localPort as number }),
      });
      return result.ok ? apiJson({ link: result.value }, 201) : refused(result.error);
    }),
  });

  http.route({
    pathPrefix: `${API_PREFIX}/links/`,
    method: "DELETE",
    handler: prefixRoute(`${API_PREFIX}/links/`, ([name, ...rest]) =>
      rest.length !== 0
        ? null
        : {
            needed: "admin",
            handler: async (ctx, request, caller) => {
              const bad = noQuery(request);
              if (bad !== null) return bad;
              const result = await ctx.runMutation(internal.infra.operator.apiUnlink, {
                caller,
                name,
              });
              return result.ok ? apiJson({ link: result.value }, 200) : refused(result.error);
            },
          },
    ),
  });

  // ---- Log tails (admin: a log line can print a secret)
  http.route({
    path: `${API_PREFIX}/logs`,
    method: "POST",
    handler: operatorRoute("admin", async (ctx, request, caller) => {
      const body = await readJson(request);
      if (body === null) return apiError(400, "invalid_request", "Send a JSON object");
      const check = fields(body, {
        app: "string",
        service: "string",
        node: "string",
        unit: "string",
        lines: "number",
      });
      if (!check.ok) return apiError(400, "invalid_request", check.error);
      const result = await ctx.runMutation(internal.infra.logs.request, {
        caller,
        ...(body as {
          app?: string;
          service?: string;
          node?: string;
          unit?: string;
          lines?: number;
        }),
      });
      if (!result.ok) return refused(result.error);
      return apiJson(
        {
          logs: { ...result.value, expiresAt: iso(result.value.expiresAt) },
          next: "GET /api/v1/logs/<id> with this token until it answers 200; the first 200 deletes it",
        },
        202,
      );
    }),
  });

  http.route({
    pathPrefix: `${API_PREFIX}/logs/`,
    method: "GET",
    handler: prefixRoute(`${API_PREFIX}/logs/`, ([id, ...rest]) =>
      rest.length !== 0
        ? null
        : {
            needed: "admin",
            handler: async (ctx, request, caller) => {
              const bad = noQuery(request);
              if (bad !== null) return bad;
              const tail = await ctx.runMutation(internal.infra.logs.consume, { caller, id });
              switch (tail.state) {
                case "gone":
                  return apiError(
                    404,
                    "not_found",
                    "No log tail with that id for this token: it was read, it expired, or it never existed",
                  );
                case "pending":
                  return apiJson(
                    { logs: { id, state: "pending", expiresAt: iso(tail.expiresAt) } },
                    202,
                  );
                default:
                  return apiJson({ logs: { id, ...tail } }, 200);
              }
            },
          },
    ),
  });
}
