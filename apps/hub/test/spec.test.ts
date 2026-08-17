import test from "node:test";
import assert from "node:assert/strict";
import { parseSpec, implicitSpec, envName } from "../src/runtime/spec.ts";
import { planDeploy } from "../src/runtime/appdeploy.ts";
import { PortAllocator } from "../src/runtime/ports.ts";
import { createDb } from "../src/db.ts";

test("parseSpec: a full valid spec normalizes routes, env, needs", () => {
  const r = parseSpec(
    `
app: shop
services:
  web:
    build: .
    port: 3000
    route: true
    needs: [db]
  api:
    build: services/api
    port: 8000
    route: shop-api
    needs: [db]
  db:
    image: reg/postgres:16
    port: 5432
    volumes: [pgdata:/var/lib/postgresql/data]
`,
    "fallback",
  );
  assert.ok(r.ok, r.ok ? "" : r.error);
  if (!r.ok) return;
  assert.equal(r.spec.app, "shop");
  const web = r.spec.services.find((s) => s.name === "web")!;
  assert.equal(web.route, "shop-web"); // route:true with TWO routed services → app-service
  assert.deepEqual(web.needs, ["db"]);
  assert.equal(r.spec.services.find((s) => s.name === "api")!.route, "shop-api");
});

test("parseSpec: route:true on the only routed service = the app name", () => {
  const r = parseSpec(`services:\n  web:\n    build: .\n    port: 3000\n    route: true`, "solo");
  assert.ok(r.ok);
  if (r.ok) assert.equal(r.spec.services[0].route, "solo");
});

test("parseSpec rejects the sharp edges with actionable errors", () => {
  const cases: Array<[string, RegExp]> = [
    ["services: {}", /at least one service/],
    ["services:\n  a:\n    build: .\n    image: x", /exactly one of build \/ image/],
    ["services:\n  a: {}", /exactly one of build \/ image/],
    ["services:\n  a:\n    build: ../../etc", /relative dir inside the repo/],
    ["services:\n  a:\n    build: .\n    route: true", /route requires port/],
    ["services:\n  a:\n    build: .\n    needs: [ghost]", /unknown service "ghost"/],
    ["services:\n  a:\n    build: .\n    needs: [a]", /cannot need itself/],
    ["services:\n  a:\n    build: .\n    needs: [b]\n  b:\n    image: x", /needs a port/],
    ["services:\n  a:\n    build: .\n    volumes: [/host/path:/x]", /named volumes only/],
    ["services:\n  a:\n    build: .\n    unknown: 1", /unknown/i],
  ];
  for (const [yaml, want] of cases) {
    const r = parseSpec(yaml, "app");
    assert.equal(r.ok, false, yaml);
    if (!r.ok) assert.match(r.error, want, `${yaml} → ${r.error}`);
  }
});

test("implicitSpec: single routed web service on the given port", () => {
  const s = implicitSpec("legacy", 8080);
  assert.equal(s.services[0].route, "legacy");
  assert.equal(s.services[0].port, 8080);
  assert.equal(envName("my-db"), "MY_DB");
});

test("planDeploy: cross-node needs get a mesh link, host.docker.internal env, and --add-host", () => {
  const alloc = new PortAllocator(createDb(":memory:"));
  const parsed = parseSpec(
    `
app: flight
services:
  web:
    build: .
    port: 3000
    route: true
    needs: [db]
  db:
    image: reg/pg:16
    port: 5432
    node: db-box
`,
    "flight",
  );
  assert.ok(parsed.ok);
  if (!parsed.ok) return;
  const { placed, links } = planDeploy(
    parsed.spec,
    { defaultNode: "web-box", registry: "reg", sha: "abc", app: "flight" },
    alloc,
  );
  const web = placed.find((p) => p.spec.name === "web")!;
  const db = placed.find((p) => p.spec.name === "db")!;
  // the dependency is published on ITS node's loopback even without a route (the mesh bridges to it)
  assert.ok(db.hostPort, "db needs a host port for the mesh share");
  assert.equal(links.length, 1);
  assert.equal(links[0].provider, "db-box");
  assert.equal(links[0].consumer, "web-box");
  assert.equal(links[0].providerPort, db.hostPort);
  // the consumer reaches it via host.docker.internal:<localPort>
  assert.equal(web.env.DB_HOST, "host.docker.internal");
  assert.equal(web.env.DB_PORT, String(links[0].localPort));
  assert.ok(web.args.includes("--add-host=host.docker.internal:host-gateway"));
  // same app replans to the SAME ports (containers bake them into env)
  const again = planDeploy(
    parsed.spec,
    { defaultNode: "web-box", registry: "reg", sha: "abc", app: "flight" },
    alloc,
  );
  assert.equal(again.links[0].localPort, links[0].localPort);
});

test("planDeploy: same-node needs use docker DNS, no links, no host port for the dependency", () => {
  const alloc = new PortAllocator(createDb(":memory:"));
  const parsed = parseSpec(
    `services:\n  web:\n    build: .\n    port: 3000\n    route: true\n    needs: [db]\n  db:\n    image: reg/pg\n    port: 5432`,
    "one",
  );
  assert.ok(parsed.ok);
  if (!parsed.ok) return;
  const { placed, links } = planDeploy(
    parsed.spec,
    { defaultNode: "n1", registry: "reg", sha: "x", app: "one" },
    alloc,
  );
  assert.equal(links.length, 0);
  const web = placed.find((p) => p.spec.name === "web")!;
  const db = placed.find((p) => p.spec.name === "db")!;
  assert.equal(web.env.DB_HOST, "db");
  assert.equal(web.env.DB_PORT, "5432");
  assert.equal(db.hostPort, undefined); // internal-only: never published on the node
});
