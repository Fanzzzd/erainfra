import test from "node:test";
import assert from "node:assert/strict";
import { createHmac, createVerify, generateKeyPairSync } from "node:crypto";
import { appJwt, verifyWebhook, parsePush, cloneUrl } from "../src/runtime/github.ts";

test("verifyWebhook accepts a correct HMAC and rejects tampering", () => {
  const secret = "s3cr3t";
  const body = JSON.stringify({ hello: "world" });
  const sig = "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
  assert.equal(verifyWebhook(secret, body, sig), true);
  assert.equal(verifyWebhook(secret, body, undefined), false);
  assert.equal(verifyWebhook(secret, body, "sha256=deadbeef"), false);
  assert.equal(verifyWebhook("wrong", body, sig), false);
  assert.equal(verifyWebhook(secret, body + "x", sig), false);
});

test("appJwt produces an RS256 JWT verifiable with the public key", () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = privateKey.export({ type: "pkcs1", format: "pem" }) as string;
  const now = 1_700_000_000;
  const jwt = appJwt("12345", pem, now);
  const [h, p, s] = jwt.split(".");
  assert.deepEqual(JSON.parse(Buffer.from(h, "base64url").toString()), {
    alg: "RS256",
    typ: "JWT",
  });
  const payload = JSON.parse(Buffer.from(p, "base64url").toString());
  assert.equal(payload.iss, "12345");
  assert.equal(payload.iat, now - 60);
  assert.equal(payload.exp, now + 540);
  const ok = createVerify("RSA-SHA256")
    .update(`${h}.${p}`)
    .verify(publicKey, Buffer.from(s, "base64url"));
  assert.equal(ok, true);
});

test("parsePush extracts repo/branch/sha and skips non-branch events", () => {
  const ev = parsePush({
    ref: "refs/heads/main",
    after: "abc123",
    repository: { full_name: "o/r" },
    installation: { id: 99 },
  });
  assert.deepEqual(ev, { repo: "o/r", branch: "main", sha: "abc123", installationId: 99 });
  assert.equal(parsePush({ ref: "refs/tags/v1", repository: { full_name: "o/r" } }), null); // tag push
  assert.equal(
    parsePush({ ref: "refs/heads/main", deleted: true, repository: { full_name: "o/r" } }),
    null,
  ); // branch delete
  assert.equal(parsePush({ nonsense: true }), null);
});

test("cloneUrl embeds a token only when given", () => {
  assert.equal(cloneUrl("o/r"), "https://github.com/o/r.git");
  assert.equal(cloneUrl("o/r", "tok"), "https://x-access-token:tok@github.com/o/r.git");
});
