// The one check that fails if the MCP bridge breaks: spawn `portless mcp`, run the initialize
// handshake, list tools. No hub is contacted (both methods are served locally).
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "portless.mjs");

function mcpRoundtrip(messages) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, "mcp"], {
      env: { ...process.env, PORTLESS_HUB: "http://127.0.0.1:1", PORTLESS_TOKEN: "t" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const replies = [];
    let buf = "";
    child.stdout.on("data", (d) => {
      buf += d.toString();
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line.trim()) replies.push(JSON.parse(line));
        if (replies.length === messages.filter((m) => m.id !== undefined).length) {
          child.kill();
          resolve(replies);
        }
      }
    });
    child.on("error", reject);
    setTimeout(() => {
      child.kill();
      reject(new Error(`timed out; got ${replies.length} replies`));
    }, 10_000).unref();
    for (const m of messages) child.stdin.write(JSON.stringify(m) + "\n");
  });
}

test("mcp: initialize handshake + tools/list expose the platform surface", async () => {
  const [init, tools] = await mcpRoundtrip([
    {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {} },
    },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "tools/list" },
  ]);
  assert.equal(init.result.serverInfo.name, "portless");
  assert.ok(init.result.capabilities.tools);
  const names = tools.result.tools.map((t) => t.name);
  for (const want of [
    "portless_deploy",
    "portless_status",
    "portless_logs",
    "portless_env_set",
    "portless_remove",
  ]) {
    assert.ok(names.includes(want), `missing tool ${want}`);
  }
  // every tool must carry a JSON schema (Claude rejects tools without one)
  for (const t of tools.result.tools) assert.equal(t.inputSchema.type, "object");
});
