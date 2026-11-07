import type { ProviderConflictsDto, ProviderContentDto, ProviderDto, ProviderHealthDto, ProviderReportDto, ProviderSyncEventDto } from '@ziptv/contracts';
import { useQuery } from '@tanstack/react-query';
import { Activity, Plus, RefreshCw } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router';

import { Badge, Button, DataTable, Dialog, ErrorNote, Field, KeyValues, PageHeader, Section, SelectField, Spinner, Stat, TextArea } from '../components/ui';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { dateInput, formatDate, fromDateInput, minutes, money, percent, relative } from '../lib/format';
import { useAction } from '../lib/mutation';
import { formatTime } from '../lib/nav';
import { statusLabel, t } from '../i18n';

const SYNC_TONE = { idle: 'ok', queued: 'neutral', running: 'warn', failed: 'danger' } as const;

/** 9.3 — licensors: integration, sync, contract, SLA and cost. */
export function ProvidersPage() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const providers = useQuery({ queryKey: ['providers'], queryFn: () => api<ProviderDto[]>('/providers'), refetchInterval: 30_000 });
  const [creating, setCreating] = useState(false);
  return (
    <>
      <PageHeader
        title={t('providers.title')}
        description={t('providers.intro')}
        actions={
          can('providers:write') ? (
            <Button tone="primary" onClick={() => setCreating(true)}>
              <Plus className="h-4 w-4" aria-hidden /> {t('providers.add')}
            </Button>
          ) : undefined
        }
      />
      <ErrorNote error={providers.error} />
      <DataTable
        label={t('providers.title')}
        rows={providers.data ?? []}
        rowKey={(row) => row.id}
        empty={providers.isPending ? t('common.loading') : t('providers.none')}
        columns={[
          {
            header: t('common.provider'),
            cell: (row) => (
              <div>
                <Link to={`/providers/${row.id}`} className="font-medium text-amber-200 hover:underline">
                  {row.name}
                </Link>
                <p className="text-xs text-fg-muted">
                  {row.type} · {row.host || '—'}
                </p>
              </div>
            ),
          },
          { header: t('common.status'), cell: (row) => <Badge tone={row.status === 'active' ? 'ok' : row.status === 'paused' ? 'warn' : 'danger'}>{statusLabel(row.status)}</Badge> },
          { header: t('common.sync'), cell: (row) => <div><Badge tone={SYNC_TONE[row.sync.status]}>{statusLabel(row.sync.status)}</Badge><p className="mt-1 text-xs text-fg-muted">{row.sync.lastSuccessAt ? t('catalog.okAgo', { when: relative(row.sync.lastSuccessAt) }) : t('providers.neverSynced')}</p></div> },
          { header: t('common.streams'), cell: (row) => t('catalog.streamsStats', { matched: row.stats.matched, pending: row.stats.pending }), className: 'whitespace-nowrap' },
          { header: t('common.contract'), cell: (row) => (row.contract.ref ? <div><p>{row.contract.ref}</p><p className="text-xs text-fg-muted">{t('catalog.until', { date: formatDate(row.contract.endAt) })}</p></div> : '—') },
          { header: 'SLA', cell: (row) => percent(row.contract.slaTargetPct) },
          { header: t('providers.costMonth'), cell: (row) => money(row.contract.monthlyCost), className: 'whitespace-nowrap' },
        ]}
      />
      <CreateProviderDialog open={creating} onClose={() => setCreating(false)} onCreated={(provider) => navigate(`/providers/${provider.id}`)} />
    </>
  );
}

type NewProviderType = 'm3u' | 'xtream' | 'vendor_feed';

