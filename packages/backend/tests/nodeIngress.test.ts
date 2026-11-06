// What a gateway Node, an App's Node and an unrelated Node receive for public ingress (ADR 0016
// phase 3b). A gateway gets the route table and one link per route; the App's Node gets one
// exposure per route granted to exactly the gateways; every other Node gets nothing.
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "../convex/_generated/api";
import schema from "../convex/schema";
import type { Id } from "../convex/_generated/dataModel";
import {
  INGRESS_PORT_END,
  INGRESS_PORT_START,
  ingressPorts,
  ingressServiceName,
} from "../convex/infra/ingress";
const modules = import.meta.glob("../convex/**/*.ts");
const T0 = Date.parse("2026-11-06T00:00:00Z");
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
});
afterEach(() => {
  vi.useRealTimers();
});

type Key = { pair: CryptoKeyPair; id: string };
async function newKey(): Promise<Key> {
  const pair = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  return { pair, id: Array.from(raw, (b) => b.toString(16).padStart(2, "0")).join("") };
}
async function sign(key: Key, message: string) {
  const signature = await crypto.subtle.sign(
    "Ed25519",
    key.pair.privateKey,
    new TextEncoder().encode(message),
  );
  return btoa(String.fromCharCode(...new Uint8Array(signature)));
}

type Enrolled = { nodeId: Id<"nodes">; credential: string; key: Key };

async function fixture() {
  const t = convexTest(schema, modules);
  const owner = await t.run((ctx) =>
    ctx.db.insert("users", { email: "owner@x.dev", role: "owner" }),
  );
  const human = t.withIdentity({ subject: `${owner}|session` });
  const request = (path: string, credential: string, data?: unknown) =>
    t.fetch(`/api/v1/nodes/${path}`, {
      method: data === undefined ? "GET" : "POST",
      headers: { Authorization: `Bearer ${credential}`, "Content-Type": "application/json" },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    });
  const prove = async (credential: string, key: Key) => {
    const address = { id: key.id, relay_urls: [], direct_addrs: ["127.0.0.1:4433"] };
    const res = await request("endpoint/challenge", credential, { address });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { challengeId: string; message: string };
    const published = await request("endpoint", credential, {
      challengeId: body.challengeId,
      signature: await sign(key, body.message),
    });
    expect(published.status).toBe(200);
  };
  const enroll = async (name: string, proven = true): Promise<Enrolled> => {
    const e = await human.mutation(api.infra.nodes.enroll, { name });
    const key = await newKey();
    if (proven) await prove(e.credential, key);
    return { ...e, key };
  };
  // gw is the gateway, app runs the routed App, other is an unrelated proven Node.
  const gw = await enroll("gw-1");
  const app = await enroll("app-1");
  const other = await enroll("other-1");
  // A deployed single-service App `name` routed at `name`: its App row, its port allocation and
  // its route row agree, as the deploy pipeline writes them.
  const route = (name: string, nodeId: Id<"nodes">, port: number) =>
    t.run(async (ctx) => {
      await ctx.db.insert("apps", {
        name,
        nodeId,
        services: [{ name: "web", image: `reg/${name}:1`, args: [], port, route: name, nodeId }],
        links: [],
        updatedAt: T0,
      });
      await ctx.db.insert("portAllocations", {
        nodeId,
        key: `${name}/web`,
        port,
        app: name,
        allocatedAt: T0,
      });
      await ctx.db.insert("appRoutes", {
        name,
        nodeId,
        image: `reg/${name}:1`,
        port,
        updatedAt: T0,
      });
    });
  const snapshot = async (credential: string) => {
    const s = await t.query(internal.infra.nodeState.state, { credential });
    if (s.unchanged) throw new Error("expected a full snapshot");
    return s;
  };
  const setRoles = (nodeId: Id<"nodes">, roles: ("gateway" | "compute")[]) =>
    human.mutation(api.infra.nodes.setPlacementRoles, { nodeId, roles });
  return { t, human, gw, app, other, route, snapshot, setRoles, enroll, prove };
}

