import type { SecurityOverviewDto } from '@ziptv/contracts';
import { useQuery } from '@tanstack/react-query';

import { Badge, DataTable, ErrorNote, Section, Stat } from '../components/ui';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { relative } from '../lib/format';
import { formatTime } from '../lib/nav';

/** 9.9 — staff security: 2FA, locks, sessions, failed sign-ins. */
export function SecurityPanel() {
  const { can } = useAuth();
  // The staff roster comes only with staff:read (auditors see the events, not the accounts).
  const roster = can('staff:read');
  const security = useQuery({
    queryKey: ['security'],
    queryFn: () => api<SecurityOverviewDto>('/security/overview'),
    refetchInterval: 60_000,
  });
  const data = security.data;
  return (
    <>
      <ErrorNote error={security.error} />
      {data && (
        <>
          <div className="mb-6 grid gap-4 sm:grid-cols-3">
            <Stat label="Failed sign-ins (24 h)" value={data.failedLogins24h} tone={data.failedLogins24h > 10 ? 'danger' : data.failedLogins24h > 0 ? 'warn' : undefined} />
            {roster && (
              <>
                <Stat
                  label="Without 2FA"
                  value={data.staff.filter((row) => !row.mfaEnabled && !row.disabled).length}
                  tone={data.staff.some((row) => !row.mfaEnabled && !row.disabled) ? 'warn' : undefined}
                />
                <Stat label="Locked now" value={data.staff.filter((row) => row.lockedUntil).length} />
              </>
            )}
          </div>
          {roster && (
            <Section title="Staff accounts">
              <DataTable
                label="Staff security"
                rows={data.staff}
                rowKey={(row) => row.id}
                columns={[
                  {
                    header: 'Staff',
                    cell: (row) => (
                      <div>
                        <p className="font-medium">{row.name}</p>
                        <p className="text-xs text-fg-muted">{row.email}</p>
                      </div>
                    ),
                  },
                  {
                    header: 'Role',
                    cell: (row) => <Badge>{row.role.replace('_', ' ')}</Badge>,
                  },
                  {
                    header: '2FA',
                    cell: (row) => (row.mfaEnabled ? <Badge tone="ok">on</Badge> : <Badge tone="warn">not set up</Badge>),
                  },
                  {
                    header: 'State',
                    cell: (row) =>
                      row.disabled ? (
                        <Badge tone="danger">disabled</Badge>
                      ) : row.lockedUntil ? (
                        <Badge tone="danger">locked until {formatTime(row.lockedUntil)}</Badge>
                      ) : (
                        <Badge tone="ok">active</Badge>
                      ),
                  },
                  {
                    header: 'Sessions',
                    cell: (row) => row.activeSessions,
                    className: 'tabular-nums',
                  },
                  {
                    header: 'Last sign-in',
                    cell: (row) => relative(row.lastLoginAt),
                  },
                ]}
              />
            </Section>
          )}
          <Section title="Recent failed sign-ins">
            <DataTable
              label="Failed sign-ins"
              rows={data.recentFailures}
              rowKey={(row) => String(row.seq)}
              empty="None."
              columns={[
                {
                  header: 'When',
                  cell: (row) => formatTime(row.occurredAt),
                  className: 'whitespace-nowrap',
                },
                { header: 'Account', cell: (row) => row.actorEmail ?? '—' },
                {
                  header: 'Reason',
                  cell: (row) => String(row.details.reason ?? '—'),
                },
                {
                  header: 'IP',
                  cell: (row) => <code className="text-xs">{row.ip ?? '—'}</code>,
                },
              ]}
            />
          </Section>
        </>
      )}
    </>
  );
}
