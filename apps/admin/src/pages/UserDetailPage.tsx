import type { AdminUserDetailDto, EntitlementDto, PackageDto, SupportNoteDto, UserBillingDto } from '@ziptv/contracts';
import { useQuery } from '@tanstack/react-query';
import { Ban, Gift, LogOut, MessageSquarePlus, RotateCcw, XCircle } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router';

import { Badge, Button, ConfirmDialog, DataTable, Dialog, ErrorNote, Field, KeyValues, PageHeader, Section, SelectField, Spinner, TextArea } from '../components/ui';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { formatDate, fromDateInput, money, relative } from '../lib/format';
import { useAction } from '../lib/mutation';
import { formatTime } from '../lib/nav';

/** 9.5 — one subscriber: account, sign-ins, subscription, payments, devices, comp access, support notes. */
export function UserDetailPage() {
  const { userId = '' } = useParams();
  const { can } = useAuth();
  const [confirm, setConfirm] = useState(false);
  const user = useQuery({ queryKey: ['user', userId], queryFn: () => api<AdminUserDetailDto>(`/users/${userId}`) });
  const revoke = useAction(() => api<{ revoked: number }>(`/users/${userId}/revoke-sessions`, { method: 'POST' }), {
    inlineErrors: true,
    success: (result) => `Signed out ${result.revoked} device${result.revoked === 1 ? '' : 's'}`,
    invalidate: [['user', userId]],
    onSuccess: () => setConfirm(false),
  });

  if (user.isPending) return <Spinner />;
  if (user.error) return <ErrorNote error={user.error} />;
  const data = user.data;
  return (
    <>
      <Link to="/users" className="text-sm text-fg-muted hover:text-fg">
        ← Subscribers
      </Link>
      <PageHeader
        title={data.email ?? `Guest ${data.id.slice(-8)}`}
        description={`Account ${data.id} · created ${formatTime(data.createdAt)}`}
        actions={
          can('users:write') && data.sessionsList.length > 0 ? (
            <Button tone="danger" onClick={() => setConfirm(true)}>
              <LogOut className="h-4 w-4" aria-hidden /> Sign out all devices
            </Button>
          ) : undefined
        }
      />
      <div className="mb-6 flex flex-wrap gap-2">
        {data.isGuest ? <Badge>Guest</Badge> : <Badge tone={data.emailVerified ? 'ok' : 'neutral'}>{data.emailVerified ? 'Email verified' : 'Email not verified'}</Badge>}
        {data.blocked && <Badge tone="danger">Blocked</Badge>}
        <Badge>Last seen {formatTime(data.lastSeenAt)}</Badge>
      </div>

      {can('billing:read') && <Billing userId={userId} />}
      {can('support:read') && <Notes userId={userId} />}

      <Section title="Signed-in devices">
        <DataTable
          label="Signed-in devices"
          rows={data.sessionsList}
          rowKey={(row) => row.id}
          empty="No signed-in devices."
          columns={[
            { header: 'Device', cell: (row) => <span className="text-fg-muted">{row.userAgent ?? 'Unknown'}</span> },
            { header: 'Signed in', cell: (row) => formatTime(row.createdAt) },
            { header: 'Last active', cell: (row) => formatTime(row.lastSeenAt) },
            { header: 'Expires', cell: (row) => (row.expiresAt ? formatTime(row.expiresAt) : 'Never (guest)') },
          ]}
        />
      </Section>

      <Section title="Own sources">
        <DataTable
          label="Sources"
          rows={data.sourcesList}
          rowKey={(row) => row.id}
          empty="No sources."
          columns={[
            { header: 'Name', cell: (row) => row.name },
            { header: 'Type', cell: (row) => <Badge>{row.type}</Badge> },
            { header: 'Status', cell: (row) => <Badge tone={row.status === 'failed' ? 'danger' : row.status === 'idle' ? 'ok' : 'warn'}>{row.status}</Badge> },
            { header: 'Last sync', cell: (row) => formatTime(row.lastSuccessAt) },
          ]}
        />
      </Section>

      <ConfirmDialog
        open={confirm}
        title="Sign out all devices?"
        description={<p>Every device of this account is signed out and its streams stop. The subscriber is notified. This is recorded in the audit log.</p>}
        confirmLabel="Sign out all devices"
        tone="danger"
        busy={revoke.isPending}
        error={revoke.error}
        onConfirm={() => revoke.mutate(undefined)}
        onClose={() => setConfirm(false)}
      />
    </>
  );
}

type Action = 'refund' | 'cancel' | 'block' | 'unblock' | { revoke: EntitlementDto };

