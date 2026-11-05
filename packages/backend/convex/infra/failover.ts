// Automatic failover for Nodes in connect-convex mode, decided from their heartbeats. The Hub's
// version (apps/hub/src/runtime/failover.ts) redeployed every App of a Node 20 seconds after its
// WebSocket closed. That treats one dropped socket as a dead Node: a Node behind a flaky NAT or
// partitioned from the Hub kept serving while its Apps started a second time elsewhere.
//
// Here a Node is failed over only after two independent observations of one outage:
//
// 1. a check finds it silent for NODE_SILENCE_MS, which is MISSED_HEARTBEATS whole heartbeat
//    intervals (policy.ts), so one late heartbeat or one lost connection is never enough;
// 2. a later check, at least FAILOVER_GRACE_MS after the first, still finds no heartbeat.
//
// A heartbeat in between clears the suspicion. Each outage fails over once (keyed by the
// `lastSeenAt` it was decided on), and each affected App is moved by a failover run of the deploy
// pipeline: it takes the App's lease, redeploys the images the App already runs on a survivor, and
// only then flips the App's routes. The old containers are not trusted to be gone; the run queues
// their removal on the lost Node for when it returns.
//
// Only Nodes that have heartbeated to Convex take part. A Node still served by the Hub has no
// `lastSeenAt` here and is neither failed over nor chosen as a survivor.
import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { internalMutation, type MutationCtx } from "../_generated/server";
import { appendAudit } from "./auditLog";
import { createRun } from "./pipeline";
import { FAILOVER_GRACE_MS, isNodeLive, isNodeSilent } from "./policy";

/** `ERAINFRA_FAILOVER=0` in the Convex environment turns automatic failover off, as on the Hub. */
export function failoverEnabled() {
  return process.env.ERAINFRA_FAILOVER !== "0";
}

/** Every App with at least one service on `nodeId`, whether or not it is the App's primary Node. */
async function appsOn(ctx: MutationCtx, nodeId: Id<"nodes">) {
  const apps = await ctx.db.query("apps").take(500);
  return apps.filter((a) => a.services.some((s) => (s.nodeId ?? a.nodeId) === nodeId));
}

async function failOver(ctx: MutationCtx, lost: Doc<"nodes">, survivors: Doc<"nodes">[]) {
  const apps = await appsOn(ctx, lost._id);
  await appendAudit(ctx, {
    actor: "system:failover",
    action: "nodes.lost",
    target: lost.name,
    outcome: survivors.length > 0 ? "attempt" : "failure",
    meta: {
      lastSeenAt: lost.lastSeenAt,
      apps: apps.map((a) => a.name),
      ...(survivors.length === 0 ? { error: "no surviving Node" } : {}),
    },
  });
  const started: Id<"appDeployments">[] = [];
  for (const [i, app] of apps.entries()) {
    // Round robin across survivors, as the Hub spread a lost Node's Apps. Planning re-checks the
    // choice and picks another live Node if this one went quiet in the meantime.
    const to = survivors[i % Math.max(survivors.length, 1)];
    started.push(
      await createRun(ctx, {
        app: app.name,
        operation: "failover",
        trigger: { kind: "failover" },
        failover: { lostNodeId: lost._id, toNodeId: to?._id ?? lost._id },
      }),
    );
  }
  return started;
}

/** Run by a cron every 10 seconds. Returns the failover runs it queued. */
export const check = internalMutation({
  args: {},
  returns: v.array(v.id("appDeployments")),
  handler: async (ctx) => {
    if (!failoverEnabled()) return [];
    const now = Date.now();
    const nodes = await ctx.db.query("nodes").take(500);
    const survivors = nodes
      .filter((n) => isNodeLive(n.lastSeenAt, now))
      .toSorted((a, b) => a.name.localeCompare(b.name));
    const started: Id<"appDeployments">[] = [];
    for (const node of nodes) {
      if (!isNodeSilent(node.lastSeenAt, now)) {
        if (node.failoverSuspectAt !== undefined)
          await ctx.db.patch(node._id, { failoverSuspectAt: undefined });
        continue;
      }
      if (node.failoverHandledSeenAt === node.lastSeenAt) continue;
      if (node.failoverSuspectAt === undefined) {
        await ctx.db.patch(node._id, { failoverSuspectAt: now });
        continue;
      }
      if (now - node.failoverSuspectAt < FAILOVER_GRACE_MS) continue;
      await ctx.db.patch(node._id, {
        failoverSuspectAt: undefined,
        failoverHandledSeenAt: node.lastSeenAt,
      });
      started.push(
        ...(await failOver(
          ctx,
          node,
          survivors.filter((s) => s._id !== node._id),
        )),
      );
    }
    return started;
  },
});
