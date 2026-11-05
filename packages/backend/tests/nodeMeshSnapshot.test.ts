// Which peers a Node's mesh snapshot may name. A peer is in another Node's `fleet` and
// `allowed_peers` only while its endpoint key is proven by a signed challenge and it holds a live
// credential; an operator reset or revoking its last credential takes it out of every snapshot.
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "../convex/_generated/api";
import schema from "../convex/schema";
import type { Id } from "../convex/_generated/dataModel";
const modules = import.meta.glob("../convex/**/*.ts");
const T0 = Date.parse("2026-11-05T00:00:00Z");
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

async function fixture() {
  const t = convexTest(schema, modules);
  const owner = await t.run((ctx) =>
    ctx.db.insert("users", { email: "owner@x.dev", role: "owner" }),
  );
  const human = t.withIdentity({ subject: `${owner}|session` });
  const a = await human.mutation(api.infra.nodes.enroll, { name: "node-a" });
  const b = await human.mutation(api.infra.nodes.enroll, { name: "node-b" });
  const request = (path: string, credential: string, data?: unknown) =>
    t.fetch(`/api/v1/nodes/${path}`, {
      method: data === undefined ? "GET" : "POST",
      headers: { Authorization: `Bearer ${credential}`, "Content-Type": "application/json" },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    });
  // Challenge, sign with the endpoint key, publish: what the Infra Agent does with its sidecar.
  const challenge = async (credential: string, key: Key) => {
    const address = { id: key.id, relay_urls: [], direct_addrs: ["127.0.0.1:4433"] };
    const res = await request("endpoint/challenge", credential, { address });
    return { res, body: (await res.json()) as { challengeId: string; message: string } };
  };
  const prove = async (credential: string, key: Key) => {
    const { res, body } = await challenge(credential, key);
    expect(res.status).toBe(200);
    const published = await request("endpoint", credential, {
      challengeId: body.challengeId,
      signature: await sign(key, body.message),
    });
    expect(published.status).toBe(200);
  };
  // b provides "db" to a.
  await t.run((ctx) =>
    ctx.db.insert("meshLinks", {
      name: "db",
      providerNodeId: b.nodeId,
      consumerNodeId: a.nodeId,
      providerPort: 5432,
      localPort: 62000,
      updatedAt: T0,
    }),
  );
  const snapshot = async (credential: string) => {
    const s = await t.query(internal.infra.nodeState.state, { credential });
    if (s.unchanged) throw new Error("expected a full snapshot");
    return s;
  };
  const credentialsOf = (nodeId: Id<"nodes">) =>
    t.run((ctx) =>
      ctx.db
        .query("nodeCredentials")
        .withIndex("by_node", (q) => q.eq("nodeId", nodeId))
        .collect(),
    );
  return { t, human, a, b, request, challenge, prove, snapshot, credentialsOf };
}