function Billing({ userId }: { userId: string }) {
  const { can } = useAuth();
  const billing = useQuery({ queryKey: ['user-billing', userId], queryFn: () => api<UserBillingDto>(`/users/${userId}/billing`), refetchInterval: 30_000 });
  const [action, setAction] = useState<Action | null>(null);
  const [granting, setGranting] = useState(false);
  const invalidate = [['user-billing', userId], ['user', userId], ['users']];
  const run = useAction(
    async ({ action, note }: { action: Action; note: string }) => {
      if (action === 'refund') return api(`/users/${userId}/subscription/refund`, { method: 'POST' });
      if (action === 'cancel') return api(`/users/${userId}/subscription/cancel`, { method: 'POST' });
      if (action === 'block' || action === 'unblock') return api(`/users/${userId}/block`, { method: 'POST', body: { blocked: action === 'block', ...(note ? { reason: note } : {}) } });
      return api(`/users/${userId}/entitlements/${action.revoke.id}`, { method: 'DELETE' });
    },
    { inlineErrors: true, success: 'Done — recorded in the audit log', invalidate, onSuccess: () => setAction(null) },
  );
  if (billing.isPending) return <Spinner label="Loading billing…" />;
  if (billing.error) return <ErrorNote error={billing.error} />;
  const data = billing.data;
  const sub = data.subscription;
  const writable = can('billing:write');
  const actionCopy = (current: Action) =>
    current === 'refund'
      ? { title: 'Refund the latest payment?', body: 'The processor refunds the last invoice; the subscription ends and its viewings stop when the refund is confirmed.', label: 'Refund', note: undefined }
      : current === 'cancel'
        ? { title: 'Cancel the subscription now?', body: 'Access ends immediately, without a refund.', label: 'Cancel now', note: undefined }
        : current === 'block'
          ? { title: 'Block this account?', body: 'Operator playback stops now and no purchases are possible until it is unblocked.', label: 'Block', note: { label: 'Reason' } }
          : current === 'unblock'
            ? { title: 'Unblock this account?', body: 'Playback and purchases are allowed again.', label: 'Unblock', note: undefined }
            : { title: 'Revoke this complimentary access?', body: 'Viewings it allowed stop now.', label: 'Revoke', note: undefined };

  return (
    <Section
      title="Subscription & billing"
      actions={
        <>
          {writable && (
            <Button onClick={() => setGranting(true)}>
              <Gift className="h-4 w-4" aria-hidden /> Give complimentary access
            </Button>
          )}
          {can('users:write') && (
            <Button tone={data.blocked ? 'ghost' : 'danger'} onClick={() => setAction(data.blocked ? 'unblock' : 'block')}>
              <Ban className="h-4 w-4" aria-hidden /> {data.blocked ? 'Unblock' : 'Block account'}
            </Button>
          )}
        </>
      }
    >
      <div className="space-y-4">
        {data.blocked && <p className="rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-red-300">Blocked{data.blockedReason ? `: ${data.blockedReason}` : ''}</p>}
        {sub ? (
          <div className="card flex flex-wrap items-center justify-between gap-3 p-4">
            <div>
              <p className="font-medium">
                {sub.package.name} <Badge tone={sub.status === 'active' || sub.status === 'trialing' ? 'ok' : 'warn'}>{sub.status.replace('_', ' ')}</Badge> {sub.cancelAtPeriodEnd && <Badge>ends at period end</Badge>}
              </p>
              <p className="mt-1 text-xs text-fg-muted">
                {sub.trialEndsAt ? `Trial until ${formatDate(sub.trialEndsAt)} · ` : ''}Paid until {formatDate(sub.currentPeriodEnd)} · access until {formatDate(sub.accessUntil)}
              </p>
            </div>
            {writable && (
              <div className="flex gap-2">
                <Button onClick={() => setAction('refund')}>
                  <RotateCcw className="h-4 w-4" aria-hidden /> Refund
                </Button>
                <Button tone="danger" onClick={() => setAction('cancel')}>
                  <XCircle className="h-4 w-4" aria-hidden /> Cancel now
                </Button>
              </div>
            )}
          </div>
        ) : (
          <p className="card p-4 text-sm text-fg-muted">No live subscription.</p>
        )}
        <KeyValues
          rows={[
            ['Limits', `${data.limits.maxStreams} stream(s) · ${data.limits.maxDevices} device(s)`],
            ['Playing now', data.playing.length ? data.playing.map((item) => `${item.deviceName} since ${relative(item.startedAt)}`).join(', ') : 'Nothing'],
          ]}
        />
        <DataTable
          label="Access"
          rows={data.entitlements}
          rowKey={(row) => row.id}
          empty="No access entitlements."
          columns={[
            { header: 'Package', cell: (row) => row.package.name },
            { header: 'From', cell: (row) => <Badge tone={row.kind === 'comp' ? 'accent' : 'neutral'}>{row.kind === 'comp' ? 'complimentary' : 'subscription'}</Badge> },
            { header: 'Window', cell: (row) => `${formatDate(row.startsAt)} → ${row.endsAt ? formatDate(row.endsAt) : 'open-ended'}` },
            { header: 'Active', cell: (row) => (row.active ? <Badge tone="ok">yes</Badge> : <Badge>no</Badge>) },
            { header: '', cell: (row) => (writable && row.kind === 'comp' && row.active ? <Button onClick={() => setAction({ revoke: row })}>Revoke</Button> : null) },
          ]}
        />
        <DataTable
          label="Payments"
          rows={data.invoices}
          rowKey={(row) => row.id}
          empty="No payments."
          columns={[
            { header: 'Paid', cell: (row) => formatTime(row.paidAt) },
            { header: 'Period', cell: (row) => `${formatDate(row.periodStart)} → ${formatDate(row.periodEnd)}` },
            { header: 'Amount', cell: (row) => money({ currency: row.currency, amountMinor: row.amountMinor }) },
            { header: 'Status', cell: (row) => <Badge tone={row.status === 'paid' ? 'ok' : 'neutral'}>{row.status}</Badge> },
          ]}
        />
        <DataTable
          label="Playback devices"
          rows={data.devices}
          rowKey={(row) => row.id}
          empty="No playback devices."
          columns={[
            { header: 'Device', cell: (row) => row.name },
            { header: 'Platform', cell: (row) => row.platform },
            { header: 'Added', cell: (row) => formatDate(row.createdAt) },
            { header: 'Last used', cell: (row) => relative(row.lastSeenAt) },
          ]}
        />
      </div>
      {action && (
        <ConfirmDialog
          open
          title={actionCopy(action).title}
          description={<p>{actionCopy(action).body}</p>}
          confirmLabel={actionCopy(action).label}
          tone={action === 'unblock' ? 'primary' : 'danger'}
          note={actionCopy(action).note}
          busy={run.isPending}
          error={run.error}
          onConfirm={(note) => run.mutate({ action, note })}
          onClose={() => setAction(null)}
        />
      )}
      <CompDialog open={granting} userId={userId} onClose={() => setGranting(false)} />
    </Section>
  );
}

