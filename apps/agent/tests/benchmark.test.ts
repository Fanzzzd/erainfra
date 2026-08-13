import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { runWorkerBenchmark } from "../benchmark.ts";

describe("Worker benchmark", () => {
  it("measures bounded local resources and unauthenticated network targets", async () => {
    const directory = await mkdtemp(join(tmpdir(), "runner-center-benchmark-"));
    const requests: Array<{ url: string; headers: Headers }> = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(input), headers: new Headers(init?.headers) });
      return new Response(new Uint8Array(32 * 1024), { status: 200 });
    }) as typeof fetch;
    try {
      const report = await runWorkerBenchmark({
        directory,
        cpuBytes: 1024 * 1024,
        memoryBytes: 1024 * 1024,
        memoryCopies: 1,
        diskBytes: 1024 * 1024,
        packageFiles: 16,
        fetchImpl,
        networkTargets: [
          { target: "github", url: "https://example.test/github" },
          { target: "ghcr", url: "https://example.test/ghcr" },
          { target: "npm", url: "https://example.test/npm" },
        ],
      });

      assert.equal(report.version, 1);
      assert.ok((report.cpuSha256MiBps ?? 0) > 0);
      assert.ok((report.memoryCopyMiBps ?? 0) > 0);
      assert.ok((report.diskWriteMiBps ?? 0) > 0);
      assert.ok((report.diskReadMiBps ?? 0) > 0);
      assert.ok((report.diskFsyncLatencyMs ?? -1) >= 0);
      assert.ok((report.packageLinkOpsPerSec ?? 0) > 0);
      assert.equal(report.network.length, 3);
      assert.deepEqual(report.errors, []);
      assert.equal(
        requests.every((request) => !request.headers.has("Authorization")),
        true,
      );
      assert.equal(
        requests.every((request) => request.headers.has("Range")),
        true,
      );
      assert.deepEqual(await readdir(directory), []);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("returns partial observations instead of failing the Worker", async () => {
    const directory = await mkdtemp(join(tmpdir(), "runner-center-benchmark-"));
    try {
      const report = await runWorkerBenchmark({
        directory,
        cpuBytes: 1024,
        memoryBytes: 1024,
        memoryCopies: 1,
        diskBytes: 1024,
        packageFiles: 2,
        fetchImpl: (async () => {
          throw new Error("offline");
        }) as typeof fetch,
        networkTargets: [{ target: "github", url: "https://example.test" }],
      });
      assert.equal(report.network[0]?.error, "offline");
      assert.match(report.errors[0] ?? "", /github: offline/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
