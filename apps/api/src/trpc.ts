import { initTRPC, TRPCError } from '@trpc/server';
import type { Principal } from './auth.ts';
import type { AuditLog } from './audit.ts';
import type { LocalRuntime } from './runtime/local.ts';
import { can, type Permission } from './rbac.ts';

export interface Context {
  principal: Principal | null;
  audit: AuditLog;
  runtime: LocalRuntime;
}

const t = initTRPC.context<Context>().create();

export const router = t.router;
export const publicProcedure = t.procedure;
export const createCallerFactory = t.createCallerFactory;

const authedProcedure = t.procedure.use(({ ctx, next }) => {
  if (!ctx.principal) throw new TRPCError({ code: 'UNAUTHORIZED' });
  return next({ ctx: { ...ctx, principal: ctx.principal } });
});

// Gate a procedure on an RBAC permission and audit every denial.
export function requirePermission(permission: Permission) {
  return authedProcedure.use(({ ctx, next, path }) => {
    if (!can(ctx.principal, permission)) {
      ctx.audit.record({
        actor: ctx.principal.id,
        action: path,
        outcome: 'deny',
        meta: { permission },
      });
      throw new TRPCError({ code: 'FORBIDDEN', message: `missing permission: ${permission}` });
    }
    return next();
  });
}
