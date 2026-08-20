import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApiServer } from "../src/server.ts";

// server.ts anchors PORTLESS_DEPLOY_DIR / PORTLESS_CLI_FILE on its own directory, so mirror that
// anchor here rather than hardcoding a repo-root-relative path: if the module ever moves, the import
// above moves with it and these stay pointed at whatever server.ts itself would compute.
const serverDir = join(import.meta.dirname, "../src");
const DEPLOY_DIR = join(serverDir, "../../../deploy/infra"); // server.ts's PORTLESS_DEPLOY_DIR default
const CLI_FILE = join(serverDir, "../../../packages/cli/portless.mjs"); // its PORTLESS_CLI_FILE default
const WEB_DIR = join(serverDir, "../../hub-web/dist"); // its PORTLESS_WEB_DIR default

// What a customer machine curls during onboarding. Both routes fail SOFT — a wrong path yields a 404
// carrying a plausible "not available on this server" message, never a boot error — so nothing else
// in this suite would notice a directory move that silently breaks node enrolment.
const INSTALLERS = ["agent.sh", "agent.ps1", "cli.sh", "image.sh", "registry.sh"];

test("the default installer paths resolve to real files and the routes serve them", async () => {
  delete process.env.PORTLESS_DEPLOY_DIR; // exercise the defaults, not whatever the shell exported
  delete process.env.PORTLESS_CLI_FILE;
  const app = createApiServer();
  try {
    assert.ok(existsSync(DEPLOY_DIR), `default deploy dir does not exist: ${DEPLOY_DIR}`);
    for (const script of INSTALLERS) {
      const onDisk = join(DEPLOY_DIR, script);
      assert.ok(existsSync(onDisk), `default deploy dir has no ${script}: ${onDisk}`);
      const res = await app.inject({
        method: "GET",
        url: `/${script}`,
        headers: { host: "hub.example" },
      });
      assert.equal(
        res.statusCode,
        200,
        `GET /${script} returned ${res.statusCode} — the default deploy dir no longer resolves`,
      );
      assert.match(
        String(res.headers["content-type"]),
        script.endsWith(".ps1") ? /text\/plain/ : /text\/x-shellscript/,
      );
      // Each script carries `<hub>` placeholders that are templated to the serving origin; assert the
      // substitution really happened, so "200 with an untemplated body" can't pass for a served script.
      assert.ok(
        readFileSync(onDisk, "utf8").includes("<hub>"),
        `${script} no longer has a <hub> placeholder to template`,
      );
      assert.ok(
        res.body.includes("http://hub.example"),
        `${script} was served without its hub URL templated in`,
      );
      assert.ok(
        !res.body.includes("<hub>"),
        `${script} was served with an untemplated <hub> left in it`,
      );
    }

    // The CLI payload cli.sh downloads. Separate default path, so it breaks independently of the above.
    assert.ok(existsSync(CLI_FILE), `default CLI file does not exist: ${CLI_FILE}`);
    const cli = await app.inject({ method: "GET", url: "/cli/portless.mjs" });
    assert.equal(
      cli.statusCode,
      200,
      `GET /cli/portless.mjs returned ${cli.statusCode} — the default CLI path no longer resolves`,
    );
    assert.match(String(cli.headers["content-type"]), /text\/javascript/);
    assert.equal(cli.body, readFileSync(CLI_FILE, "utf8"));

    // /agent-bin/:file rides deployDir (agentBinDir defaults to `<deployDir>/bin`), so the assertion
    // above pins its directory too. What is left to pin is that the route still distinguishes an
    // unbuilt binary from a bad name — the "not built" body is what tells an operator to run
    // build-agents.sh, and a directory move would otherwise turn it into an indistinguishable 404.
    const unbuilt = await app.inject({
      method: "GET",
      url: "/agent-bin/portless-agent-linux-amd64",
    });
    assert.ok(
      unbuilt.statusCode === 200 || unbuilt.statusCode === 404,
      `GET /agent-bin/… returned ${unbuilt.statusCode}`,
    );
    if (unbuilt.statusCode === 404)
      assert.match(unbuilt.body, /not built — run \S*build-agents\.sh/);
    // The allowlist, not the router, is what keeps this route from being an arbitrary-file read:
    // a traversal is normalised away before it ever reaches the handler, so probe with a name the
    // route accepts as a name and the regex rejects as a binary.
    const badName = await app.inject({ method: "GET", url: "/agent-bin/hub.sh" });
    assert.equal(badName.statusCode, 400);
  } finally {
    await app.close();
  }
});

// The enrollment scripts hand the install to the control plane's verified installer (ADR 0006), and
// they learn which control plane from a second placeholder. Unset, they must refuse: falling back to
// the unchecked download they used to do is the one behaviour the ADR exists to remove, and a
// silently untemplated `<install>` is exactly how that would come back.
const ENROLLMENT_SCRIPTS = ["agent.sh", "agent.ps1"];