describe("mesh snapshot peers", () => {
  it("excludes a peer whose endpoint is registered but unproven, and admits it once proven", async () => {
    const { t, a, b, prove, snapshot } = await fixture();
    const keyA = await newKey();
    const keyB = await newKey();
    await prove(a.credential, keyA);
    // The phase-2a path records an EndpointId with no possession proof.
    await t.mutation(internal.infra.nodes.registerEndpoint, {
      nodeId: b.nodeId,
      endpointId: keyB.id,
      endpointAddr: { directAddresses: ["127.0.0.1:4433"] },
    });
    // A legacy row that carries an address but no proof is not enough either.
    await t.run((ctx) =>
      ctx.db.patch(b.nodeId, {
        meshAddress: { id: keyB.id, relay_urls: [], direct_addrs: ["127.0.0.1:4433"] },
      }),
    );
    const before = await snapshot(a.credential);
    expect(before.desired.fleet).toEqual([]);
    expect(before.desired.links).toEqual([]);
    expect(JSON.stringify(before)).not.toContain(keyB.id);
    const providerBefore = await snapshot(b.credential);
    expect(providerBefore.desired.fleet.map((p) => p.id)).toEqual([keyA.id]);

    await prove(b.credential, keyB);
    const after = await snapshot(a.credential);
    expect(after.revision).not.toBe(before.revision);
    expect(after.desired.fleet.map((p) => p.id)).toEqual([keyB.id]);
    expect(after.desired.links).toEqual([
      { name: "db", peer: keyB.id, service: "db", listen: "127.0.0.1:62000" },
    ]);
  });

  it("drops a reset endpoint out of its peers' snapshots and voids challenges issued before", async () => {
    const { human, a, b, prove, challenge, request, snapshot } = await fixture();
    const keyA = await newKey();
    const keyB = await newKey();
    await prove(a.credential, keyA);
    await prove(b.credential, keyB);
    const linked = await snapshot(a.credential);
    expect(linked.desired.fleet.map((p) => p.id)).toEqual([keyB.id]);
    expect((await snapshot(b.credential)).desired.exposures).toEqual([
      { name: "db", target: "127.0.0.1:5432", allowed_peers: [keyA.id] },
    ]);

    // A challenge for the old key, signed before the reset, is useless after it.
    const stale = await challenge(b.credential, keyB);
    await human.mutation(api.infra.nodes.resetEndpoint, { nodeId: b.nodeId });
    expect(
      (
        await request("endpoint", b.credential, {
          challengeId: stale.body.challengeId,
          signature: await sign(keyB, stale.body.message),
        })
      ).status,
    ).toBe(409);

    const dropped = await snapshot(a.credential);
    expect(dropped.revision).not.toBe(linked.revision);
    expect(dropped.desired.fleet).toEqual([]);
    expect(dropped.desired.links).toEqual([]);
    // b's own snapshot no longer matters to a, but a stays granted there only while proven.
    expect((await snapshot(b.credential)).desired.exposures[0].allowed_peers).toEqual([keyA.id]);
    // Resetting a removes it from b's grant too.
    await human.mutation(api.infra.nodes.resetEndpoint, { nodeId: a.nodeId });
    expect((await snapshot(b.credential)).desired.exposures).toEqual([]);
  });

  it("excludes a Node with no live credential from fleet and allowed_peers", async () => {
    // Rows written directly: the snapshot check must hold even for a revocation that did not
    // go through revokeCredential (and so did not clear the endpoint).
    const { t, a, b, snapshot } = await fixture();
    await t.run(async (ctx) => {
      for (const [nodeId, hex] of [
        [a.nodeId, "aa"],
        [b.nodeId, "bb"],
      ] as const)
        await ctx.db.patch(nodeId, {
          endpointId: hex.repeat(32),
          endpointProvenAt: T0,
          meshAddress: { id: hex.repeat(32), relay_urls: [], direct_addrs: [] },
        });
      await ctx.db.insert("meshLinks", {
        name: "cache",
        providerNodeId: a.nodeId,
        consumerNodeId: b.nodeId,
        providerPort: 6379,
        localPort: 62001,
        updatedAt: T0,
      });
    });
    expect(
      (await snapshot(a.credential)).desired.exposures.find((e) => e.name === "cache")
        ?.allowed_peers,
    ).toEqual(["bb".repeat(32)]);
    await t.run(async (ctx) => {
      const rows = await ctx.db
        .query("nodeCredentials")
        .withIndex("by_node", (q) => q.eq("nodeId", b.nodeId))
        .collect();
      for (const row of rows) await ctx.db.patch(row._id, { revokedAt: T0 });
    });
    const stateA = await snapshot(a.credential);
    expect(stateA.desired.fleet).toEqual([]);
    expect(stateA.desired.exposures).toEqual([]);
    expect(stateA.desired.links).toEqual([]);
    expect(JSON.stringify(stateA)).not.toContain("bb".repeat(32));
  });

  it("revoking the last credential clears the endpoint; re-enrolment must prove a key again", async () => {
    const { t, human, a, b, prove, snapshot, credentialsOf, request } = await fixture();
    const keyA = await newKey();
    const keyB = await newKey();
    await prove(a.credential, keyA);
    await prove(b.credential, keyB);

    // Rotation: issue the new credential, then revoke the old one. The endpoint survives.
    const rotated = await human.mutation(api.infra.nodes.enroll, { name: "node-b" });
    const [first] = await credentialsOf(b.nodeId);
    await human.mutation(api.infra.nodes.revokeCredential, { credentialId: first._id });
    expect((await t.run((ctx) => ctx.db.get(b.nodeId)))?.endpointId).toBe(keyB.id);
    expect((await snapshot(a.credential)).desired.fleet.map((p) => p.id)).toEqual([keyB.id]);

    // Revoking the last one revokes the mesh identity.
    for (const c of await credentialsOf(b.nodeId))
      if (c.revokedAt === undefined)
        await human.mutation(api.infra.nodes.revokeCredential, { credentialId: c._id });
    const node = await t.run((ctx) => ctx.db.get(b.nodeId));
    expect(node?.endpointId).toBeUndefined();
    expect(node?.meshAddress).toBeUndefined();
    expect(node?.endpointProvenAt).toBeUndefined();
    expect((await snapshot(a.credential)).desired.fleet).toEqual([]);
    expect((await request("heartbeat", rotated.credential, { version: "x" })).status).toBe(401);
    const audit = await t.run((ctx) => ctx.db.query("auditEvents").collect());
    expect(audit.some((e) => e.action === "nodes.resetEndpoint" && e.target === "node-b")).toBe(
      true,
    );

    // Re-enrol: the new credential alone grants nothing until a key is proven, and the proven
    // key may differ from the revoked one.
    const again = await human.mutation(api.infra.nodes.enroll, { name: "node-b" });
    expect(again.nodeId).toBe(b.nodeId);
    expect((await snapshot(a.credential)).desired.fleet).toEqual([]);
    const heartbeat = await (await request("heartbeat", again.credential, { version: "x" })).json();
    expect(heartbeat.endpointId).toBeNull();
    const fresh = await newKey();
    await prove(again.credential, fresh);
    expect((await snapshot(a.credential)).desired.fleet.map((p) => p.id)).toEqual([fresh.id]);
  });
});

describe("endpoint refusals the Infra Agent must surface", () => {
  it("names a key change and a key held by another Node, and reports the registered key", async () => {
    const { a, b, prove, challenge, request } = await fixture();
    const keyA = await newKey();
    await prove(a.credential, keyA);
    const heartbeat = await (await request("heartbeat", a.credential, { version: "x" })).json();
    expect(heartbeat.endpointId).toBe(keyA.id);

    const changed = await challenge(a.credential, await newKey());
    expect(changed.res.status).toBe(409);
    expect(changed.body).toEqual({ error: "endpoint_key_changed" });

    const taken = await challenge(b.credential, keyA);
    expect(taken.res.status).toBe(409);
    expect(taken.body).toEqual({ error: "endpoint_in_use" });

    // Republishing the same key with a new address is allowed.
    await prove(a.credential, keyA);
    // Other refusals stay opaque.
    const bad = await request("endpoint", a.credential, { challengeId: "x", signature: "AA==" });
    expect(bad.status).toBe(409);
    expect(await bad.json()).toEqual({ error: "request_refused" });
  });
});
