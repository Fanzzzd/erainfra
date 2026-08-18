/**
 * The control plane's half of the job cache's bearer token.
 *
 * `apps/cache-service/cachetoken` is the other half, and the two are the same
 * wire format written twice: the service verifies in Go, and this deployment --
 * which is where a job first becomes a repository, a ref and an event -- mints
 * in TypeScript. Neither can import the other, so the format is pinned by
 * `apps/cache-service/cachetoken/testdata/vectors.json`, which both read.
 *
 * The format is
 *
 *     erainfra-cache-v1.<base64url(payload)>.<base64url(HMAC-SHA256(key, prefix + "." + payload))>
 *
 * with no padding on either segment, and the payload is the claim set encoded
 * exactly as Go's `encoding/json` encodes the `Claims` struct: fields in
 * declaration order, empty optionals omitted, and `<`, `>` and `&` escaped.
 * That last detail is not decoration. `JSON.stringify` leaves those three
 * characters alone and Go escapes them, so a branch named `a&b` is where two
 * implementations that agree on everything else stop producing the same bytes
 * -- and a signature over different bytes is a token the service rejects with
 * no clue as to why. `vectors.json` carries that exact case.
 *
 * ADR 0007's security contract, rule 2, is why `decideClaims` starts at read:
 * write has to prove itself from the event and the head repository, and
 * anything unproven is a read token.
 */

/** Versions the wire format. A future layout is rejected, not misparsed. */
export const CACHE_TOKEN_PREFIX = "erainfra-cache-v1";

/** The shortest shared secret this accepts. HMAC tolerates shorter; an
 * operator who pasted one has not built a secret. */
export const MIN_SIGNING_KEY_BYTES = 32;

export const PERMISSION_READ = "read";
export const PERMISSION_READ_WRITE = "read-write";

/** Clock skew the verifier absorbs, matching the Go verifier's default. */
export const DEFAULT_LEEWAY_SECONDS = 30;

export type CachePermission = typeof PERMISSION_READ | typeof PERMISSION_READ_WRITE;

/** What the service gets to know about a job. Every field is minted here; none
 * of it is copied from a request the job made. */
export type CacheTokenClaims = {
  /** "owner/name", stable across Attempts -- rule 1 turns on that stability,
   * because a per-Attempt prefix would never hit. */
  repository: string;
  /** The scope a save lands in, and the first scope a restore looks in. */
  ref: string;
  /** The second and third read scopes. A fork pull request arrives with `ref`
   * already collapsed to the base and `baseRef` empty, so it has no scope of
   * its own to read from or to write to. */
  baseRef?: string;
  defaultBranch?: string;
  permission: CachePermission;
  /** Carried for logs. Nothing is scoped by it. */
  attempt?: string;
  iat: number;
  exp: number;
};

/** What the control plane knows once GitHub has told it what a job is. */
export type CacheJobFacts = {
  /** For a pull request this is the BASE repository, which is the one whose
   * cache is at stake. */
  repository: string;
  /** Where the code that will run comes from. Owed for every event that has
   * one, not only for pull requests: `issue_comment` and `workflow_run` both
   * carry fork code into the base repository. */
  headRepository?: string;
  event?: string;
  ref: string;
  baseRef?: string;
  defaultBranch?: string;
  attempt?: string;
};

export type CacheTokenFailure = "malformed" | "signature" | "expired" | "no-repository";

export class CacheTokenError extends Error {
  readonly reason: CacheTokenFailure;

  constructor(reason: CacheTokenFailure, message: string) {
    super(message);
    this.name = "CacheTokenError";
    this.reason = reason;
  }
}

// One side of "owner/name". GitHub's own rules are narrower; the point is that
// a claim which cannot become a safe object-key segment is refused at the door
// rather than escaped downstream.
const REPOSITORY_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * The events on which an unknown head repository is treated as a foreign one.
 * Deliberately not the whole fork test -- a head repository that differs denies
 * write on any event at all -- because a list of event names is exactly the
 * thing that goes stale.
 */
const PULL_REQUEST_EVENTS = new Set([
  "pull_request",
  "pull_request_target",
  "pull_request_review",
  "pull_request_review_comment",
]);

