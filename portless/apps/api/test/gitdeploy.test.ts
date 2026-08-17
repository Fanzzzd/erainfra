import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GitProjectStore,
  startGitDeploy,
  startUploadDeploy,
  type GitBinding,
} from "../src/runtime/gitdeploy.ts";
import { createDb } from "../src/db.ts";

const sampleBind = {
  repo: "Owner/Repo",
  branch: "main",
  buildNode: "bn",
  deployNode: "dn",
  name: "app",
  port: 8080,
};

// A fake agent gateway: scripted replies per cmd, records every send.
function fakeGw(replies: Record<string, { ok: boolean; output?: string; error?: string }> = {}) {
  const calls: Array<{ id: string; cmd: Record<string, unknown> }> = [];
  return {
    calls,
    list: () => [
      { id: "bn", version: "0", roles: [], connectedAt: "" },
      { id: "dn", version: "0", roles: [], connectedAt: "" },
    ],
    send: async (id: string, cmd: Record<string, unknown>) => {
      calls.push({ id, cmd });
      return replies[cmd.cmd as string] ?? { ok: true, output: "" };
    },
  };
}

test("bindings persist across a reload (config must survive a hub restart)", () => {
  const dir = mkdtempSync(join(tmpdir(), "gp-"));
  const file = join(dir, "portless.db");
  try {
    const a = new GitProjectStore(createDb(file));
    assert.ok(a.bind(sampleBind).ok);
    // a fresh store reading the same file sees the binding (proves save+load)
    const b = new GitProjectStore(createDb(file));
    assert.equal(b.find("owner/repo", "main")?.name, "app");
    assert.equal(b.list().length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("store binds, finds case-insensitively, dedupes, and unbinds", () => {
  const s = new GitProjectStore(createDb(":memory:"));
  const r = s.bind(sampleBind);
  assert.ok(r.ok && r.binding.id);
  // find is case-insensitive on the repo
  assert.equal(s.find("owner/repo", "main")?.name, "app");
  assert.equal(s.find("owner/repo", "dev"), undefined); // branch must match
  // no double-binding the same repo+branch
  const dup = s.bind(sampleBind);
  assert.equal(dup.ok, false);
  const id = (r as { binding: GitBinding }).binding.id;
  assert.equal(s.unbind(id).ok, true);
  assert.equal(s.list().length, 0);
});

test("git deploy with no portless.yaml: implicit single service (spec → build → deployApp)", async () => {
  const gw = fakeGw({ spec: { ok: true, output: "" } });
  const b: GitBinding = { id: "1", ...sampleBind, repo: "o/r", name: "implicit1" };
  const { deployId, done } = startGitDeploy(
    b,
    "abcdef1234567890",
    undefined,
    { registry: "reg:5000", hubBase: "http://hub" },
    gw,
  );
  assert.ok(deployId);
  const r = await done;
  assert.equal(r.ok, true, r.error ?? "");

  const cmds = gw.calls.map((c) => c.cmd.cmd);
  assert.deepEqual(cmds, ["spec", "build", "deployApp"]);
  // spec + build go to the build node, with the public clone url (no token configured)
  assert.equal(gw.calls[0].id, "bn");
  assert.equal(gw.calls[0].cmd.repoUrl, "https://github.com/o/r.git");
  assert.equal(gw.calls[1].cmd.tag, "implicit1-web:abcdef123456"); // sha truncated to 12
  assert.equal(gw.calls[1].cmd.registry, "reg:5000");
  // deployApp goes to the deploy node; the single service publishes loopback host:container
  assert.equal(gw.calls[2].id, "dn");
  const svc = (gw.calls[2].cmd.services as Array<Record<string, unknown>>)[0];
  assert.equal(svc.name, "web");
  assert.equal(svc.route, "implicit1");
  assert.equal((svc.env as Record<string, string>).PORT, "8080");
  assert.match((svc.args as string[]).join(" "), /^-p 127\.0\.0\.1:\d+:8080$/);
});

test("upload deploy with a portless.yaml: two services, same-node needs → docker-DNS env, volumes", async () => {
  const yaml = `
services:
  web:
    build: .
    port: 3000
    route: true
    needs: [db]
  db:
    image: reg:5000/postgres:16
    port: 5432
    volumes: [pgdata:/var/lib/postgresql/data]
`;
  const gw = fakeGw({ spec: { ok: true, output: yaml } });
  const id = "11111111-1111-1111-1111-111111111111";
  const { done } = startUploadDeploy(
    id,
    { app: "up1" },
    { registry: "reg:5000", hubBase: "http://hub" },
    gw,
  );
  const r = await done;
  assert.equal(r.ok, true, r.error ?? "");

  assert.equal(gw.calls[0].cmd.tarUrl, `http://hub/builds/${id}/source.tgz`);
  // only web has build: — exactly one build call
  assert.deepEqual(
    gw.calls.map((c) => c.cmd.cmd),
    ["spec", "build", "deployApp"],
  );
  const services = gw.calls[2].cmd.services as Array<Record<string, unknown>>;
  const web = services.find((s) => s.name === "web")!;
  const db = services.find((s) => s.name === "db")!;
  // same node: needs resolve over the per-app docker network
  assert.equal((web.env as Record<string, string>).DB_HOST, "db");
  assert.equal((web.env as Record<string, string>).DB_PORT, "5432");
  // route:true with a single routed service = the app name
  assert.equal(web.route, "up1");
  // named volume is app-prefixed
  assert.deepEqual(db.args, ["-v", "up1-pgdata:/var/lib/postgresql/data"]);
  assert.equal(db.image, "reg:5000/postgres:16");
  assert.match(r.urls.join(","), /up1/);
});

test("build failure short-circuits (no deployApp) and reports the stage", async () => {
  const gw = fakeGw({ spec: { ok: true, output: "" }, build: { ok: false, error: "boom" } });
  const b: GitBinding = { id: "1", ...sampleBind, repo: "o/r", name: "failbuild" };
  const { done } = startGitDeploy(b, "x", undefined, { registry: "r", hubBase: "h" }, gw);
  const r = await done;
  assert.equal(r.ok, false);
  assert.equal(r.stage, "building");
  assert.match(r.error!, /boom/);
  assert.deepEqual(
    gw.calls.map((c) => c.cmd.cmd),
    ["spec", "build"],
  ); // deployApp never attempted
});

test("no portless.yaml and no port on the binding = actionable error", async () => {
  const gw = fakeGw({ spec: { ok: true, output: "" } });
  const b: GitBinding = { id: "1", repo: "o/r", branch: "main", name: "noport" }; // no port
  const { done } = startGitDeploy(b, "x", undefined, { registry: "r", hubBase: "h" }, gw);
  const r = await done;
  assert.equal(r.ok, false);
  assert.match(r.error!, /portless\.yaml/);
});
