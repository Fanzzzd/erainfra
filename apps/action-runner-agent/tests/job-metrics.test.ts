import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, it } from "node:test";
import {
  parseMetricsReport,
  startAttemptMetrics,
  type MetricsReport,
  type SamplerProcess,
  type SpawnSampler,
} from "../job-metrics.ts";

/** A stand-in for `runner-center-runtime sample`. */
class FakeSampler extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  killed: NodeJS.Signals | undefined;
  stdinClosed = false;

  constructor(onStdinEnd?: (sampler: FakeSampler) => void) {
    super();
    this.stdin.on("finish", () => {
      this.stdinClosed = true;
      onStdinEnd?.(this);
    });
    this.stdin.resume();
  }

  line(report: MetricsReport) {
    this.stdout.write(`${JSON.stringify(report)}\n`);
  }

  exit() {
    this.stdout.end();
    this.emit("close");
  }

  kill(signal?: NodeJS.Signals) {
    this.killed = signal;
    this.exit();
    return true;
  }
}

function spawner(sampler: FakeSampler) {
  const calls: Array<{ file: string; args: string[]; env: NodeJS.ProcessEnv }> = [];
  const spawnSampler: SpawnSampler = (file, args, options) => {
    calls.push({ file, args, env: options.env });
    return sampler as unknown as SamplerProcess;
  };
  return { spawnSampler, calls };
}

function reportOf(samples: number, final = false): MetricsReport {
  return { final, snapshot: { version: 1, samples } };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));
const ignoreUpload = async () => {};

