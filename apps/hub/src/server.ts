import "./boot-env.ts"; // MUST be first: sets persist-path env defaults before router.ts builds its singletons
import Fastify, { type FastifyInstance } from "fastify";
import { z } from "zod";
import fastifyStatic from "@fastify/static";
import fastifyWebsocket from "@fastify/websocket";
import { fastifyTRPCPlugin, type CreateFastifyContextOptions } from "@trpc/server/adapters/fastify";
import { existsSync, readFileSync, mkdirSync, writeFileSync, createReadStream } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { appRouter } from "./router.ts";
import { renamedEnv } from "./env.ts";
import { stateDir } from "./db.ts";
import type { Context } from "./trpc.ts";
import { InMemoryAuditLog, SqliteAuditLog, type AuditLog } from "./audit.ts";
import {
  defaultTokenStore,
  defaultAuthStores,
  resolveRequestAuth,
  LoginRateLimiter,
  SESSION_COOKIE,
  readSessionCookie,
  type TokenStore,
  type Principal,
} from "./auth.ts";
import { userStore } from "./runtime/users.ts";
import { sessionStore } from "./runtime/sessions.ts";
import { apiTokenStore } from "./runtime/apitokens.ts";
import { can } from "./rbac.ts";
import { agentGateway } from "./runtime/agents.ts";
import { dataGateway, appFromHost, sanitizeRequestHeaders, MAX_BODY } from "./runtime/dataplane.ts";
import { routeStore } from "./runtime/routes.ts";
import { installFailover } from "./runtime/failover.ts";
import { backupConfig, backupNow } from "./runtime/backup.ts";
import { githubAppConfig, verifyWebhook, parsePush } from "./runtime/github.ts";
import { gitProjects, startGitDeploy } from "./runtime/gitdeploy.ts";
import { installLinkHealer, installServeRehydrator } from "./runtime/appdeploy.ts";
import { deployments } from "./runtime/deployments.ts";
import type { IncomingMessage, ServerResponse } from "node:http";

// Re-export so existing importers (and tests) keep working.
export { appRouter, type AppRouter } from "./router.ts";