function CreateProviderDialog({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (provider: ProviderDto) => void }) {
  const [type, setType] = useState<NewProviderType>('m3u');
  const create = useAction((body: Record<string, unknown>) => api<ProviderDto>('/providers', { method: 'POST', body }), { inlineErrors: true, success: t('providers.added'), invalidate: [['providers']], onSuccess: onCreated });
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const value = (key: string) => String(form.get(key) ?? '').trim();
    const secretRef = value('secretRef');
    const connection =
      type === 'm3u'
        ? { url: value('url') }
        : type === 'vendor_feed'
          ? { url: value('url'), ...(value('token') ? { token: value('token') } : {}) }
          : { server: value('server'), username: value('username'), password: String(form.get('password') ?? '') };
    create.mutate({
      name: value('name'),
      type,
      credential: secretRef ? { secretRef } : { connection },
      ...(type === 'vendor_feed' ? { config: { publicKeys: [{ id: value('keyId') || 'k1', key: value('publicKey') }] } } : {}),
    });
  };
  return (
    <Dialog open={open} title={t('providers.add')} onClose={onClose}>
      <form className="space-y-4" onSubmit={submit} autoComplete="off">
        <Field label={t('common.name')} name="name" required maxLength={120} />
        <SelectField label={t('providers.integration')} value={type} onChange={(e) => setType(e.target.value as NewProviderType)}>
          <option value="m3u">{t('providers.m3u')}</option>
          <option value="xtream">{t('providers.xtream')}</option>
          <option value="vendor_feed">{t('feed.type')}</option>
        </SelectField>
        <Field label={t('providers.secretRef')} name="secretRef" placeholder="env:ZIPTV_SECRET_LICENSOR_A" hint={t('providers.secretRefHint')} />
        {type === 'm3u' ? (
          <Field label={t('providers.url')} name="url" type="url" />
        ) : type === 'vendor_feed' ? (
          <>
            <Field label={t('feed.url')} name="url" type="url" placeholder="https://feeds.vendor.example/ziptv/v1" />
            <Field label={t('feed.token')} name="token" type="password" autoComplete="new-password" hint={t('feed.tokenHint')} />
            <Field label={t('feed.keyId')} name="keyId" defaultValue="k1" maxLength={64} required />
            <TextArea label={t('feed.publicKey')} name="publicKey" required rows={3} maxLength={600} hint={t('feed.publicKeyHint')} />
          </>
        ) : (
          <>
            <Field label={t('providers.server')} name="server" type="url" />
            <Field label={t('common.username')} name="username" />
            <Field label={t('common.password')} name="password" type="password" autoComplete="new-password" />
          </>
        )}
        <ErrorNote error={create.error} />
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button tone="primary" type="submit" busy={create.isPending}>
            {t('common.add')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

export function ProviderDetailPage() {
  const { providerId = '' } = useParams();
  const { can } = useAuth();
  const providers = useQuery({ queryKey: ['providers'], queryFn: () => api<ProviderDto[]>('/providers') });
  const report = useQuery({ queryKey: ['provider-report', providerId], queryFn: () => api<ProviderReportDto>(`/providers/${providerId}/report`) });
  const [editing, setEditing] = useState(false);
  const health = useAction(() => api<ProviderHealthDto>(`/providers/${providerId}/health`), {});
  const sync = useAction(() => api(`/providers/${providerId}/sync`, { method: 'POST' }), { success: t('providers.syncQueued'), invalidate: [['providers']] });
  const status = useAction((value: 'active' | 'paused') => api(`/providers/${providerId}`, { method: 'PATCH', body: { status: value } }), { success: t('providers.updated'), invalidate: [['providers']] });

  const provider = providers.data?.find((item) => item.id === providerId);
  if (providers.isPending) return <Spinner />;
  if (!provider) return <ErrorNote error={providers.error ?? new Error(t('providers.notFound'))} />;
  const r = report.data;
  return (
    <>
      <Link to="/providers" className="text-sm text-fg-muted hover:text-fg">
        {t('providers.back')}
      </Link>
      <PageHeader
        title={provider.name}
        description={t('catalog.providerMeta', { type: provider.type, host: provider.host || t('catalog.noHost'), date: formatDate(provider.createdAt) })}
        actions={
          <>
            <Button busy={health.isPending} onClick={() => health.mutate(undefined)}>
              <Activity className="h-4 w-4" aria-hidden /> {t('providers.test')}
            </Button>
            {can('providers:write') && (
              <>
                <Button busy={sync.isPending} onClick={() => sync.mutate(undefined)}>
                  <RefreshCw className="h-4 w-4" aria-hidden /> {t('providers.syncNow')}
                </Button>
                <Button onClick={() => status.mutate(provider.status === 'active' ? 'paused' : 'active')}>{provider.status === 'active' ? t('providers.pause') : t('providers.activate')}</Button>
              </>
            )}
          </>
        }
      />
      {health.data && (
        <p role="status" className={`mb-4 rounded-lg px-3 py-2 text-sm ${health.data.ok ? 'bg-ok/10 text-green-300' : 'bg-danger/10 text-red-300'}`}>
          {health.data.ok ? t('catalog.reachable', { ms: health.data.latencyMs ?? 0 }) : t('catalog.notReachable', { message: health.data.message ?? t('catalog.unknownError') })}
        </p>
      )}
      <Section title={t('providers.sla')} description={r ? t('catalog.slaWindow', { days: r.windowDays }) : undefined}>
        <ErrorNote error={report.error} />
        {r && (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label={t('providers.availability')} value={percent(r.availabilityPct, 2)} tone={r.slaMet === false ? 'danger' : undefined} note={r.slaTargetPct !== null ? t('catalog.slaTarget', { target: percent(r.slaTargetPct, 2), state: r.slaMet === null ? t('catalog.slaNoData') : r.slaMet ? t('catalog.slaMet') : t('catalog.slaMissed') }) : t('providers.noSla')} />
            <Stat label={t('common.feeds')} value={t('catalog.feedsHealthy', { healthy: r.feeds.healthy, total: r.feeds.total })} tone={r.feeds.unhealthy > 0 ? 'warn' : undefined} />
            <Stat label={t('common.incidents')} value={r.incidentsInWindow} note={t('catalog.openNow', { count: r.openIncidents })} tone={r.openIncidents > 0 ? 'danger' : undefined} />
            <Stat label={t('providers.watched')} value={minutes(r.watchMinutesInWindow)} note={t('providers.onPackage')} />
          </div>
        )}
      </Section>
      <Section
        title={t('common.contract')}
        actions={
          can('providers:write') ? (
            <Button tone="primary" onClick={() => setEditing(true)}>
              {t('providers.editContract')}
            </Button>
          ) : undefined
        }
      >
        <KeyValues
          rows={[
            [t('common.reference'), provider.contract.ref ?? '—'],
            [t('providers.term'), `${formatDate(provider.contract.startAt)} → ${formatDate(provider.contract.endAt)}`],
            [t('providers.slaTarget'), percent(provider.contract.slaTargetPct, 2)],
            [t('providers.costPerMonth'), money(provider.contract.monthlyCost)],
            [t('contract.guarantee'), provider.contract.minimumGuarantee ? t('contract.perMonth', { amount: money(provider.contract.minimumGuarantee) }) : '—'],
            [t('contract.catchupWeight'), t('contract.weightValue', { weight: provider.contract.catchupWeight })],
            [t('contract.catchupFee'), provider.contract.catchupFeePerHour ? t('contract.perHour', { amount: money(provider.contract.catchupFeePerHour) }) : '—'],
            [t('common.notes'), provider.contract.notes || '—'],
          ]}
        />
      </Section>
      <Section title={t('common.sync')}>
        <KeyValues
          rows={[
            [t('common.status'), <Badge key="s" tone={SYNC_TONE[provider.sync.status]}>{statusLabel(provider.sync.status)}</Badge>],
            [t('providers.lastSuccess'), formatTime(provider.sync.lastSuccessAt)],
            [t('providers.next'), formatTime(provider.sync.nextAt)],
            [t('providers.every'), `${provider.syncIntervalHours} h`],
            [t('common.error'), provider.sync.error ?? '—'],
            [t('common.streams'), t('feed.streamStats', { total: provider.stats.streams, matched: provider.stats.matched, pending: provider.stats.pending, gone: provider.stats.gone })],
            [t('providers.credential'), provider.credential ? t('feed.credentialRotated', { source: provider.credential.source, date: formatDate(provider.credential.rotatedAt) }) : '—'],
            ...(provider.feed
              ? ([
                  [t('feed.position'), provider.feed.cursor ? <code key="c" className="text-xs">{provider.feed.cursor}</code> : t('feed.fullNext')],
                  [t('feed.generatedAt'), formatTime(provider.feed.generatedAt)],
                  [t('feed.keys'), provider.feed.keyIds.join(', ') || '—'],
                ] as [string, React.ReactNode][])
              : []),
          ]}
        />
      </Section>
      <ConflictsSection providerId={provider.id} />
      {provider.type === 'vendor_feed' && <ContentSection providerId={provider.id} />}
      <JournalSection providerId={provider.id} />
      <ContractDialog open={editing} provider={provider} onClose={() => setEditing(false)} />
    </>
  );
}

function ContractDialog({ open, provider, onClose }: { open: boolean; provider: ProviderDto; onClose: () => void }) {
  const save = useAction((contract: Record<string, unknown>) => api(`/providers/${provider.id}`, { method: 'PATCH', body: { contract } }), { inlineErrors: true, success: t('providers.contractSaved'), invalidate: [['providers'], ['provider-report', provider.id]], onSuccess: onClose });
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const value = (key: string) => String(form.get(key) ?? '').trim();
    const cost = value('cost');
    const guarantee = value('guarantee');
    const fee = value('fee');
    const termsCurrency = value('termsCurrency').toUpperCase() || 'GEL';
    save.mutate({
      minimumGuarantee: guarantee ? { currency: termsCurrency, amountMinor: Math.round(Number(guarantee) * 100) } : null,
      catchupWeight: Number(value('weight') || 1),
      catchupFeePerHour: fee ? { currency: termsCurrency, amountMinor: Math.round(Number(fee) * 100) } : null,
      ref: value('ref') || null,
      startAt: fromDateInput(value('start')),
      endAt: fromDateInput(value('end')),
      slaTargetPct: value('sla') ? Number(value('sla')) : null,
      monthlyCost: cost ? { currency: value('currency').toUpperCase() || 'GEL', amountMinor: Math.round(Number(cost) * 100) } : null,
      notes: String(form.get('notes') ?? ''),
    });
  };
  return (
    <Dialog open={open} title={t('catalog.contractOf', { name: provider.name })} onClose={onClose}>
      <form className="space-y-4" onSubmit={submit}>
        <Field label={t('providers.contractRef')} name="ref" defaultValue={provider.contract.ref ?? ''} maxLength={200} />
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t('common.start')} name="start" type="date" defaultValue={dateInput(provider.contract.startAt)} />
          <Field label={t('common.end')} name="end" type="date" defaultValue={dateInput(provider.contract.endAt)} />
        </div>
        <Field label={t('providers.slaTargetPct')} name="sla" type="number" step="0.01" min="0.01" max="100" defaultValue={provider.contract.slaTargetPct ?? ''} />
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t('providers.costPerMonth')} name="cost" type="number" step="0.01" min="0" defaultValue={provider.contract.monthlyCost ? provider.contract.monthlyCost.amountMinor / 100 : ''} />
          <Field label={t('common.currency')} name="currency" maxLength={3} defaultValue={provider.contract.monthlyCost?.currency ?? 'GEL'} />
        </div>
        <fieldset className="space-y-3 rounded-lg border border-line/10 p-3">
          <legend className="px-1 text-xs font-medium text-fg-muted">{t('contract.reportTerms')}</legend>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t('contract.guaranteePerMonth')} name="guarantee" type="number" step="0.01" min="0" defaultValue={provider.contract.minimumGuarantee ? provider.contract.minimumGuarantee.amountMinor / 100 : ''} />
            <Field label={t('common.currency')} name="termsCurrency" maxLength={3} defaultValue={provider.contract.minimumGuarantee?.currency ?? provider.contract.catchupFeePerHour?.currency ?? 'GEL'} />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t('contract.catchupWeight')} name="weight" type="number" step="0.05" min="0" max="5" defaultValue={provider.contract.catchupWeight} />
            <Field label={t('contract.catchupFeePerHour')} name="fee" type="number" step="0.01" min="0" defaultValue={provider.contract.catchupFeePerHour ? provider.contract.catchupFeePerHour.amountMinor / 100 : ''} />
          </div>
          <p className="text-xs text-fg-subtle">{t('contract.hint')}</p>
        </fieldset>
        <TextArea label={t('common.notes')} name="notes" defaultValue={provider.contract.notes} maxLength={4000} />
        <ErrorNote error={save.error} />
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button tone="primary" type="submit" busy={save.isPending}>
            {t('common.save')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

const LEVEL_TONE = { info: 'neutral', warning: 'warn', error: 'danger' } as const;

/** 16.4 — what each sync did, and every refused feed or skipped item, newest first. */
function JournalSection({ providerId }: { providerId: string }) {
  const events = useQuery({ queryKey: ['provider-events', providerId], queryFn: () => api<ProviderSyncEventDto[]>(`/providers/${providerId}/events?limit=50`), refetchInterval: 15_000 });
  return (
    <Section title={t('feed.journal')} description={t('feed.journalHint')}>
      <ErrorNote error={events.error} />
      <DataTable
        label={t('feed.journal')}
        rows={events.data ?? []}
        rowKey={(row) => row.id}
        empty={events.isPending ? t('common.loading') : t('feed.journalEmpty')}
        columns={[
          { header: t('feed.when'), cell: (row) => formatTime(row.at), className: 'whitespace-nowrap' },
          { header: t('feed.level'), cell: (row) => <Badge tone={LEVEL_TONE[row.level]}>{t(`feed.levels.${row.level}`)}</Badge> },
          { header: t('feed.code'), cell: (row) => <code className="text-xs">{row.code}</code> },
          { header: t('feed.message'), cell: (row) => <span className="break-words">{row.message}</span> },
        ]}
      />
    </Section>
  );
}

/** 16.4 — what needs a decision: grants beyond the licence, the review queue, skipped items. */
function ConflictsSection({ providerId }: { providerId: string }) {
  const conflicts = useQuery({ queryKey: ['provider-conflicts', providerId], queryFn: () => api<ProviderConflictsDto>(`/providers/${providerId}/conflicts`), refetchInterval: 30_000 });
  const data = conflicts.data;
  const total = data ? data.grantsBeyondFeed.length + data.skippedItems.length + (data.pendingStreams > 0 ? 1 : 0) : 0;
  return (
    <Section title={t('feed.conflicts')} description={total === 0 && data ? t('feed.noConflicts') : undefined}>
      <ErrorNote error={conflicts.error} />
      {data && data.pendingStreams > 0 && (
        <p className="mb-3 text-sm">
          <Link to={`/channels?review=${providerId}`} className="text-amber-200 hover:underline">
            {t('feed.pendingStreams', { count: data.pendingStreams })}
          </Link>
        </p>
      )}
      {data && data.grantsBeyondFeed.length > 0 && (
        <DataTable
          label={t('feed.beyondFeed')}
          rows={data.grantsBeyondFeed}
          rowKey={(row) => row.grantId}
          empty=""
          columns={[
            { header: t('common.channel'), cell: (row) => <Link to={`/channels/${row.channelId}`} className="text-amber-200 hover:underline">{row.channelName}</Link> },
            { header: t('common.territory'), cell: (row) => row.territory },
            { header: t('feed.reason'), cell: (row) => row.reason },
          ]}
        />
      )}
      {data && data.skippedItems.length > 0 && (
        <div className="mt-3">
          <p className="mb-1 text-sm font-medium">{t('feed.skipped', { count: data.skippedItems.length })}</p>
          <ul className="space-y-1 text-sm text-fg-muted">
            {data.skippedItems.map((item) => (
              <li key={item.path}>
                <code className="text-xs">{item.path}</code> — {item.message}
              </li>
            ))}
          </ul>
        </div>
      )}
    </Section>
  );
}

/** What a vendor feed delivered besides channels (sold through packages in Phase 17). */
function ContentSection({ providerId }: { providerId: string }) {
  const content = useQuery({ queryKey: ['provider-content', providerId], queryFn: () => api<ProviderContentDto>(`/providers/${providerId}/content`) });
  const data = content.data;
  return (
    <Section title={t('feed.content')}>
      <ErrorNote error={content.error} />
      {data && (
        <>
          <div className="mb-4 grid gap-4 sm:grid-cols-3">
            <Stat label={t('feed.movies')} value={data.movies} />
            <Stat label={t('feed.series')} value={data.series} note={t('feed.episodes', { count: data.episodes })} />
            <Stat label={t('feed.packages')} value={data.packages.filter((item) => item.status === 'active').length} />
          </div>
          <DataTable
            label={t('feed.packages')}
            rows={data.packages}
            rowKey={(row) => row.externalId}
            empty={t('feed.noPackages')}
            columns={[
              { header: t('common.name'), cell: (row) => row.name },
              { header: t('feed.externalId'), cell: (row) => <code className="text-xs">{row.externalId}</code> },
              { header: t('feed.items'), cell: (row) => row.items, className: 'tabular-nums' },
              { header: t('common.status'), cell: (row) => <Badge tone={row.status === 'active' ? 'ok' : 'neutral'}>{statusLabel(row.status)}</Badge> },
            ]}
          />
        </>
      )}
    </Section>
  );
}
