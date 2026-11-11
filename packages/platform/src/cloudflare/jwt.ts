// Verifies the RS256 JWTs Convex Auth issues, the way the Convex server does before it fills
// `ctx.auth.getUserIdentity()`. The keys come from the JWKS environment variable Convex Auth
// already uses; the issuer and audience come from the backend's auth.config.ts.

import type { Identity } from "../runtime/runtime.ts";

export type AuthProvider = { domain: string; applicationID: string };

type Jwk = Record<string, unknown> & { kid?: string };
type Key = Awaited<ReturnType<typeof crypto.subtle.importKey>>;

function base64UrlDecode(text: string): Uint8Array {
  const padded = text
    .replaceAll("-", "+")
    .replaceAll("_", "/")
    .padEnd(Math.ceil(text.length / 4) * 4, "=");
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
}

const decodeJson = (part: string): Record<string, unknown> =>
  JSON.parse(new TextDecoder().decode(base64UrlDecode(part))) as Record<string, unknown>;

export class JwtVerifier {
  private keys: Promise<Map<string | undefined, Key>>;

  constructor(
    jwks: string,
    private readonly providers: AuthProvider[],
    private readonly now: () => number = Date.now,
  ) {
    this.keys = (async () => {
      const set = JSON.parse(jwks) as { keys: Jwk[] };
      const out = new Map<string | undefined, Key>();
      for (const jwk of set.keys) {
        const key = await crypto.subtle.importKey(
          "jwk",
          jwk as never,
          { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
          false,
          ["verify"],
        );
        out.set(jwk.kid, key);
      }
      return out;
    })();
  }

  /** The identity a valid token carries, or null for a missing token; throws for a bad one. */
  async verify(token: string | null): Promise<Identity> {
    if (!token) return null;
    const parts = token.split(".");
    if (parts.length !== 3) throw new Error("Invalid JWT: not three parts");
    const [h, p, sig] = parts as [string, string, string];
    const header = decodeJson(h);
    if (header.alg !== "RS256") throw new Error(`Invalid JWT: algorithm ${String(header.alg)}`);
    const keys = await this.keys;
    const key =
      keys.get(header.kid as string | undefined) ??
      (keys.size === 1 ? [...keys.values()][0] : undefined);
    if (!key) throw new Error("Invalid JWT: unknown key");
    const ok = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      key,
      base64UrlDecode(sig),
      new TextEncoder().encode(`${h}.${p}`),
    );
    if (!ok) throw new Error("Invalid JWT: bad signature");
    const claims = decodeJson(p);
    const seconds = this.now() / 1000;
    if (typeof claims.exp === "number" && claims.exp < seconds)
      throw new Error("Invalid JWT: expired");
    if (typeof claims.nbf === "number" && claims.nbf > seconds + 60)
      throw new Error("Invalid JWT: not yet valid");
    const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    const provider = this.providers.find(
      (pr) =>
        pr.domain.replace(/\/$/, "") === String(claims.iss).replace(/\/$/, "") &&
        audiences.includes(pr.applicationID),
    );
    if (!provider) throw new Error("Invalid JWT: no auth provider matches its issuer and audience");
    const { iss, sub, aud: _aud, exp: _exp, iat: _iat, nbf: _nbf, ...rest } = claims;
    return {
      ...(rest as Record<string, string>),
      issuer: String(iss),
      subject: String(sub),
      tokenIdentifier: `${String(iss)}|${String(sub)}`,
    };
  }
}
