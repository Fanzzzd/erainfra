import { convexTest } from "convex-test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { generateKeyPairSync, createPublicKey, verify } from "node:crypto";
import {
  GITHUB_REQUEST_TIMEOUT_MS,
  appJwt,
  mintInstallationToken,
} from "../convex/controllerGithubToken";
import { internal } from "../convex/_generated/api";
import schema from "../convex/schema";
import {
  CONTRACT,
  NOW,
  insertProfile,
  insertMachine,
  insertReadiness,
} from "./support/fleetFixture";

const modules = import.meta.glob("../convex/**/*.ts");
let privateKey: string;
let pkcs8: string;
beforeAll(() => {
  const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
  privateKey = pair.privateKey.export({ format: "pem", type: "pkcs1" }).toString();
  pkcs8 = pair.privateKey.export({ format: "pem", type: "pkcs8" }).toString();
});
// The fixture's rows are dated around NOW, and the lease reads Date.now() to judge whether a
// Worker is still online. Freeze Date at NOW so the test does not depend on the wall clock. Only
// Date is faked: the stall test needs real timers to fire its abort.
beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function mockGitHub() {
  return vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input);
    expect(new Headers(init?.headers).get("Authorization")).toMatch(/^Bearer eyJ/);
    if (url.endsWith("/installation")) return Response.json({ id: 42 });
    if (url.endsWith("/access_tokens"))
      return Response.json(
        { token: "ghs_short-lived", expires_at: new Date(NOW + 3_600_000).toISOString() },
        { status: 201 },
      );
    throw new Error(`unexpected request ${url}`);
  });
}
function mint(url: string, cacheFacts = false) {
  const fetch = mockGitHub();
  return {
    fetch,
    result: mintInstallationToken({
      clientId: "Iv1.controller",
      privateKey,
      githubConfigUrl: url,
      cacheFacts,
      now: NOW,
      fetch,
    }),
  };
}

