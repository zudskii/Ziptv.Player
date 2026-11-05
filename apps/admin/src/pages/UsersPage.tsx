import type { AdminUserPageDto } from '@ziptv/contracts';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Search } from 'lucide-react';
import { useDeferredValue, useState } from 'react';
import { Link } from 'react-router';

import { Badge, Button, DataTable, ErrorNote, PageHeader } from '../components/ui';
import { api } from '../lib/api';
import { formatTime } from '../lib/nav';
import { statusLabel, t } from '../i18n';

const PAGE = 25;

export function UsersPage() {
  const [text, setText] = useState('');
  const query = useDeferredValue(text.trim());
  const [offset, setOffset] = useState(0);
  const users = useQuery({
    queryKey: ['users', query, offset],
    queryFn: () => api<AdminUserPageDto>(`/users?limit=${PAGE}&offset=${offset}${query ? `&q=${encodeURIComponent(query)}` : ''}`),
    placeholderData: keepPreviousData,
  });

  return (
    <>
      <PageHeader title={t('common.subscribers')} description={users.data ? `${users.data.total} accounts` : undefined} />
      <label className="relative mb-4 block max-w-md">
        <span className="sr-only">{t('users.search')}</span>
        <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-fg-subtle" aria-hidden />
        <input
          className="field pl-9"
          placeholder={t('users.placeholder')}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setOffset(0);
          }}
        />
      </label>
      <ErrorNote error={users.error} />
      <DataTable
        label={t('common.subscribers')}
        rows={users.data?.items ?? []}
        rowKey={(row) => row.id}
        empty={users.isPending ? t('common.loading') : t('users.noMatch')}
        columns={[
          {
            header: t('common.account'),
            cell: (row) => (
              <Link to={`/users/${row.id}`} className="font-medium text-amber-200 hover:underline">
                {row.email ?? t('people.guestId', { id: row.id.slice(-8) })}
              </Link>
            ),
          },
          { header: t('common.type'), cell: (row) => (row.isGuest ? <Badge>{t('users.guest')}</Badge> : <Badge tone={row.emailVerified ? 'ok' : 'neutral'}>{row.emailVerified ? t('users.verified') : t('users.registered')}</Badge>) },
          { header: t('common.subscription'), cell: (row) => (row.blocked ? <Badge tone="danger">{t('users.blocked')}</Badge> : row.subscription ? <Badge tone={row.subscription === 'active' || row.subscription === 'trialing' ? 'ok' : 'warn'}>{statusLabel(row.subscription)}</Badge> : <span className="text-fg-subtle">—</span>) },
          { header: t('users.sources'), cell: (row) => row.sources, className: 'tabular-nums' },
          { header: t('common.devices'), cell: (row) => row.sessions, className: 'tabular-nums' },
          { header: t('common.lastSeen'), cell: (row) => formatTime(row.lastSeenAt), className: 'whitespace-nowrap' },
        ]}
      />
      {users.data && users.data.total > PAGE && (
        <div className="mt-4 flex items-center gap-3 text-sm text-fg-muted">
          <Button disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>
            {t('users.previous')}
          </Button>
          <span>
            {t('common.range', { from: offset + 1, to: Math.min(offset + PAGE, users.data.total), total: users.data.total })}
          </span>
          <Button disabled={offset + PAGE >= users.data.total} onClick={() => setOffset(offset + PAGE)}>
            {t('users.next')}
          </Button>
        </div>
      )}
    </>
  );
}
