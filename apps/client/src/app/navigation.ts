import { Bookmark, Clapperboard, CreditCard, Grid2x2, History, Home, LayoutGrid, ListVideo, MonitorPlay, RadioTower, Server, Settings, Tv } from 'lucide-react';
import type { ComponentType } from 'react';

export interface NavItem {
  to: string;
  label: string;
  icon: ComponentType<{ className?: string }>;
  /** Visual group in the sidebar (spec: Home · Live TV/TV Guide · Movies/Series · My List/History · Sources/Settings). */
  group: number;
  /** Shown in the mobile bottom bar (the rest goes under "More"). */
  primary?: boolean;
}

export const NAV_ITEMS: NavItem[] = [
  { to: '/', label: 'Home', icon: Home, group: 0, primary: true },
  { to: '/live', label: 'Live TV', icon: Tv, group: 1, primary: true },
  { to: '/guide', label: 'TV Guide', icon: LayoutGrid, group: 1, primary: true },
  { to: '/multiview', label: 'Multi-view', icon: Grid2x2, group: 1 },
  { to: '/movies', label: 'Movies', icon: Clapperboard, group: 2, primary: true },
  { to: '/series', label: 'Series', icon: MonitorPlay, group: 2 },
  { to: '/my-list', label: 'My List', icon: Bookmark, group: 3 },
  { to: '/history', label: 'History', icon: History, group: 3 },
  { to: '/playlists', label: 'Playlists', icon: ListVideo, group: 4 },
  { to: '/sources', label: 'Sources', icon: Server, group: 4 },
  { to: '/settings', label: 'Settings', icon: Settings, group: 4 },
];

/** Operator (licensed) channels: shown only when the operator offers channels to this viewer. */
export const CHANNELS_ITEM: NavItem = { to: '/channels', label: 'Channels', icon: RadioTower, group: 1, primary: true };

/** Plans, subscription and devices: only where the operator offers channels. */
export const SUBSCRIPTION_ITEM: NavItem = { to: '/account', label: 'Subscription', icon: CreditCard, group: 4 };

export function navItems(options: { operatorChannels?: boolean } = {}): NavItem[] {
  if (!options.operatorChannels) return NAV_ITEMS;
  const settings = NAV_ITEMS.findIndex((item) => item.to === '/settings');
  return [NAV_ITEMS[0]!, CHANNELS_ITEM, ...NAV_ITEMS.slice(1, settings), SUBSCRIPTION_ITEM, ...NAV_ITEMS.slice(settings)];
}

export function isActivePath(item: NavItem, pathname: string): boolean {
  return item.to === '/' ? pathname === '/' : pathname === item.to || pathname.startsWith(`${item.to}/`);
}
