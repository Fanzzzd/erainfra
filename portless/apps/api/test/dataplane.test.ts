import test from "node:test";
import assert from "node:assert/strict";
import { appFromHost, sanitizeRequestHeaders } from "../src/runtime/dataplane.ts";

test("appFromHost: exact-suffix match, single label, port-stripped, case-insensitive", () => {
  const D = "apps.example.com";
  assert.equal(appFromHost("myapp.apps.example.com", D), "myapp");
  assert.equal(appFromHost("myapp.apps.example.com:8080", D), "myapp"); // port stripped
  assert.equal(appFromHost("MyApp.Apps.Example.Com", D), "myapp"); // lowercased
  assert.equal(appFromHost("my-app-1.apps.example.com", D), "my-app-1");
  // not an app subdomain → null (falls through to normal hub routing)
  assert.equal(appFromHost("apps.example.com", D), null); // no label
  assert.equal(appFromHost("hub.example.com", D), null); // different domain
  assert.equal(appFromHost("evil.com", D), null);
  // spoofing: a host that only *contains* the domain must not match
  assert.equal(appFromHost("myapp.apps.example.com.evil.com", D), null);
  assert.equal(appFromHost("apps.example.com.evil.com", D), null);
  // multi-label subdomain rejected (label would contain a dot)
  assert.equal(appFromHost("a.b.apps.example.com", D), null);
  // bad label chars rejected
  assert.equal(appFromHost("my_app.apps.example.com", D), null);
  assert.equal(appFromHost("-bad.apps.example.com", D), null);
  // missing inputs
  assert.equal(appFromHost(undefined, D), null);
  assert.equal(appFromHost("x.apps.example.com", undefined), null);
});

test("sanitizeRequestHeaders: strips hop-by-hop + CRLF, sets X-Forwarded-*", () => {
  const out = sanitizeRequestHeaders(
    {
      "content-type": "application/json",
      connection: "keep-alive", // hop-by-hop → dropped
      upgrade: "websocket", // hop-by-hop → dropped
      "transfer-encoding": "chunked", // hop-by-hop → dropped
      "x-forwarded-for": "1.2.3.4", // client-supplied → dropped, we set our own
      "x-evil": "a\r\nInjected: yes", // CRLF injection → dropped
      "user-agent": "curl/8",
    },
    { host: "app.apps.example.com", clientIp: "9.9.9.9", proto: "https" },
  );
  assert.equal(out["content-type"], "application/json");
  assert.equal(out["user-agent"], "curl/8");
  assert.ok(!("connection" in out) && !("upgrade" in out) && !("transfer-encoding" in out));
  assert.ok(!("x-evil" in out)); // injection dropped
  assert.equal(out["X-Forwarded-For"], "9.9.9.9"); // ours, not the client's claim
  assert.equal(out["X-Forwarded-Host"], "app.apps.example.com");
  assert.equal(out["X-Forwarded-Proto"], "https");
});
