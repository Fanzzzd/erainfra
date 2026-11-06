// One owner per name across Apps (infra/namespace.ts) and per route label (infra/apps.ts): App and
// service names may both contain `-`, so `<app>-<name>` joins can name another App's container,
// volume, mesh link or route. Driven end to end through the operator API and the Node API, with
// Infra Agents simulated by the test. Nothing here reaches a network.
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import schema from "../convex/schema";
import { upsertRoute } from "../convex/infra/apps";
import { RENAME_LOSES_DATA } from "../convex/infra/namespace";
import { insertNodeCommand } from "../convex/infra/nodeCommands";
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
    image: registry.test:5000/postgres:16
    port: 5432
    node: node-b
    volumes: [pgdata:/var/lib/postgresql/data]
`;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
  process.env.ERAINFRA_SECRETS_MASTER_KEY = "22".repeat(32);
  process.env.ERAINFRA_APP_DOMAIN = "apps.example.com";
  process.env.ERAINFRA_REGISTRY = "registry.test:5000";
});
afterEach(() => {
  vi.useRealTimers();
  for (const name of ["ERAINFRA_SECRETS_MASTER_KEY", "ERAINFRA_APP_DOMAIN", "ERAINFRA_REGISTRY"])
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
  const operator = (method: string, path: string, data?: unknown) =>
    t.fetch(`/api/v1/${path}`, {
      method,
      headers: { Authorization: `Bearer ${admin}`, "Content-Type": "application/json" },
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
      const reported = await nodeApi("commands/result", name, { ...body, ...decide(p, cmd) });
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
    const res = await operator("POST", "deployments", {
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
  /**
   * Deploy `app` from `spec` with prebuilt images only: read the spec on node-a, then let every
   * Node run what it is sent. Returns the run and every deploy payload a Node received.
   */
  const deploy = async (app: string, spec: string) => {
    const id = await startUpload(app, await upload(app));
    await agent("node-a", () => ({ outcome: "success", spec }));
    const seen = [];
    for (const name of names) seen.push(...(await agent(name)));
    return { run: await deployment(id), seen };
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
  const route = (label: string) =>
    t.run((ctx) =>
      ctx.db
        .query("appRoutes")
        .withIndex("by_name", (q) => q.eq("name", label))
        .unique(),
    );
  /** Give a Node a proven mesh endpoint, as connect-convex Nodes publish one. Returns its id. */
  const prove = async (name: string) => {
    const pair = (await crypto.subtle.generateKey("Ed25519", true, [
      "sign",
      "verify",
    ])) as CryptoKeyPair;
    const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
    const id = Array.from(raw, (b) => b.toString(16).padStart(2, "0")).join("");
    const address = { id, relay_urls: [], direct_addrs: ["127.0.0.1:4433"] };
    const res = await nodeApi("endpoint/challenge", name, { address });
    const { challengeId, message } = (await res.json()) as {
      challengeId: string;
      message: string;
    };
    const signature = new Uint8Array(
      await crypto.subtle.sign("Ed25519", pair.privateKey, new TextEncoder().encode(message)),
    );
    await nodeApi("endpoint", name, {
      challengeId,
      signature: btoa(String.fromCharCode(...signature)),
    });
    return id;
  };
  const gatewaySnapshot = async (name: string) => {
    const state = await t.query(internal.infra.nodeState.state, {
      credential: nodes[name].credential,
    });
    if (state.unchanged) throw new Error("expected a snapshot");
    return state.desired;
  };
  return {
    t,
    human,
    nodes,
    beat,
    settle,
    operator,
    pending,
    agent,
    deployment,
    upload,
    startUpload,
    deploy,
    deployShop,
    route,
    prove,
    gatewaySnapshot,
  };
}

const image = (name: string) => `registry.test:5000/${name}:1`;

describe("route ownership across Apps", () => {
  it("refuses an App whose spec claims a route label another App already serves", async () => {
    const s = await setup();
    await s.beat();
    await s.deployShop();
    const a = s.nodes["node-a"].nodeId;
    const c = s.nodes["node-c"].nodeId;
    const idA = await s.prove("node-a");
    await s.prove("node-b");
    await s.prove("node-c");
    await s.human.mutation(api.infra.nodes.setPlacementRoles, { nodeId: c, roles: ["gateway"] });
    expect(await s.route("shop")).toMatchObject({ nodeId: a, app: "shop", service: "web" });

    // A second App, deployed from another source, names the first App's public label.
    const evil = `
