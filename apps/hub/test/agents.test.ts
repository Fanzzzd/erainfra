import test from "node:test";
import assert from "node:assert/strict";
import { parseAgentMessage, AgentGateway, type AgentSocket } from "../src/runtime/agents.ts";

test("parseAgentMessage parses valid frames, rejects junk + typeless", () => {
  assert.deepEqual(parseAgentMessage('{"type":"hello","agentId":"a"}'), {
    type: "hello",
    agentId: "a",
  });
  assert.equal(parseAgentMessage("not json"), null);
  assert.equal(parseAgentMessage('{"no":"type"}'), null);
});

test("gateway registers an agent on hello and lists it", () => {
  const g = new AgentGateway();
  const sock: AgentSocket = { send: () => {}, close: () => {} };
  g.onMessage(
    sock,
    JSON.stringify({ type: "hello", agentId: "box1", version: "1.0", roles: ["relay"] }),
  );
  const list = g.list();
  assert.equal(list.length, 1);
  assert.equal(list[0].id, "box1");
  assert.equal(list[0].version, "1.0");
  // A placement role no rollout is touching, so this stays a test about registering. The retired
  // `worker` and its fold to `compute` are agent-roles.test.ts's subject.
  assert.deepEqual(list[0].roles, ["relay"]);
});

test("send dispatches a cmd and resolves on the matching reply", async () => {
  const g = new AgentGateway();
  const sent: string[] = [];
  const sock: AgentSocket = { send: (d) => sent.push(d), close: () => {} };
  g.onMessage(sock, JSON.stringify({ type: "hello", agentId: "box1" }));
  const p = g.send("box1", { cmd: "operate", operation: { name: "disk.usage", args: {} } });
  const cmd = JSON.parse(sent[0]);
  assert.equal(cmd.type, "cmd");
  assert.equal(cmd.cmd, "operate");
  assert.deepEqual(cmd.operation, { name: "disk.usage", args: {} });
  g.onMessage(sock, JSON.stringify({ type: "reply", id: cmd.id, ok: true, output: "hi" }));
  const reply = await p;
  assert.equal(reply.ok, true);
  assert.equal(reply.output, "hi");
});

test("send rejects when the agent is not connected", async () => {
  const g = new AgentGateway();
  await assert.rejects(() => g.send("ghost", { cmd: "ping" }), /not connected/);
});

test("onClose removes the agent", () => {
  const g = new AgentGateway();
  const sock: AgentSocket = { send: () => {}, close: () => {} };
  g.onMessage(sock, JSON.stringify({ type: "hello", agentId: "box1" }));
  assert.equal(g.list().length, 1);
  g.onClose(sock);
  assert.equal(g.list().length, 0);
});
