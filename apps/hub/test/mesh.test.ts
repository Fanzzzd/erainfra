import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { createDb } from "../src/db.ts";
import { establishLink, ensureAppLinks, ensureRegistryLinks } from "../src/runtime/appdeploy.ts";
import { appStore } from "../src/runtime/apps.ts";
import { LinkStore, LinkTransportStore, linkStore } from "../src/runtime/links.ts";
import {
  describeLink,
  meshDesired,
  parseMeshRelays,
  reconcileMesh,
  MESH_CAPABILITY,
  type MeshOptions,
} from "../src/runtime/meshControl.ts";

function peer(id: string, port = 1000) {
  return {
    id: createHash("sha256").update(id).digest("hex"),
    relay_urls: [],
    direct_addrs: [`127.0.0.1:${port}`],
  };
}

// A fake gateway. Nodes in `legacy` advertise no erainfra-mesh capability (an agent from before
// the sidecar); the rest do. meshApply answers with the status a sidecar would report after
// applying the desired view, so the Hub's migration check sees grants and bound listeners.
function fakeGw(
  present: string[],
  opts: {
    failShare?: boolean;
    failConnect?: boolean;
    legacy?: string[];
    down?: string[];
    unbound?: string[];
  } = {},
) {
  const sent: Array<{ to: string; cmd: any }> = [];
  const gw = {
    legacy: new Set(opts.legacy ?? []),
    list: () =>
      present.map((id) => ({
        id,
        version: null,
        roles: ["compute"],
        connectedAt: "",
        capabilities: gw.legacy.has(id) ? [] : [MESH_CAPABILITY],
      })),
    send: async (to: string, cmd: any) => {
      sent.push({ to, cmd });
      if (opts.down?.includes(to) && cmd.cmd === "meshApply")
        throw new Error("agent command timed out");
      if (cmd.cmd === "meshStatus")
        return { ok: true, output: JSON.stringify({ endpoint_id: peer(to).id, addr: peer(to) }) };
      if (cmd.cmd === "meshApply") {
        if (opts.failShare && cmd.stage === "authorize" && cmd.desired.exposures.length)
          return { ok: false, error: "share boom" };
        if (opts.failConnect && cmd.stage === "links" && cmd.desired.links.length)
          return { ok: false, error: "connect boom" };
        return {
          ok: true,
          output: JSON.stringify({
            endpoint_id: peer(to).id,
            addr: peer(to, 2000),
            exposures: cmd.desired.exposures,
            links:
              cmd.stage === "links"
                ? cmd.desired.links.map((l: any) => ({
                    ...l,
                    bound: opts.unbound?.includes(l.name) ? "" : l.listen,
                  }))
                : [],
          }),
        };
      }
      if (cmd.cmd === "meshShare")
        return { ok: true, output: `dumbpipe connect-tcp ${"b".repeat(64)}` };
      if (cmd.cmd === "meshConnect") return { ok: true, output: `127.0.0.1:${cmd.port}` };
      if (cmd.cmd === "meshDrop") return { ok: true, output: "no such link" };
      throw new Error(`unexpected command ${cmd.cmd}`);
    },
  };
  return { gw, sent };
}
const options = (extra: Partial<MeshOptions> = {}): MeshOptions => ({
  transports: new LinkTransportStore(createDb(":memory:")),
  ...extra,
});
const LINK = {
  name: "db-link",
  provider: "boxa",
  providerPort: 5432,
  consumer: "boxb",
  localPort: 15432,
};
const legacyCommands = (sent: Array<{ to: string; cmd: any }>) =>
  sent.filter((s) => s.cmd.cmd === "meshShare" || s.cmd.cmd === "meshConnect");

test("LinkStore round-trips and replaces by name", () => {
  const store = new LinkStore(createDb(":memory:"));
  store.set(LINK);
  assert.deepEqual(store.get("db-link"), LINK);
  store.set({ ...LINK, localPort: 25432 });
  assert.equal(store.get("db-link")!.localPort, 25432);
  assert.equal(store.list().length, 1);
  assert.equal(store.delete("db-link"), true);
  assert.equal(store.get("db-link"), undefined);
});

