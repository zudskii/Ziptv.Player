import { Ellipsis, Moon, Sun, SunMoon } from 'lucide-react';
import { Fragment, useState, type ReactNode } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router';

import { isActivePath, navItems, type NavItem } from '../../app/navigation';
import { NotificationBell } from '../../features/notifications/NotificationBell';
import { useRefreshOnSyncCompletion, useSources } from '../../features/sources/api';
import { useThemeStore } from '../../features/theme/theme-store';
import { cn } from '../../lib/cn';
import { IconButton } from '../ui/Button';
import { Brand } from './Brand';

/**
 * App frame: sidebar navigation on desktop, bottom tab bar on phones, top bar with
 * search / notifications / profile. Pages render into the outlet.
 */
export function AppShell({ topBarExtra }: { topBarExtra?: ReactNode }) {
  const items = navItems();
  // Background syncs finishing refresh Home rails and the notification center.
  useRefreshOnSyncCompletion(useSources().data);
  return (
    <div className="flex min-h-dvh">
      <Sidebar items={items} />
      <div className="flex min-w-0 flex-1 flex-col pb-16 lg:pb-0">
        <TopBar extra={topBarExtra} />
        <main className="min-w-0 flex-1">
          <Outlet />
        </main>
      </div>
      <BottomNav items={items} />
    </div>
  );
}

function Sidebar({ items }: { items: NavItem[] }) {
  const { pathname } = useLocation();
  const groups = [...new Set(items.map((item) => item.group))];
  return (
    <aside className="sticky top-0 hidden h-dvh w-60 shrink-0 flex-col border-r border-line/5 bg-surface/60 px-3 py-4 lg:flex">
      <div className="px-2 pb-6">
        <Brand />
      </div>
      <nav className="flex flex-1 flex-col gap-1" aria-label="Main navigation">
        {groups.map((group, index) => (
          <Fragment key={group}>
            {index > 0 && <div className="my-2 border-t border-line/5" />}
            {items
              .filter((item) => item.group === group)
              .map((item) => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  className={cn(
                    'flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
                    isActivePath(item, pathname) ? 'bg-brand/15 text-fg' : 'text-fg-muted hover:bg-fg/5 hover:text-fg',
                  )}
                >
                  <item.icon className={cn('h-5 w-5', isActivePath(item, pathname) ? 'text-brand-soft' : '')} />
                  {item.label}
                </NavLink>
              ))}
          </Fragment>
        ))}
      </nav>
    </aside>
  );
}

function TopBar({ extra }: { extra?: ReactNode }) {
  return (
    <header className="sticky top-0 z-30 border-b border-line/5 bg-canvas/85 backdrop-blur">
      <div className="flex h-14 items-center gap-2 px-3 sm:px-5">
        <div className="lg:hidden">
          <Brand compact />
        </div>
        <div className="min-w-0 flex-1">{extra}</div>
        <ThemeToggle />
        <NotificationBell />
      </div>
    </header>
  );
}

function ThemeToggle() {
  const preference = useThemeStore((state) => state.preference);
  const setPreference = useThemeStore((state) => state.setPreference);
  const next = preference === 'dark' ? 'light' : preference === 'light' ? 'system' : 'dark';
  const Icon = preference === 'dark' ? Moon : preference === 'light' ? Sun : SunMoon;
  return (
    <IconButton label={`Theme: ${preference} (switch to ${next})`} onClick={() => setPreference(next)}>
      <Icon className="h-5 w-5" />
    </IconButton>
  );
}

function BottomNav({ items }: { items: NavItem[] }) {
  const { pathname } = useLocation();
  const [moreOpen, setMoreOpen] = useState(false);
  const primary = items.filter((item) => item.primary).slice(0, 4);
  const rest = items.filter((item) => !primary.includes(item));
  const restActive = rest.some((item) => isActivePath(item, pathname));

  return (
    <>
      {moreOpen && (
        <div className="fixed inset-0 z-40 bg-black/50 lg:hidden" onClick={() => setMoreOpen(false)}>
          <nav className="absolute inset-x-3 bottom-[4.5rem] animate-fade-in rounded-2xl border border-line/10 bg-elevated p-2 shadow-2xl" aria-label="More">
            {rest.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                onClick={() => setMoreOpen(false)}
                className={cn('flex items-center gap-3 rounded-lg px-3 py-3 text-sm', isActivePath(item, pathname) ? 'bg-brand/15 text-fg' : 'text-fg-muted')}
              >
                <item.icon className="h-5 w-5" />
                {item.label}
              </NavLink>
            ))}
          </nav>
        </div>
      )}
      <nav
        className="fixed inset-x-0 bottom-0 z-40 flex h-16 border-t border-line/5 bg-surface/95 pb-[env(safe-area-inset-bottom)] backdrop-blur lg:hidden"
        aria-label="Tab bar"
      >
        {primary.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            className={cn('flex flex-1 flex-col items-center justify-center gap-1 text-[11px] font-medium', isActivePath(item, pathname) ? 'text-brand-soft' : 'text-fg-muted')}
          >
            <item.icon className="h-5 w-5" />
            {item.label}
          </NavLink>
        ))}
        {rest.length > 0 && (
          <button
            type="button"
            onClick={() => setMoreOpen((open) => !open)}
            className={cn('flex flex-1 flex-col items-center justify-center gap-1 text-[11px] font-medium', restActive || moreOpen ? 'text-brand-soft' : 'text-fg-muted')}
            aria-expanded={moreOpen}
          >
            <Ellipsis className="h-5 w-5" />
            More
          </button>
        )}
      </nav>
    </>
  );
}
