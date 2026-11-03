import type { FeedHealthState, SystemOverviewDto } from '@ziptv/contracts';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';

import { ErrorNote, PageHeader, Section, Spinner, Stat } from '../components/ui';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { moneyList } from '../lib/format';
import { formatTime } from '../lib/nav';

const HEALTH_ORDER: { state: FeedHealthState; label: string; tone?: 'warn' | 'danger' }[] = [
  { state: 'HEALTHY', label: 'Healthy' },
  { state: 'UNHEALTHY', label: 'Unhealthy', tone: 'danger' },
  { state: 'PROVIDER_OUTAGE', label: 'Provider outage', tone: 'danger' },
  { state: 'GEO_BLOCKED', label: 'Geo-blocked', tone: 'warn' },
  { state: 'NOT_ENTITLED', label: 'Not entitled', tone: 'warn' },
  { state: 'MAINTENANCE', label: 'Maintenance' },
  { state: 'UNKNOWN', label: 'Unknown' },
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
      <PageHeader title="Overview" description={data ? `Updated ${formatTime(data.generatedAt)} · refreshes every 30 s` : undefined} />
      {overview.isPending && <Spinner />}
      <ErrorNote error={overview.error} />
      {data && (
        <>
          {data.approvals.open > 0 && (
            <Link to="/approvals" className="mb-6 flex items-center justify-between rounded-xl border border-accent/30 bg-accent/10 px-4 py-3 text-sm text-amber-200 hover:bg-accent/15">
              <span>
                {data.approvals.open} change{data.approvals.open === 1 ? '' : 's'} waiting for a second person
              </span>
              <span aria-hidden>→</span>
            </Link>
          )}
          <Section title="Viewing">
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <Stat label="Watching now" value={data.viewers.playingNow} note="Authorized operator viewings" />
              <Stat label="Viewings (24 h)" value={data.viewers.started24h} />
              <Stat label="Subscribers" value={data.users.total} note={`${data.users.registered} with an account · ${data.users.activeLast24h} active in 24 h`} />
              <Stat label="Signed-in devices" value={data.sessions.active} />
            </div>
          </Section>
          <Section title="Channels" description="Playable feeds of the operator catalog by health (regions combined).">
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <Stat label="Active channels" value={data.channels.active} />
              <Stat label="Healthy feeds" value={feeds ? `${healthy} / ${feeds}` : '—'} tone={feeds && healthy < feeds ? 'warn' : undefined} />
              <Stat label="Open incidents" value={data.channels.openIncidents} tone={data.channels.openIncidents > 0 ? 'danger' : undefined} />
              <Stat label="Failing BYO sources" value={data.sources.failing} tone={data.sources.failing > 0 ? 'warn' : undefined} note={`${data.sources.total} subscriber sources`} />
            </div>
            {feeds > 0 && (
              <ul className="mt-3 flex flex-wrap gap-2 text-xs" aria-label="Feeds by health">
                {HEALTH_ORDER.filter((item) => data.channels.feeds[item.state] > 0).map((item) => (
                  <li key={item.state} className={`rounded-md px-2 py-1 ${item.tone === 'danger' ? 'bg-danger/15 text-red-300' : item.tone === 'warn' ? 'bg-accent/15 text-amber-300' : 'bg-line/10 text-fg-muted'}`}>
                    {item.label}: {data.channels.feeds[item.state]}
                  </li>
                ))}
              </ul>
            )}
          </Section>
          {data.revenue && (
            <Section title="Revenue" description="Monthly recurring revenue from what paying subscribers pay (yearly plans ÷ 12)." actions={can('billing:read') ? <Link className="text-sm text-amber-200 hover:underline" to="/finance">Finance →</Link> : undefined}>
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                <Stat label="MRR" value={moneyList(data.revenue.mrr)} />
                <Stat label="Paying subscriptions" value={data.revenue.activeSubscriptions} />
                <Stat label="Free trials" value={data.revenue.trialing} />
                <Stat label="Payment problems" value={data.revenue.inDunning} tone={data.revenue.inDunning > 0 ? 'warn' : undefined} note="Past due or in grace" />
              </div>
            </Section>
          )}
          <Section title="System">
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <Stat label="Staff" value={data.staff.total} />
              <Stat label="Staff without 2FA" value={data.staff.withoutMfa} tone={data.staff.withoutMfa > 0 ? 'warn' : undefined} note="Not signed in yet" />
              <Stat label="Outbox pending" value={data.outbox.pending} />
              <Stat label="Outbox failing" value={data.outbox.failing} tone={data.outbox.failing > 0 ? 'danger' : undefined} />
            </div>
          </Section>
        </>
      )}
    </>
  );
}
