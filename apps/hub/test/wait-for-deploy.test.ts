import test from "node:test";
import assert from "node:assert/strict";
import type { Deployment } from "../src/runtime/deployments.ts";
import { deployed, waitForDeploy } from "../scripts/verify/_wait-for-deploy.ts";

// scripts/verify needs docker, a registry, nixpacks and real machines, so none of those harnesses
// run in CI and none of them ran here. What CAN be tested without any of that is the piece this
// repair actually authored: the loop that decides a deploy is finished. Everything else in those
// harnesses is a scenario assertion that was already there.
//
// So this covers the control flow — polls until terminal, distinguishes done from failed, gives up
// on a deadline rather than hanging — against a fake caller. It does NOT cover whether a real Hub
// walks those stages in that order. That is what a live run would add and this cannot.

const dep = (stage: Deployment["stage"], extra: Partial<Deployment> = {}): Deployment => ({
  id: "d1",
  app: "probe",
  stage,
  detail: `at ${stage}`,
  urls: [],
  startedAt: "2026-08-18T00:00:00.000Z",
  ...extra,
});

const callerReturning = (stages: Deployment[]) => {
  let i = 0;
  const calls: string[] = [];
  return {
    calls,
    apps: {
      status: (input: { deployId: string }) => {
        calls.push(input.deployId);
        return Promise.resolve(stages[Math.min(i++, stages.length - 1)]);
      },
    },
  };
};

test("waitForDeploy polls until the deploy reaches a terminal stage", async () => {
  const caller = callerReturning([
    dep("queued"),
    dep("building"),
    dep("deploying"),
    dep("done", { urls: ["https://probe.apps.local"] }),
  ]);
  const d = await waitForDeploy(caller, "d1", { intervalMs: 0, quiet: true });
  assert.equal(d.stage, "done");
  assert.deepEqual(d.urls, ["https://probe.apps.local"]);
  assert.equal(caller.calls.length, 4, "should have stopped at the first terminal stage");
  assert.deepEqual(new Set(caller.calls), new Set(["d1"]), "polls the deployId it was given");
});

test("waitForDeploy returns a failed deploy rather than throwing — the caller decides", async () => {
  const caller = callerReturning([dep("failed", { error: "build blew up" })]);
  const d = await waitForDeploy(caller, "d1", { intervalMs: 0, quiet: true });
  assert.equal(d.stage, "failed");
  assert.equal(d.error, "build blew up");
});

// A harness that hangs is indistinguishable from one that is slow, and nothing is watching it.
// The two existing consumers of apps.status (the CLI and hub-web) poll forever on purpose, because
// a human is watching a spinner; this deliberately does not.
test("waitForDeploy gives up at the deadline instead of polling forever", async () => {
  const caller = callerReturning([dep("building")]);
  await assert.rejects(
    () => waitForDeploy(caller, "d1", { intervalMs: 0, timeoutMs: 0, quiet: true }),
    /still "building".*giving up/,
  );
});

test("deployed folds a failed deploy into a throw that names the stage and the error", async () => {
  const caller = callerReturning([dep("failed", { error: "no such build node" })]);
  await assert.rejects(
    () => deployed(caller, "d1", { intervalMs: 0, quiet: true }),
    /failed at stage "failed": no such build node/,
  );
});

test("deployed falls back to the stage detail when there is no error string", async () => {
  const caller = callerReturning([dep("failed", { detail: "linking web → db" })]);
  await assert.rejects(
    () => deployed(caller, "d1", { intervalMs: 0, quiet: true }),
    /linking web → db/,
  );
});

test("deployed returns the deployment on success", async () => {
  const caller = callerReturning([dep("done", { urls: ["https://probe.apps.local"] })]);
  const d = await deployed(caller, "d1", { intervalMs: 0, quiet: true });
  assert.equal(d.stage, "done");
});
