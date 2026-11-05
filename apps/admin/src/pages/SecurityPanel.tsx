import type { SecurityOverviewDto } from '@ziptv/contracts';
import { useQuery } from '@tanstack/react-query';

import { Badge, DataTable, ErrorNote, Section, Stat } from '../components/ui';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { relative } from '../lib/format';
import { formatTime } from '../lib/nav';
import { t } from '../i18n';

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
            <Stat label={t('security.failed24')} value={data.failedLogins24h} tone={data.failedLogins24h > 10 ? 'danger' : data.failedLogins24h > 0 ? 'warn' : undefined} />
            {roster && (
              <>
                <Stat
                  label={t('security.no2fa')}
                  value={data.staff.filter((row) => !row.mfaEnabled && !row.disabled).length}
                  tone={data.staff.some((row) => !row.mfaEnabled && !row.disabled) ? 'warn' : undefined}
                />
                <Stat label={t('security.lockedNow')} value={data.staff.filter((row) => row.lockedUntil).length} />
              </>
            )}
          </div>
          {roster && (
            <Section title={t('security.staffAccounts')}>
              <DataTable
                label={t('security.staffSecurity')}
                rows={data.staff}
                rowKey={(row) => row.id}
                columns={[
                  {
                    header: t('security.staff'),
                    cell: (row) => (
                      <div>
                        <p className="font-medium">{row.name}</p>
                        <p className="text-xs text-fg-muted">{row.email}</p>
                      </div>
                    ),
                  },
                  {
                    header: t('security.role'),
                    cell: (row) => <Badge>{row.role.replace('_', ' ')}</Badge>,
                  },
                  {
                    header: '2FA',
                    cell: (row) => (row.mfaEnabled ? <Badge tone="ok">{t('security.on')}</Badge> : <Badge tone="warn">{t('security.notSetUp')}</Badge>),
                  },
                  {
                    header: t('security.state'),
                    cell: (row) =>
                      row.disabled ? (
                        <Badge tone="danger">{t('security.disabled')}</Badge>
                      ) : row.lockedUntil ? (
                        <Badge tone="danger">{t('security.lockedUntil', { time: formatTime(row.lockedUntil) })}</Badge>
                      ) : (
                        <Badge tone="ok">{t('security.active')}</Badge>
                      ),
                  },
                  {
                    header: t('security.sessions'),
                    cell: (row) => row.activeSessions,
                    className: 'tabular-nums',
                  },
                  {
                    header: t('security.lastSignIn'),
                    cell: (row) => relative(row.lastLoginAt),
                  },
                ]}
              />
            </Section>
          )}
          <Section title={t('security.recentFailed')}>
            <DataTable
              label={t('security.failed')}
              rows={data.recentFailures}
              rowKey={(row) => String(row.seq)}
              empty={t('security.none')}
              columns={[
                {
                  header: t('security.when'),
                  cell: (row) => formatTime(row.occurredAt),
                  className: 'whitespace-nowrap',
                },
                { header: t('security.account'), cell: (row) => row.actorEmail ?? '—' },
                {
                  header: t('security.reason'),
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
