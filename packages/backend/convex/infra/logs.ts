// Log tails: the last lines of an App's container or a Node's platform unit, on request.
//
// The Node API stores no command output (#187), because output can hold secrets. A log tail is the
// one exception, and it is shaped so the output reaches only the person who asked:
//
//   1. An admin API token asks for N lines (at most MAX_LOG_LINES) of a service or a unit.
//      Convex writes a logTails row bound to that token and queues a `logs` Node command running
//      the allowlisted `container.logs` or `service.logs` operation, audited in one transaction.
//   2. The Node runs it, keeps the last MAX_LOG_BYTES of output, and uploads it with the command's
//      result (nodeCommands.report). Nothing else is written: the command row keeps its outcome only.
//   3. The requesting token reads the row once. The read deletes it. A row nobody reads is deleted
//      at its expiry, LOG_TTL_MS after the request, and its command is cancelled if it never ran.
//
// Reading is admin-scoped, because a log line can print an environment variable.
import { ConvexError, v } from "convex/values";

import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { internalMutation, type MutationCtx } from "../_generated/server";
import { apiCallerValidator, requireTokenPermission } from "./access";
import { isSingleContainerRoute, loadRouteOwner } from "./apps";
import { appendAudit } from "./auditLog";
import { validateOperation } from "./nodeCommandModel";
import { insertNodeCommand } from "./nodeCommands";
import { isNodeLive } from "./policy";

/** The most lines one tail returns. `docker logs --tail` is capped at 1000 by the allowlist. */
export const MAX_LOG_LINES = 1000;
export const DEFAULT_LOG_LINES = 100;
export { MAX_LOG_BYTES } from "./logOutput";
/** How long an unread tail lives. Long enough to wait behind a deploy step, short for a secret. */
export const LOG_TTL_MS = 5 * 60_000;

const UNIT = /^(portless|erainfra)-[a-z0-9-]+(\.service)?$/;

type Target = Doc<"logTails">["target"];

async function resolveTarget(
  ctx: MutationCtx,
  input: { app?: string; service?: string; node?: string; unit?: string },
): Promise<{ nodeId: Id<"nodes">; target: Target }> {
  if (input.app !== undefined) {
    if (input.node !== undefined || input.unit !== undefined) {
      throw new ConvexError("Ask for an App's service or a Node's unit, not both");
    }
    const app = await ctx.db
      .query("apps")
      .withIndex("by_name", (q) => q.eq("name", input.app!))
      .unique();
    if (app !== null) {
      const service =
        input.service === undefined
          ? app.services.length === 1
            ? app.services[0]
            : undefined
          : app.services.find((s) => s.name === input.service);
      if (service === undefined) {
        throw new ConvexError(
          input.service === undefined
            ? `${app.name} has several services; name one (${app.services.map((s) => s.name).join(", ")})`
            : `${app.name} has no service ${input.service}`,
        );
      }
      return {
        nodeId: service.nodeId ?? app.nodeId,
        target: {
          kind: "container",
          app: app.name,
          service: service.name,
          container: `${app.name}-${service.name}`,
        },
      };
    }
    // A single-container App the Hub deployed has a route and no App row; its container is the
    // route's name.
    const route = await ctx.db
      .query("appRoutes")
      .withIndex("by_name", (q) => q.eq("name", input.app!))
      .unique();
    // Only a route that is its own owner names a container; another App's label does not.
    if (route === null || !isSingleContainerRoute(route, await loadRouteOwner(ctx, route)))
      throw new ConvexError(`No App named ${input.app}`);
    if (input.service !== undefined && input.service !== route.name) {
      throw new ConvexError(`${route.name} has no service ${input.service}`);
    }
    return {
      nodeId: route.nodeId,
      target: { kind: "container", app: route.name, service: route.name, container: route.name },
    };
  }
  if (input.node === undefined || input.unit === undefined) {
    throw new ConvexError("Send app (and service), or node and unit");
  }
  if (input.service !== undefined) throw new ConvexError("service goes with app, not with unit");
  if (!UNIT.test(input.unit)) {
    throw new ConvexError("unit must be a platform unit, portless-* or erainfra-*");
  }
  const node = await ctx.db
    .query("nodes")
    .withIndex("by_name", (q) => q.eq("name", input.node!))
    .unique();
  if (node === null) throw new ConvexError(`No Node named ${input.node}`);
  return { nodeId: node._id, target: { kind: "unit", unit: input.unit } };
}

function operationFor(
  target: Target,
  lines: number,
): { name: string; args: Record<string, string> } {
  return target.kind === "container"
    ? { name: "container.logs", args: { name: target.container, lines: String(lines) } }
    : { name: "service.logs", args: { unit: target.unit, lines: String(lines) } };
}

/**
 * Ask a Node for a log tail on behalf of one API token. Every check runs before the first write,
 * and a refusal is returned, so its audit row commits.
 */
