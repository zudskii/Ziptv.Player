import type { StaffPermission } from '@ziptv/contracts';
import { Activity, BadgeCheck, CalendarClock, Coins, LayoutDashboard, LifeBuoy, Package, RadioTower, ScrollText, Server, ShieldCheck, Users, type LucideIcon } from 'lucide-react';

export interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  permission: StaffPermission;
  /** Visual group in the sidebar. */
  group: 'operations' | 'catalog' | 'customers' | 'admin';
}

/** Console sections; a section is listed only when the role grants its permission (the API checks again). */
export const NAV: NavItem[] = [
  { to: '/', label: 'Overview', icon: LayoutDashboard, permission: 'system:read', group: 'operations' },
  { to: '/approvals', label: 'Approvals', icon: BadgeCheck, permission: 'system:read', group: 'operations' },
  { to: '/monitoring', label: 'Live monitoring', icon: Activity, permission: 'monitoring:read', group: 'operations' },
  { to: '/channels', label: 'Channels', icon: RadioTower, permission: 'catalog:read', group: 'catalog' },
  { to: '/providers', label: 'Providers', icon: Server, permission: 'providers:read', group: 'catalog' },
  { to: '/epg', label: 'EPG', icon: CalendarClock, permission: 'catalog:read', group: 'catalog' },
  { to: '/packages', label: 'Packages & rights', icon: Package, permission: 'billing:read', group: 'catalog' },
  { to: '/users', label: 'Subscribers', icon: Users, permission: 'users:read', group: 'customers' },
  { to: '/support', label: 'Support & incidents', icon: LifeBuoy, permission: 'support:read', group: 'customers' },
  { to: '/finance', label: 'Finance', icon: Coins, permission: 'billing:read', group: 'customers' },
  { to: '/audit', label: 'Audit & security', icon: ScrollText, permission: 'audit:read', group: 'admin' },
  { to: '/staff', label: 'Staff', icon: ShieldCheck, permission: 'staff:read', group: 'admin' },
];

export function visibleNav(can: (permission: StaffPermission) => boolean): NavItem[] {
  return NAV.filter((item) => can(item.permission));
}

export function formatTime(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}
