import { convexTest, type TestConvex } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { api, internal } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { withDurableAudit } from "../convex/infra/audit";
import {
  APP_LEASE_TTL_MS,
  can,
  decideLease,
  DEPLOYMENTS_KEPT,
  firstFreePort,
  MAX_GIT_BINDINGS,
  mayAssignRole,
  PORT_RANGE_END,
  PORT_RANGE_START,
  roleFromHubRoles,
  type PermissionRole,
} from "../convex/infra/policy";
import {
  decryptValue,
  encryptValue,
  MASTER_KEY_ENV,
  newDataKey,
  requireMasterKey,
  unwrapDataKey,
  type SecretScope,
} from "../convex/infra/secretCrypto";
import { MASK } from "../convex/infra/secrets";
import schema from "../convex/schema";

const modules = import.meta.glob("../convex/**/*.ts");
type Harness = TestConvex<typeof schema>;

const T0 = Date.parse("2026-11-05T00:00:00.000Z");
const MASTER_KEY = "11".repeat(32);
const ENDPOINT_ID = "ab".repeat(32);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
  process.env[MASTER_KEY_ENV] = MASTER_KEY;
});

afterEach(() => {
  vi.useRealTimers();
  delete process.env[MASTER_KEY_ENV];
});

async function addUser(t: Harness, email: string, role?: PermissionRole) {
  return await t.run(
    async (ctx) => await ctx.db.insert("users", { email, ...(role === undefined ? {} : { role }) }),
  );
}

function as(t: Harness, userId: Id<"users">) {
  return t.withIdentity({ subject: `${userId}|session` });
}

async function addNode(t: Harness, name: string) {
  return await t.run(
    async (ctx) => await ctx.db.insert("nodes", { name, source: "enrolled", createdAt: T0 }),
  );
}

async function auditRows(t: Harness) {
  return await t.run(
    async (ctx) => await ctx.db.query("auditEvents").withIndex("by_seq").order("asc").collect(),
  );
}

const user = (role: PermissionRole) => ({ kind: "user" as const, userId: "u", role });
const token = (scope: "read" | "admin" | "metrics") => ({
  kind: "token" as const,
  tokenId: "t",
  scope,
});

async function deployingTo(t: Harness, nodeId: Id<"nodes">, app = "shop") {
  const deploymentId = await t.run(async (ctx) => {
    const { createDeployment } = await import("../convex/infra/deployments");
    return await createDeployment(ctx, {
      app,
      targetNodeIds: [nodeId],
      trigger: { kind: "manual" },
    });
  });
  const begun = (await t.mutation(internal.infra.deployments.begin, { deploymentId })) as {
    epoch: number;
  };
  return { deploymentId, epoch: begun.epoch };
}

describe("policy", () => {
  it("maps the Hub's roles and token scopes onto one permission table", () => {
    expect(can(user("owner"), "account.admin")).toBe(true);
    expect(can(user("admin"), "node.run")).toBe(true);
    expect(can(user("operator"), "app.deploy")).toBe(true);
    expect(can(user("operator"), "node.run")).toBe(false);
    expect(can(user("viewer"), "app.deploy")).toBe(false);
    expect(can(user("viewer"), "audit.read")).toBe(true);

    expect(can(token("admin"), "app.deploy")).toBe(true);
    expect(can(token("admin"), "account.admin")).toBe(false);
    expect(can(token("read"), "app.read")).toBe(true);
    expect(can(token("metrics"), "app.read")).toBe(false);

    // A Node credential carries no permission from the table at all.
    expect(can({ kind: "node", nodeId: "n" }, "app.read")).toBe(false);
  });

  it("takes the highest of a Hub account's roles and never lets a role assign above itself", () => {
    expect(roleFromHubRoles(["viewer", "admin"])).toBe("admin");
    expect(roleFromHubRoles(["bogus"])).toBe("viewer");
    expect(mayAssignRole("admin", "viewer", "owner")).toBe(false);
    expect(mayAssignRole("admin", "owner", "viewer")).toBe(false);
    expect(mayAssignRole("owner", "admin", "owner")).toBe(true);
  });

  it("finds the lowest free port and reports a full range", () => {
    expect(firstFreePort([])).toBe(PORT_RANGE_START);
    expect(firstFreePort([PORT_RANGE_START, PORT_RANGE_START + 2])).toBe(PORT_RANGE_START + 1);
    const full = Array.from(
      { length: PORT_RANGE_END - PORT_RANGE_START + 1 },
      (_, i) => PORT_RANGE_START + i,
    );
    expect(firstFreePort(full)).toBeNull();
  });

  it("grants a free or expired lease with a higher epoch and refuses a live one", () => {
    expect(decideLease(null, "a", 0)).toEqual({ grant: true, epoch: 1, renewed: false });
    const live = { holder: "a", epoch: 3, expiresAt: 100 };
    expect(decideLease(live, "a", 50)).toEqual({ grant: true, epoch: 3, renewed: true });
    expect(decideLease(live, "b", 50)).toEqual({ grant: false, heldBy: "a", expiresAt: 100 });
    expect(decideLease(live, "b", 100)).toEqual({ grant: true, epoch: 4, renewed: false });
    expect(decideLease({ epoch: 3, expiresAt: 999 }, "b", 50)).toEqual({
      grant: true,
      epoch: 4,
      renewed: false,
    });
  });
});