export function validateRepository(repository: string): void {
  if (repository.length === 0) {
    throw new CacheTokenError("no-repository", "cache token carries no repository claim");
  }
  const slash = repository.indexOf("/");
  const owner = slash < 0 ? "" : repository.slice(0, slash);
  const name = slash < 0 ? "" : repository.slice(slash + 1);
  if (
    slash < 0 ||
    !REPOSITORY_SEGMENT.test(owner) ||
    !REPOSITORY_SEGMENT.test(name)
  ) {
    throw new CacheTokenError(
      "no-repository",
      `cache token carries no repository claim: ${JSON.stringify(repository)} is not owner/name`,
    );
  }
}

/** Anything that is not exactly read-write is read, everywhere. */
export function canWrite(claims: CacheTokenClaims): boolean {
  return claims.permission === PERMISSION_READ_WRITE;
}

/**
 * The ordered refs a restore may match in: own ref, then base ref, then default
 * branch, deduplicated and with empties dropped. ADR 0007 rule 3 lives here --
 * a sibling feature branch is not on the list, so it cannot be read no matter
 * what a request asks for.
 */
export function readScopes(claims: CacheTokenClaims): string[] {
  const scopes: string[] = [];
  for (const ref of [claims.ref, claims.baseRef ?? "", claims.defaultBranch ?? ""]) {
    if (ref.length > 0 && !scopes.includes(ref)) {
      scopes.push(ref);
    }
  }
  return scopes;
}

/** The single ref a save lands in. Never the base ref, never the default
 * branch: a job may only add to its own scope. */
export function writeScope(claims: CacheTokenClaims): string {
  return claims.ref;
}

/**
 * Turn what the control plane learned into a claim set, without signing it.
 * Separate from `issueCacheToken` so the write decision can be read, tested and
 * logged on its own -- it is the whole of rule 2 and it is four lines.
 */
export function decideClaims(
  facts: CacheJobFacts,
  nowSeconds: number,
  ttlSeconds: number,
): CacheTokenClaims {
  const repository = facts.repository.trim();
  validateRepository(repository);
  const ref = facts.ref.trim();
  if (ref.length === 0) {
    throw new CacheTokenError("malformed", "cache token needs a ref");
  }
  if (!Number.isSafeInteger(nowSeconds) || !Number.isSafeInteger(ttlSeconds) || ttlSeconds <= 0) {
    throw new CacheTokenError("malformed", "cache token needs an integer clock and a positive TTL");
  }

  const claims: CacheTokenClaims = {
    repository,
    ref,
    baseRef: facts.baseRef?.trim() ?? "",
    defaultBranch: facts.defaultBranch?.trim() ?? "",
    permission: PERMISSION_READ,
    attempt: facts.attempt?.trim() ?? "",
    iat: nowSeconds,
    exp: nowSeconds + ttlSeconds,
  };

  // Rule 2. The question is never "is this a fork?" in the abstract, it is
  // "will this job run code the repository does not control?", and there are
  // two ways for the answer to be yes: a head repository that is not this
  // repository, whatever the event; and a pull request whose head repository
  // the control plane could not name, because on a pull request "unknown" means
  // the fact that decides this was not measured.
  const event = (facts.event ?? "").trim().toLowerCase();
  const head = (facts.headRepository ?? "").trim();
  const untrusted =
    (head.length > 0 && head.toLowerCase() !== repository.toLowerCase()) ||
    (PULL_REQUEST_EVENTS.has(event) && head.length === 0);

  if (untrusted) {
    // An untrusted job reads the base branch's entries and has no scope of its
    // own. Collapsing the ref here rather than special-casing the service means
    // there is one place where such a job's scope is decided; with neither a
    // base ref nor a default branch it is left with no readable scope at all
    // rather than with its own.
    const base = claims.baseRef!.length > 0 ? claims.baseRef! : claims.defaultBranch!;
    claims.ref = base;
    claims.baseRef = "";
  } else if (event.length > 0) {
    claims.permission = PERMISSION_READ_WRITE;
  }

  return claims;
}

