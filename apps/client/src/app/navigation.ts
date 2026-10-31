import { Bookmark, Clapperboard, History, Home, LayoutGrid, ListVideo, MonitorPlay, Server, Settings, Tv } from 'lucide-react';
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
  { to: '/movies', label: 'Movies', icon: Clapperboard, group: 2, primary: true },
  { to: '/series', label: 'Series', icon: MonitorPlay, group: 2 },
  { to: '/my-list', label: 'My List', icon: Bookmark, group: 3 },
  { to: '/history', label: 'History', icon: History, group: 3 },
  { to: '/playlists', label: 'Playlists', icon: ListVideo, group: 4 },
  { to: '/sources', label: 'Sources', icon: Server, group: 4 },
  { to: '/settings', label: 'Settings', icon: Settings, group: 4 },
];

export function navItems(): NavItem[] {
  return NAV_ITEMS;
}

export function isActivePath(item: NavItem, pathname: string): boolean {
  return item.to === '/' ? pathname === '/' : pathname === item.to || pathname.startsWith(`${item.to}/`);
}