// Read a request body into a Buffer, rejecting once it exceeds the cap (proxy bodies are buffered).
function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  // `resolveBody`, not `resolve`: `resolve` is node:path's, imported above.
  return new Promise((resolveBody, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (c: Buffer) => {
      total += c.length;
      if (total > limit) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolveBody(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

const sendStatus = (
  res: ServerResponse,
  code: number,
  msg: string,
  extra?: Record<string, string>,
) => {
  res.writeHead(code, { "content-type": "text/plain; charset=utf-8", ...extra });
  res.end(msg + "\n");
};

// Reverse-proxy one inbound request for `<app>.<domain>` to the agent that holds the app, over the
// data WS. Writes the response directly to the raw Node socket (we've hijacked the Fastify reply).
async function proxyAppRequest(
  appName: string,
  req: IncomingMessage,
  res: ServerResponse,
  ctx: { ip: string },
): Promise<void> {
  try {
    if ((req.headers.upgrade ?? "").toLowerCase() === "websocket")
      return sendStatus(res, 501, "websocket proxying not supported yet"); // ponytail: v1 is request/response only
    const node = routeStore.node(appName);
    if (!node) return sendStatus(res, 404, `no such app: ${appName}`);
    if (!dataGateway.isConnected(node))
      return sendStatus(res, 503, `app ${appName} is offline`, { "retry-after": "5" });
    const host = String(req.headers.host ?? "");
    const proto = String(req.headers["x-forwarded-proto"] ?? "http");
    const headers = sanitizeRequestHeaders(req.headers, { host, clientIp: ctx.ip, proto });
    const body = await readBody(req, MAX_BODY);
    const resp = await dataGateway.proxy(node, appName, {
      method: req.method ?? "GET",
      path: req.url ?? "/",
      headers,
      body,
    });
    // Strip response hop-by-hop / length headers; res.end(body) sets Content-Length itself.
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(resp.headers)) {
      const key = k.toLowerCase();
      if (key === "content-length" || key === "transfer-encoding" || key === "connection") continue;
      if (!/[\r\n]/.test(key) && !/[\r\n]/.test(String(v))) out[k] = String(v);
    }
    res.writeHead(resp.status, out);
    res.end(resp.body);
  } catch (e) {
    const msg = (e as Error).message;
    const code = msg.includes("too large") ? 413 : msg.includes("timed out") ? 504 : 502;
    if (!res.headersSent) sendStatus(res, code, `proxy error: ${msg}`);
    else res.end();
  }
}

// Set-Cookie for a session token. Depends on nothing in the server instance, so it lives here
// rather than being rebuilt on every createApiServer() call.
const sessionCookie = (
  req: { headers: Record<string, unknown> },
  token: string,
  maxAgeSec: number,
) => {
  // Secure whenever the request came over TLS (cloudflared sets x-forwarded-proto). SameSite=Lax
  // blocks cross-site POSTs from riding the cookie; HttpOnly keeps it away from page JS.
  const secure = (req.headers["x-forwarded-proto"] ?? "") === "https" ? "; Secure" : "";
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${secure}`;
};

export function createApiServer(
  opts: { audit?: AuditLog; tokens?: TokenStore; webDir?: string } = {},
): FastifyInstance {
  const audit = opts.audit ?? new InMemoryAuditLog();
  // Legacy static tokens (tests + PORTLESS_DEV_TOKENS bootstrap); fail-closed in production.
  const tokens = opts.tokens ?? defaultTokenStore();
  // Real authentication: user sessions (cookie) → revocable API tokens (bearer) → legacy static.
  const auth = defaultAuthStores(tokens);
  const authFor = (req: {
    headers: { authorization?: string | string[]; cookie?: string };
  }): Principal | null => resolveRequestAuth(req, auth);
  // requestTimeout:0 disables Node's 5-min cap so long agent orchestrations aren't cut off.
  // bodyLimit raised so drag-drop source uploads (tarballs) aren't capped at Fastify's 1MB default.
  // ponytail: 256MB cap, buffered in memory then written to disk — fine for a single-user PaaS; switch
  // to a streamed multipart upload if source bundles get large or uploads run concurrently.
  const app = Fastify({
    logger: false,
    requestTimeout: 0,
    keepAliveTimeout: 0,
    bodyLimit: 256 * 1024 * 1024,
  });

  // Accept tarball uploads as a raw Buffer (drag-drop deploy sends the source as a gzipped tar).
  app.addContentTypeParser(
    ["application/gzip", "application/x-tar", "application/octet-stream"],
    { parseAs: "buffer" },
    (_req, body, done) => done(null, body),
  );

  // Drag-drop source ingestion: the dashboard POSTs a project's source as a .tar.gz; a build-capable
  // agent later fetches it back over the spine and builds it. Both routes need app.deploy. The build
  // id is a server-minted UUID, so the GET path can't be traversed.
  // stateDir() rather than a second tmpdir() literal: upload staging belongs on the same volume as
  // the DB, and this way it follows the state dir's dual-read instead of drifting from it.
  const buildsDir =
    renamedEnv("ERAINFRA_BUILDS_DIR", "PORTLESS_BUILDS_DIR") ?? join(stateDir(), "builds");
  const principalFor = (req: {
    headers: { authorization?: string | string[]; cookie?: string };
  }) => {
    const p = authFor(req);
    return p && can(p, "app.deploy") ? p : undefined;
  };
  app.post("/upload", async (req, reply) => {
    if (!principalFor(req)) return reply.code(401).send({ error: "unauthorized" });
    const body = req.body;
    if (!Buffer.isBuffer(body) || body.length === 0)
      return reply
        .code(400)
        .send({ error: "expected a non-empty tar.gz body (Content-Type: application/gzip)" });
    const buildId = randomUUID();
    mkdirSync(join(buildsDir, buildId), { recursive: true });
    writeFileSync(join(buildsDir, buildId, "source.tgz"), body);
    return reply.code(201).send({ buildId, bytes: body.length });
  });
  app.get("/builds/:id/source.tgz", async (req, reply) => {
    if (!principalFor(req)) return reply.code(401).send({ error: "unauthorized" });
    const { id } = req.params as { id: string };
    if (!/^[0-9a-f-]{36}$/.test(id)) return reply.code(400).send({ error: "bad build id" });
    const f = join(buildsDir, id, "source.tgz");
    if (!existsSync(f)) return reply.code(404).send({ error: "no such build" });
    return reply.type("application/gzip").send(createReadStream(f));
  });

  // REST liveness check kept for smoke tests / unauthenticated probes.
  app.get("/health", async () => ({ ok: true }));

  // ---- Account auth (the Dokploy model): user accounts + password login + cookie sessions. -----
  // REST (not tRPC) because these set/clear cookies and run before any principal exists.
  const loginLimiter = new LoginRateLimiter();
  const loginBody = z.object({
    email: z.string().min(3).max(254),
    password: z.string().min(1).max(1024),
  });

  // Does this instance need first-boot setup? (Public: reveals only "are there users yet".)
  app.get("/auth/status", async () => ({ setup: userStore.count() === 0 }));

  // One-time first-boot setup: create the OWNER account. Locked forever once any user exists.
  app.post("/auth/setup", async (req, reply) => {
    if (userStore.count() > 0) return reply.code(403).send({ error: "setup already completed" });
    const body = loginBody.extend({ name: z.string().max(64).optional() }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: body.error.issues[0].message });
    const r = userStore.create({
      email: body.data.email,
      password: body.data.password,
      name: body.data.name,
      roles: ["owner"],
    });
    if (!r.ok) return reply.code(400).send({ error: r.error });
    audit.record({
      actor: r.user.id,
      action: "auth.setup",
      target: r.user.email,
      outcome: "success",
    });
    const { token } = sessionStore.create(
      r.user.id,
      req.headers["user-agent"] as string | undefined,
    );
    return reply
      .header("set-cookie", sessionCookie(req, token, 30 * 24 * 3600))
      .send({ ok: true, user: r.user });
  });

  app.post("/auth/login", async (req, reply) => {
    const body = loginBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "email and password required" });
    const key = `${req.ip}|${body.data.email.toLowerCase()}`;
    const gate = loginLimiter.check(key);
    if (!gate.allowed)
      return reply
        .code(429)
        .header("retry-after", String(gate.retryAfterSec))
        .send({ error: `too many attempts — retry in ${gate.retryAfterSec}s` });
    const user = userStore.verify(body.data.email, body.data.password);
    if (!user) {
      loginLimiter.fail(key);
      audit.record({
        actor: body.data.email.toLowerCase(),
        action: "auth.login",
        outcome: "failure",
      });
      return reply.code(401).send({ error: "wrong email or password" });
    }
    loginLimiter.clear(key);
    audit.record({ actor: user.id, action: "auth.login", target: user.email, outcome: "success" });
    const { token } = sessionStore.create(user.id, req.headers["user-agent"] as string | undefined);
    return reply
      .header("set-cookie", sessionCookie(req, token, 30 * 24 * 3600))
      .send({ ok: true, user });
  });

  app.post("/auth/logout", async (req, reply) => {
    const token = readSessionCookie(req.headers.cookie);
    if (token) sessionStore.revokeByToken(token);
    return reply.header("set-cookie", sessionCookie(req, "", 0)).send({ ok: true });
  });

  app.get("/auth/me", async (req, reply) => {
    const p = authFor(req);
    if (!p) return reply.code(401).send({ error: "unauthorized" });
    // Real users get their email too (the dashboard shows it); token principals have none.
    return { id: p.id, name: p.name, roles: p.roles, email: userStore.get(p.id)?.email };
  });

  // Exchange email+password for a long-lived API token — the `portless login` flow. Same throttle
  // as login; the token is returned exactly once.
  app.post("/auth/cli-token", async (req, reply) => {
    const body = loginBody.extend({ name: z.string().max(64).default("cli") }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "email and password required" });
    const key = `${req.ip}|${body.data.email.toLowerCase()}`;
    const gate = loginLimiter.check(key);
    if (!gate.allowed)
      return reply
        .code(429)
        .header("retry-after", String(gate.retryAfterSec))
        .send({ error: `too many attempts — retry in ${gate.retryAfterSec}s` });
    const user = userStore.verify(body.data.email, body.data.password);
    if (!user) {
      loginLimiter.fail(key);
      audit.record({
        actor: body.data.email.toLowerCase(),
        action: "auth.cli-token",
        outcome: "failure",
      });
      return reply.code(401).send({ error: "wrong email or password" });
    }
    loginLimiter.clear(key);
    const { token, record } = apiTokenStore.create({
      name: body.data.name,
      roles: user.roles,
      createdBy: user.id,
    });
    audit.record({
      actor: user.id,
      action: "auth.cli-token",
      target: record.name,
      outcome: "success",
    });
    return { ok: true, token, id: record.id, name: record.name };
  });

  // Agent control channel (self-controlled, replaces dumbpipe): portless agents on remote NAT'd
  // boxes dial IN over WSS and the hub pushes them commands. Authed with the same bearer token;
  // agents need app.deploy (they execute deploys). The socket staying open is the presence signal.
  // Encapsulated so @fastify/websocket is fully loaded BEFORE the route is added — otherwise the
  // `{ websocket: true }` option is ignored and the upgrade just hangs.
  app.register(async (instance) => {
    await instance.register(fastifyWebsocket);
    instance.get("/agent", { websocket: true }, (socket, req) => {
      const principal = authFor(req);
      if (!principal || !can(principal, "app.deploy")) {
        try {
          socket.close(1008, "unauthorized");
        } catch {
          /* gone */
        }
        return;
      }
      const s = { send: (d: string) => socket.send(d), close: () => socket.close() };
      socket.on("message", (data: Buffer) => agentGateway.onMessage(s, data.toString()));
      socket.on("close", () => agentGateway.onClose(s));
    });
    // Data channel: the agent's SECOND outbound socket, carrying reverse-proxied HTTP for its apps.
    // Same node auth (bearer + app.deploy); routing is driven by the hub's route table (set at deploy),
    // never by what the agent claims to serve.
    instance.get("/data", { websocket: true }, (socket, req) => {
      const principal = authFor(req);
      if (!principal || !can(principal, "app.deploy")) {
        try {
          socket.close(1008, "unauthorized");
        } catch {
          /* gone */
        }
        return;
      }
      const s = { send: (d: string) => socket.send(d), close: () => socket.close() };
      socket.on("message", (data: Buffer) => dataGateway.onMessage(s, data.toString()));
      socket.on("ping", () => dataGateway.touch(s)); // the agent pings every 20s; keep it alive for the reaper
      socket.on("close", () => dataGateway.onClose(s));
    });
  });

  // Wildcard-domain ingress: any request whose Host is `<app>.<PORTLESS_APP_DOMAIN>` is reverse-proxied
  // to the agent running that app. Disabled unless PORTLESS_APP_DOMAIN is set.
  // When the hub's own hostname lives UNDER the app domain (e.g. hub portless.on99.ai with apps at
  // *.on99.ai — Cloudflare's free Universal SSL only covers one wildcard level, so a separate
  // apps.<zone> level would fail TLS), set PORTLESS_HUB_HOST so dashboard traffic bypasses the proxy.
  const appDomain = renamedEnv("ERAINFRA_APP_DOMAIN", "PORTLESS_APP_DOMAIN");
  const hubHost = renamedEnv("ERAINFRA_HUB_HOST", "PORTLESS_HUB_HOST")?.toLowerCase();
  if (appDomain) {
    app.addHook("onRequest", async (req, reply) => {
      if (hubHost && (req.headers.host ?? "").toLowerCase().split(":")[0] === hubHost) return; // the hub itself is never an app
      const appName = appFromHost(req.headers.host, appDomain);
      if (!appName) return; // not an app subdomain
      reply.hijack(); // we own the raw response
      await proxyAppRequest(appName, req.raw, reply.raw, { ip: req.ip });
    });
  }

  // GitHub push-to-deploy webhook (the Vercel flow). Encapsulated so the raw-body parser (needed to
  // HMAC-verify the signature) doesn't affect tRPC's JSON parsing. On a verified push to a bound
  // repo+branch, it kicks off clone→build→deploy in the background and records the result.
  app.register(async (instance) => {
    instance.addContentTypeParser("application/json", { parseAs: "buffer" }, (_req, body, done) =>
      done(null, body),
    );
    instance.post("/webhook/github", async (req, reply) => {
      const cfg = githubAppConfig();
      const raw = req.body as Buffer;
      if (
        !cfg.webhookSecret ||
        !verifyWebhook(
          cfg.webhookSecret,
          raw,
          req.headers["x-hub-signature-256"] as string | undefined,
        )
      ) {
        return reply.code(401).send({ error: "bad or missing signature" });
      }
      const event = req.headers["x-github-event"];
      if (event === "ping") return reply.send({ ok: true, pong: true });
      if (event !== "push") return reply.send({ ok: true, ignored: event });
      let push;
      try {
        push = parsePush(JSON.parse(raw.toString()));
      } catch {
        return reply.code(400).send({ error: "bad json" });
      }
      if (!push) return reply.send({ ok: true, ignored: "non-branch push" });
      const binding = gitProjects.find(push.repo, push.branch);
      if (!binding)
        return reply.send({ ok: true, ignored: `no binding for ${push.repo}@${push.branch}` });
      // GitHub wants a fast 2xx — build+deploy run in the background; status is recorded on the binding.
      const proto = (req.headers["x-forwarded-proto"] as string | undefined) ?? "https";
      const deployCfg = {
        registry: renamedEnv("ERAINFRA_REGISTRY", "PORTLESS_REGISTRY") ?? "127.0.0.1:5000",
        hubBase:
          renamedEnv("ERAINFRA_HUB_BASE", "PORTLESS_HUB_BASE") ?? `${proto}://${req.headers.host}`,
        appId: cfg.appId,
        privateKey: cfg.privateKey,
      };
      void startGitDeploy(binding, push.sha, push.installationId, deployCfg).done.then((r) =>
        gitProjects.setStatus(binding.id, {
          at: new Date().toISOString(),
          sha: push.sha,
          ok: r.ok,
          stage: r.stage,
          error: r.error,
        }),
      );
      return reply.send({
        ok: true,
        building: `${push.repo}@${push.sha.slice(0, 7)} → ${binding.name}`,
      });
    });
  });

  // Public installer scripts: agent.sh/agent.ps1 (node enrollment), image.sh (build/deploy),
  // registry.sh (image store), cli.sh (the portless CLI). Unauthenticated by design — they carry
  // no secrets. We template the served base URL into each (the `<hub>` placeholder) so the
  // commands they print point back at this hub. Override the directory with PORTLESS_DEPLOY_DIR.
  const deployDir =
    renamedEnv("ERAINFRA_DEPLOY_DIR", "PORTLESS_DEPLOY_DIR") ??
    join(import.meta.dirname, "../../../deploy/infra");
  for (const script of ["registry.sh", "image.sh", "agent.sh", "agent.ps1", "cli.sh"]) {
    const mime = script.endsWith(".ps1")
      ? "text/plain; charset=utf-8"
      : "text/x-shellscript; charset=utf-8";
    app.get(`/${script}`, async (req, reply) => {
      let body: string;
      try {
        body = readFileSync(join(deployDir, script), "utf8");
      } catch {
        return reply.code(404).type("text/plain").send(`${script} not available on this server\n`);
      }
      // Behind a TLS tunnel cloudflared sets x-forwarded-proto=https; for a direct LAN/HTTP hub there's
      // no XFP, so fall back to the actual request scheme (http) instead of assuming https — otherwise
      // the templated download URL is https against a plaintext port and curl/irm fail.
      const proto = (req.headers["x-forwarded-proto"] as string | undefined) ?? req.protocol;
      const base = `${proto}://${req.headers.host}`;
      return reply.type(mime).send(body.split("<hub>").join(base));
    });
  }

  // The CLI itself (installed by cli.sh). No templating — it learns its hub via `login`.
  //
  // Two routes, one file. This is the half of the rename that has to ship FIRST: serving an extra
  // route costs a customer's box nothing, while asking for a route the Hub may not have yet is a
  // 404 whose body a shell executes as a no-op. Nothing requests /cli/erainfra.mjs today — cli.sh
  // still asks for the old path — and that is the point. The Hub is ready before the asker moves.
  const cliFile =
    renamedEnv("ERAINFRA_CLI_FILE", "PORTLESS_CLI_FILE") ??
    join(import.meta.dirname, "../../../packages/cli/portless.mjs");
  for (const route of ["/cli/portless.mjs", "/cli/erainfra.mjs"]) {
    app.get(route, async (_req, reply) => {
      if (!existsSync(cliFile))
        return reply.code(404).type("text/plain").send("cli not available on this server\n");
      return reply.type("text/javascript; charset=utf-8").send(createReadStream(cliFile));
    });
  }

  // Serve prebuilt agent binaries (populated by deploy/infra/build-agents.sh) so agent.sh / agent.ps1 can
  // download the right one. Self-hosted distribution — no Docker Hub, no third-party release host.
  // The filename allowlist keeps this from becoming an arbitrary-file read.
  //
  // Both names resolve to the same bytes, for the reason above and one more: build-agents.sh still
  // writes portless-agent-<target> and must keep doing so (CONTEXT.md rule 4 freezes the download
  // path), so an erainfra-agent-<target> request has to fall back to the file that is actually on
  // disk. If a later release does start building under the new name, the new file wins.
  const agentBinDir =
    renamedEnv("ERAINFRA_AGENT_BIN_DIR", "PORTLESS_AGENT_BIN_DIR") ?? join(deployDir, "bin");
  app.get("/agent-bin/:file", async (req, reply) => {
    const { file } = req.params as { file: string };
    if (!/^(portless|erainfra)-agent-(linux|darwin|windows)-(amd64|arm64)(\.exe)?$/.test(file)) {
      return reply.code(400).type("text/plain").send("bad agent binary name\n");
    }
    // Both candidates from EITHER spelling, not just from the renamed one. A box installed before
    // this release asks for portless-agent-<target> forever — that request is baked into an agent
    // already on disk — so once a later release builds under the renamed name, resolving a retired
    // request to the retired name alone is a 404 for exactly the machines this rollout protects.
    // Serving is the permissive side of the migration: it answers both spellings from whichever
    // single file exists.
    const current = file.replace(/^portless-agent-/, "erainfra-agent-");
    const retired = file.replace(/^erainfra-agent-/, "portless-agent-");
    const f = [join(agentBinDir, current), join(agentBinDir, retired)].find((p) => existsSync(p));
    if (!f)
      return reply
        .code(404)
        .type("text/plain")
        .send(`${file} not built — run deploy/infra/build-agents.sh on the hub\n`);
    return reply.type("application/octet-stream").send(createReadStream(f));
  });

  app.register(fastifyTRPCPlugin, {
    prefix: "/trpc",
    trpcOptions: {
      router: appRouter,
      createContext: ({ req }: CreateFastifyContextOptions): Context => ({
        principal: authFor(req),
        audit,
      }),
    },
  });

  // Single-origin production deploy: serve the built dashboard from the same origin as /trpc, so
  // one tunnel hostname covers both. The SPA uses hash routing, so static files + index at '/' are
  // enough (no catch-all rewrite). Only enabled when a build dir is configured AND exists; dev runs
  // the Vite server separately and leaves this off. PORTLESS_WEB_DIR defaults to the repo's web dist.
  // resolve() so a relative PORTLESS_WEB_DIR works (fastify-static requires an absolute root, else
  // it throws a cryptic error at boot).
  const webDir = opts.webDir ?? renamedEnv("ERAINFRA_WEB_DIR", "PORTLESS_WEB_DIR");
  if (webDir && existsSync(webDir)) {
    app.register(fastifyStatic, { root: resolve(webDir), prefix: "/" });
  }

  return app;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT ?? renamedEnv("ERAINFRA_PORT", "PORTLESS_PORT") ?? 8787);
  // Bind loopback by default: behind a tunnel, cloudflared connects over localhost — nothing
  // public binds. Opt into LAN exposure with PORTLESS_BIND only when you mean it.
  const host = renamedEnv("ERAINFRA_BIND", "PORTLESS_BIND") ?? "127.0.0.1";
  // Serve the built dashboard if present (single-origin prod deploy); default to the repo's dist.
  const webDir =
    renamedEnv("ERAINFRA_WEB_DIR", "PORTLESS_WEB_DIR") ??
    join(import.meta.dirname, "../../hub-web/dist");
  deployments.failStale("hub restarted mid-deploy"); // in-flight pipelines died with the old process
  installFailover(); // auto-redeploy stranded apps when a node drops (PORTLESS_FAILOVER=0 to disable)
  installLinkHealer(); // re-establish cross-node mesh links after agent/hub restarts
  installServeRehydrator(); // re-push app->port registrations when an agent reconnects (agent restarts forget them)
  // Liveness reaper: drop agents/data sockets that went silent (dead NAT mappings never close cleanly).
  // Agents heartbeat the control channel every 15s and ping the data channel every 20s; reaping a
  // control socket fires the disconnect → failover path.
  setInterval(() => {
    agentGateway.reapStale(45_000);
    dataGateway.reapStale(50_000);
  }, 15_000).unref();
  // Scheduled control-plane backups to your S3 when configured (PORTLESS_BACKUP_INTERVAL_MIN>0).
  const backupCfg = backupConfig();
  const backupEveryMin = Number(
    renamedEnv("ERAINFRA_BACKUP_INTERVAL_MIN", "PORTLESS_BACKUP_INTERVAL_MIN") ?? 0,
  );
  if (backupCfg && backupEveryMin > 0) {
    setInterval(
      () =>
        backupNow(backupCfg)
          .then((r) => console.log(`[backup] ${r.key} (${r.bytes}b)`))
          .catch((e) => console.error("[backup]", (e as Error).message)),
      backupEveryMin * 60_000,
    );
  }
  createApiServer({ audit: new SqliteAuditLog(), webDir })
    .listen({ port, host })
    .then((address) => console.log(`Portless API listening on ${address}`))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
