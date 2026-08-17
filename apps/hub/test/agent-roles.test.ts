import test from "node:test";
import assert from "node:assert/strict";
import {
  AgentGateway,
  normalizeAgentRoles,
  ROLE_COMPUTE,
  RETIRED_ROLE_WORKER,
  type AgentSocket,
} from "../src/runtime/agents.ts";
import { resetRenameWarnings } from "../src/env.ts";

// Stage 1 of moving the Infra Agent's PLACEMENT role off CONTEXT.md's `worker` (#64). A role crosses
// the WebSocket and the Hub holds it per connected agent, so the two sides move independently: the
// Hub learns both names first and folds them together, the agent switches a release later.
//
// The property this release rests on is the one below — every Infra Agent in the field today sends
// `worker`, and none of them will be updated on the day this deploys. If they stop being reachable
// under the right role, stage 1 has broken exactly the thing it exists to keep working.
//
// Four cases, because the fourth is the one that breaks silently:
//   retired only → folded to compute, warns   (every deployed agent, today)
//   new only     → compute, no warning        (stage 3 onward)
//   both         → ONE compute badge          (stage 2's window, and a rolling fleet)
//   neither      → untouched, and no warning  (no phantom role appears from nowhere)

// Capture console.warn without swallowing a real failure's output.
function withWarnings<T>(fn: () => T): { value: T; warnings: string[] } {
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => void warnings.push(args.map(String).join(" "));
  resetRenameWarnings();
  try {
    return { value: fn(), warnings };
  } finally {
    console.warn = original;
    resetRenameWarnings();
  }
}

// The property is about what an OPERATOR sees, so drive it the way a Node does: a real hello frame
// into a real gateway, read back through the same list() the Nodes page renders.
function helloWith(roles: unknown): string[] {
  const g = new AgentGateway();
  const sock: AgentSocket = { send: () => {}, close: () => {} };
  g.onMessage(sock, JSON.stringify({ type: "hello", agentId: "box1", version: "0.2.0", roles }));
  const listed = g.list();
  assert.equal(listed.length, 1, "the agent did not register at all");
  return listed[0]!.roles;
}

test("THE property: an agent still reporting the retired role appears under the right role", () => {
  const { value, warnings } = withWarnings(() => helloWith([RETIRED_ROLE_WORKER]));
  assert.deepEqual(
    value,
    [ROLE_COMPUTE],
    "an Infra Agent in the field today would show up with no usable role — this PR cannot deploy",
  );
  assert.equal(warnings.length, 1, "the retired role was accepted without saying it is retired");
  assert.match(warnings[0]!, /worker is a retired name/);
  assert.match(warnings[0]!, /compute/);
});

test("THE property, unpacked: the new role alone reports identically to the retired one alone", () => {
  const retired = withWarnings(() => helloWith([RETIRED_ROLE_WORKER]));
  const next = withWarnings(() => helloWith([ROLE_COMPUTE]));
  assert.deepEqual(
    retired.value,
    next.value,
    "the two names are supposed to be the same role, and an operator cannot tell which agent sent which",
  );
  assert.equal(next.warnings.length, 0, "the name we are moving TO warned as if it were retired");
});

test("both names at once is one role, not two badges", () => {
  const { value } = withWarnings(() => helloWith([RETIRED_ROLE_WORKER, ROLE_COMPUTE]));
  assert.deepEqual(value, [ROLE_COMPUTE]);
  // Order-independent: the fold happens before the dedupe either way round.
  const { value: reversed } = withWarnings(() => helloWith([ROLE_COMPUTE, RETIRED_ROLE_WORKER]));
  assert.deepEqual(reversed, [ROLE_COMPUTE]);
});

test("neither name: no role is invented, and nothing warns", () => {
  // The silent one. A Hub that filled in a default here would badge a Node with a placement nobody
  // claimed, and the Nodes page cannot tell an asserted role from a fabricated one.
  for (const roles of [[], undefined, null, "worker", 7]) {
    const { value, warnings } = withWarnings(() => helloWith(roles));
    assert.deepEqual(value, [], `roles=${JSON.stringify(roles) ?? "undefined"} produced a role`);
    assert.equal(warnings.length, 0, "warned about a retired role that was never reported");
  }
});

