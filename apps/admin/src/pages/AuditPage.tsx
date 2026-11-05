import type { AuditEntryDto, AuditPageDto, AuditVerificationDto } from '@ziptv/contracts';
import { useInfiniteQuery, useMutation } from '@tanstack/react-query';
import { ShieldAlert, ShieldCheck } from 'lucide-react';
import { useState } from 'react';

import { Badge, Button, DataTable, ErrorNote, PageHeader, Tabs } from '../components/ui';
import { SecurityPanel } from './SecurityPanel';
import { api } from '../lib/api';
import { formatTime } from '../lib/nav';
import { t } from '../i18n';

const ACTIONS = [
  '',
  'staff.login',
  'staff.login_failed',
  'staff.created',
  'staff.updated',
  'staff.mfa_enrolled',
  'staff.mfa_reset',
  'staff.password_changed',
  'staff.password_reset',
  'staff.logout',
  'user.sessions_revoked',
  'user.blocked',
  'user.unblocked',
  'change.requested',
  'change.approved',
  'change.rejected',
  'change.withdrawn',
  'change.failed',
  'change.awaiting_review',
  'change.reviewed',
  'package.created',
  'package.updated',
  'rights.granted',
  'rights.revoked',
  'entitlement.granted',
  'entitlement.revoked',
  'subscription.refund_requested',
  'subscription.canceled',
  'provider.created',
  'provider.updated',
  'channel.created',
  'channel.updated',
  'epg.guide_created',
  'epg.mapping_set',
  'support.note_added',
];

/** 9.9 — the tamper-evident audit trail and staff security. */
export function AuditPage() {
  const [tab, setTab] = useState<'log' | 'security'>('log');
  return (
    <>
      <PageHeader title={t('audit.title')} description={t('audit.intro')} />
      <Tabs
        label={t('audit.audit')}
        value={tab}
        onChange={setTab}
        items={[
          { value: 'log', label: t('audit.log') },
          { value: 'security', label: t('audit.staffSecurity') },
        ]}
      />
      {tab === 'log' ? <AuditLog /> : <SecurityPanel />}
    </>
  );
}

function AuditLog() {
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
      <div className="mb-4 flex justify-end">
        <Button busy={verify.isPending} onClick={() => verify.mutate()}>
          <ShieldCheck className="h-4 w-4" aria-hidden /> {t('audit.verify')}
        </Button>
      </div>
      {verify.data && (
        <p role="status" className={`mb-4 flex items-center gap-2 rounded-lg px-3 py-2 text-sm ${verify.data.intact ? 'bg-ok/10 text-green-300' : 'bg-danger/10 text-red-300'}`}>
          {verify.data.intact ? <ShieldCheck className="h-4 w-4" aria-hidden /> : <ShieldAlert className="h-4 w-4" aria-hidden />}
          {verify.data.intact
            ? t('auditx.intact', { count: verify.data.checked })
            : t('auditx.broken', { seq: verify.data.brokenAt?.seq ?? '?', reason: verify.data.brokenAt?.reason ?? '' })}
        </p>
      )}
      <ErrorNote error={verify.error ?? pages.error} />
      <label className="mb-4 flex max-w-xs items-center gap-2 text-sm text-fg-muted">
        {t('common.action')}
        <select className="field" value={action} onChange={(e) => setAction(e.target.value)}>
          {ACTIONS.map((value) => (
            <option key={value} value={value}>
              {value || t('audit.allActions')}
            </option>
          ))}
        </select>
      </label>
      <DataTable
        label={t('audit.entries')}
        rows={rows}
        rowKey={(row) => String(row.seq)}
        empty={pages.isPending ? t('common.loading') : t('audit.none')}
        columns={[
          { header: '#', cell: (row) => <span className="font-mono text-xs text-fg-subtle">{row.seq}</span> },
          { header: t('common.when'), cell: (row) => formatTime(row.occurredAt), className: 'whitespace-nowrap' },
          { header: t('audit.who'), cell: (row) => row.actorEmail ?? '—' },
          { header: t('common.action'), cell: (row) => <Badge tone={row.action.endsWith('failed') ? 'danger' : 'neutral'}>{row.action}</Badge> },
          { header: t('common.target'), cell: (row) => (row.targetType ? <span className="font-mono text-xs">{`${row.targetType}:${row.targetId?.slice(-8) ?? ''}`}</span> : '—') },
          { header: t('common.details'), cell: (row) => <code className="break-all font-mono text-xs text-fg-muted">{JSON.stringify(row.details)}</code> },
          { header: 'IP', cell: (row) => <span className="font-mono text-xs">{row.ip ?? '—'}</span> },
        ]}
      />
      {pages.hasNextPage && (
        <div className="mt-4">
          <Button busy={pages.isFetchingNextPage} onClick={() => void pages.fetchNextPage()}>
            {t('audit.older')}
          </Button>
        </div>
      )}
    </>
  );
}
