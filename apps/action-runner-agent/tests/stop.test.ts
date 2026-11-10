import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createStopHandler, createWorkCounter } from "../stop.ts";

function harness() {
  const counter = createWorkCounter();
  const events: string[] = [];
  const stop = createStopHandler({
    activeWork: () => counter.active,
    waitForIdle: () => counter.idle(),
    stopClaiming: () => events.push("stopClaiming"),
    cancelWork: () => events.push("cancelWork"),
    finish: async () => {
      events.push("finish");
    },
    log: () => undefined,
  });
  return { counter, events, stop };
}

describe("Worker stop sequence (#284)", () => {
  it("stops at once when nothing is running", async () => {
    const { events, stop } = harness();
    await stop("SIGTERM");
    assert.deepEqual(events, ["stopClaiming", "finish"]);
  });

  it("waits for running work instead of cancelling it on the first signal", async () => {
    const { counter, events, stop } = harness();
    counter.start();
    counter.start();
    let stopped = false;
    const stopping = stop("SIGTERM").then(() => {
      stopped = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(events, ["stopClaiming"]);
    counter.finish();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(stopped, false);
    counter.finish();
    await stopping;
    assert.deepEqual(events, ["stopClaiming", "finish"]);
  });

  it("cancels running work on a second signal, once, and still finishes once", async () => {
    const { counter, events, stop } = harness();
    counter.start();
    const first = stop("SIGTERM");
    const second = stop("SIGTERM");
    void stop("SIGINT");
    assert.deepEqual(events, ["stopClaiming", "cancelWork"]);
    counter.finish();
    await Promise.all([first, second]);
    assert.deepEqual(events, ["stopClaiming", "cancelWork", "finish"]);
  });

  it("never lets the counter go negative", async () => {
    const counter = createWorkCounter();
    counter.finish();
    assert.equal(counter.active, 0);
    await counter.idle();
  });
});
