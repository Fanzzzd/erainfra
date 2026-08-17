import test from "node:test";
import assert from "node:assert/strict";
import { AgentGateway } from "../src/runtime/agents.ts";
import { DataGateway } from "../src/runtime/dataplane.ts";

function fakeSocket() {
  return {
    sent: [] as string[],
    closed: false,
    send(d: string) {
      this.sent.push(d);
    },
    close() {
      this.closed = true;
    },
  };
}

test("AgentGateway.reapStale drops a silent agent and fires the disconnect (failover trigger)", () => {
  const gw = new AgentGateway();
  const s = fakeSocket();
  const lost: string[] = [];
  gw.onDisconnect((id) => lost.push(id));
  gw.onMessage(s, JSON.stringify({ type: "hello", agentId: "nodeA" }));
  assert.ok(gw.get("nodeA"), "registered");

  gw.reapStale(60_000); // just connected → not stale
  assert.ok(gw.get("nodeA"), "fresh agent kept");
  assert.equal(lost.length, 0);

  gw.reapStale(-1); // everything older than -1ms → stale
  assert.equal(gw.get("nodeA"), undefined, "silent agent reaped");
  assert.ok(s.closed, "socket closed");
  assert.deepEqual(lost, ["nodeA"], "disconnect fired exactly once → failover runs");
});

test("AgentGateway: a heartbeat frame keeps an agent alive", () => {
  const gw = new AgentGateway();
  const s = fakeSocket();
  gw.onMessage(s, JSON.stringify({ type: "hello", agentId: "n" }));
  gw.onMessage(s, JSON.stringify({ type: "heartbeat" })); // refreshes lastSeen
  gw.reapStale(60_000);
  assert.ok(gw.get("n"), "recently-heartbeated agent not reaped");
});

test("DataGateway.onClose rejects only the disconnecting node's in-flight requests (not every node)", async () => {
  const gw = new DataGateway();
  const a = fakeSocket();
  const b = fakeSocket();
  gw.onMessage(a, JSON.stringify({ type: "hello", agentId: "A" }));
  gw.onMessage(b, JSON.stringify({ type: "hello", agentId: "B" }));

  const reqA = gw.proxy("A", "appA", {
    method: "GET",
    path: "/",
    headers: {},
    body: Buffer.alloc(0),
  });
  const reqB = gw.proxy("B", "appB", {
    method: "GET",
    path: "/",
    headers: {},
    body: Buffer.alloc(0),
  });

  gw.onClose(a); // A disconnects — B's request must survive
  await assert.rejects(reqA, /node disconnected/);
  // B still pending: resolve it to prove it wasn't wrongly rejected
  const idB = JSON.parse(b.sent[0]).id;
  gw.onMessage(b, JSON.stringify({ type: "resp", id: idB, status: 200, headers: {}, body: "" }));
  const resB = await reqB;
  assert.equal(resB.status, 200);
});

test("DataGateway.reapStale drops a silent data socket", () => {
  const gw = new DataGateway();
  const s = fakeSocket();
  gw.onMessage(s, JSON.stringify({ type: "hello", agentId: "d" }));
  assert.ok(gw.isConnected("d"));
  gw.reapStale(60_000);
  assert.ok(gw.isConnected("d"), "fresh kept");
  gw.reapStale(-1);
  assert.equal(gw.isConnected("d"), false, "silent data socket reaped");
  assert.ok(s.closed);
});
