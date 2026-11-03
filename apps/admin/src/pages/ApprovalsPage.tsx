import type { ChangeRequestDto, ChangeRequestPageDto } from '@ziptv/contracts';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Check, Undo2, X } from 'lucide-react';
import { useState } from 'react';

import { Badge, Button, ConfirmDialog, ErrorNote, PageHeader, Pager, Spinner, Tabs } from '../components/ui';
import { api } from '../lib/api';
import { relative } from '../lib/format';
import { useAction } from '../lib/mutation';
import { formatTime } from '../lib/nav';

const KIND_LABEL: Record<ChangeRequestDto['kind'], string> = {
  'package.create': 'New package',
  'package.update': 'Package change',
  'rights.grant': 'New rights grant',
  'rights.revoke': 'Rights revoked',
};

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
    success: (result) => (result.status === 'failed' ? `Could not apply: ${result.error}` : `Request ${result.status}`),
    invalidate: [['change-requests'], ['overview'], ['packages'], ['package'], ['channel']],
    onSuccess: () => setDecision(null),
  });

  return (
    <>
      <PageHeader title="Approvals" description="Changes to prices, packages and licences are made by two people. You cannot decide on your own requests." />
      <Tabs
        label="Requests"
        value={tab}
        onChange={(value) => {
          setTab(value);
          setOffset(0);
        }}
        items={[
          { value: 'open', label: `Waiting${requests.data ? ` (${requests.data.open})` : ''}` },
          { value: 'all', label: 'History' },
        ]}
      />
      <ErrorNote error={requests.error} />
      {requests.isPending ? (
        <Spinner />
      ) : requests.data && requests.data.items.length === 0 ? (
        <p className="card p-6 text-sm text-fg-muted">{tab === 'open' ? 'Nothing is waiting for a decision.' : 'No requests yet.'}</p>
      ) : (
        <ul className="space-y-3" aria-label="Change requests">
          {requests.data?.items.map((request) => (
            <li key={request.id} className="card p-4" aria-label={request.summary}>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="mb-1 flex flex-wrap items-center gap-2">
                    <Badge tone={request.mode === 'review' ? 'danger' : 'accent'}>{KIND_LABEL[request.kind]}</Badge>
                    <Badge tone={STATUS_TONE[request.status]}>{request.mode === 'review' && request.status === 'applied' ? 'awaiting review' : request.status}</Badge>
                  </div>
                  <p className="font-medium">{request.summary}</p>
                  <p className="mt-1 text-xs text-fg-muted">
                    {request.mode === 'review' ? 'Applied' : 'Requested'} by {request.requestedBy.name} ({request.requestedBy.email}) · {formatTime(request.requestedAt)} ({relative(request.requestedAt)})
                  </p>
                  {request.decidedBy && (
                    <p className="mt-0.5 text-xs text-fg-muted">
                      {request.status} by {request.decidedBy.name} · {formatTime(request.decidedAt)}
                      {request.decisionNote ? ` — “${request.decisionNote}”` : ''}
                    </p>
                  )}
                  {request.error && <p className="mt-1 text-xs text-red-300">{request.error}</p>}
                  <details className="mt-2 text-xs text-fg-subtle">
                    <summary className="cursor-pointer select-none">Details</summary>
                    <pre className="mt-2 overflow-x-auto rounded-lg bg-sunken p-3 font-mono">{JSON.stringify(request.payload, null, 2)}</pre>
                  </details>
                </div>
                <div className="flex shrink-0 flex-wrap gap-2">
                  {request.canDecide && request.mode === 'approval' && (
                    <>
                      <Button tone="primary" onClick={() => setDecision({ request, action: 'approve' })}>
                        <Check className="h-4 w-4" aria-hidden /> Approve
                      </Button>
                      <Button tone="danger" onClick={() => setDecision({ request, action: 'reject' })}>
                        <X className="h-4 w-4" aria-hidden /> Reject
                      </Button>
                    </>
                  )}
                  {request.canDecide && request.mode === 'review' && (
                    <Button tone="primary" onClick={() => setDecision({ request, action: 'review' })}>
                      <Check className="h-4 w-4" aria-hidden /> Mark reviewed
                    </Button>
                  )}
                  {request.canWithdraw && (
                    <Button onClick={() => setDecision({ request, action: 'withdraw' })}>
                      <Undo2 className="h-4 w-4" aria-hidden /> Withdraw
                    </Button>
                  )}
                  {request.status === 'pending' && !request.canDecide && !request.canWithdraw && <span className="text-xs text-fg-subtle">Waiting for someone with the right role</span>}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
      {requests.data && <Pager offset={offset} limit={PAGE} total={requests.data.total} onChange={setOffset} />}

      <ConfirmDialog
        open={decision !== null}
        title={decision ? { approve: 'Approve this change?', reject: 'Reject this change?', withdraw: 'Withdraw your request?', review: 'Mark as reviewed?' }[decision.action] : ''}
        description={decision && <p>{decision.request.summary}</p>}
        confirmLabel={decision ? { approve: 'Approve and apply', reject: 'Reject', withdraw: 'Withdraw', review: 'Mark reviewed' }[decision.action] : ''}
        tone={decision?.action === 'reject' ? 'danger' : 'primary'}
        note={decision?.action === 'withdraw' ? undefined : { label: decision?.action === 'reject' ? 'Reason (required)' : 'Note (optional)', required: decision?.action === 'reject' }}
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