describe("port allocation", () => {
  it("is stable per (Node, key) and unique per (Node, port), across two allocations", async () => {
    const t = convexTest(schema, modules);
    const nodeA = await addNode(t, "node-a");
    const nodeB = await addNode(t, "node-b");

    const [web, db] = await Promise.all([
      t.mutation(internal.infra.ports.allocate, { nodeId: nodeA, key: "shop/web" }),
      t.mutation(internal.infra.ports.allocate, { nodeId: nodeA, key: "shop/db" }),
    ]);
    expect(new Set([web, db])).toEqual(new Set([PORT_RANGE_START, PORT_RANGE_START + 1]));

    // A redeploy asks again and must get the same port back.
    expect(
      await t.mutation(internal.infra.ports.allocate, { nodeId: nodeA, key: "shop/web" }),
    ).toBe(web);
    // Ports are per Node: the same key on another Node starts from the bottom of the range.
    expect(
      await t.mutation(internal.infra.ports.allocate, { nodeId: nodeB, key: "shop/web" }),
    ).toBe(PORT_RANGE_START);

    const rows = await t.run(async (ctx) => await ctx.db.query("portAllocations").collect());
    const pairs = rows.map((row) => `${row.nodeId}:${row.port}`);
    expect(new Set(pairs).size).toBe(pairs.length);
  });

  it("reuses a released App's ports and leaves other Apps' ports alone", async () => {
    const t = convexTest(schema, modules);
    const node = await addNode(t, "node-a");
    await t.mutation(internal.infra.ports.allocate, { nodeId: node, key: "web/web" });
    const kept = await t.mutation(internal.infra.ports.allocate, {
      nodeId: node,
      key: "web-api/api",
    });
    expect(await t.mutation(internal.infra.ports.releaseApp, { app: "web" })).toBe(1);

    expect(await t.mutation(internal.infra.ports.allocate, { nodeId: node, key: "blog/web" })).toBe(
      PORT_RANGE_START,
    );
    expect(
      await t.mutation(internal.infra.ports.allocate, { nodeId: node, key: "web-api/api" }),
    ).toBe(kept);
  });
});

describe("accounts", () => {
  it("makes the first account the owner and refuses a second account for an email", async () => {
    const t = convexTest(schema, modules);
    const { insertUser } = await import("../convex/infra/access");
    const first = await t.run(
      async (ctx) => await insertUser(ctx, { email: "A@x.dev", role: "viewer" }),
    );
    const second = await t.run(
      async (ctx) => await insertUser(ctx, { email: "b@x.dev", role: "viewer" }),
    );
    await expect(
      t.run(async (ctx) => await insertUser(ctx, { email: " a@X.DEV ", role: "admin" })),
    ).rejects.toThrow(/already exists/);

    const users = await t.run(async (ctx) => await ctx.db.query("users").collect());
    expect(users.find((u) => u._id === first)?.role).toBe("owner");
    expect(users.find((u) => u._id === second)?.role).toBe("viewer");
    expect(users.find((u) => u._id === first)?.email).toBe("a@x.dev");
  });

  it("never removes or demotes the last owner", async () => {
    const t = convexTest(schema, modules);
    const owner = await addUser(t, "owner@x.dev", "owner");
    const admin = await addUser(t, "admin@x.dev", "admin");

    await expect(
      as(t, admin).mutation(api.infra.access.removeUser, { userId: owner }),
    ).rejects.toThrow(/cannot remove an owner/);
    await expect(
      as(t, owner).mutation(api.infra.access.setUserRole, { userId: owner, role: "admin" }),
    ).rejects.toThrow(/last owner/);

    // With a second owner, demoting one is fine, and the remaining one is then the last.
    await as(t, owner).mutation(api.infra.access.setUserRole, { userId: admin, role: "owner" });
    await as(t, admin).mutation(api.infra.access.setUserRole, { userId: owner, role: "viewer" });
    await expect(
      as(t, admin).mutation(api.infra.access.setUserRole, { userId: admin, role: "admin" }),
    ).rejects.toThrow(/last owner/);
    await expect(
      as(t, admin).mutation(api.infra.access.removeUser, { userId: admin }),
    ).rejects.toThrow(/yourself/);
  });

  it("counts an account from before roles existed as an owner", async () => {
    const t = convexTest(schema, modules);
    const legacy = await addUser(t, "legacy@x.dev");
    const owner = await addUser(t, "owner@x.dev", "owner");
    // The legacy account is the other owner, so the explicit owner may step down.
    await as(t, owner).mutation(api.infra.access.setUserRole, { userId: owner, role: "admin" });
    await expect(
      as(t, legacy).mutation(api.infra.access.removeUser, { userId: legacy }),
    ).rejects.toThrow(/yourself/);
    await expect(
      as(t, owner).mutation(api.infra.access.removeUser, { userId: legacy }),
    ).rejects.toThrow(/cannot remove an owner/);
  });

  it("removes an account's sign-in material with it, and audits the removal", async () => {
    const t = convexTest(schema, modules);
    const owner = await addUser(t, "owner@x.dev", "owner");
    const viewer = await addUser(t, "viewer@x.dev", "viewer");
    await t.run(async (ctx) => {
      await ctx.db.insert("authAccounts", {
        userId: viewer,
        provider: "password",
        providerAccountId: "viewer@x.dev",
        secret: "x",
      });
      const session = await ctx.db.insert("authSessions", {
        userId: viewer,
        expirationTime: T0 + 1,
      });
      await ctx.db.insert("authRefreshTokens", { sessionId: session, expirationTime: T0 + 1 });
    });
    await as(t, owner).mutation(api.infra.access.removeUser, { userId: viewer });
    const left = await t.run(async (ctx) => ({
      accounts: await ctx.db.query("authAccounts").collect(),
      sessions: await ctx.db.query("authSessions").collect(),
      tokens: await ctx.db.query("authRefreshTokens").collect(),
    }));
    expect(left).toEqual({ accounts: [], sessions: [], tokens: [] });
    expect((await auditRows(t)).map((row) => row.action)).toEqual(["account.users.remove"]);
  });

  it("keeps viewer and operator accounts out of the full-trust CI dashboard", async () => {
    const t = convexTest(schema, modules);
    const viewer = await addUser(t, "viewer@x.dev", "viewer");
    const admin = await addUser(t, "admin@x.dev", "admin");
    await expect(as(t, viewer).query(api.apiTokens.list, {})).rejects.toThrow(/viewer role/);
    await expect(as(t, admin).query(api.apiTokens.list, {})).resolves.toEqual([]);
    await expect(as(t, admin).mutation(api.bootstrap.invite, { role: "owner" })).rejects.toThrow(
      /cannot invite/,
    );
  });

  it("requires a permission, not just a signed-in identity, for infra functions", async () => {
    const t = convexTest(schema, modules);
    const viewer = await addUser(t, "viewer@x.dev", "viewer");
    await expect(
      t.withIdentity({ subject: "nobody" }).query(api.infra.apps.list, {}),
    ).rejects.toThrow(/Authentication required/);
    await expect(as(t, viewer).query(api.infra.apps.list, {})).resolves.toEqual([]);
    await expect(
      as(t, viewer).mutation(api.infra.git.bind, { repo: "o/r", branch: "main", app: "r" }),
    ).rejects.toThrow(/viewer role does not allow app.deploy/);
  });
});

