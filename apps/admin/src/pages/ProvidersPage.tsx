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
        title="Providers"
        description="Licensed sources of the operator catalog. Credentials are stored encrypted and never shown again."
        actions={
          can('providers:write') ? (
            <Button tone="primary" onClick={() => setCreating(true)}>
              <Plus className="h-4 w-4" aria-hidden /> Add provider
            </Button>
          ) : undefined
        }
      />
      <ErrorNote error={providers.error} />
      <DataTable
        label="Providers"
        rows={providers.data ?? []}
        rowKey={(row) => row.id}
        empty={providers.isPending ? 'Loading…' : 'No providers yet.'}
        columns={[
          {
            header: 'Provider',
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
          { header: 'Status', cell: (row) => <Badge tone={row.status === 'active' ? 'ok' : row.status === 'paused' ? 'warn' : 'danger'}>{row.status}</Badge> },
          { header: 'Sync', cell: (row) => <div><Badge tone={SYNC_TONE[row.sync.status]}>{row.sync.status}</Badge><p className="mt-1 text-xs text-fg-muted">{row.sync.lastSuccessAt ? `ok ${relative(row.sync.lastSuccessAt)}` : 'never synced'}</p></div> },
          { header: 'Streams', cell: (row) => `${row.stats.matched} matched · ${row.stats.pending} to review`, className: 'whitespace-nowrap' },
          { header: 'Contract', cell: (row) => (row.contract.ref ? <div><p>{row.contract.ref}</p><p className="text-xs text-fg-muted">until {formatDate(row.contract.endAt)}</p></div> : '—') },
          { header: 'SLA', cell: (row) => percent(row.contract.slaTargetPct) },
          { header: 'Cost / month', cell: (row) => money(row.contract.monthlyCost), className: 'whitespace-nowrap' },
        ]}
      />
      <CreateProviderDialog open={creating} onClose={() => setCreating(false)} onCreated={(provider) => navigate(`/providers/${provider.id}`)} />
    </>
  );
}

