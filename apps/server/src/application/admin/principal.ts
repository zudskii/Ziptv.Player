import type { StaffMeDto, StaffPermission } from '@ziptv/contracts';

import { permissionsOf, type Permission, type StaffRole } from '../../domain/admin/rbac.js';
import type { StaffRecord } from '../ports/admin.js';

/** The signed-in staff member of an admin request. */
export interface StaffPrincipal {
  id: string;
  email: string;
  name: string;
  role: StaffRole;
  permissions: ReadonlySet<Permission>;
  sessionId: string;
  mustChangePassword: boolean;
}

/** Request context recorded with every audited action. */
export interface AdminContext {
  ip: string | null;
  userAgent: string | null;
}

export function toPrincipal(staff: StaffRecord, sessionId: string): StaffPrincipal {
  return { id: staff.id, email: staff.email, name: staff.name, role: staff.role, permissions: permissionsOf(staff.role), sessionId, mustChangePassword: staff.mustChangePassword };
}

export function toMeDto(principal: StaffPrincipal): StaffMeDto {
  return {
    id: principal.id,
    email: principal.email,
    name: principal.name,
    role: principal.role,
    permissions: [...principal.permissions] as StaffPermission[],
    mustChangePassword: principal.mustChangePassword,
  };
}

/** The actor fields of an audit entry. */
export function actorOf(principal: Pick<StaffPrincipal, 'id' | 'email'>, context: AdminContext) {
  return { actorId: principal.id, actorEmail: principal.email, ip: context.ip };
}