export const request = internalMutation({
  args: {
    caller: apiCallerValidator,
    app: v.optional(v.string()),
    service: v.optional(v.string()),
    node: v.optional(v.string()),
    unit: v.optional(v.string()),
    lines: v.optional(v.number()),
  },
  handler: async (ctx, { caller, ...args }) => {
    const { actor } = requireTokenPermission(caller, "node.run");
    const describe =
      args.app ?? (args.node === undefined ? undefined : `${args.node}/${args.unit}`);
    let resolved: { nodeId: Id<"nodes">; target: Target; lines: number; node: Doc<"nodes"> };
    try {
      const lines = args.lines ?? DEFAULT_LOG_LINES;
      if (!Number.isInteger(lines) || lines < 1 || lines > MAX_LOG_LINES) {
        throw new ConvexError(`lines must be an integer from 1 to ${MAX_LOG_LINES}`);
      }
      const { nodeId, target } = await resolveTarget(ctx, args);
      const node = await ctx.db.get(nodeId);
      if (node === null) throw new ConvexError("The Node this runs on is gone");
      // A Node that is not polling Convex would leave the request to expire unanswered.
      if (!isNodeLive(node.lastSeenAt, Date.now())) {
        throw new ConvexError(
          node.lastSeenAt === undefined
            ? `${node.name} has not connected to Convex; read its logs through the Hub (portless logs)`
            : `${node.name} is offline`,
        );
      }
      validateOperation(operationFor(target, lines));
      resolved = { nodeId, target, lines, node };
    } catch (error) {
      if (!(error instanceof ConvexError)) throw error;
      const message = typeof error.data === "string" ? error.data : "refused";
      await appendAudit(ctx, {
        actor,
        action: "logs.request",
        ...(describe === undefined ? {} : { target: describe }),
        outcome: "deny",
        meta: { error: message },
      });
      return { ok: false as const, error: message };
    }
    const now = Date.now();
    const id = await ctx.db.insert("logTails", {
      requesterTokenId: caller.tokenId,
      nodeId: resolved.nodeId,
      target: resolved.target,
      lines: resolved.lines,
      state: "pending",
      createdAt: now,
      expiresAt: now + LOG_TTL_MS,
    });
    const { id: commandId } = await insertNodeCommand(ctx, {
      nodeId: resolved.nodeId,
      idempotencyKey: `logs:${id}`,
      command: { kind: "logs", operation: operationFor(resolved.target, resolved.lines) },
    });
    await ctx.db.patch(id, { commandId });
    await ctx.scheduler.runAt(now + LOG_TTL_MS, internal.infra.logs.expire, { id });
    await appendAudit(ctx, {
      actor,
      action: "logs.request",
      target: describe!,
      outcome: "attempt",
      meta: {
        logTailId: id,
        node: resolved.node.name,
        target: resolved.target,
        lines: resolved.lines,
      },
    });
    return {
      ok: true as const,
      value: {
        id,
        state: "pending" as const,
        node: resolved.node.name,
        target: resolved.target,
        lines: resolved.lines,
        expiresAt: now + LOG_TTL_MS,
      },
    };
  },
});

/**
 * Read a tail once. Answers the same `gone` for an id that never existed, one another token asked
 * for, one already read and one expired, so a token learns nothing about another's requests.
 */
export const consume = internalMutation({
  args: { caller: apiCallerValidator, id: v.string() },
  handler: async (ctx, { caller, id }) => {
    const { actor } = requireTokenPermission(caller, "node.run");
    const tailId = ctx.db.normalizeId("logTails", id);
    const row = tailId === null ? null : await ctx.db.get(tailId);
    if (row === null || row.requesterTokenId !== caller.tokenId) return { state: "gone" as const };
    if (row.expiresAt <= Date.now()) {
      await discard(ctx, row);
      return { state: "gone" as const };
    }
    if (row.state === "pending") {
      return { state: "pending" as const, expiresAt: row.expiresAt };
    }
    await ctx.db.delete(row._id);
    await appendAudit(ctx, {
      actor,
      action: "logs.read",
      target: row.target.kind === "container" ? row.target.app : row.target.unit,
      outcome: row.state === "ready" ? "success" : "failure",
      meta: { logTailId: row._id, length: row.text?.length ?? 0 },
    });
    if (row.state === "failed") {
      return {
        state: "failed" as const,
        error:
          "The Node could not read the logs: the container or unit may not exist, or its Infra Agent predates log tails",
      };
    }
    return {
      state: "ready" as const,
      text: row.text ?? "",
      truncated: row.truncated === true,
      lines: row.lines,
      target: row.target,
    };
  },
});

async function discard(ctx: MutationCtx, row: Doc<"logTails">) {
  await ctx.db.delete(row._id);
  if (row.commandId === undefined) return;
  const command = await ctx.db.get(row.commandId);
  if (command !== null && (command.status === "pending" || command.status === "running")) {
    await ctx.db.patch(command._id, {
      status: "cancelled",
      unsettled: false,
      finishedAt: Date.now(),
    });
  }
}

/** Scheduled at request time: delete a tail nobody read, and cancel its command if it never ran. */
export const expire = internalMutation({
  args: { id: v.id("logTails") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.id);
    if (row !== null) await discard(ctx, row);
    return null;
  },
});