describe("server-side installation tokens", () => {
  it("signs a verified App JWT with both GitHub's PKCS#1 and PKCS#8 keys, never returns the key", async () => {
    for (const key of [privateKey, pkcs8, privateKey.replace(/\n/g, "\\n")]) {
      const jwt = await appJwt("Iv1.controller", key, NOW);
      const [header, claims, signature] = jwt.split(".");
      expect(
        verify(
          "RSA-SHA256",
          Buffer.from(`${header}.${claims}`),
          createPublicKey(privateKey),
          Buffer.from(signature, "base64url"),
        ),
      ).toBe(true);
      expect(JSON.parse(Buffer.from(claims, "base64url").toString())).toEqual({
        iss: "Iv1.controller",
        iat: NOW / 1000 - 60,
        exp: NOW / 1000 + 540,
      });
      expect(jwt).not.toContain("PRIVATE KEY");
    }
  });
  it("narrows a repository token to exactly that repository and Administration write", async () => {
    const { fetch, result } = mint("https://github.com/acme/widgets");
    expect(await result).toEqual({
      ok: true,
      token: "ghs_short-lived",
      expiresAt: NOW + 3_600_000,
    });
    expect(fetch.mock.calls[0][0]).toBe("https://api.github.com/repos/acme/widgets/installation");
    expect(JSON.parse(String(fetch.mock.calls[1][1]?.body))).toEqual({
      repositories: ["widgets"],
      permissions: { administration: "write" },
    });
  });
  it("requests only Self-hosted runners write at organization scope", async () => {
    const { fetch, result } = mint("https://github.com/acme");
    expect((await result).ok).toBe(true);
    expect(fetch.mock.calls[0][0]).toBe("https://api.github.com/orgs/acme/installation");
    expect(JSON.parse(String(fetch.mock.calls[1][1]?.body))).toEqual({
      permissions: { organization_self_hosted_runners: "write" },
    });
  });
  it("adds the three cache-facts read permissions only when requested", async () => {
    const { fetch, result } = mint("https://github.com/acme/widgets", true);
    expect((await result).ok).toBe(true);
    expect(JSON.parse(String(fetch.mock.calls[1][1]?.body))).toEqual({
      repositories: ["widgets"],
      permissions: { administration: "write", actions: "read", metadata: "read", contents: "read" },
    });
  });
  it("uses the GHES REST base and refuses enterprise runner scope without making any GitHub calls", async () => {
    const ghes = mint("https://ghes.example/acme/widgets");
    expect((await ghes.result).ok).toBe(true);
    expect(ghes.fetch.mock.calls[0][0]).toBe(
      "https://ghes.example/api/v3/repos/acme/widgets/installation",
    );
    const enterprise = mint("https://github.com/enterprises/acme");
    expect(await enterprise.result).toMatchObject({ ok: false, status: 422 });
    expect(enterprise.fetch).not.toHaveBeenCalled();
  });
  it("bounds each GitHub call, so a stalled GitHub ends in 504 rather than an open request", async () => {
    for (const stallAt of ["/installation", "/access_tokens"]) {
      const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
        if (!String(input).endsWith(stallAt)) return Response.json({ id: 42 });
        // Never answers: only the abort signal ends this request.
        return await new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        });
      });
      const started = performance.now();
      const result = await mintInstallationToken({
        clientId: "Iv1.controller",
        privateKey,
        githubConfigUrl: "https://github.com/acme/widgets",
        cacheFacts: false,
        now: NOW,
        fetch,
        timeoutMs: 50,
      });
      expect(result, stallAt).toMatchObject({ ok: false, status: 504 });
      expect(performance.now() - started).toBeLessThan(2_000);
      expect(JSON.stringify(result)).not.toContain("eyJ");
    }
    expect(GITHUB_REQUEST_TIMEOUT_MS).toBe(10_000);
  });

  it("fails closed on an invalid key or GitHub refusing the requested permissions", async () => {
    const fetch = mockGitHub();
    expect(
      await mintInstallationToken({
        clientId: "x",
        privateKey: "bad",
        githubConfigUrl: "https://github.com/acme/widgets",
        cacheFacts: false,
        now: NOW,
        fetch,
      }),
    ).toMatchObject({ ok: false, status: 503 });
    expect(fetch).not.toHaveBeenCalled();
    fetch.mockImplementation(async () =>
      Response.json({ message: "permission denied" }, { status: 403 }),
    );
    const response = await mintInstallationToken({
      clientId: "x",
      privateKey,
      githubConfigUrl: "https://github.com/acme/widgets",
      cacheFacts: false,
      now: NOW,
      fetch,
    });
    expect(response).toMatchObject({ ok: false, status: 502 });
    expect(JSON.stringify(response)).not.toContain(privateKey);
  });
  it("returns an installation token through HTTP only while the machine holds the lease", async () => {
    vi.stubEnv("CONTROLLER_TOKEN", "dedicated");
    vi.stubEnv("CONTROLLER_GITHUB_APP_CLIENT_ID", "Iv1.controller");
    vi.stubEnv("CONTROLLER_GITHUB_APP_PRIVATE_KEY", privateKey);
    const fetch = mockGitHub();
    vi.stubGlobal("fetch", fetch);
    const t = convexTest(schema, modules);
    const token = "0123456789abcdef0123456789abcdef";
    await insertProfile(t, { githubConfigUrl: "https://github.com/acme/widgets" });
    const machine = await insertMachine(t, "worker", { token });
    await insertReadiness(t, machine);
    const request = (epoch?: number) =>
      t.fetch("/controller/github-token", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          ...(epoch === undefined ? {} : { "X-EraInfra-Lease-Epoch": String(epoch) }),
        },
        body: JSON.stringify({ profile: CONTRACT.profile, cacheFacts: true }),
      });
    expect((await request()).status).toBe(412);
    expect(fetch).not.toHaveBeenCalled();
    const grant = await t.mutation(internal.controllerLease.acquire, {
      profile: CONTRACT.profile,
      hostname: "worker",
      instance: "instance-worker",
      caller: { kind: "machine", token },
    });
    if (!grant.granted) throw new Error("expected grant");
    const response = await request(grant.epoch);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ token: "ghs_short-lived", expiresAt: NOW + 3_600_000 });
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    // The Worker requested cache reads, but the registered Profile did not allow them.
    expect(JSON.parse(String(fetch.mock.calls[1][1]?.body))).toEqual({
      repositories: ["widgets"],
      permissions: { administration: "write" },
    });
    // Lose the lease while GitHub is minting. The second check must withhold the token.
    fetch.mockImplementation(async (input) => {
      if (String(input).endsWith("/installation")) return Response.json({ id: 42 });
      await t.run(async (ctx) => {
        const lease = await ctx.db.query("controllerLeases").first();
        await ctx.db.patch(lease!._id, { epoch: grant.epoch + 1, holder: undefined });
      });
      return Response.json(
        { token: "must-not-be-delivered", expires_at: new Date(NOW + 3_600_000).toISOString() },
        { status: 201 },
      );
    });
    const raced = await request(grant.epoch);
    expect(raced.status).toBe(412);
    expect(await raced.text()).not.toContain("must-not-be-delivered");
    const count = fetch.mock.calls.length;
    expect((await request(grant.epoch)).status).toBe(412);
    expect(fetch).toHaveBeenCalledTimes(count);
  });
});