test("the enrollment scripts learn their control plane from ERAINFRA_INSTALL_URL", async () => {
  delete process.env.PORTLESS_DEPLOY_DIR;
  process.env.ERAINFRA_INSTALL_URL = "https://control.example/";
  const app = createApiServer();
  try {
    for (const script of ENROLLMENT_SCRIPTS) {
      assert.ok(
        readFileSync(join(DEPLOY_DIR, script), "utf8").includes("<install>"),
        `${script} no longer has an <install> placeholder to template`,
      );
      const res = await app.inject({
        method: "GET",
        url: `/${script}`,
        headers: { host: "hub.example" },
      });
      assert.equal(res.statusCode, 200);
      // Trailing slash normalised away, so the script's `$INSTALL_URL/install` stays well formed.
      assert.ok(
        res.body.includes("https://control.example"),
        `${script} was served without its control plane templated in`,
      );
      assert.ok(!res.body.includes("control.example//"), `${script} doubled a slash`);
      assert.ok(!res.body.includes("<install>"), `${script} left an untemplated <install> in it`);
      // The placeholder appears exactly once in code, on purpose. A second occurrence — a guard
      // comparing against its literal text, say — is rewritten by this same substitution, and a
      // guard that ends up reading `$INSTALL_URL != <the configured url>` passes precisely when it
      // should refuse. Comments are exempt: they are prose about the placeholder, not a use of it.
      const codeUses = readFileSync(join(DEPLOY_DIR, script), "utf8")
        .split("\n")
        .filter((line) => !line.trimStart().startsWith("#"))
        .filter((line) => line.includes("<install>"));
      assert.equal(
        codeUses.length,
        1,
        `${script} uses <install> in ${codeUses.length} places; templating rewrites every one`,
      );
      assert.ok(
        !res.body.includes('curl -fsSL "$url" -o "$BIN/portless-agent"'),
        `${script} still downloads the agent without checking it`,
      );
    }
  } finally {
    await app.close();
    delete process.env.ERAINFRA_INSTALL_URL;
  }
});

test("with no control plane configured, enrollment refuses rather than installing unchecked bytes", async () => {
  delete process.env.PORTLESS_DEPLOY_DIR;
  delete process.env.ERAINFRA_INSTALL_URL;
  const app = createApiServer();
  try {
    const res = await app.inject({
      method: "GET",
      url: "/agent.sh",
      headers: { host: "hub.example" },
    });
    assert.equal(res.statusCode, 200);
    assert.ok(!res.body.includes("<install>"), "the placeholder survived into a served script");
    assert.match(res.body, /no verified installer configured/);
    // Running it with nothing configured stops before it fetches or installs anything.
    const run = spawnSync("sh", ["-s", "--", "--token", "plt_test"], {
      input: res.body,
      encoding: "utf8",
      env: { ...process.env, HOME: mkdtempSync(join(tmpdir(), "portless-enroll-")) },
    });
    assert.notEqual(run.status, 0);
    assert.match(run.stderr, /no verified installer configured/);
  } finally {
    await app.close();
  }
});

// The Hub UI's default lives one directory up from the other three and is the only one of the four
// that points at a build output, so it cannot be asserted to exist on a clean checkout. Pin the
// depth instead: if apps/hub or apps/hub-web moves, `../../hub-web` stops resolving and this fails,
// which is the same failure the 404-fails-soft trap would otherwise hide until a customer curl'd it.
test("the default web dir resolves to apps/hub-web", () => {
  assert.ok(existsSync(join(WEB_DIR, "..")), `default web dir has no package: ${WEB_DIR}`);
  assert.equal(
    JSON.parse(readFileSync(join(WEB_DIR, "../package.json"), "utf8")).name,
    "@erainfra/hub-web",
  );
});

test("a broken installer path fails soft with a 404 — which is why the test above pins the defaults", async () => {
  process.env.PORTLESS_DEPLOY_DIR = join(DEPLOY_DIR, "moved-away");
  process.env.PORTLESS_CLI_FILE = join(CLI_FILE, "moved-away");
  const app = createApiServer();
  try {
    for (const script of INSTALLERS) {
      const res = await app.inject({ method: "GET", url: `/${script}` });
      assert.equal(res.statusCode, 404); // no throw, no 5xx: invisible to any test that only boots the server
      assert.match(res.body, new RegExp(`^${script} not available on this server`));
    }
    const cli = await app.inject({ method: "GET", url: "/cli/portless.mjs" });
    assert.equal(cli.statusCode, 404);
    assert.match(cli.body, /^cli not available on this server/);
  } finally {
    await app.close();
    delete process.env.PORTLESS_DEPLOY_DIR;
    delete process.env.PORTLESS_CLI_FILE;
  }
});