describe("Attempt metrics on the Worker", () => {
  it("measures only Linux Docker and Firecracker Attempts", async () => {
    let spawned = 0;
    const spawnSampler: SpawnSampler = () => {
      spawned += 1;
      throw new Error("must not spawn");
    };
    for (const [platform, executor] of [
      ["darwin", "docker"],
      ["linux", "tart"],
      ["linux", "hyperv"],
    ] as const) {
      const metrics = startAttemptMetrics({
        attemptId: "a1",
        executor,
        runnerName: "runner-1",
        upload: ignoreUpload,
        platform,
        spawnSampler,
      });
      await metrics.stop();
    }
    assert.equal(spawned, 0);
  });

  it("runs the sampler with the Attempt's identity and forwards its snapshots", async () => {
    const sampler = new FakeSampler();
    const { spawnSampler, calls } = spawner(sampler);
    const uploads: MetricsReport[] = [];
    startAttemptMetrics({
      attemptId: "attempt-7",
      executor: "docker",
      runnerName: "rc-linux-js-7",
      upload: async (body) => void uploads.push(body),
      platform: "linux",
      spawnSampler,
    });
    assert.deepEqual(calls[0]?.args, ["sample"]);
    assert.equal(calls[0]?.env.RC_EXECUTOR, "docker");
    assert.equal(calls[0]?.env.RC_ATTEMPT_ID, "attempt-7");
    assert.equal(calls[0]?.env.RC_RUNNER_NAME, "rc-linux-js-7");

    sampler.line(reportOf(3));
    await tick();
    assert.deepEqual(uploads, [reportOf(3)]);
  });

  it("keeps one upload in flight and drops superseded snapshots rather than queueing them", async () => {
    const sampler = new FakeSampler();
    const { spawnSampler } = spawner(sampler);
    const uploads: number[] = [];
    let release: (() => void) | undefined;
    const upload = (body: MetricsReport) => {
      uploads.push(body.snapshot.samples as number);
      return new Promise<void>((resolve) => {
        release = resolve;
      });
    };
    startAttemptMetrics({
      attemptId: "a",
      executor: "firecracker",
      runnerName: "r",
      upload,
      platform: "linux",
      spawnSampler,
    });
    sampler.line(reportOf(1));
    await tick();
    sampler.line(reportOf(2));
    sampler.line(reportOf(3));
    sampler.line(reportOf(4));
    await tick();
    assert.deepEqual(uploads, [1], "nothing else starts while an upload is in flight");
    release?.();
    await tick();
    await tick();
    assert.deepEqual(uploads, [1, 4], "only the newest waiting snapshot is sent");
    release?.();
  });

  it("closes the sampler's stdin on stop and uploads its final snapshot", async () => {
    const sampler = new FakeSampler((self) => {
      self.line(reportOf(9, true));
      self.exit();
    });
    const { spawnSampler } = spawner(sampler);
    const uploads: MetricsReport[] = [];
    const metrics = startAttemptMetrics({
      attemptId: "a",
      executor: "firecracker",
      runnerName: "r",
      upload: async (body) => void uploads.push(body),
      platform: "linux",
      spawnSampler,
    });
    await metrics.stop();
    assert.equal(sampler.stdinClosed, true);
    assert.equal(sampler.killed, undefined);
    assert.deepEqual(uploads, [reportOf(9, true)]);
    // Stopping twice is the same stop.
    await metrics.stop();
    assert.equal(uploads.length, 1);
  });

  it("kills a sampler that does not exit and abandons an upload that does not finish", async () => {
    const sampler = new FakeSampler();
    const { spawnSampler } = spawner(sampler);
    const messages: string[] = [];
    const metrics = startAttemptMetrics({
      attemptId: "a",
      executor: "docker",
      runnerName: "r",
      upload: () => new Promise(() => {}),
      platform: "linux",
      spawnSampler,
      exitTimeoutMs: 20,
      flushTimeoutMs: 20,
      log: (message) => messages.push(message),
    });
    sampler.line(reportOf(2));
    await tick();
    const started = Date.now();
    await metrics.stop();
    assert.ok(Date.now() - started < 1000, "stop is bounded");
    assert.equal(sampler.killed, "SIGKILL");
    assert.ok(messages.some((message) => message.includes("killing it")));
    assert.ok(messages.some((message) => message.includes("abandoned")));
  });

  it("swallows upload failures and logs the first one only", async () => {
    const sampler = new FakeSampler((self) => {
      self.line(reportOf(5, true));
      self.exit();
    });
    const { spawnSampler } = spawner(sampler);
    const messages: string[] = [];
    let calls = 0;
    const metrics = startAttemptMetrics({
      attemptId: "a",
      executor: "docker",
      runnerName: "r",
      upload: async () => {
        calls += 1;
        throw new Error("Invalid metrics snapshot");
      },
      platform: "linux",
      spawnSampler,
      log: (message) => messages.push(message),
    });
    sampler.line(reportOf(1));
    await tick();
    await metrics.stop();
    assert.equal(calls, 2);
    assert.equal(messages.filter((message) => message.includes("upload failed")).length, 1);
  });

  it("survives a sampler that cannot start", async () => {
    const sampler = new FakeSampler();
    const { spawnSampler } = spawner(sampler);
    const metrics = startAttemptMetrics({
      attemptId: "a",
      executor: "docker",
      runnerName: "r",
      upload: async () => {},
      platform: "linux",
      spawnSampler,
      log: () => {},
    });
    sampler.emit("error", new Error("spawn runner-center-runtime ENOENT"));
    await metrics.stop();

    const throwing = startAttemptMetrics({
      attemptId: "a",
      executor: "docker",
      runnerName: "r",
      upload: async () => {},
      platform: "linux",
      spawnSampler: () => {
        throw new Error("EACCES");
      },
      log: () => {},
    });
    await throwing.stop();
  });

  it("ignores lines that are not reports, including an overlong one", async () => {
    const sampler = new FakeSampler();
    const { spawnSampler } = spawner(sampler);
    const uploads: MetricsReport[] = [];
    startAttemptMetrics({
      attemptId: "a",
      executor: "docker",
      runnerName: "r",
      upload: async (body) => void uploads.push(body),
      platform: "linux",
      spawnSampler,
    });
    sampler.stdout.write("not json\n");
    sampler.stdout.write(`${JSON.stringify({ final: "yes", snapshot: {} })}\n`);
    sampler.stdout.write(`{"final":false,"snapshot":{"pad":"${"x".repeat(1_100_000)}`);
    sampler.stdout.write(`"}}\n`);
    sampler.line(reportOf(4));
    await tick();
    assert.deepEqual(uploads, [reportOf(4)]);
  });

  it("parses exactly the sampler's line shape", () => {
    assert.deepEqual(parseMetricsReport('{"final":true,"snapshot":{"samples":1}}'), {
      final: true,
      snapshot: { samples: 1 },
    });
    assert.equal(parseMetricsReport("null"), undefined);
    assert.equal(parseMetricsReport('{"final":false,"snapshot":null}'), undefined);
    assert.equal(parseMetricsReport('{"final":false}'), undefined);
  });
});
