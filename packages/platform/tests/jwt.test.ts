// The Cloudflare host's check of Convex Auth tokens: signature, expiry, issuer and audience.

import { describe, expect, test } from "vitest";

import { JwtVerifier } from "../src/cloudflare/jwt.ts";

const ISSUER = "https://cp.example";
const providers = [{ domain: ISSUER, applicationID: "convex" }];
const ALG = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" } as const;

const b64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
const part = (value: unknown) => b64url(new TextEncoder().encode(JSON.stringify(value)));

async function keyPair() {
  const pair = await crypto.subtle.generateKey(
    { ...ALG, modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) },
    true,
    ["sign", "verify"],
  );
  const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  return { privateKey: pair.privateKey, jwks: JSON.stringify({ keys: [{ ...jwk, kid: "k1" }] }) };
}

async function sign(
  privateKey: Awaited<ReturnType<typeof keyPair>>["privateKey"],
  claims: Record<string, unknown>,
) {
  const body = `${part({ alg: "RS256", kid: "k1" })}.${part(claims)}`;
  const sig = await crypto.subtle.sign(ALG, privateKey, new TextEncoder().encode(body));
  return `${body}.${b64url(new Uint8Array(sig))}`;
}

const now = 1_800_000_000_000;
const claims = { iss: ISSUER, sub: "user1|session1", aud: "convex", exp: now / 1000 + 3600 };

describe("JwtVerifier", () => {
  test("a valid token yields the identity Convex would build", async () => {
    const { privateKey, jwks } = await keyPair();
    const verifier = new JwtVerifier(jwks, providers, () => now);
    expect(await verifier.verify(await sign(privateKey, claims))).toEqual({
      issuer: ISSUER,
      subject: "user1|session1",
      tokenIdentifier: `${ISSUER}|user1|session1`,
    });
  });

  test("no token means no identity", async () => {
    const { jwks } = await keyPair();
    expect(await new JwtVerifier(jwks, providers).verify(null)).toBeNull();
  });

  test("rejects a token signed by another key", async () => {
    const { jwks } = await keyPair();
    const other = await keyPair();
    const verifier = new JwtVerifier(jwks, providers, () => now);
    await expect(verifier.verify(await sign(other.privateKey, claims))).rejects.toThrow(
      "bad signature",
    );
  });

  test("rejects an expired token", async () => {
    const { privateKey, jwks } = await keyPair();
    const verifier = new JwtVerifier(jwks, providers, () => now);
    const token = await sign(privateKey, { ...claims, exp: now / 1000 - 1 });
    await expect(verifier.verify(token)).rejects.toThrow("expired");
  });

  test("rejects a token for another issuer or audience", async () => {
    const { privateKey, jwks } = await keyPair();
    const verifier = new JwtVerifier(jwks, providers, () => now);
    for (const bad of [{ iss: "https://evil.example" }, { aud: "other" }]) {
      const token = await sign(privateKey, { ...claims, ...bad });
      await expect(verifier.verify(token)).rejects.toThrow("no auth provider");
    }
  });
});