test("a link recorded on the mesh is never recorded back onto dumbpipe", () => {
  const store = new LinkTransportStore(createDb(":memory:"));
  store.set("db", "legacy-dumbpipe");
  assert.equal(store.get("db"), "legacy-dumbpipe");
  store.set("db", "mesh");
  store.set("db", "legacy-dumbpipe");
  assert.equal(store.get("db"), "mesh");
  store.delete("db");
  assert.equal(store.get("db"), undefined);
});

test("secure mesh discovers identities, grants providers, refreshes addresses, then links consumers", async () => {
  const { gw, sent } = fakeGw(["boxa", "boxb"]);
  const outcome = await establishLink(LINK, gw);
  assert.deepEqual(outcome, { transport: "mesh", ok: true });
  assert.deepEqual(
    sent.map((s) => [s.to, s.cmd.cmd, s.cmd.stage]),
    [
      ["boxa", "meshStatus", undefined],
      ["boxb", "meshStatus", undefined],
      ["boxa", "meshApply", "authorize"],
      ["boxb", "meshApply", "authorize"],
      // A link not yet recorded as mesh frees any dumbpipe listener on the consumer's port first.
      ["boxb", "meshDrop", undefined],
      ["boxa", "meshApply", "links"],
      ["boxb", "meshApply", "links"],
      ["boxa", "meshDrop", undefined],
    ],
  );
  const provider = sent[2].cmd.desired;
  assert.deepEqual(provider.exposures, [
    { name: "db-link", target: "127.0.0.1:5432", allowed_peers: [peer("boxb").id] },
  ]);
  const consumer = sent[6].cmd.desired;
  assert.deepEqual(consumer.links, [
    { name: "db-link", peer: peer("boxa").id, service: "db-link", listen: "0.0.0.0:15432" },
  ]);
  assert.ok(
    consumer.fleet.every((p: any) => p.direct_addrs[0] === "127.0.0.1:2000"),
    "second stage publishes rebound addresses",
  );
  assert.equal(legacyCommands(sent).length, 0, "no ticket is minted for a mesh link");
});

test("a link with an offline end is not set up, and agent errors surface", async () => {
  await assert.rejects(() => establishLink(LINK, fakeGw(["boxa"]).gw), /node offline: boxb/);
  await assert.rejects(
    () => establishLink(LINK, fakeGw(["boxa", "boxb"], { failShare: true }).gw),
    /share boom/,
  );
  await assert.rejects(
    () => establishLink(LINK, fakeGw(["boxa", "boxb"], { failConnect: true }).gw),
    /connect boom/,
  );
});

test("fleet membership grants no implicit service access and several declared consumers aggregate", () => {
  const endpoints = new Map(["a", "b", "c"].map((id) => [id, peer(id)]));
  const edge = { ...LINK, provider: "b", consumer: "a" };
  const one = meshDesired("b", [edge], endpoints);
  assert.deepEqual(one.exposures[0].allowed_peers, [peer("a").id]);
  assert.ok(!one.exposures[0].allowed_peers.includes(peer("c").id));
  const both = meshDesired("b", [edge, { ...edge, consumer: "c" }], endpoints);
  assert.deepEqual(both.exposures[0].allowed_peers, [peer("a").id, peer("c").id].toSorted());
  const revoked = meshDesired("b", [], endpoints);
  assert.deepEqual(revoked.exposures, []);
  assert.deepEqual(revoked.relays, { relays: [], n0_fallback: false });
});

test("authoritative reconciliation after deletion sends empty exposures to revoke old streams", async () => {
  const { gw, sent } = fakeGw(["boxa", "boxb"]);
  const opts = options();
  await reconcileMesh(gw, [LINK], opts);
  sent.length = 0;
  await reconcileMesh(gw, [], opts);
  const auth = sent.filter((s) => s.cmd.stage === "authorize");
  assert.equal(auth.length, 2);
  assert.ok(
    auth.every((s) => s.cmd.desired.exposures.length === 0 && s.cmd.desired.links.length === 0),
  );
  assert.equal(
    opts.transports.get(LINK.name),
    undefined,
    "a deleted link's transport is forgotten",
  );
});

