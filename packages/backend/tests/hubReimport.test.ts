// Re-running the Hub importer after Convex has started writing (docs/runbooks/retire-the-hub.md
// re-imports after each Node switch and once more at the end). Each kind of Convex write is made
// through the path an operator uses (the operator API, the deploy pipeline, failover), then the
// Hub's unchanged state is imported again. The import must never undo the Convex write, must say
// it skipped the row because Convex owns it, and must still copy what changed on the Hub.
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import type { ImportBatch, ImportItem } from "../convex/infra/hubImport";
import { decryptValue, requireMasterKey, unwrapDataKey } from "../convex/infra/secretCrypto";
import schema from "../convex/schema";
import { formatImportReport } from "../scripts/import-hub-state.ts";

const modules = import.meta.glob("../convex/**/*.ts");
const T0 = Date.parse("2026-11-06T00:00:00Z");

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
  process.env.ERAINFRA_SECRETS_MASTER_KEY = "44".repeat(32);
  process.env.ERAINFRA_APP_DOMAIN = "apps.example.com";
  process.env.ERAINFRA_REGISTRY = "127.0.0.1:5000";
});
afterEach(() => {
  vi.useRealTimers();
  delete process.env.ERAINFRA_SECRETS_MASTER_KEY;
  delete process.env.ERAINFRA_APP_DOMAIN;
  delete process.env.ERAINFRA_REGISTRY;
});

/** A Hub with one multi-service App, one single-container App, links, env and a binding. */
function hubState(changes: { image?: string; dbUrl?: string } = {}): ImportBatch[] {
  const image = changes.image ?? "hub/web:old";
  return [
    {
      kind: "users",
      rows: [
        {
          legacyId: "u-owner",
          email: "owner@acme.dev",
          name: "Ow",
          roles: ["owner"],
          passwordHash: "scrypt$hub-owner",
          createdAt: 1,
        },
        {
          legacyId: "u-viewer",
          email: "viewer@acme.dev",
          name: "Vi",
          roles: ["viewer"],
          passwordHash: "scrypt$hub-viewer",
          createdAt: 2,
        },
      ],
    },
    {
      kind: "routes",
      rows: [
        { name: "web", node: "node-b", image, port: 62001, app: "web", service: "web" },
        { name: "solo", node: "node-b", image: "hub/solo:1", port: 62000, app: "solo" },
      ],
    },
    {
      kind: "apps",
      rows: [
        {
          name: "web",
          node: "node-b",
          services: [{ name: "web", image, args: [], port: 62001, route: "web" }],
          links: [],
        },
      ],
    },
    {
      kind: "links",
      rows: [
        {
          name: "metrics",
          provider: "node-a",
          providerPort: 9100,
          consumer: "node-b",
          localPort: 62010,
          createdBy: "user",
        },
        {
          name: "cache",
          provider: "node-a",
          providerPort: 6379,
          consumer: "node-b",
          localPort: 62011,
          createdBy: "user",
        },
      ],
    },
    {
      kind: "ports",
      rows: [
        { node: "node-b", key: "web/web", port: 62001 },
        { node: "node-b", key: "solo/web", port: 62000 },
      ],
    },
    {
      kind: "secrets",
      rows: [
        {
          app: "web",
          values: {
            API_KEY: "hub-key",
            LOG_LEVEL: "info",
            DB_URL: changes.dbUrl ?? "postgres://hub",
          },
        },
      ],
    },
    {
      kind: "gitBindings",
      rows: [{ legacyId: "hub-b1", repo: "acme/web", branch: "main", app: "web" }],
    },
    {
      kind: "audit",
      rows: [{ hubSeq: 1, at: 1, actor: "u-owner", action: "git.bind", outcome: "success" }],
    },
  ];
}

