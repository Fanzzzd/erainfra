// Push-to-deploy bindings on the operator API (/api/v1/git/bindings, infra/operatorGitRoutes.ts)
// and so the `erainfra git` commands.
//
// Each change runs the body the dashboard's mutation runs (git.ts bindBranch, unbindBranch), so
// the two callers cannot disagree about a rule. The API names Nodes, not ids: the build and deploy
// Nodes are resolved here, in the binding's transaction. A change needs `app.deploy`, the
// permission the dashboard's bind and unbind need; an admin token holds it and a read token does
// not (policy.ts). Every change is audited with the token's name, and so is every refusal.
import { ConvexError, v } from "convex/values";

import { internalMutation, internalQuery } from "../_generated/server";
import { apiCallerValidator, requireTokenPermission } from "./access";
import { bindBranch, bindingViews, findBinding, listBindings, unbindBranch } from "./git";
import { audited, nodeNamed } from "./operator";

export const apiBindings = internalQuery({
  args: { caller: apiCallerValidator },
  handler: async (ctx, args) => {
    requireTokenPermission(args.caller, "app.read");
    return listBindings(ctx);
  },
});

export const apiBind = internalMutation({
  args: {
    caller: apiCallerValidator,
    repo: v.string(),
    branch: v.string(),
    app: v.string(),
    buildNode: v.optional(v.string()),
    deployNode: v.optional(v.string()),
    port: v.optional(v.number()),
  },
  handler: async (ctx, { caller, buildNode, deployNode, ...args }) => {
    const { actor } = requireTokenPermission(caller, "app.deploy");
    const target = `${args.repo}@${args.branch}`;
    return audited(ctx, { actor, action: "git.bind", target }, async () => {
      const resolve = async (name: string | undefined) => {
        if (name === undefined) return undefined;
        const node = await nodeNamed(ctx, name);
        if (node === null) throw new ConvexError(`No Node named "${name}"`);
        return node._id;
      };
      const buildNodeId = await resolve(buildNode);
      const deployNodeId = await resolve(deployNode);
      const id = await bindBranch(ctx, {
        ...args,
        ...(buildNodeId === undefined ? {} : { buildNodeId }),
        ...(deployNodeId === undefined ? {} : { deployNodeId }),
        actor,
      });
      const row = await ctx.db.get(id);
      if (row === null) throw new Error("the binding just written is gone");
      const [view] = await bindingViews(ctx, [row]);
      return view;
    });
  },
});

export const apiUnbind = internalMutation({
  args: { caller: apiCallerValidator, repo: v.string(), branch: v.string() },
  handler: async (ctx, args) => {
    const { actor } = requireTokenPermission(args.caller, "app.deploy");
    const target = `${args.repo}@${args.branch}`;
    return audited(ctx, { actor, action: "git.unbind", target }, async () => {
      const binding = await findBinding(ctx, args.repo, args.branch);
      if (binding === null) throw new ConvexError(`No binding for ${target}`);
      await unbindBranch(ctx, binding, actor);
      return { repo: binding.repo, branch: binding.branch, app: binding.app };
    });
  },
});
