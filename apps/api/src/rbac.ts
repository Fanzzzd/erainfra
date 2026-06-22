// RBAC scaffold. Roles map to a fixed permission set; `owner` is wildcard.
// ponytail: static role->permission table. Move to DB-backed roles when orgs/teams land (M10).

export type Role = 'owner' | 'admin' | 'operator' | 'viewer';

export type Permission = 'app.read' | 'app.deploy' | 'agent.run' | 'audit.read';

const READ_ONLY: Permission[] = ['app.read', 'audit.read'];

const ROLE_PERMISSIONS: Record<Role, Permission[] | '*'> = {
  owner: '*',
  admin: [
    ...READ_ONLY,
    'app.deploy',
    // Running a local AI CLI can read host files/env, so it's gated above operator: admin/owner only.
    'agent.run',
  ],
  operator: [...READ_ONLY, 'app.deploy'],
  viewer: READ_ONLY,
};

export function permissionsFor(roles: readonly Role[]): Set<Permission> | '*' {
  if (roles.some((r) => ROLE_PERMISSIONS[r] === '*')) return '*';
  const set = new Set<Permission>();
  for (const r of roles) {
    const perms = ROLE_PERMISSIONS[r];
    if (perms === '*') return '*';
    for (const p of perms) set.add(p);
  }
  return set;
}

export function can(principal: { roles: readonly Role[] }, permission: Permission): boolean {
  const perms = permissionsFor(principal.roles);
  return perms === '*' || perms.has(permission);
}
