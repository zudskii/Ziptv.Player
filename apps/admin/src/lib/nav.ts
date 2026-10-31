import type { StaffPermission } from '@ziptv/contracts';
import { Activity, LayoutDashboard, ScrollText, ShieldCheck, Users, type LucideIcon } from 'lucide-react';

export interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  permission: StaffPermission;
}

/** Console sections; a section is listed only when the role grants its permission (the API checks again). */
export const NAV: NavItem[] = [
  { to: '/', label: 'Overview', icon: LayoutDashboard, permission: 'system:read' },
  { to: '/users', label: 'Subscribers', icon: Users, permission: 'users:read' },
  { to: '/staff', label: 'Staff', icon: ShieldCheck, permission: 'staff:read' },
  { to: '/audit', label: 'Audit log', icon: ScrollText, permission: 'audit:read' },
];

/** Upcoming modules (shown greyed out so operators know what is coming). */
export const COMING: { label: string; icon: LucideIcon }[] = [{ label: 'Live monitoring', icon: Activity }];

export function visibleNav(can: (permission: StaffPermission) => boolean): NavItem[] {
  return NAV.filter((item) => can(item.permission));
}

export function formatTime(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}
