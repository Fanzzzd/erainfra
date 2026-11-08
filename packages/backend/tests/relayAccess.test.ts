// The fleet relay's access check, called the way iroh-relay 1.4's `access.http` calls it: a POST
// with no body, the client's EndpointId in X-Iroh-Endpoint-Id and the relay's bearer secret. The
// relay admits a client only on 200 with the body `true` (deploy/infra/relay.sh).
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../convex/_generated/api";
import schema from "../convex/schema";
import type { Id } from "../convex/_generated/dataModel";

const modules = import.meta.glob("../convex/**/*.ts");
const T0 = Date.parse("2026-11-08T00:00:00Z");
const SECRET = "relay-secret-0123456789abcdef0123456789abcdef";
const NEXT = "relay-secret-next-fedcba9876543210fedcba9876543210";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
  process.env.RELAY_ACCESS_TOKEN = SECRET;
});
afterEach(() => {
  vi.useRealTimers();
  delete process.env.RELAY_ACCESS_TOKEN;
  delete process.env.RELAY_ACCESS_TOKEN_NEXT;
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
  const node = await human.mutation(api.infra.nodes.enroll, { name: "edge-1" });
  const nodeRequest = (path: string, credential: string, data: unknown) =>
    t.fetch(`/api/v1/nodes/${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${credential}`, "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
  // What the Infra Agent does with its sidecar: challenge, sign with the endpoint key, publish.
  const prove = async (credential: string, key: Key) => {
    const address = {
      id: key.id,
      relay_urls: ["https://relay.example.com/"],
      direct_addrs: ["10.0.0.5:4433"],
    };
    const res = await nodeRequest("endpoint/challenge", credential, { address });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { challengeId: string; message: string };
    const published = await nodeRequest("endpoint", credential, {
      challengeId: body.challengeId,
      signature: await sign(key, body.message),
    });
    expect(published.status).toBe(200);
  };
  // The request iroh-relay's HttpAccess sends (iroh-relay 1.4.1 src/main.rs).
  const ask = (endpointId: string | null, bearer: string | null = SECRET) => {
    const headers: Record<string, string> = {};
    if (endpointId !== null) {
      headers["X-Iroh-Endpoint-Id"] = endpointId;
      headers["X-Iroh-NodeId"] = endpointId;
    }
    if (bearer !== null) headers.Authorization = `Bearer ${bearer}`;
    return t.fetch("/api/v1/relay/access", { method: "POST", headers });
  };
  const credentialsOf = (nodeId: Id<"nodes">) =>
    t.run((ctx) =>
      ctx.db
        .query("nodeCredentials")
        .withIndex("by_node", (q) => q.eq("nodeId", nodeId))
        .collect(),
    );
  return { t, human, node, prove, ask, credentialsOf };
}

async function verdict(res: Response) {
  return { status: res.status, body: await res.text() };
}

describe("relay access check", () => {
  it("admits a Node whose endpoint key is proven and whose credential is live", async () => {
    const { node, prove, ask } = await fixture();
    const key = await newKey();
    await prove(node.credential, key);
    expect(await verdict(await ask(key.id))).toEqual({ status: 200, body: "true" });
  });

  it("refuses an EndpointId that belongs to no Node", async () => {
    const { ask } = await fixture();
    expect(await verdict(await ask((await newKey()).id))).toEqual({ status: 403, body: "false" });
  });

  it("refuses an enrolled Node until it proves its key", async () => {
    const { t, node, prove, ask } = await fixture();
    const key = await newKey();
    // An EndpointId recorded without a possession proof, as the phase-2a path and a Hub import
    // record it, is not enough.
    await t.run((ctx) =>
      ctx.db.patch(node.nodeId, {
        endpointId: key.id,
        meshAddress: { id: key.id, relay_urls: [], direct_addrs: [] },
      }),
    );
    expect(await verdict(await ask(key.id))).toEqual({ status: 403, body: "false" });
    await t.run((ctx) =>
      ctx.db.patch(node.nodeId, { endpointId: undefined, meshAddress: undefined }),
    );
    await prove(node.credential, key);
    expect((await ask(key.id)).status).toBe(200);
  });

  it("refuses a Node after an operator resets its endpoint", async () => {
    const { human, node, prove, ask } = await fixture();
    const key = await newKey();
    await prove(node.credential, key);
    await human.mutation(api.infra.nodes.resetEndpoint, { nodeId: node.nodeId });
    expect((await ask(key.id)).status).toBe(403);
  });

  it("refuses a Node whose last credential is revoked, even if its row kept the endpoint", async () => {
    const { t, human, node, prove, ask, credentialsOf } = await fixture();
    const key = await newKey();
    await prove(node.credential, key);
    // Written directly, so the endpoint stays: the check must not rely on revokeCredential
    // having cleared it.
    const rows = await credentialsOf(node.nodeId);
    await t.run(async (ctx) => {
      for (const row of rows) await ctx.db.patch(row._id, { revokedAt: T0 });
    });
    expect((await ask(key.id)).status).toBe(403);

    // Through the mutation as well, after a fresh enrolment and proof.
    const again = await human.mutation(api.infra.nodes.enroll, { name: "edge-1" });
    const fresh = await newKey();
    await t.run((ctx) =>
      ctx.db.patch(node.nodeId, {
        endpointId: undefined,
        meshAddress: undefined,
        endpointProvenAt: undefined,
      }),
    );
    await prove(again.credential, fresh);
    expect((await ask(fresh.id)).status).toBe(200);
    for (const row of await credentialsOf(node.nodeId))
      if (row.revokedAt === undefined)
        await human.mutation(api.infra.nodes.revokeCredential, { credentialId: row._id });
    expect((await ask(fresh.id)).status).toBe(403);
  });

  it("answers 401 without the relay secret, before looking at the EndpointId", async () => {
    const { human, node, prove, ask } = await fixture();
    const key = await newKey();
    await prove(node.credential, key);
    const stranger = (await newKey()).id;
    const operatorToken = (
      await human.mutation(api.apiTokens.create, { name: "operator", scope: "admin" })
    ).token;
    // A member and a stranger get the same answer, so the route is no membership oracle. Neither
    // a Node credential nor an operator token is the relay secret.
    for (const bearer of [null, "wrong", `${SECRET}x`, node.credential, operatorToken])
      for (const id of [key.id, stranger, null])
        expect(await verdict(await ask(id, bearer))).toEqual({ status: 401, body: "false" });
  });

  it("fails closed with 503 while RELAY_ACCESS_TOKEN is not set", async () => {
    const { node, prove, ask } = await fixture();
    const key = await newKey();
    await prove(node.credential, key);
    delete process.env.RELAY_ACCESS_TOKEN;
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await verdict(await ask(key.id, ""))).toEqual({ status: 503, body: "false" });
    expect(await verdict(await ask(key.id))).toEqual({ status: 503, body: "false" });
    expect(error).toHaveBeenCalledWith(expect.stringContaining("RELAY_ACCESS_TOKEN"));
    error.mockRestore();
  });

  it("accepts RELAY_ACCESS_TOKEN_NEXT beside the current secret during a rotation", async () => {
    const { node, prove, ask } = await fixture();
    const key = await newKey();
    await prove(node.credential, key);
    process.env.RELAY_ACCESS_TOKEN_NEXT = NEXT;
    expect((await ask(key.id, SECRET)).status).toBe(200);
    expect((await ask(key.id, NEXT)).status).toBe(200);
    // Promoted: NEXT became the current secret and the old one stops working.
    process.env.RELAY_ACCESS_TOKEN = NEXT;
    delete process.env.RELAY_ACCESS_TOKEN_NEXT;
    expect((await ask(key.id, SECRET)).status).toBe(401);
    expect((await ask(key.id, NEXT)).status).toBe(200);
  });

  it("refuses an EndpointId that is missing or not in iroh's lowercase hex form", async () => {
    const { node, prove, ask } = await fixture();
    const key = await newKey();
    await prove(node.credential, key);
    for (const id of [null, "", key.id.toUpperCase(), key.id.slice(2), `${key.id}00`])
      expect(await verdict(await ask(id))).toEqual({ status: 400, body: "false" });
  });

  it("serves only POST, the method iroh-relay uses", async () => {
    const { t, node, prove } = await fixture();
    const key = await newKey();
    await prove(node.credential, key);
    const res = await t.fetch("/api/v1/relay/access", {
      method: "GET",
      headers: { "X-Iroh-Endpoint-Id": key.id, Authorization: `Bearer ${SECRET}` },
    });
    expect(res.status).not.toBe(200);
    expect(await res.text()).not.toBe("true");
  });
});
