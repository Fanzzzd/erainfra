// Agent-restart amnesia: the agent's app->port registry is in-memory, so a restart turns every
// route on that node into 502s while the containers still run. The hub must re-push registrations
// on every agent hello.
import test from "node:test";
import assert from "node:assert/strict";
import { installServeRehydrator } from "../src/runtime/appdeploy.ts";
import { routeStore } from "../src/runtime/routes.ts";

test("serve rehydrator: on agent connect, pushes that node's routes only", async () => {
  routeStore.set("shop", { node: "node-a", image: "shop:1", port: 62001 });
  routeStore.set("blog", { node: "node-b", image: "blog:1", port: 62002 });

  const sent: Array<{ agent: string; cmd: Record<string, unknown> }> = [];
  // No placeholder: if installServeRehydrator() never calls onConnect, calling this should throw
  // rather than silently no-op and leave the assertion below looking at an empty `sent`.
  let fire!: (id: string) => void;
  installServeRehydrator({
    onConnect: (cb) => {
      fire = cb;
    },
    send: async (agent: string, cmd: Record<string, unknown>) => {
      sent.push({ agent, cmd });
      return { ok: true };
    },
    list: () => [],
  });

  fire("node-a");
  await new Promise((r) => setTimeout(r, 10)); // sends are fire-and-forget
  assert.deepEqual(sent, [{ agent: "node-a", cmd: { cmd: "serve", app: "shop", port: 62001 } }]);
});