// The expand release: one legacy Node and three mesh Nodes. old ↔ a stays on dumbpipe, b → a goes
// on the mesh with a grant for a alone, and c, a mesh fleet member with no link, is granted nothing.
test("a mixed fleet puts each link on one transport and still denies the unauthorized peer", async () => {
  const { gw, sent } = fakeGw(["old", "a", "b", "c"], { legacy: ["old"] });
  const legacyLink = {
    name: "legacy-db",
    provider: "old",
    providerPort: 5432,
    consumer: "a",
    localPort: 15432,
  };
  const meshLink = {
    name: "db",
    provider: "b",
    providerPort: 5433,
    consumer: "a",
    localPort: 15433,
  };
  const opts = options();
  const report = await reconcileMesh(gw, [legacyLink, meshLink], opts);
  assert.deepEqual(report.links.get("legacy-db"), {
    transport: "legacy-dumbpipe",
    ok: true,
    error: undefined,
  });
  assert.deepEqual(report.links.get("db"), { transport: "mesh", ok: true });
  assert.equal(opts.transports.get("legacy-db"), "legacy-dumbpipe");
  assert.equal(opts.transports.get("db"), "mesh");

  assert.deepEqual(
    legacyCommands(sent).map((s) => [s.to, s.cmd.cmd, s.cmd.name]),
    [
      ["old", "meshShare", "legacy-db"],
      ["a", "meshConnect", "legacy-db"],
    ],
  );
  assert.equal(sent.find((s) => s.cmd.cmd === "meshConnect")!.cmd.ticket, "b".repeat(64));
  assert.ok(
    !sent.some((s) => s.to === "old" && s.cmd.cmd !== "meshShare"),
    "the legacy Node gets no mesh command",
  );
  const applies = sent.filter((s) => s.cmd.cmd === "meshApply");
  assert.ok(
    applies.every((s) => JSON.stringify(s.cmd.desired).indexOf("legacy-db") === -1),
    "a legacy link never appears in a mesh desired view",
  );
  const provider = applies.find((s) => s.to === "b" && s.cmd.stage === "authorize")!.cmd.desired;
  assert.deepEqual(provider.exposures[0].allowed_peers, [peer("a").id]);
  const outsider = applies.find((s) => s.to === "c" && s.cmd.stage === "authorize")!.cmd.desired;
  assert.deepEqual([outsider.exposures, outsider.links], [[], []]);

  const view = describeLink(gw, legacyLink, opts);
  assert.equal(view.transport, "legacy-dumbpipe");
  assert.equal(view.authenticated, false);
  assert.match(view.warning!, /unauthenticated.*install erainfra-mesh on old/);
  assert.deepEqual(
    [describeLink(gw, meshLink, opts).state, describeLink(gw, meshLink, opts).authenticated],
    ["secure", true],
  );

  // A healer pass with nothing changed leaves the working dumbpipe pair alone.
  sent.length = 0;
  await reconcileMesh(gw, [legacyLink, meshLink], opts);
  assert.equal(legacyCommands(sent).length, 0);
});

