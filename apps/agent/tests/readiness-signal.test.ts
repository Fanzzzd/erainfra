import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { clearReadinessSignal, publishReadinessSignal } from "../readiness-signal.ts";

describe("Agent readiness signal", () => {
  it("publishes the exact connected version with private permissions", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "rc-ready-"));
    const readyFile = path.join(directory, "agent.ready");

    await publishReadinessSignal(readyFile, "0.2.0-rc.2");

    assert.equal(await readFile(readyFile, "utf8"), "0.2.0-rc.2\n");
    assert.equal((await stat(readyFile)).mode & 0o777, 0o600);
    await clearReadinessSignal(readyFile);
    await assert.rejects(stat(readyFile), { code: "ENOENT" });
  });

  it("does nothing for an interactive process without a readiness path", async () => {
    await publishReadinessSignal(undefined, undefined);
    await clearReadinessSignal(undefined);
  });

  it("refuses an unversioned service signal", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "rc-ready-"));
    await assert.rejects(
      publishReadinessSignal(path.join(directory, "agent.ready"), undefined),
      /RC_AGENT_VERSION is required/,
    );
  });
});
