import type { AuditEntryDto, AuditPageDto, AuditVerificationDto } from '@ziptv/contracts';
import { useInfiniteQuery, useMutation } from '@tanstack/react-query';
import { ShieldAlert, ShieldCheck } from 'lucide-react';
import { useState } from 'react';

import { Badge, Button, DataTable, ErrorNote, PageHeader } from '../components/ui';
import { api } from '../lib/api';
import { formatTime } from '../lib/nav';

const ACTIONS = ['', 'staff.login', 'staff.login_failed', 'staff.created', 'staff.updated', 'staff.mfa_enrolled', 'staff.mfa_reset', 'staff.password_changed', 'staff.password_reset', 'staff.logout', 'user.sessions_revoked'];

export function AuditPage() {
  const [action, setAction] = useState('');
  const pages = useInfiniteQuery({
    queryKey: ['audit', action],
    initialPageParam: null as number | null,
    queryFn: ({ pageParam }) => api<AuditPageDto>(`/audit?limit=50${action ? `&action=${encodeURIComponent(action)}` : ''}${pageParam ? `&before=${pageParam}` : ''}`),
    getNextPageParam: (last) => last.nextBefore,
  });
  const verify = useMutation({ mutationFn: () => api<AuditVerificationDto>('/audit/verify') });
  const rows: AuditEntryDto[] = pages.data?.pages.flatMap((page) => page.items) ?? [];

  return (
    <>
      <PageHeader
        title="Audit log"
        description="Append-only and hash-chained: any edit or deletion is detectable."
        actions={
          <Button busy={verify.isPending} onClick={() => verify.mutate()}>
            <ShieldCheck className="h-4 w-4" aria-hidden /> Verify integrity
          </Button>
        }
      />
      {verify.data && (
        <p role="status" className={`mb-4 flex items-center gap-2 rounded-lg px-3 py-2 text-sm ${verify.data.intact ? 'bg-ok/10 text-green-300' : 'bg-danger/10 text-red-300'}`}>
          {verify.data.intact ? <ShieldCheck className="h-4 w-4" aria-hidden /> : <ShieldAlert className="h-4 w-4" aria-hidden />}
          {verify.data.intact
            ? `Intact: ${verify.data.checked} entries verified.`
            : `Broken at entry #${verify.data.brokenAt?.seq}: ${verify.data.brokenAt?.reason}. Treat as a security incident.`}
        </p>
      )}
      <ErrorNote error={verify.error ?? pages.error} />
      <label className="mb-4 flex max-w-xs items-center gap-2 text-sm text-fg-muted">
        Action
        <select className="field" value={action} onChange={(e) => setAction(e.target.value)}>
          {ACTIONS.map((value) => (
            <option key={value} value={value}>
              {value || 'All actions'}
            </option>
          ))}
        </select>
      </label>
      <DataTable
        label="Audit entries"
        rows={rows}
        rowKey={(row) => String(row.seq)}
        empty={pages.isPending ? 'Loading…' : 'No entries.'}
        columns={[
          { header: '#', cell: (row) => <span className="font-mono text-xs text-fg-subtle">{row.seq}</span> },
          { header: 'When', cell: (row) => formatTime(row.occurredAt), className: 'whitespace-nowrap' },
          { header: 'Who', cell: (row) => row.actorEmail ?? '—' },
          { header: 'Action', cell: (row) => <Badge tone={row.action.endsWith('failed') ? 'danger' : 'neutral'}>{row.action}</Badge> },
          { header: 'Target', cell: (row) => (row.targetType ? <span className="font-mono text-xs">{`${row.targetType}:${row.targetId?.slice(-8) ?? ''}`}</span> : '—') },
          { header: 'Details', cell: (row) => <code className="break-all font-mono text-xs text-fg-muted">{JSON.stringify(row.details)}</code> },
          { header: 'IP', cell: (row) => <span className="font-mono text-xs">{row.ip ?? '—'}</span> },
        ]}
      />
      {pages.hasNextPage && (
        <div className="mt-4">
          <Button busy={pages.isFetchingNextPage} onClick={() => void pages.fetchNextPage()}>
            Load older entries
          </Button>
        </div>
      )}
    </>
  );
}