describe("gateway ingress in the Node snapshot", () => {
  it("gives no routes and no ingress grants while no Node is a gateway", async () => {
    const { gw, app, other, route, snapshot } = await fixture();
    await route("web", app.nodeId, 62001);
    for (const n of [gw, app, other]) {
      const s = await snapshot(n.credential);
      expect(s.desired).not.toHaveProperty("ingress");
      expect(s.desired.exposures).toEqual([]);
      expect(s.desired.links).toEqual([]);
      expect(s.desired.fleet).toEqual([]);
    }
  });

  it("links a gateway to the App's Node and grants exactly the gateway", async () => {
    const { gw, app, other, route, snapshot, setRoles } = await fixture();
    await route("web", app.nodeId, 62001);
    await setRoles(gw.nodeId, ["gateway"]);

    const gateway = await snapshot(gw.credential);
    const port = ingressPorts([{ name: "web", createdAt: 0 }]).get("web")!;
    expect(port).toBeGreaterThanOrEqual(INGRESS_PORT_START);
    expect(port).toBeLessThanOrEqual(INGRESS_PORT_END);
    expect(gateway.desired.ingress).toEqual({
      routes: [{ host: "web", upstream: `127.0.0.1:${port}` }],
    });
    expect(gateway.desired.links).toEqual([
      {
        name: "ingress.web",
        peer: app.key.id,
        service: "ingress.web",
        listen: `127.0.0.1:${port}`,
        max_connections: 1024,
      },
    ]);
    expect(gateway.desired.exposures).toEqual([]);
    // Only the peer it needs: not the unrelated Node.
    expect(gateway.desired.fleet.map((p) => p.id)).toEqual([app.key.id]);

    const provider = await snapshot(app.credential);
    expect(provider.desired).not.toHaveProperty("ingress");
    expect(provider.desired.exposures).toEqual([
      {
        name: "ingress.web",
        target: "127.0.0.1:62001",
        allowed_peers: [gw.key.id],
        max_connections: 1024,
      },
    ]);
    expect(provider.desired.links).toEqual([]);
    expect(provider.desired.fleet.map((p) => p.id)).toEqual([gw.key.id]);

    const unrelated = await snapshot(other.credential);
    expect(unrelated.desired).not.toHaveProperty("ingress");
    expect(unrelated.desired.fleet).toEqual([]);
    expect(unrelated.desired.exposures).toEqual([]);
    expect(unrelated.desired.links).toEqual([]);
  });

  it("grants every gateway, and only gateways, on the App's exposure", async () => {
    const { gw, app, other, route, snapshot, setRoles, enroll } = await fixture();
    const gw2 = await enroll("gw-2");
    await route("web", app.nodeId, 62001);
    await setRoles(gw.nodeId, ["gateway"]);
    await setRoles(gw2.nodeId, ["gateway", "compute"]);
    await setRoles(other.nodeId, ["compute"]);
    const provider = await snapshot(app.credential);
    expect(provider.desired.exposures[0].allowed_peers).toEqual([gw.key.id, gw2.key.id].toSorted());
    const a = await snapshot(gw.credential);
    const b = await snapshot(gw2.credential);
    // Both gateways use the same loopback port for the route.
    expect(a.desired.ingress).toEqual(b.desired.ingress);
    expect(b.desired.fleet.map((p) => p.id)).toEqual([app.key.id]);
  });

  it("keeps an unreachable App's route in the table with no upstream and no grant", async () => {
    const { gw, route, snapshot, setRoles, enroll } = await fixture();
    const unproven = await enroll("app-2", false);
    await route("api", unproven.nodeId, 62002);
    await setRoles(gw.nodeId, ["gateway"]);
    const s = await snapshot(gw.credential);
    expect(s.desired.ingress).toEqual({ routes: [{ host: "api", upstream: null }] });
    expect(s.desired.links).toEqual([]);
    expect(s.desired.fleet).toEqual([]);
  });

  it("serves a route hosted on the gateway itself from loopback with no link", async () => {
    const { gw, app, route, snapshot, setRoles, enroll } = await fixture();
    const gw2 = await enroll("gw-2");
    await route("home", gw.nodeId, 62003);
    await setRoles(gw.nodeId, ["gateway"]);
    await setRoles(gw2.nodeId, ["gateway"]);
    const self = await snapshot(gw.credential);
    expect(self.desired.ingress).toEqual({
      routes: [{ host: "home", upstream: "127.0.0.1:62003" }],
    });
    expect(self.desired.links).toEqual([]);
    // The other gateway reaches it over the mesh, so gw exposes it to gw2 only.
    expect(self.desired.exposures.map((e) => e.allowed_peers)).toEqual([[gw2.key.id]]);
    expect((await snapshot(app.credential)).desired.exposures).toEqual([]);
  });

  it("refuses a route whose port belongs to another App on its Node", async () => {
    const { t, gw, app, other, route, snapshot, setRoles } = await fixture();
    await route("web", app.nodeId, 62001);
    // On `other`, port 62001 is "api"'s.
    await route("api", other.nodeId, 62001);
    await setRoles(gw.nodeId, ["gateway"]);
    const before = await snapshot(gw.credential);
    expect(before.desired.links.map((l) => l.name)).toEqual(["ingress.api", "ingress.web"]);

    // A stale write moves web's route row to `other` and keeps its port number.
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query("appRoutes")
        .withIndex("by_name", (q) => q.eq("name", "web"))
        .unique();
      await ctx.db.patch(row!._id, { nodeId: other.nodeId });
    });
    const after = await snapshot(gw.credential);
    expect(after.desired.ingress?.routes).toContainEqual({ host: "web", upstream: null });
    expect(after.desired.links.map((l) => l.name)).toEqual(["ingress.api"]);
    // Nothing on `other` points web's name at api's port.
    const exposures = (await snapshot(other.credential)).desired.exposures;
    expect(exposures.map((e) => [e.name, e.target])).toEqual([["ingress.api", "127.0.0.1:62001"]]);
    expect((await snapshot(app.credential)).desired.exposures).toEqual([]);
  });

  it("refuses a route whose port is not allocated to it, or whose App runs elsewhere", async () => {
    const { t, gw, app, other, route, snapshot, setRoles } = await fixture();
    await route("web", app.nodeId, 62001);
    await setRoles(gw.nodeId, ["gateway"]);
    const served = async () =>
      (await snapshot(gw.credential)).desired.ingress?.routes.find((r) => r.host === "web")
        ?.upstream ?? null;
    expect(await served()).not.toBeNull();

    // The allocation is released (the App was removed from that Node).
    const allocation = await t.run((ctx) =>
      ctx.db
        .query("portAllocations")
        .withIndex("by_node_key", (q) => q.eq("nodeId", app.nodeId).eq("key", "web/web"))
        .unique(),
    );
    await t.run((ctx) => ctx.db.delete(allocation!._id));
    expect(await served()).toBeNull();
    expect((await snapshot(app.credential)).desired.exposures).toEqual([]);

    // Allocated again, but the App row now places the service on another Node.
    await t.run(async (ctx) => {
      await ctx.db.insert("portAllocations", {
        nodeId: app.nodeId,
        key: "web/web",
        port: 62001,
        app: "web",
        allocatedAt: T0,
      });
      const row = await ctx.db
        .query("apps")
        .withIndex("by_name", (q) => q.eq("name", "web"))
        .unique();
      await ctx.db.patch(row!._id, {
        services: row!.services.map((s) => ({ ...s, nodeId: other.nodeId })),
      });
    });
    expect(await served()).toBeNull();
  });

  it("serves a single-container App the Hub deployed, which has a route row and no App row", async () => {
    const { t, gw, app, route, snapshot, setRoles } = await fixture();
    await setRoles(gw.nodeId, ["gateway"]);
    // What the Hub importer copies for `portless deploy --port`: the container is named after the
    // label and publishes the port itself, so there is no App row and no port allocation.
    await t.run((ctx) =>
      ctx.db.insert("appRoutes", {
        name: "solo",
        nodeId: app.nodeId,
        image: "reg/solo:1",
        port: 8080,
        updatedAt: T0,
      }),
    );
    const served = async () =>
      (await snapshot(gw.credential)).desired.ingress?.routes.find((r) => r.host === "solo")
        ?.upstream ?? null;
    expect(await served()).not.toBeNull();
    expect((await snapshot(app.credential)).desired.exposures).toEqual([
      expect.objectContaining({ name: "ingress.solo", target: "127.0.0.1:8080" }),
    ]);

    // Another App now holds port 8080 on that Node: the stale row is not sent to it.
    await route("api", app.nodeId, 8080);
    expect(await served()).toBeNull();
    expect((await snapshot(app.credential)).desired.exposures.map((e) => e.name)).toEqual([
      "ingress.api",
    ]);
  });

  it("does not serve a single-container route whose port a host service or mesh link holds", async () => {
    const { t, gw, app, other, snapshot, setRoles } = await fixture();
    await setRoles(gw.nodeId, ["gateway"]);
    process.env.ERAINFRA_REGISTRY = "127.0.0.1:61050";
    // Rows that outlived their containers: the Hub could not have published these ports while the
    // registry, the Hub, the gateway proxy or a link listener held them.
    const rows = [
      { name: "reg", port: 61050 },
      { name: "hub", port: 61080 },
      { name: "proxy", port: 61090 },
      { name: "ingress", port: 61500 },
      { name: "linked", port: 9000 },
      { name: "solo", port: 8080 },
    ];
    await t.run(async (ctx) => {
      for (const r of rows)
        await ctx.db.insert("appRoutes", {
          name: r.name,
          nodeId: app.nodeId,
          image: `reg/${r.name}:1`,
          port: r.port,
          updatedAt: T0,
        });
      // A standalone link that listens on app-1's loopback port 9000.
      await ctx.db.insert("meshLinks", {
        name: "minio-app-1",
        providerNodeId: other.nodeId,
        providerPort: 9000,
        consumerNodeId: app.nodeId,
        localPort: 9000,
        createdBy: "user",
        updatedAt: T0,
      });
    });
    try {
      const routes = (await snapshot(gw.credential)).desired.ingress?.routes ?? [];
      const served = routes.filter((r) => r.upstream !== null).map((r) => r.host);
      expect(served).toEqual(["solo"]);
      const exposures = (await snapshot(app.credential)).desired.exposures
        .map((e) => e.name)
        .filter((n) => n.startsWith("ingress."));
      expect(exposures).toEqual(["ingress.solo"]);
    } finally {
      delete process.env.ERAINFRA_REGISTRY;
    }
  });

  it("does not serve a bare route row named after an App that routes elsewhere", async () => {
    const { t, gw, app, snapshot, setRoles } = await fixture();
    await setRoles(gw.nodeId, ["gateway"]);
    await t.run(async (ctx) => {
      await ctx.db.insert("apps", {
        name: "solo",
        nodeId: app.nodeId,
        services: [{ name: "web", image: "reg/solo:2", args: [], nodeId: app.nodeId }],
        links: [],
        updatedAt: T0,
      });
      await ctx.db.insert("appRoutes", {
        name: "solo",
        nodeId: app.nodeId,
        image: "reg/solo:1",
        port: 8080,
        updatedAt: T0,
      });
    });
    const routes = (await snapshot(gw.credential)).desired.ingress?.routes;
    expect(routes).toEqual([{ host: "solo", upstream: null }]);
  });

  it("revokes routes and grants when the gateway role is removed or the gateway is revoked", async () => {
    const { t, human, gw, app, route, snapshot, setRoles } = await fixture();
    await route("web", app.nodeId, 62001);
    await setRoles(gw.nodeId, ["gateway"]);
    expect((await snapshot(app.credential)).desired.exposures).toHaveLength(1);

    await setRoles(gw.nodeId, []);
    const gateway = await snapshot(gw.credential);
    expect(gateway.desired).not.toHaveProperty("ingress");
    expect(gateway.desired.links).toEqual([]);
    expect((await snapshot(app.credential)).desired.exposures).toEqual([]);

    await setRoles(gw.nodeId, ["gateway"]);
    expect((await snapshot(app.credential)).desired.exposures).toHaveLength(1);
    const credentials = await t.run((ctx) =>
      ctx.db
        .query("nodeCredentials")
        .withIndex("by_node", (q) => q.eq("nodeId", gw.nodeId))
        .collect(),
    );
    await human.mutation(api.infra.nodes.revokeCredential, { credentialId: credentials[0]._id });
    expect((await snapshot(app.credential)).desired.exposures).toEqual([]);
  });

  it("lets only an owner or admin set placement roles, and audits it", async () => {
    const { t, gw, setRoles } = await fixture();
    const operator = await t.run((ctx) =>
      ctx.db.insert("users", { email: "op@x.dev", role: "operator" }),
    );
    await expect(
      t
        .withIdentity({ subject: `${operator}|s` })
        .mutation(api.infra.nodes.setPlacementRoles, { nodeId: gw.nodeId, roles: ["gateway"] }),
    ).rejects.toThrow();
    await setRoles(gw.nodeId, ["gateway", "gateway"]);
    const node = await t.run((ctx) => ctx.db.get(gw.nodeId));
    expect(node?.placementRoles).toEqual(["gateway"]);
    const audit = await t.run((ctx) => ctx.db.query("auditEvents").collect());
    expect(audit.map((a) => a.action)).toContain("nodes.setPlacementRoles");
  });

  it("refuses a declared link that takes an ingress name", async () => {
    const { t, gw, app, route, setRoles } = await fixture();
    await route("web", app.nodeId, 62001);
    await setRoles(gw.nodeId, ["gateway"]);
    await t.run((ctx) =>
      ctx.db.insert("meshLinks", {
        name: "ingress.web",
        providerNodeId: app.nodeId,
        consumerNodeId: gw.nodeId,
        providerPort: 62001,
        localPort: 62005,
        updatedAt: T0,
      }),
    );
    await expect(
      t.query(internal.infra.nodeState.state, { credential: gw.credential }),
    ).rejects.toThrow(/ingress name/);
  });

  it("degrades only the routes past a Node's mesh budget, and refuses no snapshot", async () => {
    const { t, gw, app, other, route, snapshot, setRoles } = await fixture();
    await setRoles(gw.nodeId, ["gateway"]);
    // One declared link already uses one of the gateway's 128 link slots.
    await t.run((ctx) =>
      ctx.db.insert("meshLinks", {
        name: "db",
        providerNodeId: other.nodeId,
        consumerNodeId: gw.nodeId,
        providerPort: 5432,
        localPort: 62999,
        updatedAt: T0,
      }),
    );
    for (let i = 0; i < 130; i++) {
      vi.setSystemTime(T0 + i);
      await route(`app${String(i).padStart(3, "0")}`, app.nodeId, 62000 + i);
    }
    const gateway = await snapshot(gw.credential);
    expect(gateway.desired.links).toHaveLength(128);
    expect(gateway.desired.ingress?.overflow).toBe(3);
    const unserved = gateway.desired.ingress!.routes.filter((r) => r.upstream === null);
    // The newest routes are the ones left out; every older one keeps its link.
    expect(unserved.map((r) => r.host)).toEqual(["app127", "app128", "app129"]);
    // The App Node exposes what fits its own budget; other Nodes are untouched.
    expect((await snapshot(app.credential)).desired.exposures).toHaveLength(128);
    const unrelated = await snapshot(other.credential);
    expect(unrelated.desired.exposures.map((e) => e.name)).toEqual(["db"]);
    expect(unrelated.desired).not.toHaveProperty("ingress");
  });
});