services:
  web:
    image: ${image("evil")}
    port: 8080
    route: shop
`;
    const id = await s.startUpload("evil", await s.upload("evil-src"), { node: "node-b" });
    await s.agent("node-a", () => ({ outcome: "success", spec: evil }));
    // Refused at planning: node-b is never asked to start anything.
    expect(await s.agent("node-b")).toEqual([]);
    const run = await s.deployment(id);
    expect(run.stage).toBe("failed");
    expect(run.error).toContain('route label "shop"');
    expect(run.error).toContain('App "evil"');
    expect(run.error).toContain('App "shop"');
    expect(await s.route("shop")).toMatchObject({ nodeId: a, app: "shop" });
    const gw = await s.gatewaySnapshot("node-c");
    expect(gw.links.find((l: { name: string }) => l.name === "ingress.shop")?.peer).toBe(idA);
  });

  it("refuses the `route: true` label of one App that equals another App's, in either order", async () => {
    const twoRouted = `
services:
  web: { image: "${image("w")}", port: 3000, route: true }
  api: { image: "${image("a")}", port: 4000, route: true }
`;
    const oneRouted = `
services:
  site: { image: "${image("s")}", port: 3000, route: true }
`;
    // App shop's web is `shop-web`; App shop-web's only routed service is `shop-web`.
    const s = await setup();
    await s.beat();
    const shop = await s.deploy("shop", twoRouted);
    expect(shop.run.stage).toBe("done");
    expect(shop.run.urls).toEqual([
      "https://shop-web.apps.example.com",
      "https://shop-api.apps.example.com",
    ]);
    const second = await s.deploy("shop-web", oneRouted);
    expect(second.run.stage).toBe("failed");
    expect(second.seen).toEqual([]);
    expect(second.run.error).toContain('route label "shop-web"');
    expect(await s.route("shop-web")).toMatchObject({ app: "shop", service: "web" });

    const r = await setup();
    await r.beat();
    expect((await r.deploy("shop-web", oneRouted)).run.stage).toBe("done");
    const reverse = await r.deploy("shop", twoRouted);
    expect(reverse.run.stage).toBe("failed");
    expect(reverse.run.error).toContain('route label "shop-web"');
    expect(reverse.run.error).toContain('App "shop-web" already holds it');
    expect(await r.route("shop-web")).toMatchObject({ app: "shop-web", service: "site" });
  });

  it("keeps a route with its App through failover", async () => {
    const s = await setup();
    await s.beat();
    await s.deployShop();
    const b = s.nodes["node-b"].nodeId;
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
    expect(await s.route("shop")).toMatchObject({ nodeId: b, app: "shop", service: "web" });
  });

  it("serves a label two App rows route at 503 instead of the last one read", async () => {
    const s = await setup();
    await s.beat();
    await s.deployShop();
    await s.prove("node-a");
    await s.prove("node-b");
    await s.prove("node-c");
    const c = s.nodes["node-c"].nodeId;
    await s.human.mutation(api.infra.nodes.setPlacementRoles, { nodeId: c, roles: ["gateway"] });
    const before = await s.gatewaySnapshot("node-c");
    expect(
      before.ingress?.routes.find((r: { host: string }) => r.host === "shop")?.upstream,
    ).not.toBe(null);
    // Rows written before route ownership existed: a second App row routing at `shop`, and the
    // route row without an owner.
    const shopRoute = (await s.route("shop"))!;
    await s.t.run(async (ctx) => {
      await ctx.db.insert("apps", {
        name: "evil",
        nodeId: shopRoute.nodeId,
        services: [
          { name: "web", image: image("evil"), args: [], port: shopRoute.port, route: "shop" },
        ],
        links: [],
        updatedAt: Date.now(),
      });
      await ctx.db.patch(shopRoute._id, { app: undefined, service: undefined });
    });
    const after = await s.gatewaySnapshot("node-c");
    expect(after.ingress?.routes.find((r: { host: string }) => r.host === "shop")?.upstream).toBe(
      null,
    );
    expect(after.links.some((l: { name: string }) => l.name === "ingress.shop")).toBe(false);
    // Neither App may claim it while both route at it, not even its owner.
    const redeploy = await s.deploy("shop", SHOP_SPEC);
    expect(redeploy.run.stage).toBe("failed");
    expect(redeploy.run.error).toContain('route label "shop": more than one App already holds it');
    // Once the other App stops routing at it, the label is shop's again and served again.
    const fixed = await s.deploy("evil", `services:\n  web: { image: "${image("e")}" }\n`);
    expect(fixed.run.stage).toBe("done");
    const served = await s.gatewaySnapshot("node-c");
    expect(
      served.ingress?.routes.find((r: { host: string }) => r.host === "shop")?.upstream,
    ).not.toBe(null);
  });

  it("refuses a route write for another App at the data layer too", async () => {
    const s = await setup();
    await s.beat();
    await s.deployShop();
    const a = s.nodes["node-a"].nodeId;
    const write = (app: string, service?: string) =>
      s.t.run((ctx) =>
        upsertRoute(ctx, {
          name: "shop",
          nodeId: a,
          image: image("x"),
          port: 62999,
          app,
          ...(service === undefined ? {} : { service }),
        }),
      );
    await expect(write("evil", "web")).rejects.toThrow(/belongs to App "shop"/);
    // The owner may move it to another of its services.
    await write("shop", "db");
    expect(await s.route("shop")).toMatchObject({ app: "shop", service: "db", port: 62999 });
  });
});

describe("Docker names across Apps", () => {
  it("refuses two Apps whose <app>-<service> container names collide", async () => {
    const s = await setup();
    await s.beat();
    const first = await s.deploy("shop-web", `services:\n  api:\n    image: ${image("a")}\n`);
    expect(first.run.stage).toBe("done");
    const second = await s.deploy("shop", `services:\n  web-api:\n    image: ${image("b")}\n`);
    expect(second.run.stage).toBe("failed");
    // Refused before the Node was asked to replace shop-web's container.
    expect(second.seen).toEqual([]);
    expect(second.run.error).toBe(
      'App "shop" cannot use the container name "shop-web-api": App "shop-web" already holds it. Rename the App, or the service, volume or dependency that derives it',
    );
  });

  it("never hands two Apps the same Docker volume", async () => {
    const s = await setup();
    await s.beat();
    const victim = await s.deploy(
      "shop",
      `services:\n  db:\n    image: ${image("postgres")}\n    volumes: [db-data:/var/lib/postgresql/data]\n`,
    );
    expect(victim.run.stage).toBe("done");
    expect(victim.seen[0].payload.services[0].args).toEqual([
      "-v",
      "shop-db-data:/var/lib/postgresql/data",
    ]);
    const other = await s.deploy(
      "shop-db",
      `services:\n  web:\n    image: ${image("x")}\n    volumes: [data:/steal]\n`,
    );
    expect(other.run.stage).toBe("failed");
    expect(other.seen).toEqual([]);
    expect(other.run.error).toContain(
      'the volume name "shop-db-data": App "shop" already holds it',
    );
    // Renaming the volume or the App is the advice, and it would start from an empty volume.
    expect(other.run.error).toContain(RENAME_LOSES_DATA);
  });

  it("refuses a mesh link name two Apps get from the 30-character truncation", async () => {
    const spec = `