describe("git bindings", () => {
  it("keeps (repo, branch) unique, ignoring repository case", async () => {
    const t = convexTest(schema, modules);
    const op = await addUser(t, "op@x.dev", "operator");
    await as(t, op).mutation(api.infra.git.bind, {
      repo: "Acme/Shop",
      branch: "main",
      app: "shop",
    });
    await expect(
      as(t, op).mutation(api.infra.git.bind, { repo: "acme/shop", branch: "main", app: "shop2" }),
    ).rejects.toThrow(/Already bound/);
    // A different branch of the same repository is a different binding.
    await as(t, op).mutation(api.infra.git.bind, {
      repo: "acme/shop",
      branch: "dev",
      app: "shop-dev",
    });
  });

  it(`stops at ${MAX_GIT_BINDINGS} bindings`, async () => {
    const t = convexTest(schema, modules);
    const op = await addUser(t, "op@x.dev", "operator");
    await t.run(async (ctx) => {
      for (let i = 0; i < MAX_GIT_BINDINGS; i += 1) {
        await ctx.db.insert("gitBindings", {
          repo: `o/r${i}`,
          repoKey: `o/r${i}`,
          branch: "main",
          app: `r${i}`,
          createdAt: T0,
        });
      }
    });
    await expect(
      as(t, op).mutation(api.infra.git.bind, { repo: "o/one-more", branch: "main", app: "x" }),
    ).rejects.toThrow(/limit reached \(200\)/);
  });
});

describe("audit", () => {
  it("issues sequence numbers in commit order with no gaps", async () => {
    const t = convexTest(schema, modules);
    await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        t.mutation(internal.infra.audit.append, {
          actor: "a",
          action: `act.${i}`,
          outcome: "success",
        }),
      ),
    );
    const rows = await auditRows(t);
    expect(rows.map((row) => row.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(new Set(rows.map((row) => row.action)).size).toBe(5);
  });

  it("lists newest first to an audit reader", async () => {
    const t = convexTest(schema, modules);
    const viewer = await addUser(t, "viewer@x.dev", "viewer");
    for (const action of ["one", "two", "three"]) {
      await t.mutation(internal.infra.audit.append, {
        actor: "a",
        action,
        outcome: "success",
        meta: { n: 1 },
      });
    }
    const listed = await as(t, viewer).query(api.infra.audit.list, { limit: 2 });
    expect(listed.map((row) => [row.seq, row.action, row.meta])).toEqual([
      [3, "three", { n: 1 }],
      [2, "two", { n: 1 }],
    ]);
    expect(
      (await as(t, viewer).query(api.infra.audit.list, { before: 2 })).map((row) => row.seq),
    ).toEqual([1]);
  });

  it("runs a side effect only after its attempt row is durable", async () => {
    const t = convexTest(schema, modules);
    const effect = vi.fn(async () => "done");
    // The action's runMutation, routed to the test deployment.
    const runMutation = ((reference: Parameters<typeof t.mutation>[0], args: never) =>
      t.mutation(reference, args)) as never;

    await expect(
      withDurableAudit({ runMutation }, { actor: "a", action: "backup.now" }, effect),
    ).resolves.toBe("done");
    expect(effect).toHaveBeenCalledTimes(1);
    expect((await auditRows(t)).map((row) => row.outcome)).toEqual(["attempt", "success"]);

    // An audit write that fails refuses the action: the effect never starts.
    const refused = vi.fn(async () => "never");
    await expect(
      withDurableAudit({ runMutation }, { actor: "a", action: " " }, refused),
    ).rejects.toThrow(/audit action/);
    expect(refused).not.toHaveBeenCalled();

    // A failed effect is recorded as a failure, after its attempt.
    await expect(
      withDurableAudit({ runMutation }, { actor: "a", action: "routes.remove" }, async () => {
        throw new Error("node unreachable");
      }),
    ).rejects.toThrow(/node unreachable/);
    const rows = await auditRows(t);
    expect(rows.slice(-2).map((row) => [row.action, row.outcome])).toEqual([
      ["routes.remove", "attempt"],
      ["routes.remove", "failure"],
    ]);
  });
});