describe("ingress ports and names", () => {
  it("never moves an existing route's port when a route is added", () => {
    const routes = Array.from({ length: 100 }, (_, i) => ({ name: `app${i}`, createdAt: i }));
    const before = ingressPorts(routes);
    const after = ingressPorts([...routes, { name: "zzz-new", createdAt: 1000 }]);
    for (const [name, port] of before) expect(after.get(name)).toBe(port);
    const all = [...after.values()];
    expect(new Set(all).size).toBe(all.length);
    for (const p of all) {
      expect(p).toBeGreaterThanOrEqual(INGRESS_PORT_START);
      expect(p).toBeLessThanOrEqual(INGRESS_PORT_END);
    }
  });

  it("gives a port to at most as many routes as the range holds", () => {
    const routes = Array.from({ length: 1000 }, (_, i) => ({ name: `r${i}`, createdAt: i }));
    const ports = ingressPorts(routes);
    expect(ports.size).toBe(INGRESS_PORT_END - INGRESS_PORT_START + 1);
    expect(ports.has("r0")).toBe(true);
    expect(ports.has("r999")).toBe(false);
  });

  it("fits every DNS label into a mesh name", () => {
    const long = "a".repeat(63);
    const other = `${"a".repeat(62)}b`;
    expect(ingressServiceName(long).length).toBeLessThanOrEqual(64);
    expect(ingressServiceName(long)).not.toBe(ingressServiceName(other));
    expect(ingressServiceName("web")).toBe("ingress.web");
  });
});