function CreateProviderDialog({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (provider: ProviderDto) => void }) {
  const [type, setType] = useState<'m3u' | 'xtream'>('m3u');
  const create = useAction((body: Record<string, unknown>) => api<ProviderDto>('/providers', { method: 'POST', body }), { inlineErrors: true, success: 'Provider added — the first sync starts now', invalidate: [['providers']], onSuccess: onCreated });
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const value = (key: string) => String(form.get(key) ?? '').trim();
    const secretRef = value('secretRef');
    const connection = type === 'm3u' ? { url: value('url') } : { server: value('server'), username: value('username'), password: String(form.get('password') ?? '') };
    create.mutate({ name: value('name'), type, credential: secretRef ? { secretRef } : { connection } });
  };
  return (
    <Dialog open={open} title="Add provider" onClose={onClose}>
      <form className="space-y-4" onSubmit={submit} autoComplete="off">
        <Field label="Name" name="name" required maxLength={120} />
        <SelectField label="Integration" value={type} onChange={(e) => setType(e.target.value as 'm3u' | 'xtream')}>
          <option value="m3u">M3U playlist</option>
          <option value="xtream">Xtream Codes</option>
        </SelectField>
        <Field label="Secret reference (preferred)" name="secretRef" placeholder="env:ZIPTV_SECRET_LICENSOR_A" hint="The variable holds the connection as JSON. Leave empty to enter it below (stored encrypted)." />
        {type === 'm3u' ? (
          <Field label="Playlist URL" name="url" type="url" />
        ) : (
          <>
            <Field label="Server" name="server" type="url" />
            <Field label="Username" name="username" />
            <Field label="Password" name="password" type="password" autoComplete="new-password" />
          </>
        )}
        <ErrorNote error={create.error} />
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button tone="primary" type="submit" busy={create.isPending}>
            Add
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
  const sync = useAction(() => api(`/providers/${providerId}/sync`, { method: 'POST' }), { success: 'Sync queued', invalidate: [['providers']] });
  const status = useAction((value: 'active' | 'paused') => api(`/providers/${providerId}`, { method: 'PATCH', body: { status: value } }), { success: 'Provider updated', invalidate: [['providers']] });

  const provider = providers.data?.find((item) => item.id === providerId);
  if (providers.isPending) return <Spinner />;
  if (!provider) return <ErrorNote error={providers.error ?? new Error('Provider not found.')} />;
  const r = report.data;
  return (
    <>
      <Link to="/providers" className="text-sm text-fg-muted hover:text-fg">
        ← Providers
      </Link>
      <PageHeader
        title={provider.name}
        description={`${provider.type} · ${provider.host || 'no host'} · added ${formatDate(provider.createdAt)}`}
        actions={
          <>
            <Button busy={health.isPending} onClick={() => health.mutate(undefined)}>
              <Activity className="h-4 w-4" aria-hidden /> Test connection
            </Button>
            {can('providers:write') && (
              <>
                <Button busy={sync.isPending} onClick={() => sync.mutate(undefined)}>
                  <RefreshCw className="h-4 w-4" aria-hidden /> Sync now
                </Button>
                <Button onClick={() => status.mutate(provider.status === 'active' ? 'paused' : 'active')}>{provider.status === 'active' ? 'Pause' : 'Activate'}</Button>
              </>
            )}
          </>
        }
      />
      {health.data && (
        <p role="status" className={`mb-4 rounded-lg px-3 py-2 text-sm ${health.data.ok ? 'bg-ok/10 text-green-300' : 'bg-danger/10 text-red-300'}`}>
          {health.data.ok ? `Reachable (${health.data.latencyMs} ms).` : `Not reachable: ${health.data.message ?? 'unknown error'}`}
        </p>
      )}
      <Section title="Service level" description={r ? `Last ${r.windowDays} days of probes of this provider's feeds.` : undefined}>
        <ErrorNote error={report.error} />
        {r && (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label="Availability" value={percent(r.availabilityPct, 2)} tone={r.slaMet === false ? 'danger' : undefined} note={r.slaTargetPct !== null ? `target ${percent(r.slaTargetPct, 2)} · ${r.slaMet === null ? 'no data' : r.slaMet ? 'met' : 'missed'}` : 'no SLA target set'} />
            <Stat label="Feeds" value={`${r.feeds.healthy} / ${r.feeds.total} healthy`} tone={r.feeds.unhealthy > 0 ? 'warn' : undefined} />
            <Stat label="Incidents" value={r.incidentsInWindow} note={`${r.openIncidents} open now`} tone={r.openIncidents > 0 ? 'danger' : undefined} />
            <Stat label="Watched" value={minutes(r.watchMinutesInWindow)} note="On package access" />
          </div>
        )}
      </Section>
      <Section
        title="Contract"
        actions={
          can('providers:write') ? (
            <Button tone="primary" onClick={() => setEditing(true)}>
              Edit contract
            </Button>
          ) : undefined
        }
      >
        <KeyValues
          rows={[
            ['Reference', provider.contract.ref ?? '—'],
            ['Term', `${formatDate(provider.contract.startAt)} → ${formatDate(provider.contract.endAt)}`],
            ['SLA target', percent(provider.contract.slaTargetPct, 2)],
            ['Cost per month', money(provider.contract.monthlyCost)],
            ['Notes', provider.contract.notes || '—'],
          ]}
        />
      </Section>
      <Section title="Sync">
        <KeyValues
          rows={[
            ['Status', <Badge key="s" tone={SYNC_TONE[provider.sync.status]}>{provider.sync.status}</Badge>],
            ['Last success', formatTime(provider.sync.lastSuccessAt)],
            ['Next', formatTime(provider.sync.nextAt)],
            ['Every', `${provider.syncIntervalHours} h`],
            ['Error', provider.sync.error ?? '—'],
            ['Streams', `${provider.stats.streams} total · ${provider.stats.matched} matched · ${provider.stats.pending} pending · ${provider.stats.gone} gone`],
            ['Credential', provider.credential ? `${provider.credential.source} · rotated ${formatDate(provider.credential.rotatedAt)}` : '—'],
          ]}
        />
      </Section>
      <ContractDialog open={editing} provider={provider} onClose={() => setEditing(false)} />
    </>
  );
}

function ContractDialog({ open, provider, onClose }: { open: boolean; provider: ProviderDto; onClose: () => void }) {
  const save = useAction((contract: Record<string, unknown>) => api(`/providers/${provider.id}`, { method: 'PATCH', body: { contract } }), { inlineErrors: true, success: 'Contract saved', invalidate: [['providers'], ['provider-report', provider.id]], onSuccess: onClose });
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
    <Dialog open={open} title={`Contract — ${provider.name}`} onClose={onClose}>
      <form className="space-y-4" onSubmit={submit}>
        <Field label="Contract reference" name="ref" defaultValue={provider.contract.ref ?? ''} maxLength={200} />
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Start" name="start" type="date" defaultValue={dateInput(provider.contract.startAt)} />
          <Field label="End" name="end" type="date" defaultValue={dateInput(provider.contract.endAt)} />
        </div>
        <Field label="SLA target (%)" name="sla" type="number" step="0.01" min="0.01" max="100" defaultValue={provider.contract.slaTargetPct ?? ''} />
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Cost per month" name="cost" type="number" step="0.01" min="0" defaultValue={provider.contract.monthlyCost ? provider.contract.monthlyCost.amountMinor / 100 : ''} />
          <Field label="Currency" name="currency" maxLength={3} defaultValue={provider.contract.monthlyCost?.currency ?? 'GEL'} />
        </div>
        <TextArea label="Notes" name="notes" defaultValue={provider.contract.notes} maxLength={4000} />
        <ErrorNote error={save.error} />
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button tone="primary" type="submit" busy={save.isPending}>
            Save
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
