// Shared by every harness that deploys something and then has to decide whether it worked.
//
// `upload.deploy` and `git.deployNow` return as soon as the pipeline is QUEUED. That is not an
// implementation detail to work around: a build takes minutes and Cloudflare cuts a tunneled request
// at ~100s, so a synchronous deploy endpoint could never have worked through the hub's own tunnel.
// The outcome is polled from `apps.status` with the returned deployId.
//
// This lives in one file because seven harnesses need it, and seven copies of a polling loop is how
// those seven drifted off the contract without anyone noticing (issue #62). It mirrors the two
// existing consumers — `waitForDeploy` in packages/cli/portless.mjs and apps/hub-web/src/api.ts —
// with one deliberate difference: both of those poll forever, which is right for a human watching a
// spinner and wrong for an unattended harness, where hanging is indistinguishable from being slow.
// This one has a deadline.
import type { Deployment } from "../../src/runtime/deployments.ts";

// Structural, so a harness can pass its tRPC caller without this file importing the router and
// dragging the whole Hub into a helper.
interface StatusCaller {
  apps: { status: (input: { deployId: string }) => Promise<Deployment> };
}

interface WaitOptions {
  timeoutMs?: number;
  intervalMs?: number;
  quiet?: boolean;
}

/** Poll until the deploy reaches a terminal stage, or throw once the deadline passes. */
export async function waitForDeploy(
  caller: StatusCaller,
  deployId: string,
  { timeoutMs = 10 * 60_000, intervalMs = 2000, quiet = false }: WaitOptions = {},
): Promise<Deployment> {
  const deadline = Date.now() + timeoutMs;
  let last = "";
  for (;;) {
    const d = await caller.apps.status({ deployId });
    const line = `${d.stage}: ${d.detail}`;
    if (!quiet && line !== last) {
      console.log(`  … ${line}`);
      last = line;
    }
    if (d.stage === "done" || d.stage === "failed") return d;
    if (Date.now() > deadline)
      throw new Error(`deploy ${deployId} still "${d.stage}" after ${timeoutMs}ms — giving up`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/**
 * The same wait, with "it did not deploy" folded into a throw. This is the shared half of the
 * success condition — the deploy settled, and it settled well. What "deployed" then *means* is
 * still the harness's own question, and each one keeps asking it: serving the right body, the route
 * landing on the right node, the proxy answering through the data plane.
 */
export async function deployed(
  caller: StatusCaller,
  deployId: string,
  options?: WaitOptions,
): Promise<Deployment> {
  const d = await waitForDeploy(caller, deployId, options);
  if (d.stage !== "done")
    throw new Error(`deploy failed at stage "${d.stage}": ${d.error ?? d.detail}`);
  return d;
}