test("a legacy link migrates to the mesh once its Node upgrades, and never goes back", async () => {
  const { gw, sent } = fakeGw(["old", "a"], { legacy: ["old"] });
  const link = {
    name: "legacy-db",
    provider: "old",
    providerPort: 5432,
    consumer: "a",
    localPort: 15432,
  };
  const opts = options();
  await reconcileMesh(gw, [link], opts);
  assert.equal(opts.transports.get("legacy-db"), "legacy-dumbpipe");

  // old installs erainfra-mesh and reconnects with the capability.
  gw.legacy.delete("old");
  sent.length = 0;
  const report = await reconcileMesh(gw, [link], opts);
  assert.deepEqual(report.links.get("legacy-db"), { transport: "mesh", ok: true });
  assert.equal(opts.transports.get("legacy-db"), "mesh");
  assert.deepEqual(
    sent.filter((s) => s.cmd.cmd !== "meshStatus").map((s) => [s.to, s.cmd.cmd, s.cmd.stage]),
    [
      ["old", "meshApply", "authorize"], // the grant exists before anything is torn down
      ["a", "meshApply", "authorize"],
      ["a", "meshDrop", undefined], // frees the consumer port for the mesh listener
      ["old", "meshApply", "links"],
      ["a", "meshApply", "links"],
      ["old", "meshDrop", undefined], // dropped only after both sidecars confirmed the mesh link
    ],
  );
  assert.equal(legacyCommands(sent).length, 0);

  // old rolls back to an agent without the sidecar. The link reports degraded and stays off dumbpipe.
  gw.legacy.add("old");
  sent.length = 0;
  const after = await reconcileMesh(gw, [link], opts);
  assert.equal(legacyCommands(sent).length, 0, "no downgrade to dumbpipe");
  assert.equal(after.links.get("legacy-db")!.ok, false);
  assert.match(after.links.get("legacy-db")!.error!, /degraded.*stays on the mesh/);
  const view = describeLink(gw, link, opts);
  assert.deepEqual([view.transport, view.state], ["mesh", "degraded"]);
});

test("an unconfirmed migration keeps the provider's dumbpipe share and is not recorded as mesh", async () => {
  const { gw, sent } = fakeGw(["old", "a"], { legacy: ["old"], unbound: ["legacy-db"] });
  const link = {
    name: "legacy-db",
    provider: "old",
    providerPort: 5432,
    consumer: "a",
    localPort: 15432,
  };
  const opts = options();
  await reconcileMesh(gw, [link], opts);
  gw.legacy.delete("old");
  sent.length = 0;
  const report = await reconcileMesh(gw, [link], opts);
  assert.match(report.links.get("legacy-db")!.error!, /migration to the mesh not confirmed/);
  assert.equal(opts.transports.get("legacy-db"), "legacy-dumbpipe");
  assert.ok(!sent.some((s) => s.to === "old" && s.cmd.cmd === "meshDrop"));
  assert.equal(legacyCommands(sent).length, 0, "both ends support the mesh, so no dumbpipe retry");
  assert.equal(describeLink(gw, link, opts).state, "migrating");
});

test("ERAINFRA_MESH_REQUIRE refuses legacy links and ends the ones already running", async (t) => {
  const { gw, sent } = fakeGw(["old", "a"], { legacy: ["old"] });
  const link = {
    name: "legacy-db",
    provider: "old",
    providerPort: 5432,
    consumer: "a",
    localPort: 15432,
  };
  const opts = options();
  await reconcileMesh(gw, [link], opts);
  sent.length = 0;
  const report = await reconcileMesh(gw, [link], { ...opts, require: true });
  assert.equal(report.links.get("legacy-db")!.ok, false);
  assert.match(
    report.links.get("legacy-db")!.error!,
    /refused \(ERAINFRA_MESH_REQUIRE=true\).*old/,
  );
  assert.equal(legacyCommands(sent).length, 0);
  assert.deepEqual(
    sent.filter((s) => s.cmd.cmd === "meshDrop").map((s) => s.to),
    ["a", "old"],
  );
  assert.equal(describeLink(gw, link, { ...opts, require: true }).state, "refused");

  process.env.ERAINFRA_MESH_REQUIRE = "true";
  t.after(() => delete process.env.ERAINFRA_MESH_REQUIRE);
  await assert.rejects(
    () => establishLink(link, fakeGw(["old", "a"], { legacy: ["old"] }).gw),
    /legacy link refused \(ERAINFRA_MESH_REQUIRE=true\)/,
  );
  process.env.ERAINFRA_MESH_REQUIRE = "maybe";
  await assert.rejects(() => establishLink(link, fakeGw(["old", "a"]).gw), /must be true or false/);
});