export async function issueCacheToken(
  signingKey: Uint8Array,
  ttlSeconds: number,
  facts: CacheJobFacts,
  nowMs: number,
): Promise<{ token: string; claims: CacheTokenClaims }> {
  requireKey(signingKey);
  const claims = decideClaims(facts, Math.floor(nowMs / 1000), ttlSeconds);
  const signed = `${CACHE_TOKEN_PREFIX}.${base64UrlEncode(utf8(encodeClaims(claims)))}`;
  const mac = await macOf(signingKey, signed);
  return { token: `${signed}.${base64UrlEncode(mac)}`, claims };
}

/**
 * Authenticate a token and return its claims. Every failure is a distinct
 * `reason`, so a caller can log which rule rejected a token without telling the
 * holder, and a token that verifies but carries no repository claim fails here
 * rather than being defaulted to something (rule 1).
 */
export async function verifyCacheToken(
  signingKey: Uint8Array,
  token: string,
  nowMs: number,
  leewaySeconds: number = DEFAULT_LEEWAY_SECONDS,
): Promise<CacheTokenClaims> {
  requireKey(signingKey);
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== CACHE_TOKEN_PREFIX) {
    throw new CacheTokenError("malformed", "cache token is malformed");
  }
  let payload: Uint8Array;
  let mac: Uint8Array;
  try {
    payload = base64UrlDecode(parts[1]!);
    mac = base64UrlDecode(parts[2]!);
  } catch {
    throw new CacheTokenError("malformed", "cache token is malformed");
  }
  const expected = await macOf(signingKey, `${parts[0]}.${parts[1]}`);
  if (!equalBytes(mac, expected)) {
    throw new CacheTokenError("signature", "cache token signature does not verify");
  }

  const claims = decodeClaims(payload);
  validateRepository(claims.repository);
  const now = Math.floor(nowMs / 1000);
  if (claims.exp === 0 || now - leewaySeconds > claims.exp) {
    throw new CacheTokenError("expired", "cache token has expired");
  }
  if (claims.permission !== PERMISSION_READ_WRITE) {
    claims.permission = PERMISSION_READ;
  }
  return claims;
}

function requireKey(signingKey: Uint8Array): void {
  if (signingKey.length < MIN_SIGNING_KEY_BYTES) {
    throw new CacheTokenError(
      "malformed",
      `cache signing key must be at least ${MIN_SIGNING_KEY_BYTES} bytes`,
    );
  }
}

function decodeClaims(payload: Uint8Array): CacheTokenClaims {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(payload));
  } catch {
    throw new CacheTokenError("malformed", "cache token is malformed");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new CacheTokenError("malformed", "cache token is malformed");
  }
  const fields = parsed as Record<string, unknown>;
  // Go refuses a payload whose fields have the wrong TYPE -- json.Unmarshal
  // fails and the whole token is malformed -- so a string where a number
  // belongs must not be coerced here either.
  const text = (name: string): string => {
    const value = fields[name];
    if (value === undefined) return "";
    if (typeof value !== "string") {
      throw new CacheTokenError("malformed", "cache token is malformed");
    }
    return value;
  };
  const number = (name: string): number => {
    const value = fields[name];
    if (value === undefined) return 0;
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new CacheTokenError("malformed", "cache token is malformed");
    }
    return value;
  };
  const permission = text("permission");
  return {
    repository: text("repository"),
    ref: text("ref"),
    baseRef: text("baseRef"),
    defaultBranch: text("defaultBranch"),
    permission: permission === PERMISSION_READ_WRITE ? PERMISSION_READ_WRITE : PERMISSION_READ,
    attempt: text("attempt"),
    iat: number("iat"),
    exp: number("exp"),
  };
}

/**
 * The claim set, byte for byte as Go's `encoding/json` writes the `Claims`
 * struct: declaration order, `omitempty` on the three optional strings, and
 * Go's HTML escaping. Written by hand rather than with `JSON.stringify`
 * because the signature is over these bytes and `JSON.stringify` differs from
 * Go on three characters.
 */
