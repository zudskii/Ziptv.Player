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
import { statusLabel, t } from '../i18n';

/** 9.5 — one subscriber: account, sign-ins, subscription, payments, devices, comp access, support notes. */
export function UserDetailPage() {
  const { userId = '' } = useParams();
  const { can } = useAuth();
  const [confirm, setConfirm] = useState(false);
  const user = useQuery({ queryKey: ['user', userId], queryFn: () => api<AdminUserDetailDto>(`/users/${userId}`) });
  const revoke = useAction(() => api<{ revoked: number }>(`/users/${userId}/revoke-sessions`, { method: 'POST' }), {
    inlineErrors: true,
    success: (result) => t('people.signedOutDevices', { count: result.revoked }),
    invalidate: [['user', userId]],
    onSuccess: () => setConfirm(false),
  });

  if (user.isPending) return <Spinner />;
  if (user.error) return <ErrorNote error={user.error} />;
  const data = user.data;
  return (
    <>
      <Link to="/users" className="text-sm text-fg-muted hover:text-fg">
        {t('userdetail.back')}
      </Link>
      <PageHeader
        title={data.email ?? t('people.guestId', { id: data.id.slice(-8) })}
        description={t('people.accountMeta', { id: data.id, time: formatTime(data.createdAt) })}
        actions={
          can('users:write') && data.sessionsList.length > 0 ? (
            <Button tone="danger" onClick={() => setConfirm(true)}>
              <LogOut className="h-4 w-4" aria-hidden /> {t('userdetail.signOutAll')}
            </Button>
          ) : undefined
        }
      />
      <div className="mb-6 flex flex-wrap gap-2">
        {data.isGuest ? <Badge>{t('userdetail.guest')}</Badge> : <Badge tone={data.emailVerified ? 'ok' : 'neutral'}>{data.emailVerified ? t('userdetail.emailVerified') : t('userdetail.emailNotVerified')}</Badge>}
        {data.blocked && <Badge tone="danger">{t('userdetail.blocked')}</Badge>}
        <Badge>{t('people.lastSeen', { time: formatTime(data.lastSeenAt) })}</Badge>
      </div>

      {can('billing:read') && <Billing userId={userId} />}
      {can('support:read') && <Notes userId={userId} />}

      <Section title={t('userdetail.signedInDevices')}>
        <DataTable
          label={t('userdetail.signedInDevices')}
          rows={data.sessionsList}
          rowKey={(row) => row.id}
          empty={t('userdetail.noDevices')}
          columns={[
            { header: t('userdetail.device'), cell: (row) => <span className="text-fg-muted">{row.userAgent ?? t('userdetail.unknown')}</span> },
            { header: t('userdetail.signedIn'), cell: (row) => formatTime(row.createdAt) },
            { header: t('userdetail.lastActive'), cell: (row) => formatTime(row.lastSeenAt) },
            { header: t('userdetail.expires'), cell: (row) => (row.expiresAt ? formatTime(row.expiresAt) : t('userdetail.neverGuest')) },
          ]}
        />
      </Section>

      <Section title={t('userdetail.ownSources')}>
        <DataTable
          label={t('userdetail.sources')}
          rows={data.sourcesList}
          rowKey={(row) => row.id}
          empty={t('userdetail.noSources')}
          columns={[
            { header: t('common.name'), cell: (row) => row.name },
            { header: t('common.type'), cell: (row) => <Badge>{row.type}</Badge> },
            { header: t('common.status'), cell: (row) => <Badge tone={row.status === 'failed' ? 'danger' : row.status === 'idle' ? 'ok' : 'warn'}>{statusLabel(row.status)}</Badge> },
            { header: t('userdetail.lastSync'), cell: (row) => formatTime(row.lastSuccessAt) },
          ]}
        />
      </Section>

      <ConfirmDialog
        open={confirm}
        title={t('userdetail.signOutAllTitle')}
        description={<p>{t('userdetail.signOutAllHint')}</p>}
        confirmLabel={t('userdetail.signOutAll')}
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
    { inlineErrors: true, success: t('userdetail.done'), invalidate, onSuccess: () => setAction(null) },
  );
  if (billing.isPending) return <Spinner label={t('userdetail.loadingBilling')} />;
  if (billing.error) return <ErrorNote error={billing.error} />;
  const data = billing.data;
  const sub = data.subscription;
  const writable = can('billing:write');
  const actionCopy = (current: Action) =>
    current === 'refund'
      ? { title: t('userdetail.refundTitle'), body: t('userdetail.refundHint'), label: t('userdetail.refund'), note: undefined }
      : current === 'cancel'
        ? { title: t('userdetail.cancelTitle'), body: t('userdetail.cancelHint'), label: t('userdetail.cancelNow'), note: undefined }
        : current === 'block'
          ? { title: t('userdetail.blockTitle'), body: t('userdetail.blockHint'), label: t('userdetail.block'), note: { label: t('common.reason') } }
          : current === 'unblock'
            ? { title: t('userdetail.unblockTitle'), body: t('userdetail.unblockHint'), label: t('userdetail.unblock'), note: undefined }
            : { title: t('userdetail.revokeTitle'), body: t('userdetail.revokeHint'), label: t('userdetail.revoke'), note: undefined };

  return (
    <Section
      title={t('userdetail.billing')}
      actions={
        <>
          {writable && (
            <Button onClick={() => setGranting(true)}>
              <Gift className="h-4 w-4" aria-hidden /> {t('userdetail.giveComp')}
            </Button>
          )}
          {can('users:write') && (
            <Button tone={data.blocked ? 'ghost' : 'danger'} onClick={() => setAction(data.blocked ? 'unblock' : 'block')}>
              <Ban className="h-4 w-4" aria-hidden /> {data.blocked ? t('userdetail.unblock') : t('userdetail.blockAccount')}
            </Button>
          )}
        </>
      }
    >
      <div className="space-y-4">
        {data.blocked && <p className="rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-red-300">{t('userdetail.blocked')}{data.blockedReason ? `: ${data.blockedReason}` : ''}</p>}
        {sub ? (
          <div className="card flex flex-wrap items-center justify-between gap-3 p-4">
            <div>
              <p className="font-medium">
                {sub.package.name} <Badge tone={sub.status === 'active' || sub.status === 'trialing' ? 'ok' : 'warn'}>{statusLabel(sub.status)}</Badge> {sub.cancelAtPeriodEnd && <Badge>{t('userdetail.endsAtPeriodEnd')}</Badge>}
              </p>
              <p className="mt-1 text-xs text-fg-muted">
                {sub.trialEndsAt ? t('people.trialPaidAccess', { trial: formatDate(sub.trialEndsAt), paid: formatDate(sub.currentPeriodEnd), access: formatDate(sub.accessUntil) }) : t('people.paidAccess', { paid: formatDate(sub.currentPeriodEnd), access: formatDate(sub.accessUntil) })}
              </p>
            </div>
            {writable && (
              <div className="flex gap-2">
                <Button onClick={() => setAction('refund')}>
                  <RotateCcw className="h-4 w-4" aria-hidden /> {t('userdetail.refund')}
                </Button>
                <Button tone="danger" onClick={() => setAction('cancel')}>
                  <XCircle className="h-4 w-4" aria-hidden /> {t('userdetail.cancelNow')}
                </Button>
              </div>
            )}
          </div>
        ) : (
          <p className="card p-4 text-sm text-fg-muted">{t('userdetail.noSub')}</p>
        )}
        <KeyValues
          rows={[
            [t('userdetail.limits'), t('people.limits', { streams: data.limits.maxStreams, devices: data.limits.maxDevices })],
            [t('userdetail.playingNow'), data.playing.length ? data.playing.map((item) => t('people.playingSince', { device: item.deviceName, when: relative(item.startedAt) })).join(', ') : t('userdetail.nothing')],
          ]}
        />
        <DataTable
          label={t('userdetail.access')}
          rows={data.entitlements}
          rowKey={(row) => row.id}
          empty={t('userdetail.noEntitlements')}
          columns={[
            { header: t('common.package'), cell: (row) => row.package.name },
            { header: t('userdetail.from'), cell: (row) => <Badge tone={row.kind === 'comp' ? 'accent' : 'neutral'}>{row.kind === 'comp' ? t('userdetail.complimentary') : t('userdetail.subscriptionLower')}</Badge> },
            { header: t('userdetail.window'), cell: (row) => `${formatDate(row.startsAt)} → ${row.endsAt ? formatDate(row.endsAt) : t('userdetail.openEnded')}` },
            { header: t('common.activeCap'), cell: (row) => (row.active ? <Badge tone="ok">{t('userdetail.yes')}</Badge> : <Badge>{t('userdetail.no')}</Badge>) },
            { header: '', cell: (row) => (writable && row.kind === 'comp' && row.active ? <Button onClick={() => setAction({ revoke: row })}>{t('userdetail.revoke')}</Button> : null) },
          ]}
        />
        <DataTable
          label={t('common.payments')}
          rows={data.invoices}
          rowKey={(row) => row.id}
          empty={t('userdetail.noPayments')}
          columns={[
            { header: t('userdetail.paid'), cell: (row) => formatTime(row.paidAt) },
            { header: t('common.period'), cell: (row) => `${formatDate(row.periodStart)} → ${formatDate(row.periodEnd)}` },
            { header: t('common.amount'), cell: (row) => money({ currency: row.currency, amountMinor: row.amountMinor }) },
            { header: t('common.status'), cell: (row) => <Badge tone={row.status === 'paid' ? 'ok' : 'neutral'}>{statusLabel(row.status)}</Badge> },
          ]}
        />
        <DataTable
          label={t('userdetail.playbackDevices')}
          rows={data.devices}
          rowKey={(row) => row.id}
          empty={t('userdetail.noPlaybackDevices')}
          columns={[
            { header: t('userdetail.device'), cell: (row) => row.name },
            { header: t('userdetail.platform'), cell: (row) => row.platform },
            { header: t('userdetail.added'), cell: (row) => formatDate(row.createdAt) },
            { header: t('userdetail.lastUsed'), cell: (row) => relative(row.lastSeenAt) },
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
  const grant = useAction((body: Record<string, unknown>) => api(`/users/${userId}/entitlements`, { method: 'POST', body }), { inlineErrors: true, success: t('userdetail.compGranted'), invalidate: [['user-billing', userId]], onSuccess: onClose });
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    grant.mutate({ packageId: String(form.get('package')), endsAt: fromDateInput(String(form.get('ends') ?? '')), note: String(form.get('note') ?? '').trim() });
  };
  return (
    <Dialog open={open} title={t('userdetail.giveComp')} onClose={onClose}>
      <form className="space-y-4" onSubmit={submit}>
        <SelectField label={t('common.package')} name="package" required>
          {packages.data?.map((pkg) => (
            <option key={pkg.id} value={pkg.id}>
              {pkg.name} ({pkg.status})
            </option>
          ))}
        </SelectField>
        <Field label={t('userdetail.untilOptional')} name="ends" type="date" />
        <TextArea label={t('userdetail.why')} name="note" required minLength={3} maxLength={500} />
        <ErrorNote error={grant.error} />
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button tone="primary" type="submit" busy={grant.isPending}>
            {t('userdetail.grant')}
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
  const add = useAction((text: string) => api<SupportNoteDto>(`/users/${userId}/notes`, { method: 'POST', body: { body: text } }), { success: t('userdetail.noteAdded'), invalidate: [['notes', userId], ['support-notes']], onSuccess: () => setBody('') });
  return (
    <Section title={t('userdetail.notes')} description={t('userdetail.notesHint')}>
      {can('support:write') && (
        <form
          className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-end"
          onSubmit={(event) => {
            event.preventDefault();
            if (body.trim()) add.mutate(body.trim());
          }}
        >
          <div className="flex-1">
            <TextArea label={t('userdetail.newNote')} value={body} onChange={(e) => setBody(e.target.value)} maxLength={4000} />
          </div>
          <Button tone="primary" type="submit" busy={add.isPending} disabled={!body.trim()}>
            <MessageSquarePlus className="h-4 w-4" aria-hidden /> {t('userdetail.addNote')}
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
        {notes.data?.length === 0 && <li className="text-sm text-fg-muted">{t('userdetail.noNotes')}</li>}
      </ul>
    </Section>
  );
}
