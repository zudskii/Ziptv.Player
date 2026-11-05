import type { StaffPermission } from '@ziptv/contracts';

import { formatDateTime, type TKey } from '../i18n';
import { Activity, BadgeCheck, CalendarClock, Coins, LayoutDashboard, LifeBuoy, Package, RadioTower, ScrollText, Server, ShieldCheck, Users, type LucideIcon } from 'lucide-react';

export interface NavItem {
  to: string;
  /** Translation key of the label. */
  label: TKey;
  icon: LucideIcon;
  permission: StaffPermission;
  /** Visual group in the sidebar. */
  group: 'operations' | 'catalog' | 'customers' | 'admin';
}

/** Console sections; a section is listed only when the role grants its permission (the API checks again). */
export const NAV: NavItem[] = [
  { to: '/', label: 'nav.overview', icon: LayoutDashboard, permission: 'system:read', group: 'operations' },
  { to: '/approvals', label: 'nav.approvals', icon: BadgeCheck, permission: 'system:read', group: 'operations' },
  { to: '/monitoring', label: 'nav.monitoring', icon: Activity, permission: 'monitoring:read', group: 'operations' },
  { to: '/channels', label: 'nav.channels', icon: RadioTower, permission: 'catalog:read', group: 'catalog' },
  { to: '/providers', label: 'nav.providers', icon: Server, permission: 'providers:read', group: 'catalog' },
  { to: '/epg', label: 'nav.epg', icon: CalendarClock, permission: 'catalog:read', group: 'catalog' },
  { to: '/packages', label: 'nav.packages', icon: Package, permission: 'billing:read', group: 'catalog' },
  { to: '/users', label: 'nav.users', icon: Users, permission: 'users:read', group: 'customers' },
  { to: '/support', label: 'nav.support', icon: LifeBuoy, permission: 'support:read', group: 'customers' },
  { to: '/finance', label: 'nav.finance', icon: Coins, permission: 'billing:read', group: 'customers' },
  { to: '/audit', label: 'nav.audit', icon: ScrollText, permission: 'audit:read', group: 'admin' },
  { to: '/staff', label: 'nav.staff', icon: ShieldCheck, permission: 'staff:read', group: 'admin' },
];

export function visibleNav(can: (permission: StaffPermission) => boolean): NavItem[] {
  return NAV.filter((item) => can(item.permission));
}

export function formatTime(iso: string | null): string {
  if (!iso) return '—';
  return formatDateTime(iso);
}
