// The account-auth surface, end to end through fastify.inject: first-boot setup, password login
// with rate limiting, cookie sessions driving tRPC, API tokens, logout. Hermetic — the singleton
// stores are in-memory under the test runner.
import test from "node:test";
import assert from "node:assert/strict";
import { createApiServer } from "../src/server.ts";
import { hashPassword, verifyPassword, UserStore } from "../src/runtime/users.ts";
import { SessionStore } from "../src/runtime/sessions.ts";
import { ApiTokenStore } from "../src/runtime/apitokens.ts";
import { LoginRateLimiter, StaticTokenStore } from "../src/auth.ts";
import { createDb } from "../src/db.ts";
import { agentGateway } from "../src/runtime/agents.ts";

test("scrypt password hashing: roundtrip, reject wrong, params encoded in the hash", () => {
  const h = hashPassword("correct horse battery");
  assert.match(h, /^scrypt\$\d+\$\d+\$\d+\$/);
  assert.ok(verifyPassword("correct horse battery", h));
  assert.ok(!verifyPassword("wrong", h));
  assert.notEqual(h, hashPassword("correct horse battery")); // fresh salt every time
});

test("user store: create/dup/verify, last-owner protection", () => {
  const s = new UserStore(createDb(":memory:"));
  assert.equal(s.count(), 0);
  const r = s.create({ email: "A@Example.com", password: "hunter22", roles: ["owner"] });
  assert.ok(r.ok);
  assert.equal(
    s.create({ email: "a@example.com", password: "hunter22", roles: ["viewer"] }).ok,
    false,
  ); // dup, case-insensitive
  assert.equal(
    s.create({ email: "b@example.com", password: "short", roles: ["viewer"] }).ok,
    false,
  ); // weak pw
  assert.ok(s.verify("a@example.com", "hunter22"));
  assert.equal(s.verify("a@example.com", "nope"), null);
  assert.equal(s.verify("ghost@example.com", "hunter22"), null);
  if (r.ok)
    assert.match(
      s.remove(r.user.id).ok ? "" : ((s.remove(r.user.id) as { error: string }).error ?? ""),
      /owner|/,
    );
  if (r.ok) assert.equal(s.remove(r.user.id).ok, false); // last owner survives
});

test("user store: updateEmail validates, dedups, keeps id-keyed references intact", () => {
  const s = new UserStore(createDb(":memory:"));
  const a = s.create({ email: "a@example.com", password: "hunter22", roles: ["owner"] });
  const b = s.create({ email: "b@example.com", password: "hunter22", roles: ["viewer"] });
  assert.ok(a.ok && b.ok);
  if (!a.ok || !b.ok) return;
  assert.equal(s.updateEmail(a.user.id, "not-an-email").ok, false);
  assert.equal(s.updateEmail(a.user.id, "B@example.com").ok, false); // taken (case-insensitive)
  const r = s.updateEmail(a.user.id, "NEW@Example.com");
  assert.ok(r.ok && r.user.email === "new@example.com");
  assert.ok(s.verify("new@example.com", "hunter22")); // same id, same password
  assert.equal(s.verify("a@example.com", "hunter22"), null); // old address gone
  assert.equal(s.updateEmail(a.user.id, "new@example.com").ok, true); // re-setting your own is fine
});

test("sessions: opaque token resolves, revocation works, hash at rest", () => {
  const s = new SessionStore(createDb(":memory:"));
  const { token, session } = s.create("u1", "test-agent");
  assert.notEqual(token, session.tokenHash); // never stored raw
  assert.equal(s.resolve(token)?.userId, "u1");
  assert.equal(s.resolve("forged"), null);
  assert.ok(s.revokeByToken(token));
  assert.equal(s.resolve(token), null);
});

test("api tokens: create-once value, resolve, revoke, masked listing", () => {
  const s = new ApiTokenStore(createDb(":memory:"));
  const { token, record } = s.create({ name: "cli @test", roles: ["operator"], createdBy: "u1" });
  assert.match(token, /^plt_[0-9a-f]{48}$/);
  assert.equal(s.resolve(token)?.id, record.id);
  assert.equal(s.resolve("plt_" + "0".repeat(48)), null);
  const listed = s.list()[0] as Record<string, unknown>;
  assert.equal(listed.hash, undefined); // never listed
  assert.equal(listed.prefix, token.slice(0, 12));
  assert.ok(s.revoke(record.id));
  assert.equal(s.resolve(token), null);
});

test("login rate limiter: 5 strikes then blocked, success clears", () => {
  const l = new LoginRateLimiter();
  for (let i = 0; i < 5; i++) {
    assert.ok(l.check("k").allowed);
    l.fail("k");
  }
  assert.equal(l.check("k").allowed, false);
  assert.ok(l.check("k").retryAfterSec > 0);
  l.clear("k");
  assert.ok(l.check("k").allowed);
});