function CompDialog({ open, userId, onClose }: { open: boolean; userId: string; onClose: () => void }) {
  const packages = useQuery({ queryKey: ['packages'], queryFn: () => api<PackageDto[]>('/packages'), enabled: open });
  const grant = useAction((body: Record<string, unknown>) => api(`/users/${userId}/entitlements`, { method: 'POST', body }), { inlineErrors: true, success: 'Complimentary access granted', invalidate: [['user-billing', userId]], onSuccess: onClose });
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    grant.mutate({ packageId: String(form.get('package')), endsAt: fromDateInput(String(form.get('ends') ?? '')), note: String(form.get('note') ?? '').trim() });
  };
  return (
    <Dialog open={open} title="Give complimentary access" onClose={onClose}>
      <form className="space-y-4" onSubmit={submit}>
        <SelectField label="Package" name="package" required>
          {packages.data?.map((pkg) => (
            <option key={pkg.id} value={pkg.id}>
              {pkg.name} ({pkg.status})
            </option>
          ))}
        </SelectField>
        <Field label="Until (optional)" name="ends" type="date" />
        <TextArea label="Why (recorded in the audit log)" name="note" required minLength={3} maxLength={500} />
        <ErrorNote error={grant.error} />
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button tone="primary" type="submit" busy={grant.isPending}>
            Grant
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function Notes({ userId }: { userId: string }) {
  const { can } = useAuth();
  const notes = useQuery({ queryKey: ['notes', userId], queryFn: () => api<SupportNoteDto[]>(`/users/${userId}/notes`) });
  const [body, setBody] = useState('');
  const add = useAction((text: string) => api<SupportNoteDto>(`/users/${userId}/notes`, { method: 'POST', body: { body: text } }), { success: 'Note added', invalidate: [['notes', userId], ['support-notes']], onSuccess: () => setBody('') });
  return (
    <Section title="Support notes" description="Internal — never shown to the subscriber.">
      {can('support:write') && (
        <form
          className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-end"
          onSubmit={(event) => {
            event.preventDefault();
            if (body.trim()) add.mutate(body.trim());
          }}
        >
          <div className="flex-1">
            <TextArea label="New note" value={body} onChange={(e) => setBody(e.target.value)} maxLength={4000} />
          </div>
          <Button tone="primary" type="submit" busy={add.isPending} disabled={!body.trim()}>
            <MessageSquarePlus className="h-4 w-4" aria-hidden /> Add note
          </Button>
        </form>
      )}
      <ul className="space-y-2">
        {notes.data?.map((note) => (
          <li key={note.id} className="card p-3 text-sm">
            <p className="whitespace-pre-wrap">{note.body}</p>
            <p className="mt-1 text-xs text-fg-muted">
              {note.author.name} · {formatTime(note.createdAt)}
            </p>
          </li>
        ))}
        {notes.data?.length === 0 && <li className="text-sm text-fg-muted">No notes yet.</li>}
      </ul>
    </Section>
  );
}