describe("App leases", () => {
  it("refuses a stale holder by its epoch", async () => {
    const t = convexTest(schema, modules);
    const first = await t.mutation(internal.infra.leases.acquire, {
      app: "shop",
      holder: "run-1",
      operation: "deploy",
    });
    expect(first).toEqual({ grant: true, epoch: 1, renewed: false });
    expect(
      await t.mutation(internal.infra.leases.acquire, {
        app: "shop",
        holder: "run-2",
        operation: "deploy",
      }),
    ).toMatchObject({ grant: false, heldBy: "run-1" });

    // run-1 stalls past its expiry; run-2 takes over with a higher epoch.
    vi.setSystemTime(T0 + APP_LEASE_TTL_MS + 1);
    expect(
      await t.mutation(internal.infra.leases.acquire, {
        app: "shop",
        holder: "run-2",
        operation: "deploy",
      }),
    ).toEqual({ grant: true, epoch: 2, renewed: false });

    // run-1 wakes up: it can neither renew nor release what it no longer holds.
    await expect(
      t.mutation(internal.infra.leases.renew, { app: "shop", epoch: 1 }),
    ).rejects.toThrow(/Stale lease/);
    await t.mutation(internal.infra.leases.release, { app: "shop", epoch: 1 });
    await expect(
      t.mutation(internal.infra.leases.renew, { app: "shop", epoch: 2 }),
    ).resolves.toBeNull();
  });

  it("runs one deploy per App at a time and fences every step on the epoch", async () => {
    const t = convexTest(schema, modules);
    const node = await addNode(t, "node-a");
    const [one, two] = await t.run(async (ctx) => {
      const { createDeployment } = await import("../convex/infra/deployments");
      return [
        await createDeployment(ctx, {
          app: "shop",
          targetNodeIds: [node],
          trigger: { kind: "manual" },
        }),
        await createDeployment(ctx, {
          app: "shop",
          targetNodeIds: [node],
          trigger: { kind: "manual" },
        }),
      ];
    });
    const begun = await t.mutation(internal.infra.deployments.begin, { deploymentId: one });
    expect(begun).toEqual({ started: true, epoch: 1 });
    expect(await t.mutation(internal.infra.deployments.begin, { deploymentId: two })).toMatchObject(
      {
        started: false,
      },
    );

    await t.mutation(internal.infra.deployments.advance, {
      deploymentId: one,
      epoch: 1,
      stage: "building",
    });

    // A failover takes the App once the run's lease lapses; the run's next write is refused.
    vi.setSystemTime(T0 + 2 * APP_LEASE_TTL_MS);
    const failover = await t.mutation(internal.infra.deployments.beginFailover, {
      app: "shop",
      lostNodeId: node,
    });
    expect(failover).toEqual({ granted: true, epoch: 2 });
    await expect(
      t.mutation(internal.infra.deployments.advance, {
        deploymentId: one,
        epoch: 1,
        stage: "done",
      }),
    ).rejects.toThrow(/Stale lease/);

    // The sweep fails the run that lost its lease, once, and leaves the queued one waiting.
    expect(await t.mutation(internal.infra.deployments.sweepStale, {})).toBe(1);
    expect(await t.mutation(internal.infra.deployments.sweepStale, {})).toBe(0);
    const runs = await t.run(async (ctx) => [await ctx.db.get(one), await ctx.db.get(two)]);
    expect(runs.map((run) => run?.stage)).toEqual(["failed", "queued"]);
  });

  it("moves an App and its routes only for the failover that holds the lease", async () => {
    const t = convexTest(schema, modules);
    const lost = await addNode(t, "lost");
    const survivor = await addNode(t, "survivor");
    await t.run(async (ctx) => {
      await ctx.db.insert("apps", {
        name: "shop",
        nodeId: lost,
        services: [{ name: "web", image: "r/shop:1", args: [], port: 62000, route: "shop" }],
        links: [],
        updatedAt: T0,
      });
      await ctx.db.insert("appRoutes", {
        name: "shop",
        nodeId: lost,
        image: "r/shop:1",
        port: 62000,
        updatedAt: T0,
      });
    });
    const { epoch } = (await t.mutation(internal.infra.deployments.beginFailover, {
      app: "shop",
      lostNodeId: lost,
    })) as { epoch: number };
    // A second failover for the same App, say from a duplicate disconnect, is refused.
    expect(
      await t.mutation(internal.infra.deployments.beginFailover, {
        app: "shop",
        lostNodeId: survivor,
      }),
    ).toMatchObject({ granted: false });
    await expect(
      t.mutation(internal.infra.deployments.completeFailover, {
        app: "shop",
        epoch: epoch + 1,
        fromNodeId: lost,
        toNodeId: survivor,
      }),
    ).rejects.toThrow(/Stale lease/);
    // Not redeployed on the survivor yet: there is no port there, so nothing moves. Keeping 62000
    // would name whatever holds 62000 on the survivor.
    await expect(
      t.mutation(internal.infra.deployments.completeFailover, {
        app: "shop",
        epoch,
        fromNodeId: lost,
        toNodeId: survivor,
      }),
    ).rejects.toThrow(/no port on the target Node/);
    await t.run((ctx) =>
      ctx.db.insert("portAllocations", {
        nodeId: survivor,
        key: "shop/web",
        port: 62003,
        app: "shop",
        allocatedAt: T0,
      }),
    );
    await t.mutation(internal.infra.deployments.completeFailover, {
      app: "shop",
      epoch,
      fromNodeId: lost,
      toNodeId: survivor,
    });
    const moved = await t.run(async (ctx) => ({
      app: await ctx.db.query("apps").first(),
      route: await ctx.db.query("appRoutes").first(),
    }));
    // Node and port move together, to the survivor's own allocation.
    expect(moved.app?.nodeId).toBe(survivor);
    expect(moved.app?.services[0]).toMatchObject({ nodeId: survivor, port: 62003 });
    expect(moved.route).toMatchObject({ nodeId: survivor, port: 62003 });
  });
});