test("ensureRegistryLinks configures the secure sidecar and persists declared consumers", async (t) => {
  process.env.PORTLESS_REGISTRY_NODE = "hub-box";
  t.after(() => delete process.env.PORTLESS_REGISTRY_NODE);
  const { gw, sent } = fakeGw(["hub-box", "far-box"]);
  assert.equal(
    await ensureRegistryLinks(["hub-box", "far-box", "far-box"], "127.0.0.1:61050", gw),
    null,
  );
  assert.equal(sent.filter((s) => s.cmd.stage === "authorize").length, 2);
  assert.deepEqual(linkStore.get("registry-far-box"), {
    name: "registry-far-box",
    provider: "hub-box",
    providerPort: 61050,
    consumer: "far-box",
    localPort: 61050,
    createdBy: "deploy",
  });
  linkStore.delete("registry-far-box");
});

test("co-located and unconfigured registry paths create no mesh grants", async (t) => {
  process.env.PORTLESS_REGISTRY_NODE = "hub-box";
  t.after(() => delete process.env.PORTLESS_REGISTRY_NODE);
  const local = fakeGw(["hub-box"]);
  assert.equal(await ensureRegistryLinks(["hub-box"], "127.0.0.1:61050", local.gw), null);
  assert.equal(local.sent.length, 0);
  delete process.env.PORTLESS_REGISTRY_NODE;
  const unset = fakeGw(["far-box"]);
  assert.equal(await ensureRegistryLinks(["far-box"], "127.0.0.1:61050", unset.gw), null);
  assert.equal(unset.sent.length, 0);
});

test("a Node that fails mid-pass does not keep a revoked grant alive on the others", async () => {
  // boxc is listed first and times out on every apply. boxa must still receive its revocation.
  const { gw, sent } = fakeGw(["boxc", "boxa", "boxb"], { down: ["boxc"] });
  const report = await reconcileMesh(gw, [], options());
  assert.match(report.errors.join("; "), /authorization failed on boxc: agent command timed out/);
  const provider = sent.find((s) => s.to === "boxa" && s.cmd.stage === "authorize");
  assert.ok(provider, "boxa was skipped after boxc failed");
  assert.deepEqual(provider.cmd.desired.exposures, []);
  assert.ok(sent.some((s) => s.to === "boxb" && s.cmd.stage === "links"));
  assert.ok(!sent.some((s) => s.to === "boxc" && s.cmd.stage === "links"));
});

test("ensureAppLinks runs one pass for all of an app's links, legacy ones included", async (t) => {
  const links = [
    {
      name: "api-db",
      need: "db",
      provider: "boxa",
      providerPort: 5432,
      consumer: "boxb",
      localPort: 15432,
    },
    {
      name: "api-cache",
      need: "cache",
      provider: "old",
      providerPort: 6379,
      consumer: "boxb",
      localPort: 16379,
    },
  ];
  appStore.set("shop", { node: "boxb", services: [], links });
  t.after(() => appStore.delete("shop"));
  const { gw, sent } = fakeGw(["boxa", "boxb", "old"], { legacy: ["old"] });
  const result = await ensureAppLinks("shop", gw);
  assert.deepEqual(result[0], { name: "api-db", ok: true, transport: "mesh" });
  assert.deepEqual(result[1], { name: "api-cache", ok: true, transport: "legacy-dumbpipe" });
  // One status per capable Node and one apply per stage: not a pass per link.
  assert.equal(sent.filter((s) => s.cmd.cmd === "meshStatus").length, 2);
  assert.equal(sent.filter((s) => s.cmd.stage === "authorize").length, 2);
  assert.deepEqual(
    sent.filter((s) => s.to === "old").map((s) => s.cmd.cmd),
    ["meshShare"],
    "a Node without the capability only ever sees the legacy commands",
  );
  const consumer = sent.find((s) => s.to === "boxb" && s.cmd.stage === "links")!.cmd.desired;
  assert.deepEqual(
    consumer.links.map((l: any) => l.name),
    ["api-db"],
  );
});

