import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "../convex/_generated/api";
import { branchProblem } from "../convex/infra/git";
import { MAX_GIT_BINDINGS } from "../convex/infra/policy";
import schema from "../convex/schema";

// Push-to-deploy bindings on the operator API (/api/v1/git/bindings, infra/operatorGitRoutes.ts),
// end to end through t.fetch as `erainfra git` calls them, and the dashboard functions that share
// their bodies (infra/git.ts).

const modules = import.meta.glob("../convex/**/*.ts");
const T0 = Date.parse("2026-11-06T00:00:00Z");

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
});
afterEach(() => {
  vi.useRealTimers();
});

async function fixture() {
  const t = convexTest(schema, modules);
  const owner = await t.run((ctx) =>
    ctx.db.insert("users", { email: "owner@example.test", role: "owner" }),
  );
  const human = t.withIdentity({ subject: `${owner}|session` });
  const token = async (name: string, scope: "read" | "admin" | "metrics") =>
    (await human.mutation(api.apiTokens.create, { name, scope })).token;
  const admin = await token("ci-admin", "admin");
  const read = await token("reader", "read");
  const metrics = await token("prom", "metrics");
  const call = async (method: string, path: string, bearer?: string, body?: unknown) => {
    const response = await t.fetch(`/api/v1${path}`, {
      method,
      headers: {
        ...(bearer === undefined ? {} : { Authorization: `Bearer ${bearer}` }),
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    return { status: response.status, body: text === "" ? null : JSON.parse(text) };
  };
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
  const node = async (name: string) =>
    await t.run((ctx) =>
      ctx.db.insert("nodes", { name, createdAt: Date.now(), source: "enrolled" }),
    );
  return { t, owner, human, admin, read, metrics, call, audit, node };
}

const unbindPath = (repo: string, branch: string) =>
  `/git/bindings?${new URLSearchParams({ repo, branch })}`;

describe("scopes", () => {
  it("lists with a read token, changes only with an admin token, and refuses a revoked one", async () => {
    const f = await fixture();
    const bind = { repo: "acme/shop", branch: "main", app: "shop" };
    const changes: Array<[string, string, unknown?]> = [
      ["POST", "/git/bindings", bind],
      ["DELETE", unbindPath("acme/shop", "main")],
    ];
    for (const [method, path, body] of changes) {
      expect((await f.call(method, path, undefined, body)).status).toBe(401);
      expect((await f.call(method, path, "erainfra_" + "0".repeat(64), body)).status).toBe(401);
      expect((await f.call(method, path, f.read, body)).status, `${method} ${path}`).toBe(403);
      expect((await f.call(method, path, f.metrics, body)).status).toBe(403);
    }
    expect((await f.call("GET", "/git/bindings")).status).toBe(401);
    expect((await f.call("GET", "/git/bindings", f.metrics)).status).toBe(403);
    expect(await f.call("GET", "/git/bindings", f.read)).toEqual({
      status: 200,
      body: { bindings: [] },
    });
    // A refused token changed nothing and is not an actor in the audit log.
    expect(await f.audit()).toEqual([]);
    expect(await f.t.run((ctx) => ctx.db.query("gitBindings").collect())).toEqual([]);

    // Revocation takes effect on the next request.
    const tokenId = await f.t.run(
      async (ctx) =>
        (await ctx.db
          .query("apiTokens")
          .filter((q) => q.eq(q.field("name"), "ci-admin"))
          .unique())!._id,
    );
    await f.human.mutation(api.apiTokens.revoke, { tokenId });
    expect((await f.call("POST", "/git/bindings", f.admin, bind)).status).toBe(401);
    expect((await f.call("GET", "/git/bindings", f.admin)).status).toBe(401);
    expect(await f.t.run((ctx) => ctx.db.query("gitBindings").collect())).toEqual([]);
  });
});

describe("bind, list and unbind", () => {
  it("round-trips a binding named by Node, with a branch that contains a slash", async () => {
    const f = await fixture();
    await f.node("builder");
    await f.node("web-1");

    const bound = await f.call("POST", "/git/bindings", f.admin, {
      repo: "Acme/Shop",
      branch: "release/1.2",
      app: "shop",
      buildNode: "builder",
      deployNode: "web-1",
      port: 3000,
    });
    expect(bound.status).toBe(201);
    const expected = {
      id: expect.any(String),
      repo: "Acme/Shop",
      branch: "release/1.2",
      app: "shop",
      buildNode: "builder",
      deployNode: "web-1",
      port: 3000,
      createdAt: "2026-11-06T00:00:00.000Z",
      lastStatus: null,
    };
    expect(bound.body).toEqual({ binding: expected });

    await f.call("POST", "/git/bindings", f.admin, {
      repo: "acme/api",
      branch: "main",
      app: "api",
    });
    const listed = await f.call("GET", "/git/bindings", f.read);
    expect(listed.status).toBe(200);
    // Ordered by repository, ignoring case, then branch.
    expect(listed.body.bindings).toEqual([
      {
        ...expected,
        repo: "acme/api",
        branch: "main",
        app: "api",
        buildNode: null,
        deployNode: null,
        port: null,
      },
      expected,
    ]);

    // GitHub repository names ignore case, so the binding is found by any casing.
    const removed = await f.call("DELETE", unbindPath("acme/shop", "release/1.2"), f.admin);
    expect(removed).toEqual({
      status: 200,
      body: { binding: { repo: "Acme/Shop", branch: "release/1.2", app: "shop" } },
    });
    expect(
      (await f.call("GET", "/git/bindings", f.read)).body.bindings.map(
        (b: { repo: string }) => b.repo,
      ),
    ).toEqual(["acme/api"]);
    expect((await f.call("DELETE", unbindPath("acme/shop", "release/1.2"), f.admin)).status).toBe(
      404,
    );

    const rows = (await f.audit()).filter((r) => r.action.startsWith("git."));
    expect(rows).toEqual([
      {
        actor: "token:ci-admin",
        action: "git.bind",
        target: "Acme/Shop@release/1.2",
        outcome: "success",
        meta: { app: "shop", buildNode: "builder", deployNode: "web-1", port: 3000 },
      },
      {
        actor: "token:ci-admin",
        action: "git.bind",
        target: "acme/api@main",
        outcome: "success",
        meta: { app: "api", buildNode: null, deployNode: null, port: null },
      },
      {
        actor: "token:ci-admin",
        action: "git.unbind",
        target: "Acme/Shop@release/1.2",
        outcome: "success",
        meta: { app: "shop" },
      },
      {
        actor: "token:ci-admin",
        action: "git.unbind",
        target: "acme/shop@release/1.2",
        outcome: "deny",
        meta: { error: "No binding for acme/shop@release/1.2" },
      },
    ]);
  });

  it("queues a deploy for a push to the branch it bound", async () => {
    const f = await fixture();
    await f.call("POST", "/git/bindings", f.admin, {
      repo: "acme/shop",
      branch: "main",
      app: "shop",
    });
    const push = { deliveryId: "d-1", repo: "acme/shop", branch: "main", sha: "a".repeat(40) };
    expect((await f.t.mutation(internal.infra.git.acceptPush, push)).outcome).toBe("queued");
    await f.call("DELETE", unbindPath("acme/shop", "main"), f.admin);
    expect(
      (await f.t.mutation(internal.infra.git.acceptPush, { ...push, deliveryId: "d-2" })).outcome,
    ).toBe("no-binding");
  });
});

describe("refusals", () => {
  it("refuses a duplicate binding with 409, and audits it with the token's name", async () => {
    const f = await fixture();
    const bind = { repo: "acme/shop", branch: "main", app: "shop" };
    expect((await f.call("POST", "/git/bindings", f.admin, bind)).status).toBe(201);
    const again = await f.call("POST", "/git/bindings", f.admin, {
      ...bind,
      repo: "ACME/shop",
      app: "shop2",
    });
    expect(again.status).toBe(409);
    expect(again.body.error).toEqual({
      code: "conflict",
      message: "Already bound: ACME/shop@main",
    });
    // Another branch of the same repository is another binding.
    expect(
      (await f.call("POST", "/git/bindings", f.admin, { ...bind, branch: "dev", app: "shop-dev" }))
        .status,
    ).toBe(201);
    expect(await f.t.run((ctx) => ctx.db.query("gitBindings").collect())).toHaveLength(2);
    expect((await f.audit()).map((r) => [r.actor, r.action, r.target, r.outcome])).toEqual([
      ["token:ci-admin", "git.bind", "acme/shop@main", "success"],
      ["token:ci-admin", "git.bind", "ACME/shop@main", "deny"],
      ["token:ci-admin", "git.bind", "acme/shop@dev", "success"],
    ]);
  });

  it(`stops at ${MAX_GIT_BINDINGS} bindings`, async () => {
    const f = await fixture();
    await f.t.run(async (ctx) => {
      for (let i = 0; i < MAX_GIT_BINDINGS - 1; i += 1) {
        await ctx.db.insert("gitBindings", {
          repo: `o/r${i}`,
          repoKey: `o/r${i}`,
          branch: "main",
          app: `r${i}`,
          createdAt: T0,
        });
      }
    });
    const bind = (repo: string) =>
      f.call("POST", "/git/bindings", f.admin, { repo, branch: "main", app: "x" });
    expect((await bind("o/last")).status).toBe(201);
    const over = await bind("o/one-more");
    expect(over.status).toBe(409);
    expect(over.body.error.message).toBe(`Binding limit reached (${MAX_GIT_BINDINGS})`);
    expect((await f.call("GET", "/git/bindings", f.read)).body.bindings).toHaveLength(
      MAX_GIT_BINDINGS,
    );
    expect((await f.audit()).at(-1)).toMatchObject({
      actor: "token:ci-admin",
      action: "git.bind",
      target: "o/one-more@main",
      outcome: "deny",
      meta: { error: `Binding limit reached (${MAX_GIT_BINDINGS})` },
    });
  });

  it("refuses an unknown Node with 404 and a binding that could never match a push with 400", async () => {
    const f = await fixture();
    const bind = { repo: "acme/shop", branch: "main", app: "shop" };
    const ghost = await f.call("POST", "/git/bindings", f.admin, { ...bind, buildNode: "ghost" });
    expect(ghost.status).toBe(404);
    expect(ghost.body.error.message).toBe('No Node named "ghost"');
    for (const [change, message] of [
      [{ branch: "refs/heads/main" }, "Name the branch without refs/heads/"],
      [{ branch: "feature branch" }, '"feature branch" is not a branch name git accepts'],
      [{ branch: "a..b" }, '"a..b" is not a branch name git accepts'],
      [{ branch: "" }, "Name a branch"],
      [{ repo: "shop" }, "Name the repository as owner/name"],
      [{ app: "Shop_1" }, "An App name is lowercase letters, digits and dashes, at most 63"],
      [{ port: 70000 }, "port must be an integer from 1 to 65535"],
      [{ port: 80.5 }, "port must be an integer from 1 to 65535"],
    ] as const) {
      const refused = await f.call("POST", "/git/bindings", f.admin, { ...bind, ...change });
      expect(refused.status, JSON.stringify(change)).toBe(400);
      expect(refused.body.error.message).toBe(message);
    }
    // Every one of those reached the mutation and was audited as a refusal.
    const denied = (await f.audit()).filter((r) => r.outcome === "deny");
    expect(denied).toHaveLength(9);
    expect(new Set(denied.map((r) => r.actor))).toEqual(new Set(["token:ci-admin"]));
    expect(await f.t.run((ctx) => ctx.db.query("gitBindings").collect())).toEqual([]);
  });

  it("answers 400 to a malformed request before it reaches the mutation", async () => {
    const f = await fixture();
    for (const body of [
      { repo: "acme/shop", branch: "main" },
      { repo: "acme/shop", branch: "main", app: "shop", extra: 1 },
      { repo: "acme/shop", branch: "main", app: "shop", port: "80" },
      ["acme/shop"],
    ]) {
      expect((await f.call("POST", "/git/bindings", f.admin, body)).status).toBe(400);
    }
    for (const query of ["", "?repo=acme/shop", "?branch=main", "?repo=a/b&branch=main&x=1"]) {
      expect((await f.call("DELETE", `/git/bindings${query}`, f.admin)).status, query).toBe(400);
    }
    expect((await f.call("GET", "/git/bindings?all=1", f.read)).status).toBe(400);
    expect(await f.audit()).toEqual([]);
  });
});

describe("dashboard functions", () => {
  it("bind, list and unbind through the same bodies as the API", async () => {
    const f = await fixture();
    const builder = await f.node("builder");
    const viewerId = await f.t.run((ctx) =>
      ctx.db.insert("users", { email: "viewer@example.test", role: "viewer" }),
    );
    const viewer = f.t.withIdentity({ subject: `${viewerId}|s` });
    await expect(
      viewer.mutation(api.infra.git.bind, { repo: "acme/shop", branch: "main", app: "shop" }),
    ).rejects.toThrow(/viewer role does not allow app.deploy/);
    await expect(
      f.human.mutation(api.infra.git.bind, {
        repo: "acme/shop",
        branch: "refs/heads/main",
        app: "shop",
      }),
    ).rejects.toThrow(/without refs\/heads/);
    const id = await f.human.mutation(api.infra.git.bind, {
      repo: "acme/shop",
      branch: "main",
      app: "shop",
      buildNodeId: builder,
    });
    expect(await viewer.query(api.infra.git.list, {})).toEqual([
      {
        _id: id,
        repo: "acme/shop",
        branch: "main",
        app: "shop",
        buildNodeId: builder,
        buildNode: "builder",
        deployNode: null,
        createdAt: T0,
        lastStatus: null,
      },
    ]);
    // The API sees what the dashboard bound, and refuses to bind it again.
    expect((await f.call("GET", "/git/bindings", f.read)).body.bindings[0].buildNode).toBe(
      "builder",
    );
    expect(
      (
        await f.call("POST", "/git/bindings", f.admin, {
          repo: "acme/shop",
          branch: "main",
          app: "shop",
        })
      ).status,
    ).toBe(409);
    expect(await f.human.mutation(api.infra.git.unbind, { bindingId: id })).toBe(true);
    expect(await f.human.mutation(api.infra.git.unbind, { bindingId: id })).toBe(false);
    const rows = (await f.audit()).filter((r) => r.outcome === "success");
    expect(rows.map((r) => [r.actor, r.action])).toEqual([
      [f.owner, "git.bind"],
      [f.owner, "git.unbind"],
    ]);
  });
});

describe("branchProblem", () => {
  it("accepts what git accepts and refuses what it does not", () => {
    for (const ok of ["main", "release/1.2", "feat/a-b_c", "v1.0", "dependabot/npm/x-1.2.3"])
      expect(branchProblem(ok), ok).toBeNull();
    for (const bad of [
      "",
      "refs/heads/main",
      "a b",
      "a\tb",
      "a~1",
      "a^",
      "a:b",
      "a?",
      "a*",
      "a[b",
      "a\\b",
      "a..b",
      "a@{1}",
      "a//b",
      "/a",
      "-a",
      "a/",
      "a.",
      "a.lock",
      "@",
      "x".repeat(256),
    ])
      expect(branchProblem(bad), JSON.stringify(bad)).not.toBeNull();
  });
});
