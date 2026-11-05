// Verifies the Hub's exact hash format (apps/hub/src/runtime/users.ts):
// `scrypt$32768$8$1$<16-byte salt base64>$<64-byte hash base64>`.
// Imported passwords use UTF-8 without normalization, as node:crypto scrypt does on the Hub.
import { scrypt } from "@noble/hashes/scrypt.js";

export const HUB_HASH_PREFIX = "scrypt$";

export function isHubPasswordHash(stored: string) {
  return stored.startsWith(HUB_HASH_PREFIX);
}

function decodeBase64(text: string, length: number) {
  try {
    const binary = atob(text);
    // Require the canonical encoding the Hub writes, not a truncated or oversized digest.
    if (binary.length !== length || btoa(binary) !== text) return null;
    return Uint8Array.from(binary, (char) => char.codePointAt(0)!);
  } catch {
    return null;
  }
}

/** Fixed-length comparison with no data-dependent early return. */
function constantTimeEqual(actual: Uint8Array, expected: Uint8Array) {
  let difference = 0;
  for (let i = 0; i < expected.length; i += 1) difference |= actual[i] ^ expected[i];
  return difference === 0;
}

export async function verifyHubPassword(password: string, stored: string) {
  const parts = stored.split("$");
  if (
    parts.length !== 6 ||
    parts[0] !== "scrypt" ||
    parts[1] !== "32768" ||
    parts[2] !== "8" ||
    parts[3] !== "1"
  ) {
    return false;
  }
  const salt = decodeBase64(parts[4], 16);
  const expected = decodeBase64(parts[5], 64);
  if (salt === null || expected === null) return false;
  // Sync scrypt avoids the timers scryptAsync uses to yield: Convex mutations have no timers.
  // Parameters and output size are fixed to the Hub's values, so a corrupt row cannot ask for
  // more memory or CPU. The Hub uses the same 32 MiB work factor.
  const actual = scrypt(new TextEncoder().encode(password), salt, {
    N: 2 ** 15,
    r: 8,
    p: 1,
    dkLen: 64,
    maxmem: 64 * 1024 * 1024,
  });
  return constantTimeEqual(actual, expected);
}
