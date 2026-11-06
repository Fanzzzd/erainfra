// The App deploy pipeline and failover run from Convex (infra/pipeline.ts, infra/failover.ts),
// driven end to end through the operator API and the Node API, with Infra Agents simulated by the
// test. Nothing here reaches a network.
import { generateKeyPairSync } from "node:crypto";
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import schema from "../convex/schema";
import { isRouteLabel } from "../convex/infra/ingress";
import { implicitSpec, parseSpec } from "../convex/infra/spec";
import { FAILOVER_GRACE_MS, NODE_SILENCE_MS } from "../convex/infra/policy";

const modules = import.meta.glob("../convex/**/*.ts");
const T0 = Date.parse("2026-11-06T00:00:00Z");

const SHOP_SPEC = `
services:
  web:
    build: .
    port: 3000
    route: true
    needs: [db]
    env: { NODE_ENV: production }
  db:
    image: 127.0.0.1:5000/postgres:16
    port: 5432
    node: node-b
    volumes: [pgdata:/var/lib/postgresql/data]
`;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
  process.env.ERAINFRA_SECRETS_MASTER_KEY = "22".repeat(32);
  process.env.ERAINFRA_APP_DOMAIN = "apps.example.com";
  process.env.ERAINFRA_REGISTRY = "127.0.0.1:5000";
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  for (const name of [
    "ERAINFRA_SECRETS_MASTER_KEY",
    "ERAINFRA_APP_DOMAIN",
    "ERAINFRA_GH_APP_ID",
    "ERAINFRA_GH_APP_KEY",
    "ERAINFRA_GH_WEBHOOK_SECRET",
    "GITHUB_WEBHOOK_SECRET",
    "ERAINFRA_REGISTRY",
    "ERAINFRA_REGISTRY_NODE",
  ])
    delete process.env[name];
});

type Outcome = "success" | "failure" | "unknown";
type Cmd = { id: Id<"nodeCommands">; idempotencyKey: string; kind: string };

