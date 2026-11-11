import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { api, internal } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { LOG_TTL_MS, MAX_LOG_BYTES } from "../convex/infra/logs";
import schema from "../convex/schema";
import { setUpBefore } from "./support/clock.ts";

// The infrastructure routes of the operator API (infra/operatorRoutes.ts): scopes, audit, and the
// log-tail lifecycle, end to end through t.fetch as the `erainfra` CLI calls them.

const modules = import.meta.glob("../convex/**/*.ts");
const T0 = Date.parse("2026-11-06T00:00:00Z");

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
  process.env.ERAINFRA_SECRETS_MASTER_KEY = "22".repeat(32);
});
afterEach(() => {
  vi.useRealTimers();
  delete process.env.ERAINFRA_SECRETS_MASTER_KEY;
  delete process.env.ERAINFRA_APP_DOMAIN;
});

async function fixture() {
  const t = convexTest(schema, modules);
  const owner = await t.run((ctx) =>
    ctx.db.insert("users", { email: "owner@example.test", role: "owner" }),
  );
  const human = t.withIdentity({ subject: `${owner}|session` });
  const admin = (await human.mutation(api.apiTokens.create, { name: "ci-admin", scope: "admin" }))
    .token;
  const otherAdmin = (
    await human.mutation(api.apiTokens.create, { name: "other-admin", scope: "admin" })
  ).token;
  const read = (await human.mutation(api.apiTokens.create, { name: "reader", scope: "read" }))
    .token;
  const metrics = (await human.mutation(api.apiTokens.create, { name: "prom", scope: "metrics" }))
    .token;
  const call = async (method: string, path: string, token?: string, body?: unknown) => {
    const response = await t.fetch(`/api/v1${path}`, {
      method,
      headers: {
        ...(token === undefined ? {} : { Authorization: `Bearer ${token}` }),
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    return { status: response.status, body: text === "" ? null : JSON.parse(text), text };
  };
  const node = (path: string, credential: string, data?: unknown) =>
    t.fetch(`/api/v1/nodes/${path}`, {
      method: data === undefined ? "GET" : "POST",
      headers: { Authorization: `Bearer ${credential}`, "Content-Type": "application/json" },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    });
  const audit = async () =>
    await t.run(async (ctx) => {
      const rows = await ctx.db.query("auditEvents").withIndex("by_seq").collect();
      return rows.map((r) => ({
        actor: r.actor,
        action: r.action,
        target: r.target,
        outcome: r.outcome,
        meta: r.metaJson === undefined ? undefined : JSON.parse(r.metaJson),
      }));
    });
  return { t, human, admin, otherAdmin, read, metrics, call, node, audit };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

/** Enroll a Node through the API and heartbeat it once, so Convex sees it in connect-convex mode. */
async function liveNode(f: Fixture, name: string) {
  const enrolled = await f.call("POST", "/nodes", f.admin, { name });
  expect(enrolled.status).toBe(201);
  expect((await f.node("heartbeat", enrolled.body.credential, { version: "test" })).status).toBe(
    200,
  );
  return {
    id: enrolled.body.node.id as Id<"nodes">,
    credential: enrolled.body.credential as string,
  };
}

/** Give a Node a proven endpoint, as a completed challenge (nodeState.publish) would. */
async function prove(f: Fixture, nodeId: Id<"nodes">, key: string) {
  await f.t.run((ctx) =>
    ctx.db.patch(nodeId, {
      endpointId: key,
      meshAddress: { id: key, relay_urls: [], direct_addrs: [] },
      endpointProvenAt: Date.now(),
    }),
  );
}

async function seedApp(f: Fixture, nodeId: Id<"nodes">, services = ["web", "worker"]) {
  await f.t.run(async (ctx) => {
    await ctx.db.insert("apps", {
      name: "shop",
      nodeId,
      services: services.map((name, i) => ({
        name,
        image: `127.0.0.1:5000/shop-${name}:abc`,
        args: [],
        ...(i === 0 ? { port: 62000, route: "shop" } : {}),
      })),
      links: [],
      updatedAt: Date.now(),
    });
    await ctx.db.insert("appRoutes", {
      name: "shop",
      nodeId,
      image: "127.0.0.1:5000/shop-web:abc",
      port: 62000,
      updatedAt: Date.now(),
    });
    await ctx.db.insert("portAllocations", {
      nodeId,
      key: "shop/web",
      port: 62000,
      app: "shop",
      allocatedAt: Date.now(),
    });
  });
}

describe("scopes", () => {
  it("answers 401 without a valid token and 403 for a read or metrics token on a change", async () => {
    const f = await fixture();
    const changes: Array<[string, string, unknown?]> = [
      ["POST", "/nodes", { name: "edge-1" }],
      ["POST", "/nodes/edge-1/revoke", {}],
      ["POST", "/nodes/edge-1/endpoint/reset"],
      ["PUT", "/apps/shop/env", { vars: { A: "1" } }],
      ["DELETE", "/apps/shop/env/A"],
      ["DELETE", "/apps/shop"],
      ["POST", "/links", { provider: "a", providerPort: 1, consumer: "b" }],
      ["DELETE", "/links/a-1-b"],
      ["POST", "/logs", { app: "shop" }],
      ["GET", "/logs/whatever"],
    ];
    for (const [method, path, body] of changes) {
      expect((await f.call(method, path, undefined, body)).status, `${method} ${path}`).toBe(401);
      expect((await f.call(method, path, "erainfra_" + "0".repeat(64), body)).status).toBe(401);
      expect((await f.call(method, path, f.read, body)).status, `${method} ${path}`).toBe(403);
      expect((await f.call(method, path, f.metrics, body)).status).toBe(403);
    }
    for (const path of ["/nodes", "/apps", "/links", "/apps/shop/env"]) {
      expect((await f.call("GET", path)).status).toBe(401);
      expect((await f.call("GET", path, f.metrics)).status).toBe(403);
      expect((await f.call("GET", path, f.read)).status, path).toBe(200);
    }
    // Nothing was changed or audited by a refused token.
    expect(await f.audit()).toEqual([]);
  });

  it("refuses a Node credential on the infrastructure routes", async () => {
    const f = await fixture();
    const a = await liveNode(f, "node-a");
    for (const path of ["/nodes", "/apps", "/links"])
      expect((await f.call("GET", path, a.credential)).status).toBe(401);
    expect((await f.call("POST", "/nodes", a.credential, { name: "rogue" })).status).toBe(401);
  });

  it("does not shadow the Node API that shares the /api/v1/nodes prefix", async () => {
    const f = await fixture();
    const a = await liveNode(f, "node-a");
    expect((await f.node("commands", a.credential)).status).toBe(200);
    expect((await f.call("POST", "/nodes/node-a/explode", f.admin, {})).status).toBe(404);
    expect((await f.call("GET", "/apps/shop/secrets", f.read)).status).toBe(404);
  });
});

describe("Nodes", () => {
  it("enrolls, lists with transport and endpoint proof, and revokes, all audited", async () => {
    const f = await fixture();
    const created = await f.call("POST", "/nodes", f.admin, { name: "edge-1" });
    expect(created.status).toBe(201);
    expect(created.body.credential).toMatch(/^erainfra_node_[0-9a-f]{64}$/);

    let list = await f.call("GET", "/nodes", f.read);
    expect(list.body.nodes).toEqual([
      expect.objectContaining({
        name: "edge-1",
        transport: "hub",
        online: false,
        lastSeenAt: null,
        endpoint: expect.objectContaining({ id: null, proven: false, provenAt: null }),
        liveCredentials: 1,
      }),
    ]);
    // The credential is never listed, only its hint.
    expect(list.text).not.toContain(created.body.credential);

    // Each step on its own instant, so no two commits share one.
    vi.setSystemTime(T0 + 1_000);
    await f.node("heartbeat", created.body.credential, { version: "1.2.3" });
    vi.setSystemTime(T0 + 2_000);
    await prove(f, created.body.node.id, "ab".repeat(32));
    list = await f.call("GET", "/nodes", f.read);
    expect(list.body.nodes[0]).toMatchObject({
      transport: "convex",
      online: true,
      infraAgentVersion: "1.2.3",
      lastSeenAt: new Date(T0 + 1_000).toISOString(),
      endpoint: {
        id: "ab".repeat(32),
        proven: true,
        provenAt: new Date(T0 + 2_000).toISOString(),
      },
    });

    const revoked = await f.call("POST", "/nodes/edge-1/revoke", f.admin, {});
    expect(revoked.status).toBe(200);
    expect(revoked.body.revoked).toHaveLength(1);
    list = await f.call("GET", "/nodes", f.read);
    // Revoking the last credential takes the Node out of the mesh.
    expect(list.body.nodes[0]).toMatchObject({
      liveCredentials: 0,
      endpoint: { id: null, proven: false },
    });
    expect((await f.node("commands", created.body.credential)).status).toBe(401);

    const actions = (await f.audit()).map((r) => [r.actor, r.action, r.target, r.outcome]);
    expect(actions).toEqual([
      ["token:ci-admin", "nodes.enroll", "edge-1", "success"],
      [
        "token:ci-admin",
        "nodes.revokeCredential",
        expect.stringMatching(/^erainfra_node_/),
        "success",
      ],
      ["token:ci-admin", "nodes.resetEndpoint", "edge-1", "success"],
    ]);
  });

  it("audits refusals and answers 404 for an unknown Node", async () => {
    const f = await fixture();
    expect((await f.call("POST", "/nodes", f.admin, { name: "bad name!" })).status).toBe(400);
    expect((await f.call("POST", "/nodes", f.admin, { name: "x", extra: 1 })).status).toBe(400);
    expect((await f.call("POST", "/nodes/ghost/revoke", f.admin, {})).status).toBe(404);
    expect((await f.call("POST", "/nodes/ghost/endpoint/reset", f.admin)).status).toBe(404);
    expect((await f.audit()).map((r) => [r.action, r.outcome])).toEqual([
      ["nodes.enroll", "deny"],
      ["nodes.revokeCredential", "deny"],
      ["nodes.resetEndpoint", "deny"],
    ]);
  });

  it("revokes one credential by hint and keeps the Node's endpoint while another is live", async () => {
    const f = await fixture();
    const first = await f.call("POST", "/nodes", f.admin, { name: "edge-1" });
    await f.call("POST", "/nodes", f.admin, { name: "edge-1" });
    await prove(f, first.body.node.id, "cd".repeat(32));
    const hint = (first.body.credential as string).slice(0, "erainfra_node_".length + 8);
    const revoked = await f.call("POST", "/nodes/edge-1/revoke", f.admin, { credential: hint });
    expect(revoked.body.revoked).toEqual([hint]);
    const [node] = (await f.call("GET", "/nodes", f.read)).body.nodes;
    expect(node).toMatchObject({ liveCredentials: 1, endpoint: { proven: true } });
    expect(
      (await f.call("POST", "/nodes/edge-1/revoke", f.admin, { credential: "nope" })).status,
    ).toBe(404);
  });
});

describe("placement roles", () => {
  it("sets and clears a Node's roles through the API, as an admin token only", async () => {
    const f = await fixture();
    await f.call("POST", "/nodes", f.admin, { name: "edge-1" });
    expect(
      (await f.call("PUT", "/nodes/edge-1/roles", f.read, { roles: ["gateway"] })).status,
    ).toBe(403);
    const set = await f.call("PUT", "/nodes/edge-1/roles", f.admin, {
      roles: ["gateway", "compute", "gateway"],
    });
    expect(set.status).toBe(200);
    expect(set.body).toEqual({ node: "edge-1", placementRoles: ["compute", "gateway"] });
    expect((await f.call("GET", "/nodes", f.read)).body.nodes[0].placementRoles).toEqual([
      "compute",
      "gateway",
    ]);
    expect(
      (await f.call("PUT", "/nodes/edge-1/roles", f.admin, { roles: ["worker"] })).status,
    ).toBe(400);
    expect((await f.call("PUT", "/nodes/edge-1/roles", f.admin, { roles: "gateway" })).status).toBe(
      400,
    );
    expect((await f.call("PUT", "/nodes/ghost/roles", f.admin, { roles: [] })).status).toBe(404);
    expect((await f.call("PUT", "/nodes/edge-1/roles", f.admin, { roles: [] })).body).toEqual({
      node: "edge-1",
      placementRoles: [],
    });
    const rows = (await f.audit()).filter((r) => r.action === "nodes.setPlacementRoles");
    expect(rows.map((r) => [r.actor, r.outcome])).toEqual([
      ["token:ci-admin", "success"],
      ["token:ci-admin", "deny"],
      ["token:ci-admin", "deny"],
      ["token:ci-admin", "success"],
    ]);
    expect(rows[0].meta).toEqual({ from: [], to: ["compute", "gateway"] });
  });
});

describe("env", () => {
  it("sets, lists masked and unsets with a structured scope, never returning a value", async () => {
    const f = await fixture();
    expect(
      (
        await f.call("PUT", "/apps/shop/env", f.admin, {
          vars: { DATABASE_URL: "postgres://s3cret" },
        })
      ).status,
    ).toBe(200);
    const set = await f.call("PUT", "/apps/shop/env", f.admin, {
      vars: { API_KEY: "k-123" },
      service: "web",
    });
    expect(set.body).toEqual({ app: "shop", names: ["API_KEY"] });

    const env = await f.call("GET", "/apps/shop/env", f.read);
    expect(env.status).toBe(200);
    expect(env.body.env.app).toEqual([expect.objectContaining({ name: "DATABASE_URL" })]);
    expect(env.body.env.services.web).toEqual([expect.objectContaining({ name: "API_KEY" })]);
    expect(env.text).not.toContain("s3cret");
    expect(env.text).not.toContain("k-123");

    // Unsetting the App-wide name leaves the service's alone, and the reverse.
    expect((await f.call("DELETE", "/apps/shop/env/API_KEY", f.admin)).body.removed).toBe(false);
    expect(
      (await f.call("DELETE", "/apps/shop/env/API_KEY?service=web", f.admin)).body.removed,
    ).toBe(true);
    expect((await f.call("GET", "/apps/shop/env", f.read)).body.env.services).toEqual({});

    expect((await f.call("PUT", "/apps/shop/env", f.admin, { vars: { "1BAD": "x" } })).status).toBe(
      400,
    );
    expect((await f.call("PUT", "/apps/shop/env", f.admin, { vars: { A: 1 } })).status).toBe(400);
    expect((await f.call("DELETE", "/apps/shop/env/A?scope=web", f.admin)).status).toBe(400);

    const rows = await f.audit();
    expect(rows.map((r) => [r.actor, r.action, r.outcome])).toEqual([
      ["token:ci-admin", "env.set", "success"],
      ["token:ci-admin", "env.set", "success"],
      ["token:ci-admin", "env.unset", "success"],
      ["token:ci-admin", "env.set", "deny"],
    ]);
    expect(rows[1].meta).toEqual({ service: "web", names: ["API_KEY"] });
    expect(JSON.stringify(rows)).not.toContain("s3cret");
  });
});

describe("links", () => {
  it("declares, shows transport and state from endpoint proofs, and removes", async () => {
    const f = await fixture();
    const a = await liveNode(f, "node-a");
    const b = await liveNode(f, "node-b");
    const created = await f.call("POST", "/links", f.admin, {
      provider: "node-a",
      providerPort: 8080,
      consumer: "node-b",
    });
    expect(created.status).toBe(201);
    expect(created.body.link).toEqual({
      name: "node-a-8080-node-b",
      address: "127.0.0.1:8080",
      replaced: false,
    });

    let [link] = (await f.call("GET", "/links", f.read)).body.links;
    expect(link).toMatchObject({
      kind: "standalone",
      createdBy: "user",
      provider: "node-a",
      consumer: "node-b",
      listen: "127.0.0.1:8080",
      transport: "legacy",
      state: "pending",
    });
    expect(link.reason).toContain("node-a and node-b have no proven mesh endpoint");

    await prove(f, a.id, "a1".repeat(32));
    await prove(f, b.id, "b1".repeat(32));
    [link] = (await f.call("GET", "/links", f.read)).body.links;
    expect(link).toMatchObject({ transport: "mesh", state: "active", reason: null });

    // The consumer's snapshot now carries it, so the declared link reaches the Node.
    const snapshot = await (await f.node("state", b.credential)).json();
    expect(snapshot.desired.links).toEqual([
      expect.objectContaining({ name: "node-a-8080-node-b", listen: "127.0.0.1:8080" }),
    ]);

    vi.setSystemTime(T0 + 10 * 60_000);
    [link] = (await f.call("GET", "/links", f.read)).body.links;
    expect(link).toMatchObject({ transport: "mesh", state: "degraded" });

    expect((await f.call("DELETE", "/links/node-a-8080-node-b", f.admin)).status).toBe(200);
    expect((await f.call("GET", "/links", f.read)).body.links).toEqual([]);
    expect((await f.call("DELETE", "/links/node-a-8080-node-b", f.admin)).status).toBe(404);
    expect(
      (await f.audit())
        .filter((r) => r.action.startsWith("mesh."))
        .map((r) => [r.action, r.outcome]),
    ).toEqual([
      ["mesh.link", "success"],
      ["mesh.unlink", "success"],
      ["mesh.unlink", "deny"],
    ]);
  });

  it("refuses a link the mesh could not carry", async () => {
    const f = await fixture();
    await liveNode(f, "node-a");
    await liveNode(f, "node-b");
    const link = (body: Record<string, unknown>) => f.call("POST", "/links", f.admin, body);
    expect(
      (await link({ provider: "node-a", providerPort: 5432, consumer: "node-b", name: "db" }))
        .status,
    ).toBe(201);
    // Same consumer port under another name.
    const clash = await link({
      provider: "node-a",
      providerPort: 6000,
      consumer: "node-b",
      localPort: 5432,
    });
    expect(clash.status).toBe(400);
    expect(clash.body.error.message).toContain("already listens on port 5432");
    expect((await link({ provider: "node-a", providerPort: 1, consumer: "node-a" })).status).toBe(
      400,
    );
    expect(
      (await link({ provider: "node-a", providerPort: 70000, consumer: "node-b" })).status,
    ).toBe(400);
    expect((await link({ provider: "ghost", providerPort: 1, consumer: "node-b" })).status).toBe(
      404,
    );
    expect(
      (await link({ provider: "node-a", providerPort: 1, consumer: "node-b", name: "Bad_Name" }))
        .status,
    ).toBe(400);
    // A gateway's ingress links listen on this range.
    const reserved = await link({ provider: "node-a", providerPort: 61100, consumer: "node-b" });
    expect(reserved.status).toBe(400);
    expect(reserved.body.error.message).toContain("reserved for gateway ingress");
    // Re-declaring a name re-points it, as on the Hub.
    const again = await link({
      provider: "node-a",
      providerPort: 5433,
      consumer: "node-b",
      name: "db",
    });
    expect(again.body.link.replaced).toBe(true);
    // A link the deploy pipeline manages is not the operator's to re-point.
    await f.t.run(async (ctx) => {
      const row = await ctx.db.query("meshLinks").first();
      await ctx.db.patch(row!._id, { createdBy: "deploy" });
    });
    expect(
      (await link({ provider: "node-a", providerPort: 1, consumer: "node-b", name: "db" })).status,
    ).toBe(400);
  });
});

describe("Apps", () => {
  it("lists and reads status, then removes an App by queueing container removals", async () => {
    const f = await fixture();
    process.env.ERAINFRA_APP_DOMAIN = "apps.example.test";
    const a = await liveNode(f, "node-a");
    await seedApp(f, a.id);

    const list = await f.call("GET", "/apps", f.read);
    expect(list.body.apps).toEqual([
      expect.objectContaining({
        name: "shop",
        kind: "app",
        node: "node-a",
        status: "running",
        failover: false,
        lastDeployment: null,
      }),
    ]);
    expect(list.body.apps[0].services[0]).toMatchObject({
      name: "web",
      node: "node-a",
      container: "shop-web",
      url: "https://shop.apps.example.test",
    });
    const status = await f.call("GET", "/apps/shop", f.read);
    expect(status.body.app).toMatchObject({
      name: "shop",
      deployments: [],
      env: { app: [], services: {} },
    });
    expect((await f.call("GET", "/apps/nope", f.read)).status).toBe(404);

    const removed = await f.call("DELETE", "/apps/shop", f.admin);
    expect(removed.status).toBe(202);
    expect(removed.body.removal.containers).toEqual([
      { node: "node-a", container: "shop-web" },
      { node: "node-a", container: "shop-worker" },
    ]);
    const queued = await f.t.run((ctx) => ctx.db.query("nodeCommands").collect());
    expect(queued.map((c) => c.command)).toEqual([
      { kind: "operate", operation: { name: "container.remove", args: { name: "shop-web" } } },
      { kind: "operate", operation: { name: "container.remove", args: { name: "shop-worker" } } },
      {
        kind: "operate",
        operation: { name: "container.network.remove", args: { name: "shop-net" } },
      },
    ]);
    const left = await f.t.run(async (ctx) => ({
      apps: await ctx.db.query("apps").collect(),
      routes: await ctx.db.query("appRoutes").collect(),
      ports: await ctx.db.query("portAllocations").collect(),
    }));
    expect(left).toEqual({ apps: [], routes: [], ports: [] });
    expect((await f.call("GET", "/apps", f.read)).body.apps).toEqual([]);
    const row = (await f.audit()).find((r) => r.action === "apps.remove")!;
    expect(row).toMatchObject({ actor: "token:ci-admin", target: "shop", outcome: "success" });
  });

  it("refuses to remove an App while it deploys or while its Node is still on the Hub", async () => {
    const f = await fixture();
    const enrolled = await f.call("POST", "/nodes", f.admin, { name: "hub-node" });
    await seedApp(f, enrolled.body.node.id);
    const hub = await f.call("DELETE", "/apps/shop", f.admin);
    expect(hub.status).toBe(400);
    expect(hub.body.error.message).toContain("remove it on the Hub");
    expect((await f.call("GET", "/apps", f.read)).body.apps[0].status).toBe("hub");

    await f.node("heartbeat", enrolled.body.credential, { version: "t" });
    await f.t.run((ctx) =>
      ctx.db.insert("appLeases", {
        app: "shop",
        holder: "deployment:x",
        operation: "deploy",
        epoch: 1,
        expiresAt: Date.now() + 60_000,
        acquiredAt: Date.now(),
      }),
    );
    expect((await f.call("DELETE", "/apps/shop", f.admin)).status).toBe(409);
    expect(await f.t.run((ctx) => ctx.db.query("apps").collect())).toHaveLength(1);
    expect(await f.t.run((ctx) => ctx.db.query("nodeCommands").collect())).toEqual([]);
    expect(
      (await f.audit()).filter((r) => r.action === "apps.remove").map((r) => r.outcome),
    ).toEqual(["deny", "deny"]);
    expect((await f.call("DELETE", "/apps/ghost", f.admin)).status).toBe(404);
  });
});

async function request(f: Fixture, body: Record<string, unknown>, token = f.admin) {
  return await f.call("POST", "/logs", token, body);
}

/** Claim the one queued logs command as the Node, read its payload and report `report`. */
async function runOnNode(f: Fixture, credential: string, report: Record<string, unknown>) {
  const { commands } = await (await f.node("commands", credential)).json();
  expect(commands).toHaveLength(1);
  expect(commands[0].kind).toBe("logs");
  const claim = await (
    await f.node("commands/claim", credential, { commandId: commands[0].id, owner: "o" })
  ).json();
  const ids = { commandId: commands[0].id, owner: "o", epoch: claim.epoch };
  const payload = await (await f.node("commands/payload", credential, ids)).json();
  const result = await f.node("commands/result", credential, { ...ids, ...report });
  return { payload, result };
}

describe("log tails", () => {
  it("delivers a bounded tail once, to the requesting token only", async () => {
    const { f, a } = await setUpBefore(T0, async () => {
      const seeded = await fixture();
      const node = await liveNode(seeded, "node-a");
      await seedApp(seeded, node.id);
      return { f: seeded, a: node };
    });
    const asked = await request(f, { app: "shop", service: "worker", lines: 50 });
    expect(asked.status).toBe(202);
    const id = asked.body.logs.id;
    expect(asked.body.logs).toMatchObject({
      state: "pending",
      node: "node-a",
      lines: 50,
      target: { kind: "container", container: "shop-worker" },
      expiresAt: new Date(T0 + LOG_TTL_MS).toISOString(),
    });

    expect((await f.call("GET", `/logs/${id}`, f.admin)).status).toBe(202);
    // Another admin token, and a read token, learn nothing.
    expect((await f.call("GET", `/logs/${id}`, f.otherAdmin)).status).toBe(404);
    expect((await f.call("GET", `/logs/${id}`, f.read)).status).toBe(403);

    const secretish = "line 1\nDATABASE_URL=postgres://u:pw@db\n\u001b[31mred\u001b[0m\n";
    const { payload, result } = await runOnNode(f, a.credential, {
      outcome: "success",
      output: btoa(secretish),
      truncated: false,
    });
    expect(payload).toEqual({
      kind: "logs",
      operation: { name: "container.logs", args: { name: "shop-worker", lines: "50" } },
    });
    expect(result.status).toBe(200);
    // The output is held only in the requester's row, never on the command.
    const command = await f.t.run((ctx) => ctx.db.query("nodeCommands").first());
    expect(JSON.stringify(command)).not.toContain("DATABASE_URL");

    expect((await f.call("GET", `/logs/${id}`, f.otherAdmin)).status).toBe(404);
    const read = await f.call("GET", `/logs/${id}`, f.admin);
    expect(read.status).toBe(200);
    expect(read.body.logs).toMatchObject({ state: "ready", text: secretish, truncated: false });
    // Deleted on first read.
    expect((await f.call("GET", `/logs/${id}`, f.admin)).status).toBe(404);
    expect(await f.t.run((ctx) => ctx.db.query("logTails").collect())).toEqual([]);

    const rows = (await f.audit()).filter((r) => r.action.startsWith("logs."));
    expect(rows.map((r) => [r.actor, r.action, r.outcome])).toEqual([
      ["token:ci-admin", "logs.request", "attempt"],
      ["token:ci-admin", "logs.read", "success"],
    ]);
    expect(JSON.stringify(rows)).not.toContain("DATABASE_URL");
  });

  it("caps lines and bytes and refuses what a Node cannot answer", async () => {
    const f = await fixture();
    const a = await liveNode(f, "node-a");
    await seedApp(f, a.id);
    expect((await request(f, { app: "shop", service: "web", lines: 1001 })).status).toBe(400);
    expect((await request(f, { app: "shop", service: "web", lines: 0 })).status).toBe(400);
    // Several services: the request must name one.
    expect((await request(f, { app: "shop" })).body.error.message).toContain(
      "name one (web, worker)",
    );
    expect((await request(f, { app: "shop", service: "db" })).status).toBe(400);
    expect((await request(f, { app: "ghost" })).status).toBe(404);
    expect((await request(f, { node: "node-a", unit: "sshd" })).status).toBe(400);
    expect((await request(f, { app: "shop", node: "node-a", unit: "portless-agent" })).status).toBe(
      400,
    );
    expect((await request(f, { app: "shop", service: "web", argv: "x" })).status).toBe(400);

    // A Node that never connected to Convex (still on the Hub) is refused up front.
    await f.call("POST", "/nodes", f.admin, { name: "hub-node" });
    const hub = await request(f, { node: "hub-node", unit: "portless-agent" });
    expect(hub.status).toBe(400);
    expect(hub.body.error.message).toContain("portless logs");

    const asked = await request(f, { node: "node-a", unit: "erainfra-mesh.service", lines: 1000 });
    expect(asked.status).toBe(202);
    const tooBig = new Uint8Array(MAX_LOG_BYTES + 3).fill(65);
    let binary = "";
    for (const byte of tooBig) binary += String.fromCharCode(byte);
    const { payload, result } = await runOnNode(f, a.credential, {
      outcome: "success",
      output: btoa(binary),
    });
    expect(payload.operation).toEqual({
      name: "service.logs",
      args: { unit: "erainfra-mesh.service", lines: "1000" },
    });
    expect(result.status).toBe(409);
    expect((await f.call("GET", `/logs/${asked.body.logs.id}`, f.admin)).status).toBe(202);

    // Output is accepted only from a logs command.
    const denied = (await f.audit()).filter(
      (r) => r.action === "logs.request" && r.outcome === "deny",
    );
    expect(denied).toHaveLength(8);
  });

  it("reports a failed read, then forgets it", async () => {
    const f = await fixture();
    const a = await liveNode(f, "node-a");
    const asked = await request(f, { node: "node-a", unit: "portless-agent" });
    const { result } = await runOnNode(f, a.credential, { outcome: "failure" });
    expect(result.status).toBe(200);
    const read = await f.call("GET", `/logs/${asked.body.logs.id}`, f.admin);
    expect(read.body.logs.state).toBe("failed");
    expect((await f.call("GET", `/logs/${asked.body.logs.id}`, f.admin)).status).toBe(404);
  });

  it("expires an unread tail and cancels a command that never ran", async () => {
    const { f, a } = await setUpBefore(T0, async () => {
      const seeded = await fixture();
      return { f: seeded, a: await liveNode(seeded, "node-a") };
    });
    const asked = await request(f, { node: "node-a", unit: "portless-agent" });
    const id = asked.body.logs.id as Id<"logTails">;
    vi.setSystemTime(T0 + LOG_TTL_MS);
    expect((await f.call("GET", `/logs/${id}`, f.admin)).status).toBe(404);
    expect(await f.t.run((ctx) => ctx.db.query("logTails").collect())).toEqual([]);
    const [command] = await f.t.run((ctx) => ctx.db.query("nodeCommands").collect());
    expect(command.status).toBe("cancelled");

    // The scheduled expiry does the same for a tail nobody asks about again. The clock cannot run
    // back, so the Node reports in again to stay online.
    expect((await f.node("heartbeat", a.credential, { version: "test" })).status).toBe(200);
    const second = await request(f, { node: "node-a", unit: "portless-agent" });
    await f.t.mutation(internal.infra.logs.expire, { id: second.body.logs.id });
    expect(await f.t.run((ctx) => ctx.db.query("logTails").collect())).toEqual([]);
    const commands = await f.t.run((ctx) => ctx.db.query("nodeCommands").collect());
    expect(commands.every((c) => c.status === "cancelled")).toBe(true);
  });

  it("cannot be queued by hand, and output is refused from any other command", async () => {
    const f = await fixture();
    const a = await liveNode(f, "node-a");
    await expect(
      f.human.mutation(api.infra.nodeCommands.enqueue, {
        nodeId: a.id,
        idempotencyKey: "logs-by-hand",
        command: { kind: "logs", operation: { name: "container.logs", args: { name: "x" } } },
      }),
    ).rejects.toThrow(/api\/v1\/logs/);
    const id = await f.human.mutation(api.infra.nodeCommands.enqueue, {
      nodeId: a.id,
      idempotencyKey: "hostname",
      command: { kind: "operate", operation: { name: "system.hostname", args: {} } },
    });
    const claim = await (
      await f.node("commands/claim", a.credential, { commandId: id, owner: "o" })
    ).json();
    const result = await f.node("commands/result", a.credential, {
      commandId: id,
      owner: "o",
      epoch: claim.epoch,
      outcome: "success",
      output: btoa("hostname"),
    });
    expect(result.status).toBe(409);
  });
});

describe("dashboard functions", () => {
  it("lets a viewer read Nodes, Apps, links and runs, and only an operator or above change them", async () => {
    const f = await fixture();
    const a = await liveNode(f, "node-a");
    await liveNode(f, "node-b");
    await seedApp(f, a.id);
    await f.t.run((ctx) =>
      ctx.db.insert("appDeployments", {
        app: "shop",
        stage: "done",
        detail: "deployed",
        urls: [],
        startedAt: Date.now(),
        targetNodeIds: [a.id],
        operation: "failover",
        trigger: { kind: "failover", actor: "system:failover" },
      }),
    );
    const viewerId = await f.t.run((ctx) =>
      ctx.db.insert("users", { email: "viewer@example.test", role: "viewer" }),
    );
    const viewer = f.t.withIdentity({ subject: `${viewerId}|s` });
    expect((await viewer.query(api.infra.operator.nodes, {})).map((n) => n.name)).toEqual([
      "node-a",
      "node-b",
    ]);
    expect((await viewer.query(api.infra.operator.apps, {}))[0]).toMatchObject({
      name: "shop",
      lastDeployment: { operation: "failover", stage: "done" },
    });
    expect(await viewer.query(api.infra.operator.links, {})).toEqual([]);
    expect((await viewer.query(api.infra.deployments.list, {}))[0]).toMatchObject({
      operation: "failover",
      trigger: "failover",
      actor: "system:failover",
    });
    const link = { provider: "node-a", providerPort: 80, consumer: "node-b" };
    await expect(viewer.mutation(api.infra.operator.link, link)).rejects.toThrow(/viewer/);
    await expect(viewer.mutation(api.infra.operator.remove, { app: "shop" })).rejects.toThrow(
      /viewer/,
    );
    expect((await f.human.mutation(api.infra.operator.link, link)).name).toBe("node-a-80-node-b");
    await f.human.mutation(api.infra.operator.unlink, { name: "node-a-80-node-b" });
    const actions = (await f.audit()).filter((r) => r.action.startsWith("mesh."));
    expect(actions.map((r) => [r.action, r.actor.startsWith("token:")])).toEqual([
      ["mesh.link", false],
      ["mesh.unlink", false],
    ]);
    await expect(f.t.query(api.infra.operator.nodes, {})).rejects.toThrow(/Authentication/);
  });
});