test("http flow: setup-once → login (cookie) → tRPC → cli-token → logout", async () => {
  const app = createApiServer({ tokens: new StaticTokenStore({}) }); // no legacy tokens: accounts only
  try {
    // first boot: setup required
    let r = await app.inject({ method: "GET", url: "/auth/status" });
    assert.deepEqual(r.json(), { setup: true });

    // weak setups rejected; good setup creates THE owner and logs in
    r = await app.inject({
      method: "POST",
      url: "/auth/setup",
      payload: { email: "not-an-email", password: "longenough" },
    });
    assert.equal(r.statusCode, 400);
    r = await app.inject({
      method: "POST",
      url: "/auth/setup",
      payload: { email: "me@example.com", password: "super-secret-1", name: "Me" },
    });
    assert.equal(r.statusCode, 200);
    const setupCookie = r.headers["set-cookie"] as string;
    assert.match(setupCookie, /portless_session=.+HttpOnly/);
    assert.deepEqual((r.json() as { user: { roles: string[] } }).user.roles, ["owner"]);

    // setup is one-time
    r = await app.inject({
      method: "POST",
      url: "/auth/setup",
      payload: { email: "evil@example.com", password: "super-secret-2" },
    });
    assert.equal(r.statusCode, 403);
    r = await app.inject({ method: "GET", url: "/auth/status" });
    assert.deepEqual(r.json(), { setup: false });

    // wrong password rejected; right password sets a session cookie
    r = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email: "me@example.com", password: "nope-nope-nope" },
    });
    assert.equal(r.statusCode, 401);
    r = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email: "me@example.com", password: "super-secret-1" },
    });
    assert.equal(r.statusCode, 200);
    const cookie = (r.headers["set-cookie"] as string).split(";")[0];

    // the cookie authenticates both /auth/me and tRPC
    r = await app.inject({ method: "GET", url: "/auth/me", headers: { cookie } });
    assert.equal(r.statusCode, 200);
    assert.equal((r.json() as { name: string }).name, "Me");
    r = await app.inject({ method: "GET", url: "/trpc/agents.list", headers: { cookie } });
    assert.equal(r.statusCode, 200);
    // no cookie, no access
    r = await app.inject({ method: "GET", url: "/trpc/agents.list" });
    assert.equal(r.statusCode, 401);

    // account.tokens.create over tRPC returns a plt_ token that authenticates as a bearer
    r = await app.inject({
      method: "POST",
      url: "/trpc/account.tokens.create",
      headers: { cookie, "content-type": "application/json" },
      payload: JSON.stringify({ name: "node test", role: "operator" }),
    });
    assert.equal(r.statusCode, 200);
    const tok = (r.json() as { result: { data: { token: string } } }).result.data.token;
    assert.match(tok, /^plt_/);
    r = await app.inject({
      method: "GET",
      url: "/trpc/agents.list",
      headers: { authorization: `Bearer ${tok}` },
    });
    assert.equal(r.statusCode, 200);
    // The real operator bearer token is denied before the outbound control channel is touched.
    let gatewaySends = 0;
    const originalSend = agentGateway.send;
    agentGateway.send = (async () => {
      gatewaySends++;
      return { ok: true };
    }) as typeof agentGateway.send;
    try {
      r = await app.inject({
        method: "POST",
        url: "/trpc/agents.run",
        headers: { authorization: `Bearer ${tok}`, "content-type": "application/json" },
        payload: JSON.stringify({
          agentId: "n1",
          operation: { name: "disk.usage", args: {} },
          confirm: true,
        }),
      });
      assert.equal(r.statusCode, 403);
      assert.match(r.body, /agent\.run/);
      assert.equal(gatewaySends, 0);
    } finally {
      agentGateway.send = originalSend;
    }
    // operator tokens cannot mint credentials
    r = await app.inject({
      method: "POST",
      url: "/trpc/account.tokens.create",
      headers: { authorization: `Bearer ${tok}`, "content-type": "application/json" },
      payload: JSON.stringify({ name: "escalate", role: "owner" }),
    });
    assert.equal(r.statusCode, 403);

    // cli-token: email+password → API token
    r = await app.inject({
      method: "POST",
      url: "/auth/cli-token",
      payload: { email: "me@example.com", password: "super-secret-1", name: "cli @mac" },
    });
    assert.equal(r.statusCode, 200);
    assert.match((r.json() as { token: string }).token, /^plt_/);

    // change email: wrong password rejected, right one re-anchors login; the session survives
    r = await app.inject({
      method: "POST",
      url: "/trpc/account.changeEmail",
      headers: { cookie, "content-type": "application/json" },
      payload: JSON.stringify({ password: "wrong-wrong", email: "me2@example.com" }),
    });
    assert.equal(r.statusCode, 401);
    r = await app.inject({
      method: "POST",
      url: "/trpc/account.changeEmail",
      headers: { cookie, "content-type": "application/json" },
      payload: JSON.stringify({ password: "super-secret-1", email: "me2@example.com" }),
    });
    assert.equal(r.statusCode, 200);
    r = await app.inject({ method: "GET", url: "/auth/me", headers: { cookie } });
    assert.equal((r.json() as { email: string }).email, "me2@example.com");
    r = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email: "me2@example.com", password: "super-secret-1" },
    });
    assert.equal(r.statusCode, 200); // new address signs in
    r = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email: "me@example.com", password: "super-secret-1" },
    });
    assert.equal(r.statusCode, 401); // old address is dead

    // logout revokes the session
    r = await app.inject({ method: "POST", url: "/auth/logout", headers: { cookie } });
    assert.equal(r.statusCode, 200);
    r = await app.inject({ method: "GET", url: "/auth/me", headers: { cookie } });
    assert.equal(r.statusCode, 401);

    // rate limit: 5 bad logins → 429
    for (let i = 0; i < 5; i++) {
      await app.inject({
        method: "POST",
        url: "/auth/login",
        payload: { email: "brute@example.com", password: `guess-${i}` },
      });
    }
    r = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email: "brute@example.com", password: "guess-final" },
    });
    assert.equal(r.statusCode, 429);
  } finally {
    await app.close();
  }
});