services:
  web:
    image: ${image("w")}
    needs: [db]
  db:
    image: ${image("d")}
    port: 5432
    node: node-b
`;
    const stem = "a".repeat(30);
    const s = await setup();
    await s.beat();
    const first = await s.deploy(`${stem}-one`, spec);
    expect(first.run.stage).toBe("done");
    expect(first.run.plan?.links.map((l) => l.name)).toEqual([`${stem}-db`]);
    const second = await s.deploy(`${stem}-two`, spec);
    expect(second.run.stage).toBe("failed");
    expect(second.seen).toEqual([]);
    expect(second.run.error).toContain(
      `the mesh link "${stem}-db": App "${stem}-one" already holds it`,
    );
  });

  it("refuses the second of two first deploys whose names collide while both are in flight", async () => {
    const s = await setup();
    await s.beat();
    // shop-web plans and waits on its deploy step; shop plans while it is still in flight.
    const firstId = await s.startUpload("shop-web", await s.upload("one"));
    await s.agent("node-a", () => ({
      outcome: "success",
      spec: `services:\n  api: { image: "${image("a")}" }\n`,
    }));
    expect((await s.deployment(firstId)).stage).toBe("deploying");
    const secondId = await s.startUpload("shop", await s.upload("two"));
    const deploys = await s.agent("node-a", (_payload, cmd) =>
      cmd.kind === "spec"
        ? { outcome: "success", spec: `services:\n  web-api: { image: "${image("b")}" }\n` }
        : { outcome: "success" },
    );
    expect(deploys.map((d) => d.payload.app ?? d.cmd.kind)).toEqual(["shop-web", "spec"]);
    expect((await s.deployment(firstId)).stage).toBe("done");
    const second = await s.deployment(secondId);
    expect(second.stage).toBe("failed");
    expect(second.error).toContain('App "shop-web" already holds it');
  });

  it("lets two Apps share a name prefix when no derived name collides", async () => {
    const s = await setup();
    await s.beat();
    const spec = `services:\n  web: { image: "${image("w")}", port: 3000, route: true, volumes: ["data:/d"] }\n`;
    expect((await s.deploy("shop", spec)).run.stage).toBe("done");
    expect((await s.deploy("shop-staging", spec)).run.stage).toBe("done");
    // And an App redeploys over its own names.
    expect((await s.deploy("shop", spec)).run.stage).toBe("done");
  });
});

describe("removing an App and retiring containers by exact name", () => {
  it("refuses `apps remove` of a label another App routes at, and touches none of its containers", async () => {
    const s = await setup();
    await s.beat();
    const shop = await s.deploy(
      "shop",
      `services:\n  web: { image: "${image("w")}", port: 3000, route: true }\n  api: { image: "${image("a")}", port: 4000, route: true }\n`,
    );
    expect(shop.run.stage).toBe("done");
    const res = await s.operator("DELETE", "apps/shop-web");
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: { message: string } }).error.message).toContain(
      'the route shop-web belongs to App "shop"',
    );
    expect(await s.pending("node-a")).toEqual([]);
    expect(await s.route("shop-web")).toMatchObject({ app: "shop", service: "web" });
    // The App itself is removed by its own name, its two containers exactly.
    const removed = await s.operator("DELETE", "apps/shop");
    expect(removed.status).toBe(202);
    const body = (await removed.json()) as {
      removal: { containers: Array<{ container: string }>; routes: string[] };
    };
    expect(body.removal.containers.map((c) => c.container).toSorted()).toEqual([
      "shop-api",
      "shop-web",
    ]);
    expect(body.removal.routes.toSorted()).toEqual(["shop-api", "shop-web"]);
  });

  it("still removes a single-container App the Hub deployed by its route", async () => {
    const s = await setup();
    await s.beat();
    const a = s.nodes["node-a"].nodeId;
    await s.t.run((ctx) =>
      ctx.db.insert("appRoutes", {
        name: "solo",
        nodeId: a,
        image: image("solo"),
        port: 62000,
        updatedAt: Date.now(),
      }),
    );
    const removed = await s.operator("DELETE", "apps/solo");
    expect(removed.status).toBe(202);
    const queued = await s.t.run((ctx) =>
      ctx.db
        .query("nodeCommands")
        .withIndex("by_node_status", (q) => q.eq("nodeId", a).eq("status", "pending"))
        .collect(),
    );
    expect(queued.map((c) => c.command)).toEqual([
      { kind: "operate", operation: { name: "container.remove", args: { name: "solo" } } },
    ]);
  });

  it("cancels only the retirements of the containers a run starts, not another App's", async () => {
    const s = await setup();
    await s.beat();
    const b = s.nodes["node-b"].nodeId;
    // A failover of App shop-web queued the retirement of its old container on node-b.
    await s.t.run((ctx) =>
      insertNodeCommand(ctx, {
        nodeId: b,
        idempotencyKey: "older-run:retire-api:node-b",
        command: {
          kind: "operate",
          operation: { name: "container.remove", args: { name: "shop-web-api" } },
        },
      }),
    );
    // App shop plans a deploy to node-b. Its names start with `shop-` too.
    const id = await s.startUpload("shop", await s.upload(), { node: "node-b" });
    await s.agent("node-a", () => ({
      outcome: "success",
      spec: `services:\n  web: { image: "${image("w")}" }\n`,
    }));
    expect((await s.deployment(id)).stage).toBe("deploying");
    const retire = await s.t.run((ctx) =>
      ctx.db
        .query("nodeCommands")
        .withIndex("by_node_key", (q) =>
          q.eq("nodeId", b).eq("idempotencyKey", "older-run:retire-api:node-b"),
        )
        .unique(),
    );
    expect(retire?.status).toBe("pending");
  });
});
