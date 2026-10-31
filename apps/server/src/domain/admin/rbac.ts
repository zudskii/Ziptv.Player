/**
 * Operator console access control (pure). Staff accounts are separate from subscriber accounts:
 * a compromised viewer login can never reach the console, and staff always sign in with MFA.
 *
 * Roles are assigned in the database; what a role may do is defined here, in code, reviewed
 * like any other change. The API checks permissions, never roles: hiding a button is not
 * access control.
 */

export const STAFF_ROLES = ['SUPER_ADMIN', 'CONTENT_MANAGER', 'NOC_OPERATOR', 'SUPPORT_AGENT', 'FINANCE', 'VIEW_ONLY'] as const;
export type StaffRole = (typeof STAFF_ROLES)[number];

export const PERMISSIONS = [
  'system:read',
  'staff:read',
  'staff:write',
  'audit:read',
  'users:read',
  'users:write',
  'catalog:read',
  'catalog:write',
  'providers:read',
  'providers:write',
  'monitoring:read',
  'monitoring:operate',
  'billing:read',
  'billing:write',
  'rights:read',
  'rights:write',
  'support:read',
  'support:write',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const READ_ALL: Permission[] = ['system:read', 'catalog:read', 'providers:read', 'monitoring:read', 'rights:read'];

export const ROLE_PERMISSIONS: Readonly<Record<StaffRole, readonly Permission[]>> = {
  SUPER_ADMIN: PERMISSIONS,
  CONTENT_MANAGER: [...READ_ALL, 'catalog:write', 'providers:write', 'rights:write', 'audit:read'],
  NOC_OPERATOR: [...READ_ALL, 'monitoring:operate', 'support:read'],
  SUPPORT_AGENT: ['system:read', 'users:read', 'users:write', 'support:read', 'support:write', 'catalog:read', 'monitoring:read'],
  FINANCE: ['system:read', 'billing:read', 'billing:write', 'users:read', 'audit:read', 'rights:read'],
  VIEW_ONLY: [...READ_ALL, 'billing:read', 'support:read'],
};

export function isStaffRole(value: string): value is StaffRole {
  return (STAFF_ROLES as readonly string[]).includes(value);
}

export function permissionsOf(role: StaffRole): ReadonlySet<Permission> {
  return new Set(ROLE_PERMISSIONS[role]);
}

export function can(role: StaffRole, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}