function encodeClaims(claims: CacheTokenClaims): string {
  const fields: string[] = [
    `"repository":${goString(claims.repository)}`,
    `"ref":${goString(claims.ref)}`,
  ];
  if ((claims.baseRef ?? "").length > 0) {
    fields.push(`"baseRef":${goString(claims.baseRef!)}`);
  }
  if ((claims.defaultBranch ?? "").length > 0) {
    fields.push(`"defaultBranch":${goString(claims.defaultBranch!)}`);
  }
  fields.push(`"permission":${goString(claims.permission)}`);
  if ((claims.attempt ?? "").length > 0) {
    fields.push(`"attempt":${goString(claims.attempt!)}`);
  }
  fields.push(`"iat":${goInteger(claims.iat)}`, `"exp":${goInteger(claims.exp)}`);
  return `{${fields.join(",")}}`;
}

function goInteger(value: number): string {
  if (!Number.isSafeInteger(value)) {
    throw new CacheTokenError("malformed", "cache token timestamps must be safe integers");
  }
  return String(value);
}

const HEX = "0123456789abcdef";

/**
 * A JSON string literal as Go writes one. The differences from
 * `JSON.stringify` are `<`, `>`, `&` (Go escapes all three by default),
 * U+2028 and U+2029 (Go escapes them, and so does modern JSON.stringify), and
 * unpaired surrogates, which Go writes as the six characters `�` because
 * they are not valid UTF-8 at all.
 */
function goString(value: string): string {
  let out = '"';
  for (const character of value) {
    const code = character.codePointAt(0)!;
    if (code >= 0xd800 && code <= 0xdfff) {
      out += "\\ufffd";
      continue;
    }
    switch (character) {
      case '"':
        out += '\\"';
        continue;
      case "\\":
        out += "\\\\";
        continue;
      case "\n":
        out += "\\n";
        continue;
      case "\r":
        out += "\\r";
        continue;
      case "\t":
        out += "\\t";
        continue;
      case "<":
        out += "\\u003c";
        continue;
      case ">":
        out += "\\u003e";
        continue;
      case "&":
        out += "\\u0026";
        continue;
      case " ":
        out += "\\u2028";
        continue;
      case " ":
        out += "\\u2029";
        continue;
      default:
        break;
    }
    if (code < 0x20) {
      out += `\\u00${HEX[(code >> 4) & 0xf]}${HEX[code & 0xf]}`;
      continue;
    }
    out += character;
  }
  return `${out}"`;
}

const BASE64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

function base64UrlEncode(bytes: Uint8Array): string {
  let out = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index]!;
    const second = bytes[index + 1];
    const third = bytes[index + 2];
    out += BASE64URL[first >> 2];
    if (second === undefined) {
      out += BASE64URL[(first & 0x03) << 4];
      break;
    }
    out += BASE64URL[((first & 0x03) << 4) | (second >> 4)];
    if (third === undefined) {
      out += BASE64URL[(second & 0x0f) << 2];
      break;
    }
    out += BASE64URL[((second & 0x0f) << 2) | (third >> 6)];
    out += BASE64URL[third & 0x3f];
  }
  return out;
}

function base64UrlDecode(text: string): Uint8Array {
  // Length 1 (mod 4) cannot be produced by any encoder, and Go's decoder
  // refuses it. Non-zero trailing bits are NOT refused, by Go or here: being
  // stricter than the other implementation would turn a signature failure into
  // a malformed one and the two ends would disagree about which rule fired.
  if (text.length % 4 === 1) {
    throw new Error("invalid base64url length");
  }
  const bytes = new Uint8Array(Math.floor((text.length * 6) / 8));
  let accumulator = 0;
  let bits = 0;
  let written = 0;
  for (const character of text) {
    const value = BASE64URL.indexOf(character);
    if (value < 0) {
      throw new Error("invalid base64url character");
    }
    accumulator = (accumulator << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes[written++] = (accumulator >> bits) & 0xff;
    }
  }
  return bytes.subarray(0, written);
}

function utf8(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

async function macOf(signingKey: Uint8Array, signed: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    signingKey as unknown as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, utf8(signed) as unknown as BufferSource));
}

/** Constant time in the length that matters: a compare that returns early
 * leaks how much of a forged MAC was right. */
function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) {
    return false;
  }
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left[index]! ^ right[index]!;
  }
  return difference === 0;
}