describe("deployment retention", () => {
  it(`keeps the newest ${DEPLOYMENTS_KEPT} records`, async () => {
    const t = convexTest(schema, modules);
    const viewer = await addUser(t, "viewer@x.dev", "viewer");
    await t.run(async (ctx) => {
      const { createDeployment } = await import("../convex/infra/deployments");
      for (let i = 0; i < DEPLOYMENTS_KEPT + 3; i += 1) {
        await createDeployment(ctx, {
          app: "shop",
          targetNodeIds: [],
          trigger: { kind: "manual" },
          stage: "done",
          startedAt: T0 + i,
        });
      }
    });
    const rows = await t.run(async (ctx) => await ctx.db.query("appDeployments").collect());
    expect(rows).toHaveLength(DEPLOYMENTS_KEPT);
    expect(Math.min(...rows.map((row) => row.startedAt))).toBe(T0 + 3);
    expect(await as(t, viewer).query(api.infra.deployments.retainedCount, {})).toBe(
      DEPLOYMENTS_KEPT,
    );
  });
});

describe("push webhook intake", () => {
  it("queues one deploy per delivery id, however often GitHub delivers it", async () => {
    const t = convexTest(schema, modules);
    const node = await addNode(t, "node-a");
    await t.run(async (ctx) => {
      await ctx.db.insert("gitBindings", {
        repo: "acme/shop",
        repoKey: "acme/shop",
        branch: "main",
        app: "shop",
        deployNodeId: node,
        createdAt: T0,
      });
    });
    const push = { deliveryId: "guid-1", repo: "Acme/Shop", branch: "main", sha: "abc" };
    const first = await t.mutation(internal.infra.git.acceptPush, push);
    expect(first.outcome).toBe("queued");
    expect(await t.mutation(internal.infra.git.acceptPush, push)).toEqual({ outcome: "duplicate" });
    expect(
      await t.mutation(internal.infra.git.acceptPush, {
        ...push,
        deliveryId: "guid-2",
        branch: "dev",
      }),
    ).toEqual({ outcome: "no-binding" });

    const state = await t.run(async (ctx) => ({
      deployments: await ctx.db.query("appDeployments").collect(),
      deliveries: await ctx.db.query("webhookDeliveries").collect(),
    }));
    expect(state.deployments).toHaveLength(1);
    expect(state.deployments[0]).toMatchObject({
      app: "shop",
      stage: "queued",
      // The binding's deploy Node is where unpinned services land; the planning step sets the
      // targets once it has read the spec.
      defaultNodeId: node,
      targetNodeIds: [],
      source: { kind: "git", repo: "acme/shop", ref: "main" },
      trigger: { kind: "git", sha: "abc", deliveryId: "guid-1" },
    });
    expect(state.deliveries.map((d) => [d.deliveryId, d.status, d.push?.outcome])).toEqual([
      ["guid-1", "processed", "queued"],
      ["guid-2", "processed", "no-binding"],
    ]);
  });
});

