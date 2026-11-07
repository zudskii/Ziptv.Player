import type { ChangeRequestDto, ChangeRequestPageDto } from '@ziptv/contracts';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Check, Undo2, X } from 'lucide-react';
import { useState } from 'react';

import { Badge, Button, ConfirmDialog, ErrorNote, PageHeader, Pager, Spinner, Tabs } from '../components/ui';
import { api } from '../lib/api';
import { relative } from '../lib/format';
import { useAction } from '../lib/mutation';
import { formatTime } from '../lib/nav';
import { statusLabel, t } from '../i18n';

const kindLabel = (kind: ChangeRequestDto['kind']) => t(`approvals.kind.${kind.replace('.', '_') as 'package_create' | 'package_update' | 'rights_grant' | 'rights_revoke' | 'promo_create'}`);

const STATUS_TONE: Record<ChangeRequestDto['status'], 'neutral' | 'ok' | 'warn' | 'danger' | 'accent'> = {
  pending: 'warn',
  applied: 'ok',
  reviewed: 'ok',
  rejected: 'danger',
  withdrawn: 'neutral',
  failed: 'danger',
};

type Decision = { request: ChangeRequestDto; action: 'approve' | 'reject' | 'withdraw' | 'review' };
const PAGE = 25;

/**
 * 9.6 — four-eyes control. Prices, packages and new rights grants wait here for a second person;
 * emergency rights revocations are applied at once and reviewed here afterwards.
 */
export function ApprovalsPage() {
  const [tab, setTab] = useState<'open' | 'all'>('open');
  const [offset, setOffset] = useState(0);
  const [decision, setDecision] = useState<Decision | null>(null);
  const requests = useQuery({
    queryKey: ['change-requests', tab, offset],
    queryFn: () => api<ChangeRequestPageDto>(`/change-requests?limit=${PAGE}&offset=${offset}${tab === 'open' ? '&status=open' : ''}`),
    placeholderData: keepPreviousData,
    refetchInterval: 30_000,
  });
  const decide = useAction(({ request, action, note }: Decision & { note: string }) => api<ChangeRequestDto>(`/change-requests/${request.id}/${action}`, { method: 'POST', body: note ? { note } : {} }), {
    inlineErrors: true,
    success: (result) => (result.status === 'failed' ? t('approvals.couldNotApply', { error: result.error ?? '' }) : t('approvals.requestStatus', { status: statusLabel(result.status) })),
    invalidate: [['change-requests'], ['overview'], ['packages'], ['package'], ['channel']],
    onSuccess: () => setDecision(null),
  });

  return (
    <>
      <PageHeader title={t('approvals.title')} description={t('approvals.intro')} />
      <Tabs
        label={t('approvals.requests')}
        value={tab}
        onChange={(value) => {
          setTab(value);
          setOffset(0);
        }}
        items={[
          { value: 'open', label: requests.data ? t('approvals.waitingCount', { count: requests.data.open }) : t('approvals.waiting') },
          { value: 'all', label: t('approvals.history') },
        ]}
      />
      <ErrorNote error={requests.error} />
      {requests.isPending ? (
        <Spinner />
      ) : requests.data && requests.data.items.length === 0 ? (
        <p className="card p-6 text-sm text-fg-muted">{tab === 'open' ? t('approvals.noneWaiting') : t('approvals.none')}</p>
      ) : (
        <ul className="space-y-3" aria-label={t('approvals.changeRequests')}>
          {requests.data?.items.map((request) => (
            <li key={request.id} className="card p-4" aria-label={request.summary}>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="mb-1 flex flex-wrap items-center gap-2">
                    <Badge tone={request.mode === 'review' ? 'danger' : 'accent'}>{kindLabel(request.kind)}</Badge>
                    <Badge tone={STATUS_TONE[request.status]}>{request.mode === 'review' && request.status === 'applied' ? t('approvals.awaitingReview') : statusLabel(request.status)}</Badge>
                  </div>
                  <p className="font-medium">{request.summary}</p>
                  <p className="mt-1 text-xs text-fg-muted">
                    {t(request.mode === 'review' ? 'approvals.appliedBy' : 'approvals.requestedBy', { name: request.requestedBy.name, email: request.requestedBy.email, time: formatTime(request.requestedAt), ago: relative(request.requestedAt) })}
                  </p>
                  {request.decidedBy && (
                    <p className="mt-0.5 text-xs text-fg-muted">
                      {t('approvals.decidedBy', { status: statusLabel(request.status), name: request.decidedBy.name, time: formatTime(request.decidedAt) })}
                      {request.decisionNote ? ` — “${request.decisionNote}”` : ''}
                    </p>
                  )}
                  {request.error && <p className="mt-1 text-xs text-red-300">{request.error}</p>}
                  <details className="mt-2 text-xs text-fg-subtle">
                    <summary className="cursor-pointer select-none">{t('approvals.details')}</summary>
                    <pre className="mt-2 overflow-x-auto rounded-lg bg-sunken p-3 font-mono">{JSON.stringify(request.payload, null, 2)}</pre>
                  </details>
                </div>
                <div className="flex shrink-0 flex-wrap gap-2">
                  {request.canDecide && request.mode === 'approval' && (
                    <>
                      <Button tone="primary" onClick={() => setDecision({ request, action: 'approve' })}>
                        <Check className="h-4 w-4" aria-hidden /> {t('approvals.approve')}
                      </Button>
                      <Button tone="danger" onClick={() => setDecision({ request, action: 'reject' })}>
                        <X className="h-4 w-4" aria-hidden /> {t('approvals.reject')}
                      </Button>
                    </>
                  )}
                  {request.canDecide && request.mode === 'review' && (
                    <Button tone="primary" onClick={() => setDecision({ request, action: 'review' })}>
                      <Check className="h-4 w-4" aria-hidden /> {t('approvals.markReviewed')}
                    </Button>
                  )}
                  {request.canWithdraw && (
                    <Button onClick={() => setDecision({ request, action: 'withdraw' })}>
                      <Undo2 className="h-4 w-4" aria-hidden /> {t('approvals.withdraw')}
                    </Button>
                  )}
                  {request.status === 'pending' && !request.canDecide && !request.canWithdraw && <span className="text-xs text-fg-subtle">{t('approvals.waitingRole')}</span>}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
      {requests.data && <Pager offset={offset} limit={PAGE} total={requests.data.total} onChange={setOffset} />}

      <ConfirmDialog
        open={decision !== null}
        title={decision ? { approve: t('approvals.approveTitle'), reject: t('approvals.rejectTitle'), withdraw: t('approvals.withdrawTitle'), review: t('approvals.reviewTitle') }[decision.action] : ''}
        description={decision && <p>{decision.request.summary}</p>}
        confirmLabel={decision ? { approve: t('approvals.approveApply'), reject: t('approvals.reject'), withdraw: t('approvals.withdraw'), review: t('approvals.markReviewed') }[decision.action] : ''}
        tone={decision?.action === 'reject' ? 'danger' : 'primary'}
        note={decision?.action === 'withdraw' ? undefined : { label: decision?.action === 'reject' ? t('approvals.reasonRequired') : t('approvals.noteOptional'), required: decision?.action === 'reject' }}
        busy={decide.isPending}
        error={decide.error}
        onConfirm={(note) => decision && decide.mutate({ ...decision, note })}
        onClose={() => {
          setDecision(null);
          decide.reset();
        }}
      />
    </>
  );
}
