import type { SystemOverviewDto } from '@ziptv/contracts';
import { useQuery } from '@tanstack/react-query';

import { ErrorNote, PageHeader, Spinner, Stat } from '../components/ui';
import { api } from '../lib/api';
import { formatTime } from '../lib/nav';

export function OverviewPage() {
  const overview = useQuery({ queryKey: ['overview'], queryFn: () => api<SystemOverviewDto>('/system/overview'), refetchInterval: 30_000 });
  const data = overview.data;
  return (
    <>
      <PageHeader title="Overview" description={data ? `Updated ${formatTime(data.generatedAt)}` : undefined} />
      {overview.isPending && <Spinner />}
      <ErrorNote error={overview.error} />
      {data && (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Stat label="Subscribers" value={data.users.total} note={`${data.users.registered} registered · ${data.users.activeLast24h} active in 24 h`} />
          <Stat label="Active sessions" value={data.sessions.active} />
          <Stat label="Sources" value={data.sources.total} note={`${data.sources.syncing} syncing`} />
          <Stat label="Failing sources" value={data.sources.failing} tone={data.sources.failing > 0 ? 'warn' : undefined} />
          <Stat label="Staff" value={data.staff.total} />
          <Stat label="Staff without 2FA" value={data.staff.withoutMfa} tone={data.staff.withoutMfa > 0 ? 'warn' : undefined} note="Not signed in yet" />
          <Stat label="Outbox pending" value={data.outbox.pending} />
          <Stat label="Outbox failing" value={data.outbox.failing} tone={data.outbox.failing > 0 ? 'danger' : undefined} />
        </div>
      )}
    </>
  );
}
