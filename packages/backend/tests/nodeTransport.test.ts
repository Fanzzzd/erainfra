import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { api, internal } from "../convex/_generated/api";
import schema from "../convex/schema";
import { validateDockerArgs } from "../convex/infra/dockerArgs";
import { validateOperation, COMMAND_TTL_MS } from "../convex/infra/nodeCommandModel";
import { legacyEndpointAddress } from "../convex/infra/nodeState";
import { listNodeViews } from "../convex/infra/operator";
const modules = import.meta.glob("../convex/**/*.ts");
const T0 = Date.parse("2026-11-05T00:00:00Z");
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
  process.env.ERAINFRA_SECRETS_MASTER_KEY = "11".repeat(32);
});
afterEach(() => {
  vi.useRealTimers();
  delete process.env.ERAINFRA_SECRETS_MASTER_KEY;
});
async function fixture() {
  const t = convexTest(schema, modules);
  const owner = await t.run((ctx) =>
    ctx.db.insert("users", { email: "owner@x.dev", role: "owner" }),
  );
  const human = t.withIdentity({ subject: `${owner}|session` });
  const a = await human.mutation(api.infra.nodes.enroll, { name: "node-a" });
  const b = await human.mutation(api.infra.nodes.enroll, { name: "node-b" });
  const cmd = await human.mutation(api.infra.nodeCommands.enqueue, {
    nodeId: b.nodeId,
    idempotencyKey: "restart-1",
    command: {
      kind: "operate",
      operation: { name: "systemctl.restart", args: { unit: "portless-agent" } },
    },
  });
  const request = (path: string, credential: string, data?: unknown) =>
    t.fetch(`/api/v1/nodes/${path}`, {
      method: data === undefined ? "GET" : "POST",
      headers: { Authorization: `Bearer ${credential}`, "Content-Type": "application/json" },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    });
  return { t, human, a, b, cmd, request };
}
it("checks the same Docker-argument cases as Hub and Go", () => {
  const cases = JSON.parse(
    readFileSync(new URL("../../../testdata/dockerargs-cases.json", import.meta.url), "utf8"),
  ) as { cases: Array<{ args: string[]; expect: string }> };
  for (const c of cases.cases)
    expect(validateDockerArgs(c.args) === null, JSON.stringify(c.args)).toBe(c.expect === "accept");
});
it("refuses shell/argv, unsafe units, unexpected fields and bad counts", () => {
  for (const op of [
    { name: "sh", args: { command: "id" } },
    { name: "systemctl.restart", args: { unit: "sshd" } },
    { name: "disk.usage", args: { argv: "anything" } },
    { name: "container.logs", args: { name: "x", lines: "1001" } },
  ] as Array<{ name: string; args: Record<string, string> }>)
    expect(() => validateOperation(op)).toThrow();
});
describe("scoped Node HTTP API", () => {
  it("derives identity server-side; A cannot list, claim, report or fetch B's payload", async () => {
    const { request, a, b, cmd } = await fixture();
    expect((await request("commands?cursor=", a.credential)).status).toBe(200);
    expect((await (await request("commands", a.credential)).json()).commands).toEqual([]);
    for (const path of [
      "commands/claim",
      "commands/renew",
      "commands/payload",
      "commands/result",
    ]) {
      const data =
        path === "commands/claim"
          ? { commandId: cmd, owner: "a" }
          : {
              commandId: cmd,
              owner: "b",
              epoch: 1,
              ...(path === "commands/result" ? { outcome: "success" } : {}),
            };
      expect((await request(path, a.credential, data)).status).toBe(409);
    }
    expect(
      (await request("heartbeat", a.credential, { version: "dev", nodeId: b.nodeId })).status,
    ).toBe(400);
    expect((await request("commands?nodeId=" + b.nodeId, a.credential)).status).toBe(400);
    expect(
      (await request("commands/claim", b.credential, { commandId: cmd, owner: "b" })).status,
    ).toBe(200);
    const payload = await request("commands/payload", b.credential, {
      commandId: cmd,
      owner: "b",
      epoch: 1,
    });
    expect((await payload.json()).operation.name).toBe("systemctl.restart");
  });
  it("rejects operator tokens on every Node route and Node tokens on the operator API", async () => {
    const { request, t, a, human } = await fixture();
    const token = await human.mutation(api.apiTokens.create, { name: "operator", scope: "admin" });
    for (const path of ["state", "commands"])
      expect((await request(path, token.token)).status).toBe(401);
    for (const path of [
      "heartbeat",
      "endpoint/challenge",
      "endpoint",
      "commands/claim",
      "commands/renew",
      "commands/result",
      "commands/payload",
      "commands/status",
    ])
      expect((await request(path, token.token, {})).status).toBe(401);
    expect(
      (await t.fetch("/api/v1/workers", { headers: { Authorization: `Bearer ${a.credential}` } }))
        .status,
    ).toBe(401);
  });
  it("checks revocation on every route, including a previously valid claim", async () => {
    const { request, human, b, cmd } = await fixture();
    await request("commands/claim", b.credential, { commandId: cmd, owner: "b" });
    const node = (await human.query(api.infra.nodes.list, {})).find((n) => n._id === b.nodeId)!;
    await human.mutation(api.infra.nodes.revokeCredential, {
      credentialId: node.credentials[0]._id,
    });
    for (const path of ["state", "commands"])
      expect((await request(path, b.credential)).status).toBe(401);
    for (const path of [
      "heartbeat",
      "endpoint/challenge",
      "endpoint",
      "commands/claim",
      "commands/renew",
      "commands/result",
      "commands/payload",
    ])
      expect((await request(path, b.credential, {})).status).toBe(401);
  });
  it("serializes competing claims and refuses stale epochs/owners and cancellation", async () => {
    const { t, human, request, b, cmd } = await fixture();
    const outcomes = await Promise.all([
      request("commands/claim", b.credential, { commandId: cmd, owner: "one" }),
      request("commands/claim", b.credential, { commandId: cmd, owner: "two" }),
    ]);
    expect(outcomes.map((r) => r.status).toSorted()).toEqual([200, 409]);
    const owner = outcomes[0].status === 200 ? "one" : "two";
    vi.setSystemTime(T0 + COMMAND_TTL_MS + 1);
    expect(
      (
        await request("commands/result", b.credential, {
          commandId: cmd,
          owner,
          epoch: 1,
          outcome: "success",
        })
      ).status,
    ).toBe(409);
    const renewed = await (
      await request("commands/claim", b.credential, { commandId: cmd, owner: "replacement" })
    ).json();
    expect(renewed.epoch).toBe(2);
    // Even the current owner cannot reuse an earlier execution epoch.
    expect(
      (
        await request("commands/renew", b.credential, {
          commandId: cmd,
          owner: "replacement",
          epoch: 1,
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await request("commands/result", b.credential, {
          commandId: cmd,
          owner: "replacement",
          epoch: 1,
          outcome: "success",
        })
      ).status,
    ).toBe(409);
    const competing = await human.mutation(api.infra.nodeCommands.enqueue, {
      nodeId: b.nodeId,
      idempotencyKey: "other-command",
      command: { kind: "operate", operation: { name: "disk.usage", args: {} } },
    });
    expect(
      (await request("commands/claim", b.credential, { commandId: competing, owner: "another" }))
        .status,
    ).toBe(409);
    expect(
      (await request("commands/renew", b.credential, { commandId: cmd, owner, epoch: 1 })).status,
    ).toBe(409);
    await human.mutation(api.infra.nodeCommands.cancel, { commandId: cmd });
    expect(
      (
        await request("commands/renew", b.credential, {
          commandId: cmd,
          owner: "replacement",
          epoch: 2,
        })
      ).status,
    ).toBe(409);
    expect((await t.run((ctx) => ctx.db.get(cmd)))?.status).toBe("cancelled");
  });
  // The Infra Agent forgets a journal key only when this says the command is terminal with the
  // outcome it recorded, so the answer must be exactly the row's status, and a terminal command
  // must be one Convex never delivers again.
  it("answers command statuses for this Node only, and never re-delivers a terminal command", async () => {
    const { human, request, a, b, cmd } = await fixture();
    const statuses = async (credential: string, commandIds: unknown) => {
      const response = await request("commands/status", credential, { commandIds });
      return {
        status: response.status,
        body: response.status === 200 ? await response.json() : null,
      };
    };
    const other = await human.mutation(api.infra.nodeCommands.enqueue, {
      nodeId: a.nodeId,
      idempotencyKey: "a-disk",
      command: { kind: "operate", operation: { name: "disk.usage", args: {} } },
    });
    expect((await statuses(b.credential, [cmd, other, "cmd00001", ""])).body).toEqual({
      commands: [
        { id: cmd, status: "pending" },
        // Another Node's command, a malformed id and an empty one all read as missing.
        { id: other, status: "missing" },
        { id: "cmd00001", status: "missing" },
        { id: "", status: "missing" },
      ],
    });
    const lease = await (
      await request("commands/claim", b.credential, { commandId: cmd, owner: "b" })
    ).json();
    expect((await statuses(b.credential, [cmd])).body.commands[0].status).toBe("running");
    const report = { commandId: cmd, owner: "b", epoch: lease.epoch, outcome: "success" };
    expect((await request("commands/result", b.credential, report)).status).toBe(200);
    expect((await statuses(b.credential, [cmd])).body.commands[0].status).toBe("success");
    // Terminal: not listed, not claimable by any owner, even after the lease would have lapsed.
    vi.setSystemTime(T0 + 10 * COMMAND_TTL_MS);
    expect((await (await request("commands", b.credential)).json()).commands).toEqual([]);
    for (const owner of ["b", "after-restart"])
      expect(
        (await request("commands/claim", b.credential, { commandId: cmd, owner })).status,
      ).toBe(409);
    expect((await statuses(b.credential, [cmd])).body.commands[0].status).toBe("success");
    // Bounded and strictly shaped.
    expect((await statuses(b.credential, Array(201).fill(cmd))).status).toBe(409);
    expect((await statuses(b.credential, Array(200).fill(cmd))).status).toBe(200);
    expect((await statuses(b.credential, ["x".repeat(65)])).status).toBe(409);
    expect((await statuses(b.credential, "not-a-list")).status).toBe(409);
    expect(
      (await request("commands/status", b.credential, { commandIds: [], extra: 1 })).status,
    ).toBe(400);
  });
  it("stores the command health a heartbeat reports, keeping when a block began", async () => {
    const { t, request, b } = await fixture();
    const heartbeat = (body: Record<string, unknown>) =>
      request("heartbeat", b.credential, { version: "0.3.0", ...body });
    const view = async () =>
      (await t.run((ctx) => listNodeViews(ctx, Date.now()))).find((n) => n.id === b.nodeId)!
        .commands;
    // An older agent sends the version alone.
    expect((await heartbeat({})).status).toBe(200);
    expect(await view()).toEqual({
      blocked: null,
      blockedSince: null,
      journalKeys: null,
      journalKeyLimit: null,
    });
    expect(
      (
        await heartbeat({
          commandsBlocked: "journal_full",
          journalKeys: 10000,
          journalKeyLimit: 10000,
        })
      ).status,
    ).toBe(200);
    vi.setSystemTime(T0 + 60_000);
    // A different reason while still blocked keeps the original start.
    await heartbeat({
      commandsBlocked: "journal_error",
      journalKeys: 10000,
      journalKeyLimit: 10000,
    });
    expect(await view()).toEqual({
      blocked: "journal_error",
      blockedSince: T0,
      journalKeys: 10000,
      journalKeyLimit: 10000,
    });
    vi.setSystemTime(T0 + 120_000);
    await heartbeat({ journalKeys: 2, journalKeyLimit: 10000 });
    expect(await view()).toEqual({
      blocked: null,
      blockedSince: null,
      journalKeys: 2,
      journalKeyLimit: 10000,
    });
    const node = await t.run((ctx) => ctx.db.get(b.nodeId));
    expect(node?.commandsBlockedSince).toBeUndefined();
    for (const bad of [
      { commandsBlocked: "Journal Full; rm -rf" },
      { commandsBlocked: "" },
      { journalKeys: -1 },
      { journalKeys: 1.5 },
      { journalKeyLimit: 2_000_000 },
    ])
      expect((await heartbeat(bad)).status, JSON.stringify(bad)).toBe(409);
  });
  it("enqueues only with a human permission and durable audit; deduplicates keys and bounds pages", async () => {
    const { t, human, a } = await fixture();
    const command = { kind: "operate" as const, operation: { name: "disk.usage", args: {} } };
    await expect(
      t.mutation(api.infra.nodeCommands.enqueue, {
        nodeId: a.nodeId,
        idempotencyKey: "x",
        command,
      }),
    ).rejects.toThrow(/Authentication/);
    const viewer = await t.run((ctx) =>
      ctx.db.insert("users", { email: "viewer@x.dev", role: "viewer" }),
    );
    await expect(
      t.withIdentity({ subject: viewer }).mutation(api.infra.nodeCommands.enqueue, {
        nodeId: a.nodeId,
        idempotencyKey: "x",
        command,
      }),
    ).rejects.toThrow(/node.run/);
    for (let i = 0; i < 28; i++)
      await human.mutation(api.infra.nodeCommands.enqueue, {
        nodeId: a.nodeId,
        idempotencyKey: `q-${i}`,
        command,
      });
    const id = await human.mutation(api.infra.nodeCommands.enqueue, {
      nodeId: a.nodeId,
      idempotencyKey: "q-0",
      command,
    });
    await expect(
      human.mutation(api.infra.nodeCommands.enqueue, {
        nodeId: a.nodeId,
        idempotencyKey: "q-0",
        command: { kind: "operate", operation: { name: "system.hostname", args: {} } },
      }),
    ).rejects.toThrow(/different command/);
    const first = await t.query(internal.infra.nodeState.pending, {
      credential: a.credential,
      cursor: null,
    });
    expect(first.commands).toHaveLength(25);
    const next = await t.query(internal.infra.nodeState.pending, {
      credential: a.credential,
      cursor: first.cursor,
    });
    expect(next.commands).toHaveLength(3);
    const audit = await t.run((ctx) => ctx.db.query("auditEvents").collect());
    expect(audit.some((r) => r.target === id && r.action === "nodes.enqueue")).toBe(true);
  });
  it("rolls back the queued command if its durable audit insert fails", async () => {
    const { t, human, a } = await fixture();
    // Corrupting the singleton audit counter makes appendAudit refuse the entire transaction.
    await t.run((ctx) => ctx.db.insert("infraCounters", { name: "auditSeq", value: 1 }));
    await expect(
      human.mutation(api.infra.nodeCommands.enqueue, {
        nodeId: a.nodeId,
        idempotencyKey: "no-audit",
        command: { kind: "operate", operation: { name: "disk.usage", args: {} } },
      }),
    ).rejects.toThrow();
    expect(
      await t.run((ctx) =>
        ctx.db
          .query("nodeCommands")
          .withIndex("by_node", (q) => q.eq("nodeId", a.nodeId))
          .collect(),
      ),
    ).toEqual([]);
  });
  it("delivers plaintext only through an active claimed deploy and only its placed services", async () => {
    const { t, human, a, b, request } = await fixture();
    const dep = await t.run(async (ctx) => {
      await ctx.db.insert("apps", {
        name: "shop",
        nodeId: a.nodeId,
        services: [
          { name: "web", image: "shop:1", args: [] },
          { name: "db", nodeId: b.nodeId, image: "postgres:16", args: [] },
        ],
        links: [],
        updatedAt: T0,
      });
      const { createDeployment } = await import("../convex/infra/deployments");
      return await createDeployment(ctx, {
        app: "shop",
        targetNodeIds: [a.nodeId, b.nodeId],
        trigger: { kind: "manual" },
      });
    });
    const deploy = { kind: "deploy" as const, deploymentId: dep };
    await expect(
      human.mutation(api.infra.nodeCommands.enqueue, {
        nodeId: a.nodeId,
        idempotencyKey: "deploy-1",
        command: deploy,
      }),
    ).rejects.toThrow(/not active/);
    await t.mutation(internal.infra.deployments.begin, { deploymentId: dep });
    await expect(
      human.mutation(api.infra.nodeCommands.enqueue, {
        nodeId: a.nodeId,
        idempotencyKey: "wrong-operation",
        command: { ...deploy, operation: "failover" },
      }),
    ).rejects.toThrow(/lease operation/);
    for (const [service, value] of [
      [undefined, "common"],
      ["web", "web-private"],
      ["db", "db-private"],
    ] as Array<[string | undefined, string]>)
      await human.mutation(api.infra.secrets.set, { app: "shop", service, vars: { TOKEN: value } });
    const id = await human.mutation(api.infra.nodeCommands.enqueue, {
      nodeId: a.nodeId,
      idempotencyKey: "deploy-1",
      command: deploy,
    });
    const c = { commandId: id, owner: "a", epoch: 1 };
    expect((await request("commands/payload", a.credential, c)).status).toBe(409);
    await request("commands/claim", a.credential, { commandId: id, owner: "a" });
    const payload = await (await request("commands/payload", a.credential, c)).json();
    expect(payload.services.map((s: { name: string; env: unknown }) => [s.name, s.env])).toEqual([
      ["web", { TOKEN: "web-private" }],
    ]);
    expect((await request("commands/payload", b.credential, c)).status).toBe(409);
    const listing = JSON.stringify(await (await request("commands", a.credential)).json());
    expect(listing).not.toContain("private");
    expect(
      (
        await request("commands/result", a.credential, {
          ...c,
          outcome: "success",
          output: "web-private",
        })
      ).status,
      // `output` is a field of the result route now, for log tails only (infra/logs.ts); a deploy
      // command that sends it is refused and nothing is stored.
    ).toBe(409);
    vi.setSystemTime(T0 + COMMAND_TTL_MS + 1);
    expect((await request("commands/payload", a.credential, c)).status).toBe(409);
    const audit = JSON.stringify(await t.run((ctx) => ctx.db.query("auditEvents").collect()));
    expect(audit).not.toContain("web-private");
  });
});

describe("mesh possession and desired state", () => {
  it("binds a one-use signed challenge to Node, credential and exact address", async () => {
    const { request, a, b } = await fixture();
    const pair = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
    const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
    const address = {
      id: Array.from(raw, (byte) => byte.toString(16).padStart(2, "0")).join(""),
      relay_urls: ["https://relay.example"],
      direct_addrs: ["192.0.2.1:1234"],
    };
    const challenge = await (await request("endpoint/challenge", a.credential, { address })).json();
    const sig = new Uint8Array(
      await crypto.subtle.sign(
        "Ed25519",
        pair.privateKey,
        new TextEncoder().encode(challenge.message),
      ),
    );
    const proof = {
      challengeId: challenge.challengeId,
      signature: btoa(String.fromCharCode(...sig)),
    };
    expect((await request("endpoint", b.credential, proof)).status).toBe(409);
    expect((await request("endpoint", a.credential, { ...proof, signature: "AA==" })).status).toBe(
      409,
    );
    expect((await request("endpoint", a.credential, proof)).status).toBe(200);
    expect((await request("endpoint", a.credential, proof)).status).toBe(409);
    const another = await (await request("endpoint/challenge", b.credential, { address })).json();
    const sigB = new Uint8Array(
      await crypto.subtle.sign(
        "Ed25519",
        pair.privateKey,
        new TextEncoder().encode(another.message),
      ),
    );
    expect(
      (
        await request("endpoint", b.credential, {
          challengeId: another.challengeId,
          signature: btoa(String.fromCharCode(...sigB)),
        })
      ).status,
    ).toBe(409);
  });
  it("refuses expired challenges and bounds the HTTP body and signed message", async () => {
    const { request, a } = await fixture();
    const pair = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
    const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
    const address = {
      id: Array.from(raw, (byte) => byte.toString(16).padStart(2, "0")).join(""),
      relay_urls: [],
      direct_addrs: [],
    };
    const challenge = await (await request("endpoint/challenge", a.credential, { address })).json();
    const signed = new Uint8Array(
      await crypto.subtle.sign(
        "Ed25519",
        pair.privateKey,
        new TextEncoder().encode(challenge.message),
      ),
    );
    vi.setSystemTime(T0 + 60001);
    expect(
      (
        await request("endpoint", a.credential, {
          challengeId: challenge.challengeId,
          signature: btoa(String.fromCharCode(...signed)),
        })
      ).status,
    ).toBe(409);
    expect(
      (await request("heartbeat", a.credential, { version: "x".repeat(256 * 1024) })).status,
    ).toBe(409);
    const oversized = {
      ...address,
      relay_urls: Array.from({ length: 8 }, () => "https://relay.example/" + "a".repeat(480)),
      direct_addrs: Array.from({ length: 16 }, () => "a".repeat(128)),
    };
    expect((await request("endpoint/challenge", a.credential, { address: oversized })).status).toBe(
      409,
    );
  });
  it("returns only declared peers and per-exposure consumers, in #181's address shape", async () => {
    const { t, human, a, b } = await fixture();
    // Enrolled, so it holds a live credential: a peer without one is never granted.
    const { nodeId: c } = await human.mutation(api.infra.nodes.enroll, { name: "unrelated" });
    await t.run(async (ctx) => {
      for (const [nodeId, hex] of [
        [a.nodeId, "aa"],
        [b.nodeId, "bb"],
        [c, "cc"],
      ] as const)
        await ctx.db.patch(nodeId, {
          endpointId: hex.repeat(32),
          endpointProvenAt: T0,
          meshAddress: {
            id: hex.repeat(32),
            relay_urls: ["https://relay.example"],
            direct_addrs: [],
          },
        });
      await ctx.db.insert("meshLinks", {
        name: "db",
        providerNodeId: b.nodeId,
        consumerNodeId: a.nodeId,
        providerPort: 5432,
        localPort: 62000,
        updatedAt: T0,
      });
      await ctx.db.insert("meshLinks", {
        name: "cache",
        providerNodeId: b.nodeId,
        consumerNodeId: c,
        providerPort: 6379,
        localPort: 62001,
        updatedAt: T0,
      });
      await ctx.db.insert("apps", {
        name: "shop",
        nodeId: a.nodeId,
        services: [
          { name: "web", image: "shop:1", args: [] },
          { name: "db", image: "postgres:16", nodeId: b.nodeId, args: [] },
        ],
        links: [
          {
            name: "app-db",
            need: "db",
            providerNodeId: b.nodeId,
            consumerNodeId: a.nodeId,
            providerPort: 5432,
            localPort: 62002,
          },
        ],
        updatedAt: T0,
      });
    });
    const stateA = await t.query(internal.infra.nodeState.state, { credential: a.credential });
    const stateB = await t.query(internal.infra.nodeState.state, { credential: b.credential });
    expect(stateA.desired?.fleet.map((p) => p.id)).toEqual(["bb".repeat(32)]);
    expect(stateB.desired?.exposures.find((e) => e.name === "cache")?.allowed_peers).toEqual([
      "cc".repeat(32),
    ]);
    expect(stateB.desired?.exposures.find((e) => e.name === "app-db")?.allowed_peers).toEqual([
      "aa".repeat(32),
    ]);
    expect(stateB.desired?.exposures.find((e) => e.name === "db")).toMatchObject({
      target: "127.0.0.1:5432",
      allowed_peers: ["aa".repeat(32)],
    });
    expect(stateA.desired?.links.find((l) => l.name === "db")).toMatchObject({
      service: "db",
      peer: "bb".repeat(32),
      listen: "127.0.0.1:62000",
    });
    expect(JSON.stringify(stateA)).not.toContain("cc".repeat(32));
    expect(
      await t.query(internal.infra.nodeState.state, {
        credential: a.credential,
        revision: stateA.revision,
      }),
    ).toEqual({ revision: stateA.revision, unchanged: true });
    const conflict = await t.run((ctx) =>
      ctx.db.insert("apps", {
        name: "conflict",
        nodeId: a.nodeId,
        services: [],
        updatedAt: T0,
        links: [
          {
            name: "db",
            need: "db",
            providerNodeId: c,
            consumerNodeId: a.nodeId,
            providerPort: 5432,
            localPort: 62000,
          },
        ],
      }),
    );
    await expect(
      t.query(internal.infra.nodeState.state, { credential: a.credential }),
    ).rejects.toThrow(/Conflicting mesh link name/);
    await t.run((ctx) => ctx.db.delete(conflict));
    await t.run((ctx) => ctx.db.patch(b.nodeId, { endpointProvenAt: undefined }));
    expect(
      (await t.query(internal.infra.nodeState.state, { credential: a.credential })).desired?.fleet,
    ).toEqual([]);
    expect(
      legacyEndpointAddress({
        endpointId: "ab",
        endpointAddr: { relayUrl: "https://r", directAddresses: ["a"] },
      }),
    ).toEqual({ id: "ab", relay_urls: ["https://r"], direct_addrs: ["a"] });
  });
});
