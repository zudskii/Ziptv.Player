import type { ChangeRequestPageDto } from '@ziptv/contracts';
import { useQuery } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { LogOut } from 'lucide-react';
import { NavLink, Outlet } from 'react-router';

import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { visibleNav, type NavItem } from '../lib/nav';
import { Badge } from './ui';
import { LanguagePicker } from './LanguagePicker';
import { t } from '../i18n';

const GROUPS: NavItem['group'][] = ['operations', 'catalog', 'customers', 'admin'];

export function Layout() {
  const { me, can, signOut } = useAuth();
  const items = visibleNav(can);
  // Four-eyes requests waiting for someone: a badge on Approvals.
  const approvals = useQuery({ queryKey: ['change-requests', 'open-count'], queryFn: () => api<ChangeRequestPageDto>('/change-requests?status=open&limit=1'), enabled: can('system:read'), refetchInterval: 60_000 });
  const open = approvals.data?.open ?? 0;
  const label = (item: NavItem) => (
    <>
      <item.icon className="h-4 w-4 shrink-0" aria-hidden /> <span className="flex-1">{t(item.label)}</span>
      {item.to === '/approvals' && open > 0 && (
        <span className="rounded-full bg-accent px-1.5 text-xs font-semibold text-black" aria-label={t('nav.openCount', { count: open })}>
          {open}
        </span>
      )}
    </>
  );
  return (
    <div className="flex min-h-dvh">
      <aside className="hidden w-60 shrink-0 flex-col border-r border-line/[0.07] bg-sunken md:flex">
        <div className="flex items-center gap-2 px-5 py-5">
          <img src="/favicon.svg" alt="" className="h-7 w-7" />
          <div>
            <p className="text-sm font-semibold leading-tight">ZIPTV</p>
            <p className="text-xs text-accent">{t('common.console')}</p>
          </div>
        </div>
        <nav aria-label={t('common.consoleNav')} className="flex-1 space-y-4 overflow-y-auto px-3 pb-6">
          {GROUPS.map((group) => {
            const entries = items.filter((item) => item.group === group);
            if (entries.length === 0) return null;
            return (
              <div key={group} className="space-y-1">
                <p className="px-3 text-[11px] font-semibold uppercase tracking-wider text-fg-subtle">{t(`nav.group.${group}`)}</p>
                {entries.map((item) => (
                  <NavLink
                    key={item.to}
                    to={item.to}
                    end={item.to === '/'}
                    className={({ isActive }) => clsx('flex items-center gap-3 rounded-lg px-3 py-2 text-sm', isActive ? 'bg-accent/15 text-amber-200' : 'text-fg-muted hover:bg-line/5 hover:text-fg')}
                  >
                    {label(item)}
                  </NavLink>
                ))}
              </div>
            );
          })}
        </nav>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-line/[0.07] px-4 py-3 md:px-8">
          <span className="flex items-center gap-2 text-sm font-semibold md:hidden">
            <img src="/favicon.svg" alt="" className="h-6 w-6" /> {t('common.consoleShort')}
          </span>
          <nav aria-label={t('common.consoleSections')} className="order-last -mx-1 flex w-full gap-1 overflow-x-auto md:hidden">
            {items.map((item) => (
              <NavLink key={item.to} to={item.to} end={item.to === '/'} className={({ isActive }) => clsx('whitespace-nowrap rounded-md px-2 py-1 text-sm', isActive ? 'bg-accent/15 text-amber-200' : 'text-fg-muted')}>
                {t(item.label)}
              </NavLink>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-3 text-sm">
            <LanguagePicker />
            <span className="hidden text-fg-muted sm:inline">{me?.name}</span>
            {me && (
              <span className="whitespace-nowrap">
                <Badge tone="warn">{me.role.replace('_', ' ')}</Badge>
              </span>
            )}
            <button type="button" onClick={() => void signOut()} aria-label={t('common.signOut')} className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-md px-2 py-1 text-fg-muted hover:bg-line/10 hover:text-fg">
              <LogOut className="h-4 w-4" aria-hidden /> <span className="hidden sm:inline">{t('common.signOut')}</span>
            </button>
          </div>
        </header>
        <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-6 md:px-8">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
