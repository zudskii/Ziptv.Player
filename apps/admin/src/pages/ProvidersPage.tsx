import type { ProviderDto, ProviderHealthDto, ProviderReportDto } from '@ziptv/contracts';
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

function CreateProviderDialog({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (provider: ProviderDto) => void }) {
  const [type, setType] = useState<'m3u' | 'xtream'>('m3u');
  const create = useAction((body: Record<string, unknown>) => api<ProviderDto>('/providers', { method: 'POST', body }), { inlineErrors: true, success: t('providers.added'), invalidate: [['providers']], onSuccess: onCreated });
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const value = (key: string) => String(form.get(key) ?? '').trim();
    const secretRef = value('secretRef');
    const connection = type === 'm3u' ? { url: value('url') } : { server: value('server'), username: value('username'), password: String(form.get('password') ?? '') };
    create.mutate({ name: value('name'), type, credential: secretRef ? { secretRef } : { connection } });
  };
  return (
    <Dialog open={open} title={t('providers.add')} onClose={onClose}>
      <form className="space-y-4" onSubmit={submit} autoComplete="off">
        <Field label={t('common.name')} name="name" required maxLength={120} />
        <SelectField label={t('providers.integration')} value={type} onChange={(e) => setType(e.target.value as 'm3u' | 'xtream')}>
          <option value="m3u">{t('providers.m3u')}</option>
          <option value="xtream">{t('providers.xtream')}</option>
        </SelectField>
        <Field label={t('providers.secretRef')} name="secretRef" placeholder="env:ZIPTV_SECRET_LICENSOR_A" hint={t('providers.secretRefHint')} />
        {type === 'm3u' ? (
          <Field label={t('providers.url')} name="url" type="url" />
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
            [t('common.streams'), `${provider.stats.streams} total · ${provider.stats.matched} matched · ${provider.stats.pending} pending · ${provider.stats.gone} gone`],
            [t('providers.credential'), provider.credential ? `${provider.credential.source} · rotated ${formatDate(provider.credential.rotatedAt)}` : '—'],
          ]}
        />
      </Section>
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
    save.mutate({
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