test("an element that is not a string is not a role", () => {
  // Coercing would let a malformed frame assert a placement nobody sent: `[["worker"]]` stringifies
  // to exactly `worker` and would be folded as if an agent had claimed it.
  const { value, warnings } = withWarnings(() =>
    helloWith([null, 7, ["worker"], { role: "worker" }, ["compute"], true]),
  );
  assert.deepEqual(value, []);
  assert.equal(warnings.length, 0, "a nested array was folded as if it were a reported role");
});

test("an unfamiliar role string crosses verbatim rather than being dropped", () => {
  // The forward direction of every stage of this rollout: a Hub that predates a placement role must
  // show an unfamiliar badge, not a missing one. An allowlist here would make stage 3 invisible on
  // any Hub that had not taken stage 1, which is the failure the four stages exist to prevent.
  const { value, warnings } = withWarnings(() => helloWith(["quarantine", ROLE_COMPUTE]));
  assert.deepEqual(value, ["quarantine", ROLE_COMPUTE]);
  assert.equal(warnings.length, 0);
});

test("the other three placement roles cross unchanged", () => {
  // Only `worker` collided with a machine kind. Renaming any of these would be its own rollout, and
  // `gateway` and `relay` are read by BuildInstallPlan, so they are behavioural, not display.
  const { value, warnings } = withWarnings(() => helloWith(["gateway", "database", "relay"]));
  assert.deepEqual(value, ["gateway", "database", "relay"]);
  assert.equal(warnings.length, 0);
});

test("no Node is ever rendered as CONTEXT.md's other machine kind", () => {
  // The bug, stated as an invariant: whatever an agent reports, what the Hub hands the Nodes page
  // never contains the word CONTEXT.md gives to a Worker — the machine kind running the OTHER daemon.
  for (const roles of [
    [RETIRED_ROLE_WORKER],
    [ROLE_COMPUTE],
    [RETIRED_ROLE_WORKER, ROLE_COMPUTE],
    ["gateway", RETIRED_ROLE_WORKER],
    [RETIRED_ROLE_WORKER, RETIRED_ROLE_WORKER],
  ]) {
    const { value } = withWarnings(() => helloWith(roles));
    assert.equal(
      value.includes(RETIRED_ROLE_WORKER),
      false,
      `${JSON.stringify(roles)} still reaches the Roles column as "${RETIRED_ROLE_WORKER}"`,
    );
  }
});

test("a fleet of retired agents warns once, not once per hello", () => {
  // `connect` re-dials forever and a Hub carries every Node in the deployment, so a warning tied to
  // a hello would grow without bound and train its operator to ignore the line.
  const { warnings } = withWarnings(() => {
    for (let i = 0; i < 20; i++) helloWith([RETIRED_ROLE_WORKER]);
  });
  assert.equal(warnings.length, 1);
});

test("normalizeAgentRoles is the whole surface: reconnect folds the same way as first connect", () => {
  // A reconnect replaces the entry through the same hello path, so a fold that lived at the call
  // site rather than in the parser would come back as `worker` on the second connection.
  const g = new AgentGateway();
  const first: AgentSocket = { send: () => {}, close: () => {} };
  const second: AgentSocket = { send: () => {}, close: () => {} };
  withWarnings(() => {
    g.onMessage(first, JSON.stringify({ type: "hello", agentId: "box1", roles: [ROLE_COMPUTE] }));
    g.onMessage(
      second,
      JSON.stringify({ type: "hello", agentId: "box1", roles: [RETIRED_ROLE_WORKER] }),
    );
  });
  assert.deepEqual(g.get("box1")?.roles, [ROLE_COMPUTE]);
  const { value } = withWarnings(() => normalizeAgentRoles([RETIRED_ROLE_WORKER]));
  assert.deepEqual(value, [ROLE_COMPUTE], "the exported fold disagrees with the hello path");
});
