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
  const route = (name: string, nodeId: Id<"nodes">, port: number) =>
    t.run((ctx) =>
      ctx.db.insert("appRoutes", { name, nodeId, image: `reg/${name}:1`, port, updatedAt: T0 }),
    );
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

  it("moves the link and the grant when failover moves the route", async () => {
    const { t, gw, app, other, route, snapshot, setRoles } = await fixture();
    await route("web", app.nodeId, 62001);
    await setRoles(gw.nodeId, ["gateway"]);
    const before = await snapshot(gw.credential);
    const unchanged = await t.query(internal.infra.nodeState.state, {
      credential: gw.credential,
      revision: before.revision,
    });
    expect(unchanged.unchanged).toBe(true);

    const lease = await t.mutation(internal.infra.deployments.beginFailover, {
      app: "web",
      lostNodeId: app.nodeId,
    });
    if (!lease.granted) throw new Error("lease refused");
    await t.mutation(internal.infra.deployments.completeFailover, {
      app: "web",
      epoch: lease.epoch,
      fromNodeId: app.nodeId,
      toNodeId: other.nodeId,
    });

    const after = await snapshot(gw.credential);
    expect(after.revision).not.toBe(before.revision);
    // Same loopback port, new peer: the proxy's upstream does not change, the link's peer does.
    expect(after.desired.ingress).toEqual(before.desired.ingress);
    expect(after.desired.links[0].peer).toBe(other.key.id);
    expect(after.desired.fleet.map((p) => p.id)).toEqual([other.key.id]);
    expect((await snapshot(app.credential)).desired.exposures).toEqual([]);
    expect((await snapshot(other.credential)).desired.exposures[0].allowed_peers).toEqual([
      gw.key.id,
    ]);
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

  it("fits every DNS label into a mesh name", () => {
    const long = "a".repeat(63);
    const other = `${"a".repeat(62)}b`;
    expect(ingressServiceName(long).length).toBeLessThanOrEqual(64);
    expect(ingressServiceName(long)).not.toBe(ingressServiceName(other));
    expect(ingressServiceName("web")).toBe("ingress.web");
  });
});
