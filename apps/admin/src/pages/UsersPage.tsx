import type { AdminUserPageDto } from '@ziptv/contracts';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Search } from 'lucide-react';
import { useDeferredValue, useState } from 'react';
import { Link } from 'react-router';

import { Badge, Button, DataTable, ErrorNote, PageHeader } from '../components/ui';
import { api } from '../lib/api';
import { formatTime } from '../lib/nav';

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
      <PageHeader title="Subscribers" description={users.data ? `${users.data.total} accounts` : undefined} />
      <label className="relative mb-4 block max-w-md">
        <span className="sr-only">Search subscribers</span>
        <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-fg-subtle" aria-hidden />
        <input
          className="field pl-9"
          placeholder="Email or account id"
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setOffset(0);
          }}
        />
      </label>
      <ErrorNote error={users.error} />
      <DataTable
        label="Subscribers"
        rows={users.data?.items ?? []}
        rowKey={(row) => row.id}
        empty={users.isPending ? 'Loading…' : 'No subscribers match.'}
        columns={[
          {
            header: 'Account',
            cell: (row) => (
              <Link to={`/users/${row.id}`} className="font-medium text-amber-200 hover:underline">
                {row.email ?? `Guest ${row.id.slice(-8)}`}
              </Link>
            ),
          },
          { header: 'Type', cell: (row) => (row.isGuest ? <Badge>Guest</Badge> : <Badge tone={row.emailVerified ? 'ok' : 'neutral'}>{row.emailVerified ? 'Verified' : 'Registered'}</Badge>) },
          { header: 'Sources', cell: (row) => row.sources, className: 'tabular-nums' },
          { header: 'Devices', cell: (row) => row.sessions, className: 'tabular-nums' },
          { header: 'Last seen', cell: (row) => formatTime(row.lastSeenAt), className: 'whitespace-nowrap' },
        ]}
      />
      {users.data && users.data.total > PAGE && (
        <div className="mt-4 flex items-center gap-3 text-sm text-fg-muted">
          <Button disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>
            Previous
          </Button>
          <span>
            {offset + 1}–{Math.min(offset + PAGE, users.data.total)} of {users.data.total}
          </span>
          <Button disabled={offset + PAGE >= users.data.total} onClick={() => setOffset(offset + PAGE)}>
            Next
          </Button>
        </div>
      )}
    </>
  );
}