test("a migration whose provider cannot be authorized leaves the consumer's dumbpipe listener alone", async () => {
  const { gw, sent } = fakeGw(["old", "a"], { legacy: ["old"] });
  const link = {
    name: "legacy-db",
    provider: "old",
    providerPort: 5432,
    consumer: "a",
    localPort: 15432,
  };
  const opts = options();
  await reconcileMesh(gw, [link], opts);
  // old gains the capability, but its sidecar times out on every apply.
  const broken = fakeGw(["old", "a"], { down: ["old"] });
  const report = await reconcileMesh(broken.gw, [link], opts);
  assert.match(report.links.get("legacy-db")!.error!, /migration to the mesh not confirmed/);
  assert.ok(!broken.sent.some((s) => s.cmd.cmd === "meshDrop"), "no dumbpipe half was dropped");
  const consumer = broken.sent.find((s) => s.to === "a" && s.cmd.stage === "links")!.cmd.desired;
  assert.deepEqual(consumer.links, [], "the mesh listener would collide with dumbpipe's");
  assert.equal(opts.transports.get("legacy-db"), "legacy-dumbpipe");
  assert.equal(
    legacyCommands(sent.concat(broken.sent)).length,
    2,
    "only the first pass's share and connect",
  );
});

test("ERAINFRA_MESH_RELAYS takes a URL or an object with a QUIC address discovery port", () => {
  assert.deepEqual(
    parseMeshRelays(
      '[{"url":"https://relay.on99.ai","quic_port":443},"https://relay.example",{"url":"https://noqad.example","quic":false},{"url":"https://explicit.example","quic":true}]',
      false,
    ),
    [
      { url: "https://relay.on99.ai", quic_port: 443 },
      "https://relay.example",
      { url: "https://noqad.example", quic: false },
      "https://explicit.example",
    ],
  );
  assert.deepEqual(parseMeshRelays("[]", false), []);
  assert.deepEqual(parseMeshRelays('[{"url":"http://r.example","quic_port":443}]', false), [
    { url: "http://r.example", quic_port: 443 },
  ]);
  const refusals: Array<[string, string, boolean?]> = [
    ['{"url":"https://r.example"}', "ERAINFRA_MESH_RELAYS must be a JSON URL array, each entry"],
    ["https://r.example", "ERAINFRA_MESH_RELAYS must be a JSON URL array"],
    [
      '[{"url":"https://r.example","quic_port":0}]',
      'ERAINFRA_MESH_RELAYS entry 1: relay https://r.example: "quic_port" must be a port number from 1 to 65535, not 0',
    ],
    [
      '["https://a.example",{"url":"https://r.example","quic_port":65536}]',
      'entry 2: relay https://r.example: "quic_port" must be a port number from 1 to 65535, not 65536',
    ],
    ['[{"url":"https://r.example","quic_port":"443"}]', 'from 1 to 65535, not "443"'],
    ['[{"url":"https://r.example","quic_port":443.5}]', "from 1 to 65535, not 443.5"],
    [
      '[{"url":"https://r.example","quic":false,"quic_port":443}]',
      '"quic": false turns QUIC address discovery off, so drop "quic_port"',
    ],
    ['[{"url":"https://r.example","quic":"no"}]', '"quic" must be true or false, not "no"'],
    ['[{"url":"https://r.example","qad_port":443}]', 'relay field "qad_port" is unknown'],
    ['[{"quic_port":443}]', 'entry 1: a relay object needs "url", a string'],
    ["[443]", "a relay is a URL string or an object like"],
    ["[null]", "a relay is a URL string or an object like"],
    [
      '[{"url":"ftp://r.example","quic_port":443}]',
      'relay ftp://r.example has scheme "ftp"; use https',
    ],
    ['["relay.example"]', 'relay relay.example has scheme ""; use https'],
    [
      '[{"url":"http://r.example","quic_port":443}]',
      "relay http://r.example is plain http; refusing to send the relay auth token over it",
      true,
    ],
  ];
  for (const [raw, message, withToken] of refusals) {
    assert.throws(
      () => parseMeshRelays(raw, withToken ?? false),
      (e: Error) => e.message.includes(message),
      raw,
    );
  }
});
