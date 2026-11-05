import type { FeedHealthState, SystemOverviewDto } from '@ziptv/contracts';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';

import { ErrorNote, PageHeader, Section, Spinner, Stat } from '../components/ui';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { moneyList } from '../lib/format';
import { formatTime } from '../lib/nav';
import { t } from '../i18n';

const HEALTH_ORDER: { state: FeedHealthState; tone?: 'warn' | 'danger' }[] = [
  { state: 'HEALTHY' },
  { state: 'UNHEALTHY', tone: 'danger' },
  { state: 'PROVIDER_OUTAGE', tone: 'danger' },
  { state: 'GEO_BLOCKED', tone: 'warn' },
  { state: 'NOT_ENTITLED', tone: 'warn' },
  { state: 'MAINTENANCE' },
  { state: 'UNKNOWN' },
];

/** 9.1 — the operator's day at a glance: viewing, catalog health, revenue, things waiting for a decision. */
export function OverviewPage() {
  const { can } = useAuth();
  const overview = useQuery({ queryKey: ['overview'], queryFn: () => api<SystemOverviewDto>('/system/overview'), refetchInterval: 30_000 });
  const data = overview.data;
  const feeds = data ? Object.values(data.channels.feeds).reduce((sum, value) => sum + value, 0) : 0;
  const healthy = data?.channels.feeds.HEALTHY ?? 0;
  return (
    <>
      <PageHeader title={t('overview.title')} description={data ? t('overview.updated', { time: formatTime(data.generatedAt) }) : undefined} />
      {overview.isPending && <Spinner />}
      <ErrorNote error={overview.error} />
      {data && (
        <>
          {data.approvals.open > 0 && (
            <Link to="/approvals" className="mb-6 flex items-center justify-between rounded-xl border border-accent/30 bg-accent/10 px-4 py-3 text-sm text-amber-200 hover:bg-accent/15">
              <span>
                {t('overview.waiting', { count: data.approvals.open })}
              </span>
              <span aria-hidden>→</span>
            </Link>
          )}
          <Section title={t('overview.viewing')}>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <Stat label={t('overview.watchingNow')} value={data.viewers.playingNow} note="Authorized operator viewings" />
              <Stat label={t('overview.viewings24')} value={data.viewers.started24h} />
              <Stat label={t('overview.subscribers')} value={data.users.total} note={t('overview.usersNote', { registered: data.users.registered, active: data.users.activeLast24h })} />
              <Stat label={t('overview.devices')} value={data.sessions.active} />
            </div>
          </Section>
          <Section title={t('overview.channels')} description={t('overview.channelsHint')}>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <Stat label={t('overview.activeChannels')} value={data.channels.active} />
              <Stat label={t('overview.healthyFeeds')} value={feeds ? `${healthy} / ${feeds}` : '—'} tone={feeds && healthy < feeds ? 'warn' : undefined} />
              <Stat label={t('overview.openIncidents')} value={data.channels.openIncidents} tone={data.channels.openIncidents > 0 ? 'danger' : undefined} />
              <Stat label={t('overview.failingSources')} value={data.sources.failing} tone={data.sources.failing > 0 ? 'warn' : undefined} note={t('overview.sourcesNote', { total: data.sources.total })} />
            </div>
            {feeds > 0 && (
              <ul className="mt-3 flex flex-wrap gap-2 text-xs" aria-label={t('overview.feedsByHealth')}>
                {HEALTH_ORDER.filter((item) => data.channels.feeds[item.state] > 0).map((item) => (
                  <li key={item.state} className={`rounded-md px-2 py-1 ${item.tone === 'danger' ? 'bg-danger/15 text-red-300' : item.tone === 'warn' ? 'bg-accent/15 text-amber-300' : 'bg-line/10 text-fg-muted'}`}>
                    {t(`overview.health.${item.state}`)}: {data.channels.feeds[item.state]}
                  </li>
                ))}
              </ul>
            )}
          </Section>
          {data.revenue && (
            <Section title={t('overview.revenue')} description={t('overview.revenueHint')} actions={can('billing:read') ? <Link className="text-sm text-amber-200 hover:underline" to="/finance">{t('overview.financeLink')}</Link> : undefined}>
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                <Stat label={t('overview.mrr')} value={moneyList(data.revenue.mrr)} />
                <Stat label={t('overview.paying')} value={data.revenue.activeSubscriptions} />
                <Stat label={t('overview.trials')} value={data.revenue.trialing} />
                <Stat label={t('overview.paymentProblems')} value={data.revenue.inDunning} tone={data.revenue.inDunning > 0 ? 'warn' : undefined} note="Past due or in grace" />
              </div>
            </Section>
          )}
          <Section title={t('overview.system')}>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <Stat label={t('overview.staff')} value={data.staff.total} />
              <Stat label={t('overview.staffNo2fa')} value={data.staff.withoutMfa} tone={data.staff.withoutMfa > 0 ? 'warn' : undefined} note="Not signed in yet" />
              <Stat label={t('overview.outboxPending')} value={data.outbox.pending} />
              <Stat label={t('overview.outboxFailing')} value={data.outbox.failing} tone={data.outbox.failing > 0 ? 'danger' : undefined} />
            </div>
          </Section>
        </>
      )}
    </>
  );
}
