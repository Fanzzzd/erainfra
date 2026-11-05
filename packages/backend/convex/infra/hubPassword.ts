// Verifies passwords hashed by the Hub, so an account the importer brought over signs in with the
// password it already had instead of needing a reset.
//
// The Hub stores `scrypt$N$r$p$<salt base64>$<hash base64>` (apps/hub/src/runtime/users.ts,
// node:crypto scrypt, N=2^15 r=8 p=1). Convex Auth's own hashes are Lucia's `<salt>:<key>` form.
// The prefix tells them apart. The cost is the same: both need 128 * N * r = 32 MiB.
//
// The scrypt here is the one Convex Auth's default hasher already runs (Lucia's, a port of
// @noble/hashes), imported from its file because Lucia does not export it.
import { scrypt } from "lucia/dist/scrypt/index.js";

export const HUB_HASH_PREFIX = "scrypt$";

export function isHubPasswordHash(stored: string) {
  return stored.startsWith(HUB_HASH_PREFIX);
}

/** Bounds on the parameters a stored hash may ask for, so a corrupt row cannot exhaust memory. */
const MAX_N = 2 ** 17;
const MAX_R = 16;
const MAX_P = 4;

function fromBase64(text: string) {
  return Uint8Array.from(atob(text), (char) => char.codePointAt(0)!);
}

export async function verifyHubPassword(password: string, stored: string) {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, nText, rText, pText, saltB64, hashB64] = parts;
  const N = Number(nText);
  const r = Number(rText);
  const p = Number(pText);
  if (![N, r, p].every(Number.isInteger) || N < 2 || N > MAX_N || (N & (N - 1)) !== 0) {
    return false;
  }
  if (r < 1 || r > MAX_R || p < 1 || p > MAX_P) return false;
  const expected = fromBase64(hashB64);
  // Node's scrypt takes the password as UTF-8 without normalization, so neither does this.
  const actual = await scrypt(new TextEncoder().encode(password), fromBase64(saltB64), {
    N,
    r,
    p,
    dkLen: expected.length,
    maxmem: 128 * N * r * 2,
  });
  if (actual.length !== expected.length) return false;
  let difference = 0;
  for (let i = 0; i < actual.length; i += 1) difference |= actual[i] ^ expected[i];
  return difference === 0;
}
