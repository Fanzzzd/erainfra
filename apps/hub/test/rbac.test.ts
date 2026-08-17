import test from "node:test";
import assert from "node:assert/strict";
import { can } from "../src/rbac.ts";

test("owner can do everything", () => {
  const owner = { roles: ["owner"] as const };
  assert.ok(can(owner, "agent.run"));
  assert.ok(can(owner, "app.deploy"));
  assert.ok(can(owner, "audit.read"));
});

test("viewer is read-only", () => {
  const viewer = { roles: ["viewer"] as const };
  assert.ok(can(viewer, "app.read"));
  assert.ok(!can(viewer, "app.deploy"));
  assert.ok(!can(viewer, "agent.run"));
});

test("operator can deploy but not run agents", () => {
  const operator = { roles: ["operator"] as const };
  assert.ok(can(operator, "app.deploy"));
  assert.ok(can(operator, "app.read"));
  assert.ok(!can(operator, "agent.run"));
});

test("agent.run is admin/owner only — an operator cannot run local AI CLIs", () => {
  assert.ok(!can({ roles: ["operator"] as const }, "agent.run")); // would let it read host secrets
  assert.ok(!can({ roles: ["viewer"] as const }, "agent.run"));
  assert.ok(can({ roles: ["admin"] as const }, "agent.run"));
  assert.ok(can({ roles: ["owner"] as const }, "agent.run")); // wildcard
});

test("multiple roles union their permissions", () => {
  const mixed = { roles: ["viewer", "operator"] as const };
  assert.ok(can(mixed, "app.deploy"));
  assert.ok(can(mixed, "app.read"));
});