// The Hub fails an App over by its primary Node: it moves the App's node and its routes to the
// survivor but keeps services[].node at the Node it left (apps/hub/src/runtime/failover.ts). The
// importer places each routed service on its route's Node, so the gateway serves it there.
describe("an imported App the Hub had failed over", () => {
  it("is served at the gateway once its Node runs connect-convex", async () => {
    const { t, gw, snapshot, setRoles } = await fixture();
    await setRoles(gw.nodeId, ["gateway"]);
    const batches = [
      {
        kind: "routes" as const,
        rows: [
          {
            name: "shop",
            node: "app-1",
            image: "reg/shop:1",
            port: 62001,
            app: "shop",
            service: "web",
          },
        ],
      },
      {
        kind: "apps" as const,
        rows: [
          {
            name: "shop",
            node: "app-1", // failover moved the App ...
            // ... but left the service's node where it was (other-1, the lost Node)
            services: [
              {
                name: "web",
                image: "reg/shop:1",
                args: [],
                port: 62001,
                route: "shop",
                node: "other-1",
              },
            ],
            links: [],
          },
        ],
      },
      { kind: "ports" as const, rows: [{ node: "app-1", key: "shop/web", port: 62001 }] },
    ];
    process.env.ERAINFRA_SECRETS_MASTER_KEY = "44".repeat(32);
    await t.action(internal.infra.hubImport.run, { batches });
    const routes = (await snapshot(gw.credential)).desired.ingress?.routes;
    expect(routes?.find((r) => r.host === "shop")?.upstream ?? null).not.toBeNull();
  });
});