async function setup(names = ["node-a", "node-b", "node-c"]) {
  const t = convexTest(schema, modules);
  const owner = await t.run((ctx) => ctx.db.insert("users", { email: "o@x.dev", role: "owner" }));
  const human = t.withIdentity({ subject: `${owner}|session` });
  const nodes: Record<string, { nodeId: Id<"nodes">; credential: string }> = {};
  for (const name of names) nodes[name] = await human.mutation(api.infra.nodes.enroll, { name });
  const admin = (await human.mutation(api.apiTokens.create, { name: "ci", scope: "admin" })).token;
  const reader = (await human.mutation(api.apiTokens.create, { name: "ro", scope: "read" })).token;

  const beat = async (...which: string[]) => {
    for (const name of which.length ? which : names)
      await t.mutation(internal.infra.nodeState.heartbeat, {
        credential: nodes[name].credential,
        version: "test",
      });
  };
  // Let every scheduled tick and kick run. They sit on real zero-delay timers.
  const settle = () => t.finishAllScheduledFunctions(() => {});
  const nodeApi = (path: string, name: string, data?: unknown) =>
    t.fetch(`/api/v1/nodes/${path}`, {
      method: data === undefined ? "GET" : "POST",
      headers: {
        Authorization: `Bearer ${nodes[name].credential}`,
        "Content-Type": "application/json",
      },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    });
  const operator = (path: string, token: string, data?: unknown) =>
    t.fetch(`/api/v1/${path}`, {
      method: data === undefined ? "GET" : "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    });
  const pending = async (name: string): Promise<Cmd[]> =>
    (
      await t.query(internal.infra.nodeState.pending, {
        credential: nodes[name].credential,
        cursor: null,
      })
    ).commands as Cmd[];

  /**
   * One poll of a simulated Infra Agent over the real Node HTTP API: claim each unsettled command,
   * fetch its payload, let `decide` say how it went, report. Returns what it saw.
   */
  const agent = async (
    name: string,
    decide: (payload: any, cmd: Cmd) => { outcome: Outcome; spec?: string } = () => ({
      outcome: "success",
    }),
  ) => {
    const seen: Array<{ cmd: Cmd; payload: any }> = [];
    for (const cmd of await pending(name)) {
      const claim = await nodeApi("commands/claim", name, { commandId: cmd.id, owner: name });
      expect(claim.status).toBe(200);
      const { epoch } = (await claim.json()) as { epoch: number };
      const body = { commandId: cmd.id, owner: name, epoch };
      const payload = await nodeApi("commands/payload", name, body);
      expect(payload.status).toBe(200);
      const p = await payload.json();
      seen.push({ cmd, payload: p });
      const result = decide(p, cmd);
      const reported = await nodeApi("commands/result", name, { ...body, ...result });
      expect(reported.status).toBe(200);
    }
    await settle();
    return seen;
  };
  const deployment = (id: string) =>
    t.run(async (ctx) => (await ctx.db.get(id as Id<"appDeployments">))!);
  const upload = async (bytes = "source-tarball") =>
    await t.run((ctx) => ctx.storage.store(new Blob([bytes])));
  const startUpload = async (app: string, storageId: string, extra: object = {}) => {
    const res = await operator("deployments", admin, {
      app,
      upload: storageId,
      buildNode: "node-a",
      node: "node-a",
      ...extra,
    });
    expect(res.status).toBe(202);
    const id = ((await res.json()) as { deployment: { id: string } }).deployment.id;
    await settle();
    return id;
  };

  /** Drive a full deploy of the shop App from an upload to `done`. */
  const deployShop = async () => {
    const id = await startUpload("shop", await upload());
    await agent("node-a", () => ({ outcome: "success", spec: SHOP_SPEC }));
    await agent("node-a"); // build web
    await agent("node-a"); // deploy web
    await agent("node-b"); // deploy db
    return id;
  };
  return {
    t,
    human,
    nodes,
    admin,
    reader,
    beat,
    settle,
    nodeApi,
    operator,
    pending,
    agent,
    deployment,
    upload,
    startUpload,
    deployShop,
  };
}

/** A spec whose every service is routed with `route: true`. */
const routed = (app: string, ...services: string[]) =>
  parseSpec(
    `services:\n${services.map((s, i) => `  ${s}:\n    image: x\n    port: ${80 + i}\n    route: true\n`).join("")}`,
    app,
  );

describe("spec parsing", () => {
  it("keeps the Hub's rules: route naming, needs, named volumes only, strict keys", () => {
    const parsed = parseSpec(SHOP_SPEC, "shop");
    expect(parsed).toMatchObject({ ok: true });
    if (!parsed.ok) return;
    expect(parsed.spec.services.map((s) => [s.name, s.route ?? null])).toEqual([
      ["web", "shop"],
      ["db", null],
    ]);
    expect(
      parseSpec("services:\n  web:\n    image: x\n    volumes: [/etc:/etc]\n", "a"),
    ).toMatchObject({
      ok: false,
    });
    expect(parseSpec("services:\n  web:\n    image: x\n    privileged: true\n", "a")).toEqual({
      ok: false,
      error: 'portless.yaml: services.web: Unrecognized key: "privileged"',
    });
    expect(parseSpec("services:\n  web:\n    build: ../x\n", "a")).toMatchObject({ ok: false });
    expect(parseSpec("services:\n  web:\n    image: x\n    needs: [db]\n", "a")).toEqual({
      ok: false,
      error: 'service "web": needs unknown service "db"',
    });
    expect(implicitSpec("a", 8080).services[0]).toMatchObject({ route: "a", port: 8080 });
  });

  // A gateway serves only a DNS label (isRouteLabel) and skips any other route row, so a spec
  // that routes at one would deploy and report a URL nothing answers.
  it("refuses a route label no gateway can serve, derived or written", () => {
    const app = "a".repeat(40);
    const long = routed(app, "s".repeat(30), "other");
    expect(long).toEqual({
      ok: false,
      error:
        `service "${"s".repeat(30)}": route: true gives the label "${app}-${"s".repeat(30)}" (71 characters), ` +
        "which is not served: a route label is a DNS label: at most 63 characters, lowercase letters, " +
        "digits and dashes, starting and ending with a letter or digit. Name the label explicitly (route: <label>)",
    });
    // 63 characters is the longest label, and is served.
    const longest = routed("a".repeat(40), "s".repeat(22), "other");
    expect(longest.ok && longest.spec.services.map((s) => s.route!).every(isRouteLabel)).toBe(true);
    // An App or service name may end in a dash; a label may not.
    expect(routed("shop-", "web")).toMatchObject({
      ok: false,
      error: /route: true gives the label "shop-"/,
    });
    expect(
      parseSpec("services:\n  web:\n    image: x\n    port: 80\n    route: shop-\n", "a"),
    ).toMatchObject({ ok: false, error: /route "shop-" is not served/ });
  });
});

describe("deploy pipeline", () => {
  it("fails a source with no spec whose App name is no route label, before planning", async () => {
    const s = await setup();
    await s.beat();
    const id = await s.startUpload("shop-", await s.upload(), { port: 8080 });
    await s.agent("node-a", () => ({ outcome: "success", spec: "" }));
    expect(await s.deployment(id)).toMatchObject({
      stage: "failed",
      error: expect.stringMatching(/^service "web": route: true gives the label "shop-"/),
    });
    expect(await s.t.run((ctx) => ctx.db.query("appRoutes").collect())).toEqual([]);
  });

  it("runs spec, plan, build, deploy and link, each step a keyed Node command", async () => {
    const s = await setup();
    await s.beat();
    await s.human.mutation(api.infra.secrets.set, { app: "shop", vars: { API_KEY: "k-1" } });
    await s.human.mutation(api.infra.secrets.set, {
      app: "shop",
      service: "db",
      vars: { POSTGRES_PASSWORD: "pw" },
    });
    const storageId = await s.upload();
    const id = await s.startUpload("shop", storageId);
    expect((await s.deployment(id)).stage).toBe("reading-spec");

    const spec = await s.agent("node-a", () => ({ outcome: "success", spec: SHOP_SPEC }));
    expect(spec).toHaveLength(1);
    expect(spec[0].cmd.idempotencyKey).toBe(`${id}:spec:${s.nodes["node-a"].nodeId}`);
    // The build Node fetches the upload through a URL in its claimed payload, not a credential.
    expect(spec[0].payload).toMatchObject({ kind: "spec", source: { kind: "upload" } });
    expect(spec[0].payload.source.url).toMatch(/^https?:\/\//);
    expect((await s.deployment(id)).stage).toBe("building");

    const build = await s.agent("node-a");
    expect(build.map((b) => b.payload)).toEqual([
      {
        kind: "build",
        app: "shop",
        service: "web",
        source: { kind: "upload", url: spec[0].payload.source.url },
        dir: "",
        image: `127.0.0.1:5000/shop-web:${id.slice(0, 12)}`,
      },
    ]);
    expect((await s.deployment(id)).stage).toBe("deploying");

    const onA = await s.agent("node-a");
    const onB = await s.agent("node-b");
    expect(onA[0].cmd.idempotencyKey).toBe(`${id}:deploy:${s.nodes["node-a"].nodeId}`);
    const web = onA[0].payload.services[0];
    expect(web).toMatchObject({ name: "web", route: "shop" });
    expect(web.env).toMatchObject({
      PORT: "3000",
      NODE_ENV: "production",
      API_KEY: "k-1",
      DB_HOST: "host.docker.internal",
    });
    // A service-private secret reaches only the Node running that service.
    expect(web.env.POSTGRES_PASSWORD).toBeUndefined();
    expect(onB[0].payload.services[0].env).toMatchObject({
      POSTGRES_PASSWORD: "pw",
      API_KEY: "k-1",
    });

    const done = await s.deployment(id);
    expect(done).toMatchObject({ stage: "done", urls: ["https://shop.apps.example.com"] });
    const state = await s.t.run(async (ctx) => ({
      app: await ctx.db
        .query("apps")
        .withIndex("by_name", (q) => q.eq("name", "shop"))
        .unique(),
      route: await ctx.db
        .query("appRoutes")
        .withIndex("by_name", (q) => q.eq("name", "shop"))
        .unique(),
      lease: await ctx.db
        .query("appLeases")
        .withIndex("by_app", (q) => q.eq("app", "shop"))
        .unique(),
      upload: await ctx.storage.get(storageId),
      commands: await ctx.db
        .query("nodeCommands")
        .withIndex("by_deployment", (q) => q.eq("deploymentId", id as Id<"appDeployments">))
        .collect(),
      audit: (await ctx.db.query("auditEvents").collect()).map((e) => [e.action, e.outcome]),
    }));
    expect(state.app?.services.map((x) => [x.name, x.nodeId])).toEqual([
      ["web", s.nodes["node-a"].nodeId],
      ["db", s.nodes["node-b"].nodeId],
    ]);
    expect(state.app?.links).toEqual([
      expect.objectContaining({
        name: "shop-db",
        providerNodeId: s.nodes["node-b"].nodeId,
        consumerNodeId: s.nodes["node-a"].nodeId,
        localPort: Number(web.env.DB_PORT),
      }),
    ]);
    expect(state.app?.spec?.services).toHaveLength(2);
    expect(state.route).toMatchObject({ nodeId: s.nodes["node-a"].nodeId, port: web.port });
    expect(state.lease?.holder).toBeUndefined();
    expect(state.upload).toBeNull();
    expect(state.commands.map((c) => c.status)).toEqual([
      "success",
      "success",
      "success",
      "success",
    ]);
    expect(state.audit).toContainEqual(["apps.deploy.request", "attempt"]);
    expect(state.audit).toContainEqual(["apps.deploy", "success"]);

    // Ticking a finished run again enqueues nothing.
    await s.t.mutation(internal.infra.pipeline.tick, { deploymentId: id as Id<"appDeployments"> });
    expect(await s.pending("node-a")).toEqual([]);

    // Status and history through the operator API, readable with a read token.
    const got = await s.operator(`deployments/${id}`, s.reader);
    expect(got.status).toBe(200);
    expect(await got.json()).toMatchObject({
      deployment: { id, app: "shop", stage: "done", buildNode: "node-a" },
    });
    const listed = (await (await s.operator("deployments?app=shop", s.reader)).json()) as {
      deployments: Array<{ id: string }>;
    };
    expect(listed.deployments.map((d) => d.id)).toEqual([id]);

    // A redeploy gets the same host ports back: they are stable per (Node, key).
    await s.beat();
    const again = await s.startUpload("shop", await s.upload());
    await s.agent("node-a", () => ({ outcome: "success", spec: SHOP_SPEC }));
    await s.agent("node-a");
    const redeployed = await s.agent("node-a");
    await s.agent("node-b");
    expect((await s.deployment(again)).stage).toBe("done");
    expect(redeployed[0].payload.services[0]).toMatchObject({ port: web.port });
    expect(redeployed[0].payload.services[0].env.DB_PORT).toBe(web.env.DB_PORT);
  });

  it("fails the run when a step fails, cancels what is left and frees the App", async () => {
    const s = await setup();
    await s.beat();
    const storageId = await s.upload();
    const id = await s.startUpload("shop", storageId);
    await s.agent("node-a", () => ({ outcome: "success", spec: SHOP_SPEC }));
    await s.agent("node-a", () => ({ outcome: "failure" }));
    const run = await s.deployment(id);
    expect(run).toMatchObject({ stage: "failed", detail: "building" });
    expect(run.error).toContain("build-web failed on node-a");
    const after = await s.t.run(async (ctx) => ({
      app: await ctx.db.query("apps").first(),
      lease: await ctx.db.query("appLeases").first(),
      upload: await ctx.storage.get(storageId),
    }));
    expect(after.app).toBeNull();
    expect(after.lease?.holder).toBeUndefined();
    expect(after.upload).toBeNull();
    expect(await s.pending("node-b")).toEqual([]);
  });

  it("fails a run whose build Node stops heartbeating, and a run with an unknown outcome", async () => {
    const s = await setup();
    await s.beat();
    const id = await s.startUpload("shop", await s.upload());
    // The pulse keeps the run's lease while it waits; node-a stays silent.
    for (let at = T0 + 10_000; at <= T0 + NODE_SILENCE_MS + 10_000; at += 10_000) {
      vi.setSystemTime(at);
      await s.beat("node-b", "node-c");
      await s.t.mutation(internal.infra.pipeline.pulse, {});
      await s.settle();
    }
    expect(await s.deployment(id)).toMatchObject({
      stage: "failed",
      error: "node-a has stopped sending heartbeats",
    });

    await s.beat();
    const second = await s.startUpload("shop", await s.upload());
    await s.agent("node-a", () => ({ outcome: "unknown" }));
    expect((await s.deployment(second)).error).toContain("unknown outcome");
  });

  it("refuses a stale epoch once another holder takes the App's lease mid-run", async () => {
    const s = await setup();
    await s.beat();
    const first = await s.startUpload("shop", await s.upload());
    const [cmd] = await s.pending("node-a");
    const claim = await s.t.mutation(internal.infra.nodeCommands.claim, {
      credential: s.nodes["node-a"].credential,
      commandId: cmd.id,
      owner: "agent",
    });
    // The coordinator stalls past the lease TTL; another operation takes the App.
    vi.setSystemTime(T0 + 61_000);
    await s.beat();
    const taken = await s.t.mutation(internal.infra.leases.acquire, {
      app: "shop",
      holder: "failover:elsewhere",
      operation: "failover",
    });
    expect(taken).toMatchObject({ grant: true, epoch: 2 });

    // The Node's step for the old epoch can no longer fetch its payload or report.
    const body = {
      credential: s.nodes["node-a"].credential,
      commandId: cmd.id,
      owner: "agent",
      epoch: claim.epoch,
    };
    await s.t.mutation(internal.infra.nodeCommands.renew, body).catch(() => undefined);
    await expect(s.t.query(internal.infra.nodeCommands.payload, body)).rejects.toThrow(/Stale/);
    await expect(
      s.t.mutation(internal.infra.nodeCommands.report, {
        ...body,
        outcome: "success",
        spec: SHOP_SPEC,
      }),
    ).rejects.toThrow(/Stale/);

    // The run's own tick refuses to advance on the old epoch and fails the run instead.
    await s.t.mutation(internal.infra.pipeline.tick, {
      deploymentId: first as Id<"appDeployments">,
    });
    expect(await s.deployment(first)).toMatchObject({
      stage: "failed",
      error: "lost its App lease mid-run",
    });
    const lease = await s.t.run((ctx) => ctx.db.query("appLeases").first());
    expect(lease).toMatchObject({ holder: "failover:elsewhere", epoch: 2 });
    expect(await s.t.run((ctx) => ctx.db.query("apps").first())).toBeNull();
  });

  it("runs two deploys of one App one after the other", async () => {
    const s = await setup();
    await s.beat();
    const one = await s.startUpload("shop", await s.upload("one"));
    const two = await s.startUpload("shop", await s.upload("two"));
    expect((await s.deployment(one)).stage).toBe("reading-spec");
    expect((await s.deployment(two)).stage).toBe("queued");
    // The second gets no Node step while the first holds the lease, however often it is ticked.
    await s.t.mutation(internal.infra.pipeline.pulse, {});
    await s.settle();
    expect((await s.deployment(two)).stage).toBe("queued");
    expect((await s.pending("node-a")).map((c) => c.idempotencyKey)).toEqual([
      `${one}:spec:${s.nodes["node-a"].nodeId}`,
    ]);

    await s.agent("node-a", () => ({ outcome: "failure" }));
    expect((await s.deployment(one)).stage).toBe("failed");
    expect((await s.deployment(two)).stage).toBe("reading-spec");
    expect((await s.deployment(two)).leaseEpoch).toBe((await s.deployment(one)).leaseEpoch! + 1);
  });

  it("refuses deploy requests without an admin token and audits refusals", async () => {
    const s = await setup();
    expect((await s.operator("deployments/uploads", s.reader, {})).status).toBe(403);
    expect((await s.operator("deployments", s.reader, { app: "shop" })).status).toBe(403);
    const created = await s.operator("deployments/uploads", s.admin, {});
    expect(created.status).toBe(201);
    expect(((await created.json()) as { uploadUrl: string }).uploadUrl).toMatch(/^https?:\/\//);
    const bad = await s.operator("deployments", s.admin, { app: "shop", upload: "nope" });
    expect(bad.status).toBe(400);
    expect(await s.operator("deployments", s.admin, { app: "shop", argv: ["sh"] })).toMatchObject({
      status: 400,
    });
    const audit = await s.t.run((ctx) => ctx.db.query("auditEvents").collect());
    const byTokens = audit.filter((e) => e.actor.startsWith("token:"));
    expect(byTokens.map((e) => [e.actor, e.action, e.outcome])).toEqual([
      ["token:ci", "apps.deploy.upload", "success"],
      ["token:ci", "apps.deploy.request", "deny"],
    ]);
  });
});

async function sign(secret: string, body: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return `sha256=${Array.from(new Uint8Array(mac), (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

const SOLO = `
services:
  web:
    image: 127.0.0.1:5000/postgres:16
    port: 5432
    route: true
    volumes: [pgdata:/var/lib/postgresql/data]
`;

/** Let every Node's simulated agent settle what it is sent, answering a spec step with `spec`. */
async function drive(s: Awaited<ReturnType<typeof setup>>, spec: string) {
  for (let i = 0; i < 6; i++)
    for (const name of Object.keys(s.nodes))
      await s.agent(name, (_p, c) =>
        c.kind === "spec" ? { outcome: "success", spec } : { outcome: "success" },
      );
}

/** Deploy `app` with a spec, on whatever Node the request picks, and drive it to the end. */
async function deployWith(
  s: Awaited<ReturnType<typeof setup>>,
  app: string,
  spec: string,
  request: object = {},
) {
  const res = await s.operator("deployments", s.admin, {
    app,
    upload: await s.upload(),
    ...request,
  });
  expect(res.status).toBe(202);
  const id = ((await res.json()) as { deployment: { id: string } }).deployment.id;
  await s.settle();
  await drive(s, spec);
  return id;
}

describe("a deploy that names no Node", () => {
  it("keeps an existing App on the Node it runs on, not the first live Node by name", async () => {
    const s = await setup(["aliyun", "work-remote"]);
    await s.beat();
    await deployWith(s, "solo", SOLO, { node: "work-remote", buildNode: "work-remote" });

    // A redeploy with no --node, as the Hub-retirement runbook's "deploy every App" step does.
    const again = await s.operator("deployments", s.admin, {
      app: "solo",
      upload: await s.upload(),
    });
    expect(again.status).toBe(202);
    const id = ((await again.json()) as { deployment: { id: string } }).deployment.id;
    await s.settle();
    const run = await s.deployment(id);
    expect(run.defaultNodeId).toBe(s.nodes["work-remote"].nodeId);
    expect(run.buildNodeId).toBe(s.nodes["work-remote"].nodeId);
    expect(await s.pending("aliyun")).toEqual([]);
    await drive(s, SOLO);
    expect((await s.deployment(id)).stage).toBe("done");
    const routes = await s.t.run((ctx) => ctx.db.query("appRoutes").collect());
    expect(routes.map((r) => r.nodeId)).toEqual([s.nodes["work-remote"].nodeId]);
  });

  it("refuses when the App's Node is not live, instead of moving it to another Node", async () => {
    const s = await setup(["aliyun", "work-remote"]);
    await s.beat();
    await deployWith(s, "solo", SOLO, { node: "work-remote", buildNode: "work-remote" });
    vi.setSystemTime(T0 + NODE_SILENCE_MS + 10_000);
    await s.beat("aliyun");

    const res = await s.operator("deployments", s.admin, {
      app: "solo",
      upload: await s.upload(),
    });
    const id = ((await res.json()) as { deployment: { id: string } }).deployment.id;
    await s.settle();
    const run = await s.deployment(id);
    expect(run.stage).toBe("failed");
    expect(run.error).toContain('App "solo" runs on work-remote, which is not connected to Convex');
    expect(run.error).toContain("--node");
    expect(await s.pending("aliyun")).toEqual([]);
  });

  it("keeps each service on its own Node when they differ", async () => {
    const s = await setup(["aliyun", "node-a", "node-b"]);
    await s.beat();
    await deployWith(s, "shop", SHOP_SPEC, { node: "node-a", buildNode: "node-a" });
    // The spec no longer pins db; it still runs on node-b with its volume.
    const unpinned = SHOP_SPEC.replace("    node: node-b\n", "");
    expect(unpinned).not.toContain("node-b");
    await deployWith(s, "shop", unpinned);
    const app = await s.t.run(async (ctx) =>
      ctx.db
        .query("apps")
        .withIndex("by_name", (q) => q.eq("name", "shop"))
        .unique(),
    );
    expect(app?.nodeId).toBe(s.nodes["node-a"].nodeId);
    const where = Object.fromEntries(app!.services.map((x) => [x.name, x.nodeId ?? app!.nodeId]));
    expect(where).toEqual({ web: s.nodes["node-a"].nodeId, db: s.nodes["node-b"].nodeId });
    const runs = await s.t.run((ctx) => ctx.db.query("appDeployments").collect());
    expect(runs.map((r) => r.stage)).toEqual(["done", "done"]);
  });

  it("keeps a single-container App the Hub deployed on its route's Node, on a push too", async () => {
    const s = await setup(["aliyun", "work-remote"]);
    await s.beat();
    await s.t.run(async (ctx) => {
      await ctx.db.insert("appRoutes", {
        name: "solo",
        nodeId: s.nodes["work-remote"].nodeId,
        image: "127.0.0.1:5000/solo:old",
        port: 8080,
        updatedAt: T0,
      });
      // An imported Hub binding names no deploy Node.
      await ctx.db.insert("gitBindings", {
        repo: "acme/solo",
        repoKey: "acme/solo",
        branch: "main",
        app: "solo",
        createdAt: T0,
      });
    });
    const pushed = await s.t.mutation(internal.infra.git.acceptPush, {
      deliveryId: "guid-solo",
      repo: "acme/solo",
      branch: "main",
      sha: "a".repeat(40),
    });
    expect(pushed.outcome).toBe("queued");
    await s.settle();
    const run = await s.deployment((pushed as { deploymentId: string }).deploymentId);
    expect(run.defaultNodeId).toBe(s.nodes["work-remote"].nodeId);
    expect(await s.pending("aliyun")).toEqual([]);
  });

  it("still places a new App on the first live Node", async () => {
    const s = await setup(["aliyun", "work-remote"]);
    await s.beat();
    const res = await s.operator("deployments", s.admin, {
      app: "fresh",
      upload: await s.upload(),
    });
    const id = ((await res.json()) as { deployment: { id: string } }).deployment.id;
    await s.settle();
    expect((await s.deployment(id)).defaultNodeId).toBe(s.nodes["aliyun"].nodeId);
  });
});

describe("push-to-deploy", () => {
  it("deploys once per delivery and lends the build Node a read-only token for one repository", async () => {
    const s = await setup();
    await s.beat();
    const binding = await s.human.mutation(api.infra.git.bind, {
      repo: "acme/shop",
      branch: "main",
      app: "shop",
      buildNodeId: s.nodes["node-a"].nodeId,
      deployNodeId: s.nodes["node-a"].nodeId,
    });
    process.env.ERAINFRA_GH_WEBHOOK_SECRET = "whsec";
    const sha = "a".repeat(40);
    const body = JSON.stringify({
      ref: "refs/heads/main",
      after: sha,
      repository: { full_name: "acme/shop" },
    });
    const deliver = async () =>
      await s.t.fetch("/github/webhook", {
        method: "POST",
        headers: {
          "X-GitHub-Event": "push",
          "X-GitHub-Delivery": "delivery-1",
          "X-Hub-Signature-256": await sign("whsec", body),
          "Content-Type": "application/json",
        },
        body,
      });
    expect(await (await deliver()).text()).toBe("Accepted");
    expect(await (await deliver()).text()).toBe("Duplicate");
    await s.settle();
    const runs = await s.t.run((ctx) => ctx.db.query("appDeployments").collect());
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      stage: "reading-spec",
      source: { kind: "git", repo: "acme/shop", ref: "main", sha },
      gitBindingId: binding,
    });

    // With the deploy App configured, the claimed payload carries a token minted for this one
    // repository with Contents read, and the token is stored nowhere in Convex.
    const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
    process.env.ERAINFRA_GH_APP_ID = "12345";
    process.env.ERAINFRA_GH_APP_KEY = pair.privateKey
      .export({ format: "pem", type: "pkcs8" })
      .toString();
    const calls: Array<{ url: string; body?: unknown }> = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      calls.push({ url, body: init.body ? JSON.parse(init.body as string) : undefined });
      if (url.endsWith("/repos/acme/shop/installation"))
        return new Response(JSON.stringify({ id: 77 }), { status: 200 });
      return new Response(
        JSON.stringify({ token: "ghs_minted", expires_at: "2026-11-06T01:00:00Z" }),
        {
          status: 201,
        },
      );
    });
    const seen = await s.agent("node-a", () => ({
      outcome: "success",
      spec: "services:\n  web:\n    build: .\n    port: 8080\n    route: true\n",
    }));
    expect(seen[0].payload.source).toEqual({
      kind: "git",
      repo: "acme/shop",
      ref: "main",
      sha,
      token: "ghs_minted",
    });
    expect(calls.map((c) => c.url)).toEqual([
      "https://api.github.com/repos/acme/shop/installation",
      "https://api.github.com/app/installations/77/access_tokens",
    ]);
    expect(calls[1].body).toEqual({ repositories: ["shop"], permissions: { contents: "read" } });
    const dump = JSON.stringify(
      await s.t.run(async (ctx) => [
        await ctx.db.query("nodeCommands").collect(),
        await ctx.db.query("appDeployments").collect(),
        await ctx.db.query("auditEvents").collect(),
      ]),
    );
    expect(dump).not.toContain("ghs_minted");

    await s.agent("node-a"); // build
    await s.agent("node-a"); // deploy
    const status = await s.t.run((ctx) => ctx.db.get(binding));
    expect(status?.lastStatus).toMatchObject({ sha, ok: true, stage: "done" });
  });
});

describe("webhook secrets", () => {
  // One secret per purpose: the event type picks the secret before the signature is checked.
  const deliver = async (
    s: Awaited<ReturnType<typeof setup>>,
    event: string,
    secret: string,
    body: string,
  ) =>
    await s.t.fetch("/github/webhook", {
      method: "POST",
      headers: {
        "X-GitHub-Event": event,
        "X-GitHub-Delivery": `delivery-${event}-${secret}`,
        "X-Hub-Signature-256": await sign(secret, body),
        "Content-Type": "application/json",
      },
      body,
    });
  const push = JSON.stringify({
    ref: "refs/heads/main",
    after: "b".repeat(40),
    repository: { full_name: "acme/shop" },
  });
  const job = JSON.stringify({
    action: "queued",
    workflow_job: { id: 1, labels: ["self-hosted"], workflow_name: "ci" },
    repository: { full_name: "acme/shop", private: false },
  });

  it("refuses a push signed with the CI App's secret, and a job signed with the deploy secret", async () => {
    const s = await setup();
    await s.beat();
    await s.human.mutation(api.infra.git.bind, { repo: "acme/shop", branch: "main", app: "shop" });
    process.env.GITHUB_WEBHOOK_SECRET = "ci-secret";
    process.env.ERAINFRA_GH_WEBHOOK_SECRET = "deploy-secret";

    expect((await deliver(s, "push", "ci-secret", push)).status).toBe(401);
    expect((await deliver(s, "workflow_job", "deploy-secret", job)).status).toBe(401);
    const recorded = await s.t.run(async (ctx) => ({
      runs: await ctx.db.query("appDeployments").collect(),
      deliveries: await ctx.db.query("webhookDeliveries").collect(),
    }));
    expect(recorded).toEqual({ runs: [], deliveries: [] });

    // Each secret still works for its own purpose.
    expect((await deliver(s, "push", "deploy-secret", push)).status).toBe(202);
    expect((await deliver(s, "workflow_job", "ci-secret", job)).status).not.toBe(401);
    // GitHub's ping comes from either App and does nothing.
    expect((await deliver(s, "ping", "deploy-secret", "{}")).status).toBe(200);
    expect((await deliver(s, "ping", "ci-secret", "{}")).status).toBe(200);
    await s.settle();
    expect(await s.t.run((ctx) => ctx.db.query("appDeployments").collect())).toHaveLength(1);
  });

  it("refuses every push while no deploy secret is set, even one signed with the CI secret", async () => {
    const s = await setup();
    process.env.GITHUB_WEBHOOK_SECRET = "ci-secret";
    expect((await deliver(s, "push", "ci-secret", push)).status).toBe(401);
  });
});

type Key = { pair: CryptoKeyPair; id: string };
async function newKey(): Promise<Key> {
  const pair = (await crypto.subtle.generateKey("Ed25519", true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  return { pair, id: Array.from(raw, (b) => b.toString(16).padStart(2, "0")).join("") };
}

describe("mesh links from the pipeline", () => {
  it("publishes cross-Node needs and the registry links in each Node's mesh snapshot", async () => {
    process.env.ERAINFRA_REGISTRY = "127.0.0.1:5000";
    process.env.ERAINFRA_REGISTRY_NODE = "node-c";
    const s = await setup();
    await s.beat();
    // Each Node proves its endpoint key the way connect-convex does with its sidecar.
    const keys: Record<string, Key> = {};
    for (const name of ["node-a", "node-b", "node-c"]) {
      keys[name] = await newKey();
      const address = { id: keys[name].id, relay_urls: [], direct_addrs: ["127.0.0.1:4433"] };
      const challenge = await s.nodeApi("endpoint/challenge", name, { address });
      expect(challenge.status).toBe(200);
      const { challengeId, message } = (await challenge.json()) as {
        challengeId: string;
        message: string;
      };
      const signature = new Uint8Array(
        await crypto.subtle.sign(
          "Ed25519",
          keys[name].pair.privateKey,
          new TextEncoder().encode(message),
        ),
      );
      const published = await s.nodeApi("endpoint", name, {
        challengeId,
        signature: btoa(String.fromCharCode(...signature)),
      });
      expect(published.status).toBe(200);
    }
    const snapshot = async (name: string) => {
      const res = await s.nodeApi("state", name);
      expect(res.status).toBe(200);
      return ((await res.json()) as { desired: any }).desired;
    };

    const id = await s.startUpload("shop", await s.upload());
    await s.agent("node-a", () => ({ outcome: "success", spec: SHOP_SPEC }));
    // Planning wired the registry before the build: node-a pushes, node-a and node-b pull.
    expect((await snapshot("node-a")).links).toContainEqual({
      name: "registry-node-a",
      peer: keys["node-c"].id,
      service: "registry-node-a",
      listen: "127.0.0.1:5000",
    });
    await s.agent("node-a"); // build
    const deployedA = await s.agent("node-a");
    await s.agent("node-b");
    expect((await s.deployment(id)).stage).toBe("done");
    const web = deployedA[0].payload.services[0];
    const db = (await s.t.run((ctx) => ctx.db.query("apps").first()))!.services.find(
      (x) => x.name === "db",
    )!;

    // node-b provides db to node-a only, at db's loopback host port.
    const b = await snapshot("node-b");
    expect(b.exposures).toContainEqual({
      name: "shop-db",
      target: `127.0.0.1:${db.port}`,
      allowed_peers: [keys["node-a"].id],
    });
    expect(b.links).toContainEqual({
      name: "registry-node-b",
      peer: keys["node-c"].id,
      service: "registry-node-b",
      listen: "127.0.0.1:5000",
    });
    // node-a listens where its container reaches the host (host.docker.internal resolves to the
    // Docker bridge gateway), at the port injected as DB_PORT. Convex names the scope; the Node
    // resolves its own bridge address. A snapshot with a scoped listener is version 2.
    const a = await snapshot("node-a");
    expect(a.v).toBe(2);
    expect(a.links).toContainEqual({
      name: "shop-db",
      peer: keys["node-b"].id,
      service: "shop-db",
      listen: `bridge:${web.env.DB_PORT}`,
    });
    expect(web.env.DB_HOST).toBe("host.docker.internal");
    expect(web.args).toContain("--add-host=host.docker.internal:host-gateway");
    // node-c, the registry Node, grants each consumer its own link and nothing else.
    const c = await snapshot("node-c");
    expect(c.exposures).toEqual([
      { name: "registry-node-a", target: "127.0.0.1:5000", allowed_peers: [keys["node-a"].id] },
      { name: "registry-node-b", target: "127.0.0.1:5000", allowed_peers: [keys["node-b"].id] },
    ]);
    expect(c.links).toEqual([]);
    // Snapshots without a scoped listener stay version 1, for agents that know only it.
    expect([b.v, c.v]).toEqual([1, 1]);
    // No listener anywhere binds every interface.
    for (const snap of [a, b, c])
      for (const link of snap.links as Array<{ listen: string }>)
        expect(link.listen).toMatch(/^(127\.0\.0\.1|bridge):\d+$/);
  });

  it("refuses to take over a registry link name that someone declared", async () => {
    process.env.ERAINFRA_REGISTRY_NODE = "node-c";
    const s = await setup();
    await s.beat();
    await s.t.run((ctx) => ctx.db.patch(s.nodes["node-c"].nodeId, { endpointProvenAt: T0 }));
    await s.t.run((ctx) =>
      ctx.db.insert("meshLinks", {
        name: "registry-node-a",
        providerNodeId: s.nodes["node-b"].nodeId,
        providerPort: 8080,
        consumerNodeId: s.nodes["node-a"].nodeId,
        localPort: 8080,
        createdBy: "user",
        updatedAt: T0,
      }),
    );
    const id = await s.startUpload("shop", await s.upload());
    await s.agent("node-a", () => ({ outcome: "success", spec: SHOP_SPEC }));
    expect(await s.deployment(id)).toMatchObject({
      stage: "failed",
      error: "the mesh link name registry-node-a is taken by a link someone declared",
    });
  });

  it("fails a build before it starts while the registry is unset, malformed or out of reach", async () => {
    const s = await setup();
    await s.beat();
    const attempt = async () => {
      const id = await s.startUpload("shop", await s.upload());
      await s.agent("node-a", () => ({ outcome: "success", spec: SHOP_SPEC }));
      const run = await s.deployment(id);
      expect(run.stage).toBe("failed");
      expect(run.detail).toBe("planning");
      expect((await s.pending("node-a")).map((c) => c.kind)).toEqual([]);
      return run.error;
    };

    delete process.env.ERAINFRA_REGISTRY;
    expect(await attempt()).toContain("ERAINFRA_REGISTRY is not set in the Convex environment");

    process.env.ERAINFRA_REGISTRY = "http://127.0.0.1:61050";
    expect(await attempt()).toContain("is not a registry address");

    // The registry Node has never proven a mesh endpoint (it is still in Hub mode), so no other
    // Node can reach the registry it runs.
    process.env.ERAINFRA_REGISTRY = "127.0.0.1:61050";
    process.env.ERAINFRA_REGISTRY_NODE = "node-c";
    expect(await attempt()).toContain("the registry Node node-c (ERAINFRA_REGISTRY_NODE)");
  });

  it("deploys an App that builds nothing without a registry", async () => {
    delete process.env.ERAINFRA_REGISTRY;
    const s = await setup();
    await s.beat();
    const spec = "services:\n  web:\n    image: nginx:1\n    port: 80\n    route: true\n";
    const id = await s.startUpload("plain", await s.upload());
    await s.agent("node-a", () => ({ outcome: "success", spec }));
    await s.agent("node-a");
    expect((await s.deployment(id)).stage).toBe("done");
  });
});

describe("failover", () => {
  it("waits for a missed-heartbeat window and a grace period, not one gap", async () => {
    const s = await setup();
    await s.beat();
    await s.deployShop();
    const check = () => s.t.mutation(internal.infra.failover.check, {});

    // Two heartbeat intervals without node-a: a late or lost beat, not an outage.
    vi.setSystemTime(T0 + 80_000);
    await s.beat("node-b", "node-c");
    expect(await check()).toEqual([]);
    // Past the window: suspected, but nothing moves on one observation.
    vi.setSystemTime(T0 + NODE_SILENCE_MS + 5_000);
    await s.beat("node-b", "node-c");
    expect(await check()).toEqual([]);
    vi.setSystemTime(T0 + NODE_SILENCE_MS + 5_000 + FAILOVER_GRACE_MS - 1_000);
    expect(await check()).toEqual([]);
    // node-a comes back within the grace period: the suspicion is dropped.
    await s.beat("node-a");
    expect(await check()).toEqual([]);
    vi.setSystemTime(T0 + NODE_SILENCE_MS + 5_000 + FAILOVER_GRACE_MS + 1_000);
    expect(await check()).toEqual([]);
    const runs = await s.t.run((ctx) => ctx.db.query("appDeployments").collect());
    expect(runs.filter((r) => r.operation === "failover")).toEqual([]);
  });

  it("moves every service off a lost primary Node, then flips the route", async () => {
    const s = await setup();
    await s.beat();
    await s.deployShop();
    const a = s.nodes["node-a"].nodeId;
    const b = s.nodes["node-b"].nodeId;

    let now = T0 + NODE_SILENCE_MS + 1_000;
    vi.setSystemTime(now);
    await s.beat("node-b", "node-c");
    expect(await s.t.mutation(internal.infra.failover.check, {})).toEqual([]);
    now += FAILOVER_GRACE_MS;
    vi.setSystemTime(now);
    await s.beat("node-b", "node-c");
    const [runId] = await s.t.mutation(internal.infra.failover.check, {});
    expect(runId).toBeDefined();
    await s.settle();
    // One outage fails over once.
    expect(await s.t.mutation(internal.infra.failover.check, {})).toEqual([]);

    const run = await s.deployment(runId);
    expect(run).toMatchObject({ operation: "failover", stage: "deploying" });
    // node-b is the first survivor by name. web joins db there, so only node-b redeploys.
    expect(run.plan?.deployNodeIds).toEqual([b]);
    expect(await s.pending("node-c")).toEqual([]);
    const lease = await s.t.run((ctx) => ctx.db.query("appLeases").first());
    expect(lease).toMatchObject({ operation: "failover" });

    const routeBefore = await s.t.run((ctx) => ctx.db.query("appRoutes").first());
    expect(routeBefore?.nodeId).toBe(a);
    const onB = await s.agent("node-b");
    expect(onB[0].payload.services.map((x: { name: string; image: string }) => x.name)).toEqual([
      "web",
      "db",
    ]);
    // No rebuild: the image already built is redeployed.
    expect(onB[0].payload.services[0].image).toMatch(/^127\.0\.0\.1:5000\/shop-web:/);
    expect(onB[0].payload.services[0].env).toMatchObject({ DB_HOST: "db", DB_PORT: "5432" });

    expect((await s.deployment(runId)).stage).toBe("done");
    const after = await s.t.run(async (ctx) => ({
      app: await ctx.db.query("apps").first(),
      route: await ctx.db.query("appRoutes").first(),
      retire: await ctx.db
        .query("nodeCommands")
        .withIndex("by_node_status", (q) => q.eq("nodeId", a).eq("status", "pending"))
        .collect(),
    }));
    expect(after.app?.nodeId).toBe(b);
    expect(after.app?.services.map((x) => [x.name, x.nodeId])).toEqual([
      ["web", b],
      ["db", b],
    ]);
    expect(after.app?.links).toEqual([]);
    expect(after.route?.nodeId).toBe(b);
    // The lost Node, if it was only partitioned, removes its copy when it returns.
    expect(after.retire.map((c) => c.command)).toEqual([
      { kind: "operate", operation: { name: "container.remove", args: { name: "shop-web" } } },
    ]);
  });

  it("moves a route to the survivor's own port, and gateway ingress follows it there", async () => {
    const s = await setup();
    await s.beat();
    await s.deployShop();
    const a = s.nodes["node-a"].nodeId;
    const b = s.nodes["node-b"].nodeId;
    const c = s.nodes["node-c"].nodeId;
    const allocation = (nodeId: Id<"nodes">, key: string) =>
      s.t.run((ctx) =>
        ctx.db
          .query("portAllocations")
          .withIndex("by_node_key", (q) => q.eq("nodeId", nodeId).eq("key", key))
          .unique(),
      );
    const oldPort = (await allocation(a, "shop/web"))!.port;
    // On the survivor, web's old port number already belongs to another App.
    await s.t.run((ctx) =>
      ctx.db.insert("portAllocations", {
        nodeId: b,
        key: "other/web",
        port: oldPort,
        app: "other",
        allocatedAt: T0,
      }),
    );
    // node-c is a gateway; node-b and node-c prove their mesh keys.
    const prove = async (name: string) => {
      const key = await newKey();
      const address = { id: key.id, relay_urls: [], direct_addrs: ["127.0.0.1:4433"] };
      const res = await s.nodeApi("endpoint/challenge", name, { address });
      expect(res.status).toBe(200);
      const { challengeId, message } = (await res.json()) as {
        challengeId: string;
        message: string;
      };
      const signature = new Uint8Array(
        await crypto.subtle.sign("Ed25519", key.pair.privateKey, new TextEncoder().encode(message)),
      );
      const published = await s.nodeApi("endpoint", name, {
        challengeId,
        signature: btoa(String.fromCharCode(...signature)),
      });
      expect(published.status).toBe(200);
      return key.id;
    };
    const idB = await prove("node-b");
    const idC = await prove("node-c");
    await s.human.mutation(api.infra.nodes.setPlacementRoles, { nodeId: c, roles: ["gateway"] });

    let now = T0 + NODE_SILENCE_MS + 1_000;
    vi.setSystemTime(now);
    await s.beat("node-b", "node-c");
    await s.t.mutation(internal.infra.failover.check, {});
    now += FAILOVER_GRACE_MS;
    vi.setSystemTime(now);
    await s.beat("node-b", "node-c");
    const [runId] = await s.t.mutation(internal.infra.failover.check, {});
    await s.settle();
    await s.agent("node-b");
    expect((await s.deployment(runId)).stage).toBe("done");

    const newPort = (await allocation(b, "shop/web"))!.port;
    expect(newPort).not.toBe(oldPort);
    const state = await s.t.run(async (ctx) => ({
      route: await ctx.db.query("appRoutes").first(),
      app: await ctx.db.query("apps").first(),
    }));
    expect(state.route).toMatchObject({ nodeId: b, port: newPort });
    expect(state.app?.services.find((x) => x.name === "web")).toMatchObject({
      nodeId: b,
      port: newPort,
    });
    const snapshot = async (name: string) => {
      const r = await s.t.query(internal.infra.nodeState.state, {
        credential: s.nodes[name].credential,
      });
      if (r.unchanged) throw new Error("expected a full snapshot");
      return r.desired;
    };
    // The exposure on the new Node targets the port web was deployed on there, never `other`'s.
    const onB = (await snapshot("node-b")).exposures.filter((e) => e.name === "ingress.shop");
    expect(onB).toEqual([
      {
        name: "ingress.shop",
        target: `127.0.0.1:${newPort}`,
        allowed_peers: [idC],
        max_connections: 1024,
      },
    ]);
    const gateway = await snapshot("node-c");
    expect(gateway.links.find((l) => l.name === "ingress.shop")?.peer).toBe(idB);
    expect(gateway.ingress?.routes).toEqual([
      { host: "shop", upstream: expect.stringMatching(/^127\.0\.0\.1:61\d{3}$/) },
    ]);
  });

  it("moves a service on a lost secondary Node and records each service's new Node", async () => {
    const s = await setup();
    await s.beat();
    await s.deployShop();
    const a = s.nodes["node-a"].nodeId;
    const c = s.nodes["node-c"].nodeId;
    // node-b (db only; the App's primary is node-a) is lost. The Hub keyed group failover on the
    // primary Node alone and would not have moved db at all.
    let now = T0 + NODE_SILENCE_MS + 1_000;
    vi.setSystemTime(now);
    await s.beat("node-a", "node-c");
    await s.t.mutation(internal.infra.failover.check, {});
    now += FAILOVER_GRACE_MS;
    vi.setSystemTime(now);
    await s.beat("node-a", "node-c");
    const [runId] = await s.t.mutation(internal.infra.failover.check, {});
    await s.settle();
    const run = await s.deployment(runId);
    // node-a is the first survivor; db joins web there.
    expect(run.failover).toMatchObject({ toNodeId: a });
    await s.agent("node-a");
    expect((await s.deployment(runId)).stage).toBe("done");
    const app = await s.t.run((ctx) => ctx.db.query("apps").first());
    expect(app?.nodeId).toBe(a);
    expect(app?.services.map((x) => [x.name, x.nodeId])).toEqual([
      ["web", a],
      ["db", a],
    ]);
    expect(app?.services.some((x) => x.nodeId === c)).toBe(false);
  });
});
