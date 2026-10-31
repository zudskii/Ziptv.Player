import { clsx } from 'clsx';
import { LogOut } from 'lucide-react';
import { NavLink, Outlet } from 'react-router';

import { useAuth } from '../lib/auth';
import { COMING, visibleNav } from '../lib/nav';
import { Badge } from './ui';

export function Layout() {
  const { me, can, signOut } = useAuth();
  const items = visibleNav(can);
  return (
    <div className="flex min-h-dvh">
      <aside className="hidden w-60 shrink-0 flex-col border-r border-line/[0.07] bg-sunken md:flex">
        <div className="flex items-center gap-2 px-5 py-5">
          <img src="/favicon.svg" alt="" className="h-7 w-7" />
          <div>
            <p className="text-sm font-semibold leading-tight">ZIPTV</p>
            <p className="text-xs text-accent">Operator console</p>
          </div>
        </div>
        <nav aria-label="Console navigation" className="flex-1 space-y-1 px-3">
          {items.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === '/'}
              className={({ isActive }) => clsx('flex items-center gap-3 rounded-lg px-3 py-2 text-sm', isActive ? 'bg-accent/15 text-amber-200' : 'text-fg-muted hover:bg-line/5 hover:text-fg')}
            >
              <item.icon className="h-4 w-4" aria-hidden /> {item.label}
            </NavLink>
          ))}
          <div className="pt-4">
            {COMING.map((item) => (
              <span key={item.label} className="flex cursor-default items-center gap-3 rounded-lg px-3 py-2 text-sm text-fg-subtle" title="Coming in a later phase">
                <item.icon className="h-4 w-4" aria-hidden /> {item.label}
              </span>
            ))}
          </div>
        </nav>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-line/[0.07] px-4 py-3 md:px-8">
          <span className="flex items-center gap-2 text-sm font-semibold md:hidden">
            <img src="/favicon.svg" alt="" className="h-6 w-6" /> Console
          </span>
          <nav aria-label="Console sections" className="order-last -mx-1 flex w-full gap-1 overflow-x-auto md:hidden">
            {items.map((item) => (
              <NavLink key={item.to} to={item.to} end={item.to === '/'} className={({ isActive }) => clsx('whitespace-nowrap rounded-md px-2 py-1 text-sm', isActive ? 'bg-accent/15 text-amber-200' : 'text-fg-muted')}>
                {item.label}
              </NavLink>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-3 text-sm">
            <span className="hidden text-fg-muted sm:inline">{me?.name}</span>
            {me && (
              <span className="whitespace-nowrap">
                <Badge tone="warn">{me.role.replace('_', ' ')}</Badge>
              </span>
            )}
            <button type="button" onClick={() => void signOut()} aria-label="Sign out" className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-md px-2 py-1 text-fg-muted hover:bg-line/10 hover:text-fg">
              <LogOut className="h-4 w-4" aria-hidden /> <span className="hidden sm:inline">Sign out</span>
            </button>
          </div>
        </header>
        <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 md:px-8">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