describe("App secrets", () => {
  it("stores ciphertext only and returns masked values from every query", async () => {
    const t = convexTest(schema, modules);
    const op = await addUser(t, "op@x.dev", "operator");
    const PLAINTEXT = "postgres://user:hunter2@db/shop";
    await as(t, op).mutation(api.infra.secrets.set, {
      app: "shop",
      vars: { DATABASE_URL: PLAINTEXT, API_KEY: "sk_live_123" },
    });

    // Nothing at rest holds the value: not the secret rows, not the data key rows, not the audit.
    const stored = await t.run(async (ctx) => ({
      secrets: await ctx.db.query("appSecrets").collect(),
      keys: await ctx.db.query("appDataKeys").collect(),
      audit: await ctx.db.query("auditEvents").collect(),
    }));
    expect(JSON.stringify(stored)).not.toContain("hunter2");
    expect(JSON.stringify(stored)).not.toContain("sk_live_123");
    expect(stored.keys).toHaveLength(1);

    // Every public query an operator can call returns the mask, never a value.
    const outputs = await Promise.all([
      as(t, op).query(api.infra.secrets.list, { app: "shop" }),
      as(t, op).query(api.infra.apps.list, {}),
      as(t, op).query(api.infra.apps.routes, {}),
      as(t, op).query(api.infra.apps.meshLinks, {}),
      as(t, op).query(api.infra.deployments.list, {}),
      as(t, op).query(api.infra.audit.list, {}),
      as(t, op).query(api.infra.git.list, {}),
      as(t, op).query(api.infra.nodes.list, {}),
    ]);
    expect(JSON.stringify(outputs)).not.toContain("hunter2");
    expect(JSON.stringify(outputs)).not.toContain("sk_live_123");
    expect(outputs[0]).toEqual([
      { name: "API_KEY", preview: MASK, updatedAt: T0 },
      { name: "DATABASE_URL", preview: MASK, updatedAt: T0 },
    ]);
  });

  it("decrypts only for a live deploy that targets the asking Node", async () => {
    const t = convexTest(schema, modules);
    const op = await addUser(t, "op@x.dev", "operator");
    const target = await addNode(t, "target");
    const bystander = await addNode(t, "bystander");
    await t.run(async (ctx) => {
      await ctx.db.insert("apps", {
        name: "shop",
        nodeId: target,
        services: [{ name: "web", image: "r/shop:1", args: [] }],
        links: [],
        updatedAt: T0,
      });
    });
    await as(t, op).mutation(api.infra.secrets.set, { app: "shop", vars: { TOKEN: "app-level" } });
    await as(t, op).mutation(api.infra.secrets.set, {
      app: "shop",
      service: "web",
      vars: { TOKEN: "service-level" },
    });
    const { deploymentId, epoch } = await deployingTo(t, target);

    expect(
      await t.query(internal.infra.secrets.forNodeDeploy, { nodeId: target, deploymentId }),
    ).toEqual({
      appWide: { TOKEN: "app-level" },
      services: { web: { TOKEN: "service-level" } },
    });
    await expect(
      t.query(internal.infra.secrets.forNodeDeploy, { nodeId: bystander, deploymentId }),
    ).rejects.toThrow(/does not target this Node/);

    await t.mutation(internal.infra.deployments.advance, { deploymentId, epoch, stage: "done" });
    await expect(
      t.query(internal.infra.secrets.forNodeDeploy, { nodeId: target, deploymentId }),
    ).rejects.toThrow(/finished/);
  });

  it("isolates service-private scopes by placement on a split App, even among deployment targets", async () => {
    const t = convexTest(schema, modules);
    const op = await addUser(t, "op@x.dev", "operator");
    const webNode = await addNode(t, "web-node");
    const dbNode = await addNode(t, "db-node");
    const bystander = await addNode(t, "bystander");
    const unusedTarget = await addNode(t, "unused-target");
    const deploymentId = await t.run(async (ctx) => {
      await ctx.db.insert("apps", {
        name: "shop",
        nodeId: webNode,
        services: [
          // An absent nodeId inherits the App's primary Node.
          { name: "web", image: "r/shop:1", args: [] },
          { name: "db", image: "postgres:16", args: [], nodeId: dbNode },
        ],
        links: [],
        updatedAt: T0,
      });
      const { createDeployment } = await import("../convex/infra/deployments");
      return await createDeployment(ctx, {
        app: "shop",
        targetNodeIds: [webNode, dbNode, unusedTarget],
        trigger: { kind: "manual" },
      });
    });
    for (const [service, value] of [
      [undefined, "shared-env"],
      ["web", "web-private"],
      ["db", "db-private"],
    ] as Array<[string | undefined, string]>) {
      await as(t, op).mutation(api.infra.secrets.set, {
        app: "shop",
        service,
        vars: { TOKEN: value },
      });
    }
    await t.mutation(internal.infra.deployments.begin, { deploymentId });

    // Both service hosts receive the common environment, but neither gets the other's private scope.
    expect(
      await t.query(internal.infra.secrets.forNodeDeploy, { nodeId: webNode, deploymentId }),
    ).toEqual({
      appWide: { TOKEN: "shared-env" },
      services: { web: { TOKEN: "web-private" } },
    });
    expect(
      await t.query(internal.infra.secrets.forNodeDeploy, { nodeId: dbNode, deploymentId }),
    ).toEqual({
      appWide: { TOKEN: "shared-env" },
      services: { db: { TOKEN: "db-private" } },
    });
    await expect(
      t.query(internal.infra.secrets.forNodeDeploy, { nodeId: bystander, deploymentId }),
    ).rejects.toThrow(/does not target this Node/);
    await expect(
      t.query(internal.infra.secrets.forNodeDeploy, { nodeId: unusedTarget, deploymentId }),
    ).rejects.toThrow(/No services of this App are placed on this Node/);

    // A new lease holder fences secret reads from the old deployment on both legitimate hosts.
    vi.setSystemTime(T0 + APP_LEASE_TTL_MS + 1);
    await t.mutation(internal.infra.leases.acquire, {
      app: "shop",
      holder: "replacement",
      operation: "deploy",
    });
    for (const nodeId of [webNode, dbNode]) {
      await expect(
        t.query(internal.infra.secrets.forNodeDeploy, { nodeId, deploymentId }),
      ).rejects.toThrow(/no longer holds its App's lease/);
    }
  });

  it("returns only the App-wide scope for a targeted single-container deployment with no apps row", async () => {
    const t = convexTest(schema, modules);
    const op = await addUser(t, "op@x.dev", "operator");
    const nodeId = await addNode(t, "single-container");
    await as(t, op).mutation(api.infra.secrets.set, { app: "shop", vars: { TOKEN: "common" } });
    await as(t, op).mutation(api.infra.secrets.set, {
      app: "shop",
      service: "web",
      vars: { TOKEN: "unplaced" },
    });
    const { deploymentId } = await deployingTo(t, nodeId);
    expect(await t.query(internal.infra.secrets.forNodeDeploy, { nodeId, deploymentId })).toEqual({
      appWide: { TOKEN: "common" },
      services: {},
    });
  });

  it("refuses to read with a different master key and to decrypt a row moved to another name", async () => {
    const t = convexTest(schema, modules);
    const op = await addUser(t, "op@x.dev", "operator");
    const target = await addNode(t, "target");
    await as(t, op).mutation(api.infra.secrets.set, { app: "shop", vars: { A: "1", B: "2" } });
    const { deploymentId } = await deployingTo(t, target);

    // Swap the two ciphertexts: each is bound to its own name, so neither decrypts as the other.
    await t.run(async (ctx) => {
      const [a, b] = await ctx.db.query("appSecrets").collect();
      await ctx.db.patch(a._id, { ciphertext: b.ciphertext, iv: b.iv });
    });
    await expect(
      t.query(internal.infra.secrets.forNodeDeploy, { nodeId: target, deploymentId }),
    ).rejects.toThrow();

    process.env[MASTER_KEY_ENV] = "22".repeat(32);
    await expect(
      t.query(internal.infra.secrets.forNodeDeploy, { nodeId: target, deploymentId }),
    ).rejects.toThrow(/wrapped by master key/);
    delete process.env[MASTER_KEY_ENV];
    await expect(
      as(t, op).mutation(api.infra.secrets.set, { app: "shop", vars: { C: "3" } }),
    ).rejects.toThrow(/ERAINFRA_SECRETS_MASTER_KEY is not set/);
  });

  it("validates every name before writing any value", async () => {
    const t = convexTest(schema, modules);
    const op = await addUser(t, "op@x.dev", "operator");
    await expect(
      as(t, op).mutation(api.infra.secrets.set, { app: "shop", vars: { GOOD: "1", "1BAD": "2" } }),
    ).rejects.toThrow(/Invalid environment variable name: 1BAD/);
    expect(await t.run(async (ctx) => await ctx.db.query("appSecrets").collect())).toEqual([]);
  });

  it("holds App and service names to the naming rule before writing anything", async () => {
    const t = convexTest(schema, modules);
    const op = await addUser(t, "op@x.dev", "operator");
    await expect(
      as(t, op).mutation(api.infra.secrets.set, { app: "web/api", vars: { A: "1" } }),
    ).rejects.toThrow(/Invalid App name: web\/api/);
    await expect(
      as(t, op).mutation(api.infra.secrets.set, { app: "web", service: "-api", vars: { A: "1" } }),
    ).rejects.toThrow(/Invalid service name: -api/);
    await expect(
      as(t, op).query(api.infra.secrets.list, { app: "web", service: "" }),
    ).rejects.toThrow(/Invalid service name/);
    expect(
      await t.run(async (ctx) => ({
        secrets: await ctx.db.query("appSecrets").collect(),
        keys: await ctx.db.query("appDataKeys").collect(),
      })),
    ).toEqual({ secrets: [], keys: [] });
  });

  // App `web` with service `api`, and App `web-api`: the Hub's `<app>-<service>` string named both
  // `web-api`, so each App's Node received the other's secrets.
  async function collidingApps(t: Harness) {
    const op = await addUser(t, "op@x.dev", "operator");
    const webNode = await addNode(t, "web-node");
    const webApiNode = await addNode(t, "web-api-node");
    await t.run(async (ctx) => {
      await ctx.db.insert("apps", {
        name: "web",
        nodeId: webNode,
        services: [{ name: "api", image: "r/web-api:1", args: [] }],
        links: [],
        updatedAt: T0,
      });
      await ctx.db.insert("apps", {
        name: "web-api",
        nodeId: webApiNode,
        services: [{ name: "main", image: "r/web-api-app:1", args: [] }],
        links: [],
        updatedAt: T0,
      });
    });
    return { op, webNode, webApiNode };
  }

  it("keeps service api of App web and App web-api apart, in both directions", async () => {
    const t = convexTest(schema, modules);
    const { op, webNode, webApiNode } = await collidingApps(t);
    const set = (scope: SecretScope, value: string) =>
      as(t, op).mutation(api.infra.secrets.set, { ...scope, vars: { TOKEN: value } });
    await set({ app: "web" }, "web-common");
    await set({ app: "web", service: "api" }, "web-api-service-private");
    // Writing App web-api's App-wide scope second must not overwrite service api of App web.
    await set({ app: "web-api" }, "web-api-app-wide");

    expect(
      await t.run(async (ctx) =>
        (await ctx.db.query("appDataKeys").collect()).map((k) => [k.app, k.service ?? null]),
      ),
    ).toEqual([
      ["web", null],
      ["web", "api"],
      ["web-api", null],
    ]);
    const names = async (scope: SecretScope) =>
      (await as(t, op).query(api.infra.secrets.list, scope)).map((row) => row.name);
    expect(await names({ app: "web-api" })).toEqual(["TOKEN"]);
    expect(await names({ app: "web", service: "api" })).toEqual(["TOKEN"]);

    // App web deploys: its Node gets web's scopes and nothing of App web-api.
    const web = await deployingTo(t, webNode, "web");
    const forWeb = await t.query(internal.infra.secrets.forNodeDeploy, {
      nodeId: webNode,
      deploymentId: web.deploymentId,
    });
    expect(forWeb).toEqual({
      appWide: { TOKEN: "web-common" },
      services: { api: { TOKEN: "web-api-service-private" } },
    });
    expect(JSON.stringify(forWeb)).not.toContain("web-api-app-wide");

    // App web-api deploys: its Node gets web-api's App-wide scope and nothing of App web.
    const webApi = await deployingTo(t, webApiNode, "web-api");
    const forWebApi = await t.query(internal.infra.secrets.forNodeDeploy, {
      nodeId: webApiNode,
      deploymentId: webApi.deploymentId,
    });
    expect(forWebApi).toEqual({ appWide: { TOKEN: "web-api-app-wide" }, services: { main: {} } });
    expect(JSON.stringify(forWebApi)).not.toContain("web-common");
    expect(JSON.stringify(forWebApi)).not.toContain("service-private");

    // Unsetting App web-api's variable leaves service api of App web alone, and the reverse.
    expect(
      await as(t, op).mutation(api.infra.secrets.unset, { app: "web-api", name: "TOKEN" }),
    ).toBe(true);
    expect(await names({ app: "web", service: "api" })).toEqual(["TOKEN"]);
    expect(
      await as(t, op).mutation(api.infra.secrets.unset, {
        app: "web",
        service: "api",
        name: "TOKEN",
      }),
    ).toBe(true);
    expect(await names({ app: "web" })).toEqual(["TOKEN"]);
    expect(
      await t.query(internal.infra.secrets.forNodeDeploy, {
        nodeId: webNode,
        deploymentId: web.deploymentId,
      }),
    ).toEqual({ appWide: { TOKEN: "web-common" }, services: { api: {} } });
  });

  it("binds data keys and values to (app, service), so web/api and web-api do not decrypt as each other", async () => {
    const master = await requireMasterKey({ [MASTER_KEY_ENV]: MASTER_KEY });
    const service: SecretScope = { app: "web", service: "api" };
    const appWide: SecretScope = { app: "web-api" };
    for (const [from, to] of [
      [service, appWide],
      [appWide, service],
    ]) {
      const created = await newDataKey(master, from);
      const wrapped = { ...created.wrapped, masterKeyId: master.id };
      const sealed = await encryptValue(created.key, from, "TOKEN", "value");
      const unwrapped = await unwrapDataKey(master, from, wrapped);
      expect(await decryptValue(unwrapped, from, "TOKEN", sealed)).toBe("value");
      await expect(unwrapDataKey(master, to, wrapped)).rejects.toThrow();
      await expect(decryptValue(created.key, to, "TOKEN", sealed)).rejects.toThrow();
    }
  });

  it("refuses rows moved between scope web/api and scope web-api in the database, both ways", async () => {
    const moves: Array<[SecretScope, SecretScope]> = [
      [{ app: "web", service: "api" }, { app: "web-api" }],
      [{ app: "web-api" }, { app: "web", service: "api" }],
    ];
    for (const [from, to] of moves) {
      const t = convexTest(schema, modules);
      const { op, webNode, webApiNode } = await collidingApps(t);
      await as(t, op).mutation(api.infra.secrets.set, { ...from, vars: { TOKEN: "moved" } });
      // Relabel the data key and the value together, the strongest move a database writer has.
      await t.run(async (ctx) => {
        for (const { _id, _creationTime, service: _service, ...rest } of await ctx.db
          .query("appDataKeys")
          .collect()) {
          await ctx.db.replace(_id, { ...rest, ...to });
        }
        for (const { _id, _creationTime, service: _service, ...rest } of await ctx.db
          .query("appSecrets")
          .collect()) {
          await ctx.db.replace(_id, { ...rest, ...to });
        }
      });
      const nodeId = to.app === "web" ? webNode : webApiNode;
      const { deploymentId } = await deployingTo(t, nodeId, to.app);
      const read = () => t.query(internal.infra.secrets.forNodeDeploy, { nodeId, deploymentId });
      await expect(read()).rejects.toThrow();
    }
  });
});

describe("Nodes", () => {
  it("binds a credential to one Node and lets the Node register its iroh endpoint once", async () => {
    const t = convexTest(schema, modules);
    const owner = await addUser(t, "owner@x.dev", "owner");
    const { nodeId, credential } = await as(t, owner).mutation(api.infra.nodes.enroll, {
      name: "edge-1",
    });
    expect(credential).toMatch(/^erainfra_node_[0-9a-f]{64}$/);

    expect(await t.query(internal.infra.nodes.authenticate, { credential })).toMatchObject({
      nodeId,
    });
    expect(
      await t.query(internal.infra.nodes.authenticate, {
        credential: `erainfra_node_${"0".repeat(64)}`,
      }),
    ).toBeNull();

    const addr = { relayUrl: "https://relay.example/", directAddresses: ["203.0.113.5:4433"] };
    await t.mutation(internal.infra.nodes.registerEndpoint, {
      nodeId,
      endpointId: ENDPOINT_ID,
      endpointAddr: addr,
    });
    // Addresses change as a Node moves; the same key re-registering is fine.
    await t.mutation(internal.infra.nodes.registerEndpoint, {
      nodeId,
      endpointId: ENDPOINT_ID,
      endpointAddr: { directAddresses: [] },
    });
    // A different key is a different identity and needs an operator.
    await expect(
      t.mutation(internal.infra.nodes.registerEndpoint, {
        nodeId,
        endpointId: "cd".repeat(32),
        endpointAddr: addr,
      }),
    ).rejects.toThrow(/must reset it/);
    // Another Node cannot claim this one's key.
    const other = await addNode(t, "edge-2");
    await expect(
      t.mutation(internal.infra.nodes.registerEndpoint, {
        nodeId: other,
        endpointId: ENDPOINT_ID,
        endpointAddr: addr,
      }),
    ).rejects.toThrow(/already belongs to edge-1/);

    const listed = (await as(t, owner).query(api.infra.nodes.list, {})).find(
      (n) => n.name === "edge-1",
    )!;
    expect(listed).toMatchObject({
      endpointId: ENDPOINT_ID,
      endpointAddr: { directAddresses: [] },
    });
    expect(JSON.stringify(listed)).not.toContain(credential);

    await as(t, owner).mutation(api.infra.nodes.revokeCredential, {
      credentialId: listed.credentials[0]._id,
    });
    expect(await t.query(internal.infra.nodes.authenticate, { credential })).toBeNull();
  });
});