async function setup() {
  const t = convexTest(schema, modules);
  const operatorId = await t.run((ctx) =>
    ctx.db.insert("users", { email: "ops@example.test", role: "owner" }),
  );
  const human = t.withIdentity({ subject: `${operatorId}|session` });
  const nodes: Record<string, { nodeId: Id<"nodes">; credential: string }> = {};
  for (const name of ["node-a", "node-b"])
    nodes[name] = await human.mutation(api.infra.nodes.enroll, { name });
  const admin = (await human.mutation(api.apiTokens.create, { name: "ops", scope: "admin" })).token;
  const beat = async () => {
    for (const { credential } of Object.values(nodes))
      await t.mutation(internal.infra.nodeState.heartbeat, { credential, version: "test" });
  };
  const call = async (method: string, path: string, body?: unknown) => {
    const r = await t.fetch(`/api/v1${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${admin}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await r.text();
    return { status: r.status, body: text === "" ? null : JSON.parse(text) };
  };
  const importHub = async (batches = hubState()) =>
    await t.action(internal.infra.hubImport.run, { batches });
  const previewHub = async (batches = hubState()) =>
    await t.action(internal.infra.hubImport.preview, { batches });
  const settle = () => t.finishAllScheduledFunctions(() => {});
  const state = () =>
    t.run(async (ctx) => {
      const nodeName = async (id: Id<"nodes">) => (await ctx.db.get(id))!.name;
      const app = await ctx.db
        .query("apps")
        .withIndex("by_name", (q) => q.eq("name", "web"))
        .unique();
      const route = await ctx.db
        .query("appRoutes")
        .withIndex("by_name", (q) => q.eq("name", "web"))
        .unique();
      const env: Record<string, string | null> = { API_KEY: null, LOG_LEVEL: null, DB_URL: null };
      const keyRow = await ctx.db
        .query("appDataKeys")
        .withIndex("by_app_service", (q) => q.eq("app", "web").eq("service", undefined))
        .unique();
      if (keyRow !== null) {
        const scope = { app: "web" };
        const dataKey = await unwrapDataKey(await requireMasterKey(process.env), scope, keyRow);
        const rows = await ctx.db
          .query("appSecrets")
          .withIndex("by_app_service_name", (q) => q.eq("app", "web").eq("service", undefined))
          .collect();
        for (const row of rows) env[row.name] = await decryptValue(dataKey, scope, row.name, row);
      }
      const links = await ctx.db.query("meshLinks").collect();
      const ports = await ctx.db.query("portAllocations").collect();
      return {
        app:
          app === null
            ? null
            : {
                node: await nodeName(app.nodeId),
                hasSpec: app.spec !== undefined,
                services: app.services.map((s) => ({ image: s.image, port: s.port })),
              },
        route:
          route === null
            ? null
            : { node: await nodeName(route.nodeId), port: route.port, image: route.image },
        solo: await ctx.db
          .query("appRoutes")
          .withIndex("by_name", (q) => q.eq("name", "solo"))
          .unique(),
        env,
        links: Object.fromEntries(links.map((l) => [l.name, l.providerPort])),
        ports: (
          await Promise.all(
            ports.map(async (p) => `${await nodeName(p.nodeId)} ${p.key} ${p.port}`),
          )
        ).toSorted(),
        users: (await ctx.db.query("users").collect()).map((u) => u.email).toSorted(),
        bindings: (await ctx.db.query("gitBindings").collect()).map(
          (b) => `${b.repo}@${b.branch}:${b.app}`,
        ),
      };
    });
  /** Simulated Infra Agents on both Nodes, over the real Node API, until no command is left. */
  const runAgents = async (outcome: "success" | "failure") => {
    const spec = "services:\n  web:\n    build: .\n    port: 3000\n    route: true\n";
    for (let round = 0; round < 4; round++) {
      for (const [name, { credential }] of Object.entries(nodes)) {
        const nodeCall = (path: string, body: unknown) =>
          t.fetch(`/api/v1/nodes/${path}`, {
            method: "POST",
            headers: { Authorization: `Bearer ${credential}`, "Content-Type": "application/json" },
            body: JSON.stringify(body),
          });
        const pending = await t.query(internal.infra.nodeState.pending, {
          credential,
          cursor: null,
        });
        for (const cmd of pending.commands) {
          const claim = await nodeCall("commands/claim", { commandId: cmd.id, owner: name });
          const { epoch } = (await claim.json()) as { epoch: number };
          const reported = await nodeCall("commands/result", {
            commandId: cmd.id,
            owner: name,
            epoch,
            outcome,
            ...(cmd.kind === "spec" && outcome === "success" ? { spec } : {}),
          });
          expect(reported.status).toBe(200);
        }
        await settle();
      }
    }
  };
  return { t, human, nodes, admin, beat, call, importHub, previewHub, settle, runAgents, state };
}

const skipped = (items: ImportItem[]) =>
  items.filter((i) => i.outcome === "skipped").map((i) => `${i.kind} ${i.key}: ${i.reason}`);

describe("re-importing the Hub after Convex writes", () => {
  it("keeps the spec, Node, image, route and ports of an App a Convex deploy moved", async () => {
    const s = await setup();
    await s.importHub();
    await s.beat();
    // A real Convex deploy of the Hub's App `web`, onto node-a.
    const storageId = await s.t.run((ctx) => ctx.storage.store(new Blob(["source"])));
    const started = await s.call("POST", "/deployments", {
      app: "web",
      upload: storageId,
      buildNode: "node-a",
      node: "node-a",
    });
    expect(started.status).toBe(202);
    await s.settle();
    await s.runAgents("success");
    const deployed = await s.state();
    expect(deployed.app).toMatchObject({ node: "node-a", hasSpec: true });
    expect(deployed.route?.node).toBe("node-a");
    const convexPort = deployed.route!.port;

    const report = await s.importHub();
    const after = await s.state();
    expect(after.app).toEqual(deployed.app);
    expect(after.route).toEqual(deployed.route);
    // The gateway serves a route only while the App row, the route row and the port allocation
    // agree (nodeState.ts servesPlacement). They still do, on node-a at Convex's port.
    expect(after.app?.services[0].port).toBe(convexPort);
    expect(after.ports).toContain(`node-a web/web ${convexPort}`);
    expect(skipped(report.items)).toEqual(
      expect.arrayContaining([
        "routes web: owned by Convex: App web was deployed through Convex",
        "apps web: owned by Convex: App web was deployed through Convex",
        "ports node-b web/web: owned by Convex: App web was deployed through Convex",
      ]),
    );
    expect(report.items.filter((i) => i.outcome === "refused")).toEqual([]);
  });

  it("keeps an App a Convex deploy wrote before rows recorded who wrote them", async () => {
    const s = await setup();
    await s.importHub();
    // What a deploy's commit wrote before provenance existed: a stored spec and a new placement,
    // with nothing saying Convex wrote them, and an older import's rows likewise unmarked.
    await s.t.run(async (ctx) => {
      const app = (await ctx.db
        .query("apps")
        .withIndex("by_name", (q) => q.eq("name", "web"))
        .unique())!;
      await ctx.db.patch(app._id, {
        nodeId: s.nodes["node-a"].nodeId,
        services: [{ name: "web", image: "registry/web:new", args: [], port: 62000, route: "web" }],
        spec: {
          app: "web",
          services: [
            { name: "web", build: ".", port: 3000, route: "web", env: {}, volumes: [], needs: [] },
          ],
        },
        provenance: undefined,
      });
      const route = (await ctx.db
        .query("appRoutes")
        .withIndex("by_name", (q) => q.eq("name", "web"))
        .unique())!;
      await ctx.db.patch(route._id, {
        nodeId: s.nodes["node-a"].nodeId,
        image: "registry/web:new",
        port: 62000,
        provenance: undefined,
      });
    });
    await s.importHub();
    const after = await s.state();
    expect(after.app).toEqual({
      node: "node-a",
      hasSpec: true,
      services: [{ image: "registry/web:new", port: 62000 }],
    });
    expect(after.route).toEqual({ node: "node-a", port: 62000, image: "registry/web:new" });
  });

  it("keeps an App a failover moved, with its route", async () => {
    const s = await setup();
    await s.importHub();
    const toPort = await s.t.mutation(internal.infra.ports.allocate, {
      nodeId: s.nodes["node-a"].nodeId,
      key: "web/web",
    });
    const lease = await s.t.mutation(internal.infra.deployments.beginFailover, {
      app: "web",
      lostNodeId: s.nodes["node-b"].nodeId,
    });
    if (!lease.granted) throw new Error("no lease");
    await s.t.mutation(internal.infra.deployments.completeFailover, {
      app: "web",
      epoch: lease.epoch,
      fromNodeId: s.nodes["node-b"].nodeId,
      toNodeId: s.nodes["node-a"].nodeId,
    });
    const report = await s.importHub();
    const after = await s.state();
    expect(after.app).toMatchObject({ node: "node-a", services: [{ port: toPort }] });
    expect(after.route).toMatchObject({ node: "node-a", port: toPort });
    expect(skipped(report.items)).toContain(
      "apps web: owned by Convex: App web was changed in Convex",
    );
  });

  it("does not bring back an App removed in Convex, nor its route and ports", async () => {
    const s = await setup();
    await s.importHub();
    await s.beat();
    expect((await s.call("DELETE", "/apps/solo")).status).toBe(202);
    const report = await s.importHub();
    const after = await s.state();
    expect(after.solo).toBeNull();
    expect(after.ports.filter((p) => p.includes("solo/"))).toEqual([]);
    expect(skipped(report.items)).toEqual(
      expect.arrayContaining([
        "routes solo: owned by Convex: App solo was removed in Convex",
        "ports node-b solo/web: owned by Convex: App solo was removed in Convex",
      ]),
    );
  });

  it("keeps env set in Convex, does not restore env unset there, and copies the Hub's other changes", async () => {
    const s = await setup();
    await s.importHub();
    expect((await s.call("PUT", "/apps/web/env", { vars: { API_KEY: "convex-key" } })).status).toBe(
      200,
    );
    expect((await s.call("DELETE", "/apps/web/env/LOG_LEVEL")).status).toBe(200);
    // Meanwhile the Hub changed a variable Convex never touched.
    const report = await s.importHub(hubState({ dbUrl: "postgres://hub-v2" }));
    expect((await s.state()).env).toEqual({
      API_KEY: "convex-key",
      LOG_LEVEL: null,
      DB_URL: "postgres://hub-v2",
    });
    expect(skipped(report.items)).toEqual([
      "secrets web:API_KEY: owned by Convex: the variable was set in Convex",
      "secrets web:LOG_LEVEL: owned by Convex: the variable was unset in Convex",
    ]);
    expect(report.items).toContainEqual({ kind: "secrets", key: "web:DB_URL", outcome: "updated" });
  });

  it("keeps a link replaced in Convex and does not restore a link removed there", async () => {
    const s = await setup();
    await s.importHub();
    const replaced = await s.call("POST", "/links", {
      name: "metrics",
      provider: "node-a",
      providerPort: 9200,
      consumer: "node-b",
      localPort: 62010,
    });
    expect(replaced.status).toBe(201);
    expect((await s.call("DELETE", "/links/cache")).status).toBe(200);
    const report = await s.importHub();
    expect((await s.state()).links).toEqual({ metrics: 9200 });
    expect(skipped(report.items)).toEqual([
      "links metrics: owned by Convex: the link was written in Convex",
      "links cache: owned by Convex: the link was removed in Convex",
    ]);
  });

  it("keeps an unbind done in Convex, and a re-bind to another App, without failing the import", async () => {
    const s = await setup();
    await s.importHub();
    expect((await s.call("DELETE", "/git/bindings?repo=acme%2Fweb&branch=main")).status).toBe(200);
    let report = await s.importHub();
    expect((await s.state()).bindings).toEqual([]);
    expect(skipped(report.items)).toEqual([
      "gitBindings acme/web@main: owned by Convex: the branch was unbound in Convex",
    ]);
    expect(
      (await s.call("POST", "/git/bindings", { repo: "acme/web", branch: "main", app: "web2" }))
        .status,
    ).toBe(201);
    report = await s.importHub();
    expect((await s.state()).bindings).toEqual(["acme/web@main:web2"]);
    expect(report.items.filter((i) => i.outcome === "refused")).toEqual([]);
  });

  it("keeps the result a Convex run recorded on an imported binding", async () => {
    const s = await setup();
    await s.importHub();
    await s.beat();
    const bindingId = await s.t.run(
      async (ctx) =>
        (await ctx.db
          .query("gitBindings")
          .withIndex("by_legacyId", (q) => q.eq("legacyId", "hub-b1"))
          .unique())!._id,
    );
    // What a push through the Convex webhook queues for the bound branch (githubDeploy.ts).
    const storageId = await s.t.run((ctx) => ctx.storage.store(new Blob(["source"])));
    await s.t.run(async (ctx) => {
      const { createRun } = await import("../convex/infra/pipeline");
      await createRun(ctx, {
        app: "web",
        operation: "deploy",
        trigger: { kind: "git", sha: "c0ffee" },
        source: { kind: "upload", storageId },
        buildNodeId: s.nodes["node-a"].nodeId,
        defaultNodeId: s.nodes["node-a"].nodeId,
        gitBindingId: bindingId,
      });
    });
    await s.settle();
    await s.runAgents("failure");
    const lastStatus = () =>
      s.t.run(async (ctx) => (await ctx.db.get(bindingId))?.lastStatus ?? null);
    expect(await lastStatus()).toMatchObject({ sha: "c0ffee", ok: false });
    // The Hub still has its own, older result for the branch.
    const hub = hubState().map((b) =>
      b.kind === "gitBindings"
        ? {
            ...b,
            rows: b.rows.map((r) => ({
              ...r,
              lastStatus: { at: 1, sha: "hub", ok: true, stage: "done" },
            })),
          }
        : b,
    );
    const report = await s.importHub(hub);
    expect(await lastStatus()).toMatchObject({ sha: "c0ffee", ok: false });
    expect(skipped(report.items)).toEqual([
      "gitBindings acme/web@main: owned by Convex: a Convex run recorded its result on the binding",
    ]);
  });

  it("treats a later write that did not claim a binding as Convex's", async () => {
    const s = await setup();
    await s.importHub();
    vi.setSystemTime(T0 + 1_000);
    // A writer that sets the time but forgets provenance; tests/provenanceWrites.test.ts keeps
    // such a writer out of convex/, and this is the backstop if one slips through.
    await s.t.run(async (ctx) => {
      const row = (await ctx.db
        .query("gitBindings")
        .withIndex("by_legacyId", (q) => q.eq("legacyId", "hub-b1"))
        .unique())!;
      await ctx.db.patch(row._id, { app: "web-renamed", updatedAt: Date.now() });
    });
    const report = await s.importHub();
    expect((await s.state()).bindings).toEqual(["acme/web@main:web-renamed"]);
    expect(skipped(report.items)).toEqual([
      "gitBindings acme/web@main: owned by Convex: the binding was changed in Convex",
    ]);
  });

  it("keeps a branch bound in Convex before the Hub's binding was ever imported", async () => {
    const s = await setup();
    await s.call("POST", "/git/bindings", { repo: "acme/web", branch: "main", app: "web2" });
    const report = await s.importHub();
    expect((await s.state()).bindings).toEqual(["acme/web@main:web2"]);
    expect(skipped(report.items)).toEqual([
      "gitBindings acme/web@main: owned by Convex: the branch is bound in Convex to App web2",
    ]);
  });

  it("does not bring back a Hub account removed in Convex", async () => {
    const s = await setup();
    await s.importHub();
    const viewer = await s.t.run(async (ctx) =>
      (await ctx.db.query("users").collect()).find((u) => u.email === "viewer@acme.dev"),
    );
    await s.human.mutation(api.infra.access.removeUser, { userId: viewer!._id });
    const report = await s.importHub();
    expect((await s.state()).users).not.toContain("viewer@acme.dev");
    expect(skipped(report.items)).toEqual([
      "users viewer@acme.dev: owned by Convex: the account was removed in Convex",
    ]);
  });

  it("still copies what changed on the Hub for rows Convex never wrote, and only those", async () => {
    const s = await setup();
    await s.importHub();
    const linkWrites = () =>
      s.t.run(async (ctx) => (await ctx.db.query("meshLinks").collect()).map((l) => l.updatedAt));
    const linksBefore = await linkWrites();
    vi.setSystemTime(T0 + 60_000);
    const report = await s.importHub(hubState({ image: "hub/web:new" }));
    expect((await s.state()).app?.services[0].image).toBe("hub/web:new");
    expect((await s.state()).route?.image).toBe("hub/web:new");
    expect(report.items.map((i) => `${i.kind} ${i.key} ${i.outcome}`)).toEqual([
      "routes web updated",
      "apps web updated",
    ]);
    // An unchanged Hub row is not rewritten.
    expect(await linkWrites()).toEqual(linksBefore);
  });

  it("reports in a dry run exactly what the import would do, and writes nothing", async () => {
    const s = await setup();
    await s.importHub();
    await s.call("PUT", "/apps/web/env", { vars: { API_KEY: "convex-key" } });
    await s.call("DELETE", "/links/cache");
    const hub = hubState({ image: "hub/web:new" });
    const before = await s.state();
    const preview = await s.previewHub(hub);
    expect(await s.state()).toEqual(before);
    const real = await s.importHub(hub);
    expect(preview).toEqual(real);
    const printed = formatImportReport(preview, true);
    expect(printed.refused).toBe(0);
    expect(printed.lines).toContain(
      "  skipped  secrets web:API_KEY: owned by Convex: the variable was set in Convex",
    );
  });

  it("refuses a batch that fails as a whole row by row, and still applies the batches after it", async () => {
    const s = await setup();
    delete process.env.ERAINFRA_SECRETS_MASTER_KEY;
    const report = await s.importHub();
    expect(report.items.filter((i) => i.outcome === "refused").map((i) => i.key)).toEqual(["web"]);
    expect(report.counts.gitBindings).toEqual({ created: 1 });
    expect(report.counts.audit).toEqual({ created: 1 });
    expect(formatImportReport(report, false).refused).toBe(1);
  });
});

/** Every document in every table, so a test can say nothing at all changed. */
async function everything(t: ReturnType<typeof convexTest>, except: string[] = []) {
  return await t.run(async (ctx) => {
    const tables: Record<string, unknown[]> = {};
    for (const table of Object.keys(schema.tables).toSorted()) {
      if (except.includes(table)) continue;
      tables[table] = await ctx.db.query(table as keyof typeof schema.tables).collect();
    }
    return tables;
  });
}

// The rows of a batch share one mutation and a refused row does not stop the rows after it, so
// Convex never rolls back a refused row's writes. A refused row must have written nothing. A port or
// binding row naming a Node that does not exist yet is the case to watch: creating the Node is its
// first write, and the port or binding can still be refused after it.
describe("a refused row", () => {
  const cases: Array<{ name: string; batch: ImportBatch; reason: RegExp; except?: string[] }> = [
    {
      name: "a port on a Node the import would create",
      batch: { kind: "ports", rows: [{ node: "node-new", key: "web/web", port: 0 }] },
      reason: /Not a port/,
    },
    {
      name: "a binding whose build Node the import would create",
      batch: {
        kind: "gitBindings",
        rows: [
          {
            legacyId: "hub-bad",
            repo: "not a repository",
            branch: "main",
            app: "web",
            buildNode: "node-new",
            deployNode: "node-other",
          },
        ],
      },
      reason: /owner\/name/,
    },
    {
      name: "an account",
      batch: {
        kind: "users",
        rows: [
          {
            legacyId: "u-bad",
            email: "not an email",
            name: "Bad",
            roles: ["admin"],
            passwordHash: "scrypt$x",
            createdAt: 1,
          },
        ],
      },
      reason: /valid email/,
    },
    {
      name: "an audit row",
      batch: {
        kind: "audit",
        rows: [{ hubSeq: 7, at: 1, actor: "u-owner", action: " ", outcome: "success" }],
      },
      reason: /audit action/,
      // The batch records how far the trail was imported, refused rows or not.
      except: ["infraCounters"],
    },
  ];

  for (const { name, batch, reason, except } of cases) {
    it(`leaves nothing behind for ${name}`, async () => {
      const t = convexTest(schema, modules);
      const before = await everything(t, except);
      const report = await t.action(internal.infra.hubImport.run, { batches: [batch] });
      expect(report.items).toEqual([
        expect.objectContaining({
          kind: batch.kind,
          outcome: "refused",
          reason: expect.stringMatching(reason),
        }),
      ]);
      expect(await everything(t, except)).toEqual(before);
      // The refusal is decided before writing, so a dry run sees it too.
      const preview = await t.action(internal.infra.hubImport.preview, { batches: [batch] });
      expect(preview.items).toEqual(report.items);
    });
  }

  it("still writes the rows after a refused one in full", async () => {
    const t = convexTest(schema, modules);
    const report = await t.action(internal.infra.hubImport.run, {
      batches: [
        {
          kind: "ports",
          rows: [
            { node: "node-new", key: "web/web", port: 0 },
            { node: "node-next", key: "web/web", port: 4100 },
          ],
        },
      ],
    });
    expect(report.items.map((i) => [i.key, i.outcome])).toEqual([
      ["node-new web/web", "refused"],
      ["node-next web/web", "created"],
    ]);
    const nodes = await t.run(async (ctx) =>
      (await ctx.db.query("nodes").collect()).map((n) => n.name),
    );
    expect(nodes).toEqual(["node-next"]);
  });
});
