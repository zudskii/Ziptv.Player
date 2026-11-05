import type { ChangeRequestedDto, ChangeRequestPageDto, MasterChannelPageDto, PackageDetailDto, PackageDto } from '@ziptv/contracts';
import { useQuery } from '@tanstack/react-query';
import { Plus, X } from 'lucide-react';
import { useDeferredValue, useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router';
import { toast } from 'sonner';

import { Badge, Button, DataTable, Dialog, ErrorNote, Field, KeyValues, PageHeader, Section, SelectField, Spinner, TextArea } from '../components/ui';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { formatDate, money } from '../lib/format';
import { useAction } from '../lib/mutation';
import { statusLabel, t, tx } from '../i18n';

const sentForApproval = (result: unknown, applied: string) => toast.success(typeof result === 'object' && result !== null && 'changeRequest' in result ? t('packages.sentForApproval') : applied);

/** 9.6 — packages (what is sold) and their channels. Every change is approved by a second person. */
export function PackagesPage() {
  const { can } = useAuth();
  const packages = useQuery({ queryKey: ['packages'], queryFn: () => api<PackageDto[]>('/packages') });
  const pending = useQuery({ queryKey: ['change-requests', 'packages'], queryFn: () => api<ChangeRequestPageDto>('/change-requests?status=pending&kind=package.create') });
  const [creating, setCreating] = useState(false);
  return (
    <>
      <PageHeader
        title={t('packages.title')}
        description={t('packages.intro')}
        actions={
          can('billing:write') ? (
            <Button tone="primary" onClick={() => setCreating(true)}>
              <Plus className="h-4 w-4" aria-hidden /> {t('packages.new')}
            </Button>
          ) : undefined
        }
      />
      {pending.data && pending.data.items.length > 0 && (
        <ul className="mb-4 space-y-1 text-sm">
          {pending.data.items.map((request) => (
            <li key={request.id} className="rounded-lg border border-accent/30 bg-accent/10 px-3 py-2 text-amber-200">
              {tx('pkg.waitingApproval', { summary: request.summary, link: (chunks) => <Link className="underline" to="/approvals">{chunks}</Link> })}
            </li>
          ))}
        </ul>
      )}
      <ErrorNote error={packages.error} />
      <DataTable
        label={t('packages.packages')}
        rows={packages.data ?? []}
        rowKey={(row) => row.id}
        empty={packages.isPending ? t('common.loading') : t('packages.none')}
        columns={[
          { header: t('common.package'), cell: (row) => <Link to={`/packages/${row.id}`} className="font-medium text-amber-200 hover:underline">{row.name}</Link> },
          { header: t('common.status'), cell: (row) => <Badge tone={row.status === 'active' ? 'ok' : row.status === 'draft' ? 'warn' : 'neutral'}>{statusLabel(row.status)}</Badge> },
          { header: t('common.price'), cell: (row) => t('pkg.pricePer', { price: money({ currency: row.currency, amountMinor: row.priceMinor }), period: t(`pkg.period.${row.billingPeriod}`) }), className: 'whitespace-nowrap' },
          { header: t('packages.trial'), cell: (row) => (row.trialDays ? t('pkg.days', { count: row.trialDays }) : '—') },
          { header: t('packages.limits'), cell: (row) => t('pkg.limits', { streams: row.maxStreams, devices: row.maxDevices }) },
          { header: t('common.channels'), cell: (row) => row.channels, className: 'tabular-nums' },
          { header: t('common.model'), cell: (row) => row.businessModel },
        ]}
      />
      <PackageDialog open={creating} onClose={() => setCreating(false)} />
    </>
  );
}

export function PackageDetailPage() {
  const { packageId = '' } = useParams();
  const { can } = useAuth();
  const pkg = useQuery({ queryKey: ['package', packageId], queryFn: () => api<PackageDetailDto>(`/packages/${packageId}`) });
  const requests = useQuery({ queryKey: ['change-requests', 'package', packageId], queryFn: () => api<ChangeRequestPageDto>(`/change-requests?targetId=${packageId}&limit=10`) });
  const channels = useQuery({ queryKey: ['channels', 'all'], queryFn: () => api<MasterChannelPageDto>('/channels?limit=200'), enabled: can('catalog:read') });
  const [editing, setEditing] = useState(false);
  const [channelEditing, setChannelEditing] = useState(false);
  if (pkg.isPending) return <Spinner />;
  if (pkg.error) return <ErrorNote error={pkg.error} />;
  const data = pkg.data;
  const names = new Map(channels.data?.items.map((channel) => [channel.id, channel.name]));
  const open = requests.data?.items.find((request) => request.status === 'pending');
  return (
    <>
      <Link to="/packages" className="text-sm text-fg-muted hover:text-fg">
        {t('packages.back')}
      </Link>
      <PageHeader
        title={data.name}
        description={t('pkg.slugCreated', { slug: data.slug, date: formatDate(data.createdAt) })}
        actions={
          can('billing:write') && !open ? (
            <>
              <Button onClick={() => setChannelEditing(true)}>{t('packages.changeChannels')}</Button>
              <Button tone="primary" onClick={() => setEditing(true)}>
                {t('packages.changeTerms')}
              </Button>
            </>
          ) : undefined
        }
      />
      {open && (
        <p className="mb-4 rounded-lg border border-accent/30 bg-accent/10 px-3 py-2 text-sm text-amber-200">
          {tx('pkg.waitingRequested', { summary: open.summary, name: open.requestedBy.name, link: (chunks) => <Link className="underline" to="/approvals">{chunks}</Link> })}
        </p>
      )}
      <Section title={t('packages.terms')}>
        <KeyValues
          rows={[
            [t('common.status'), <Badge key="s" tone={data.status === 'active' ? 'ok' : data.status === 'draft' ? 'warn' : 'neutral'}>{statusLabel(data.status)}</Badge>],
            [t('common.price'), t('pkg.pricePer', { price: money({ currency: data.currency, amountMinor: data.priceMinor }), period: t(`pkg.period.${data.billingPeriod}`) })],
            [t('packages.freeTrial'), data.trialDays ? t('pkg.days', { count: data.trialDays }) : t('common.noneLower')],
            [t('packages.simultaneous'), data.maxStreams],
            [t('common.devices'), data.maxDevices],
            [t('packages.businessModel'), data.businessModel],
            [t('common.description'), data.description || '—'],
          ]}
        />
      </Section>
      <Section title={t('pkg.channelsCount', { count: data.channelIds.length })}>
        <ul className="flex flex-wrap gap-2">
          {data.channelIds.map((id) => (
            <li key={id}>
              <Link to={`/channels/${id}`}>
                <Badge>{names.get(id) ?? id.slice(-8)}</Badge>
              </Link>
            </li>
          ))}
          {data.channelIds.length === 0 && <li className="text-sm text-fg-muted">{t('packages.noChannels')}</li>}
        </ul>
      </Section>
      <Section title={t('packages.history')}>
        <DataTable
          label={t('packages.requests')}
          rows={requests.data?.items ?? []}
          rowKey={(row) => row.id}
          empty={t('packages.noChanges')}
          columns={[
            { header: t('packages.change'), cell: (row) => row.summary },
            { header: t('common.status'), cell: (row) => <Badge tone={row.status === 'applied' ? 'ok' : row.status === 'pending' ? 'warn' : row.status === 'withdrawn' ? 'neutral' : 'danger'}>{statusLabel(row.status)}</Badge> },
            { header: t('packages.requested'), cell: (row) => `${row.requestedBy.name} · ${formatDate(row.requestedAt)}` },
            { header: t('packages.decided'), cell: (row) => (row.decidedBy ? `${row.decidedBy.name} · ${formatDate(row.decidedAt)}` : '—') },
          ]}
        />
      </Section>
      <PackageDialog open={editing} pkg={data} onClose={() => setEditing(false)} />
      <ChannelPicker open={channelEditing} pkg={data} onClose={() => setChannelEditing(false)} />
    </>
  );
}

/** Create (no `pkg`) or change the terms of a package — both go to approval. */
function PackageDialog({ open, pkg, onClose }: { open: boolean; pkg?: PackageDetailDto; onClose: () => void }) {
  const save = useAction((body: Record<string, unknown>) => api<ChangeRequestedDto | PackageDetailDto>(pkg ? `/packages/${pkg.id}` : '/packages', { method: pkg ? 'PATCH' : 'POST', body }), {
    inlineErrors: true,
    invalidate: [['packages'], ['package'], ['change-requests']],
    onSuccess: (result) => {
      sentForApproval(result, pkg ? t('packages.updated') : t('packages.created'));
      onClose();
    },
  });
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const value = (key: string) => String(form.get(key) ?? '').trim();
    const body: Record<string, unknown> = {
      name: value('name'),
      description: value('description'),
      priceMinor: Math.round(Number(value('price')) * 100),
      currency: value('currency').toUpperCase(),
      billingPeriod: value('period'),
      trialDays: Number(value('trial') || 0),
      maxStreams: Number(value('streams')),
      maxDevices: Number(value('devices')),
    };
    if (pkg) {
      body.status = value('status');
      // Only what changed: the request summary (and the approver) see exactly that.
      const current: Record<string, unknown> = { name: pkg.name, description: pkg.description, priceMinor: pkg.priceMinor, currency: pkg.currency, billingPeriod: pkg.billingPeriod, trialDays: pkg.trialDays, maxStreams: pkg.maxStreams, maxDevices: pkg.maxDevices, status: pkg.status };
      for (const key of Object.keys(body)) if (body[key] === current[key]) delete body[key];
      if (Object.keys(body).length === 0) return onClose();
    }
    save.mutate(body);
  };
  return (
    <Dialog open={open} title={pkg ? t('pkg.changeNamed', { name: pkg.name }) : t('packages.new')} onClose={onClose}>
      <form className="space-y-4" onSubmit={submit}>
        <Field label={t('common.name')} name="name" defaultValue={pkg?.name} required maxLength={100} />
        <TextArea label={t('common.description')} name="description" defaultValue={pkg?.description} maxLength={1000} />
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label={t('common.price')} name="price" type="number" step="0.01" min="0" required defaultValue={pkg ? pkg.priceMinor / 100 : ''} />
          <Field label={t('common.currency')} name="currency" maxLength={3} required defaultValue={pkg?.currency ?? 'GEL'} />
          <SelectField label={t('packages.per')} name="period" defaultValue={pkg?.billingPeriod ?? t('packages.month')}>
            <option value={t('packages.month')}>{t('packages.month')}</option>
            <option value={t('packages.year')}>{t('packages.year')}</option>
          </SelectField>
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label={t('packages.trialDays')} name="trial" type="number" min="0" max="90" defaultValue={pkg?.trialDays ?? 0} />
          <Field label={t('common.streams')} name="streams" type="number" min="1" max="20" required defaultValue={pkg?.maxStreams ?? 1} />
          <Field label={t('common.devices')} name="devices" type="number" min="1" max="50" required defaultValue={pkg?.maxDevices ?? 3} />
        </div>
        {pkg && (
          <SelectField label={t('common.status')} name="status" defaultValue={pkg.status}>
            <option value="draft">{t('packages.draftOption')}</option>
            <option value="active">{t('packages.activeOption')}</option>
            <option value="retired">{t('packages.retiredOption')}</option>
          </SelectField>
        )}
        <p className="text-xs text-fg-subtle">{t('packages.priceHint')}</p>
        <ErrorNote error={save.error} />
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button tone="primary" type="submit" busy={save.isPending}>
            {t('packages.requestApproval')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function ChannelPicker({ open, pkg, onClose }: { open: boolean; pkg: PackageDetailDto; onClose: () => void }) {
  return (
    <Dialog open={open} title={t('pkg.channelsOf', { name: pkg.name })} onClose={onClose}>
      {/* Mounted per opening: starts from the package's current channels. */}
      {open && <ChannelPickerBody pkg={pkg} onClose={onClose} />}
    </Dialog>
  );
}

function ChannelPickerBody({ pkg, onClose }: { pkg: PackageDetailDto; onClose: () => void }) {
  const [selected, setSelected] = useState<string[]>(pkg.channelIds);
  const [text, setText] = useState('');
  const q = useDeferredValue(text.trim());
  const results = useQuery({ queryKey: ['channels', 'picker', q], queryFn: () => api<MasterChannelPageDto>(`/channels?limit=50&status=active${q ? `&q=${encodeURIComponent(q)}` : ''}`) });
  const all = useQuery({ queryKey: ['channels', 'all'], queryFn: () => api<MasterChannelPageDto>('/channels?limit=200') });
  const names = new Map(all.data?.items.map((channel) => [channel.id, channel.name]));
  const save = useAction((channelIds: string[]) => api<ChangeRequestedDto | PackageDetailDto>(`/packages/${pkg.id}`, { method: 'PATCH', body: { channelIds } }), {
    inlineErrors: true,
    invalidate: [['package'], ['change-requests']],
    onSuccess: (result) => {
      sentForApproval(result, t('packages.channelsUpdated'));
      onClose();
    },
  });
  return (
    <>
      <div className="flex flex-wrap gap-1.5">
        {selected.map((id) => (
          <button key={id} type="button" onClick={() => setSelected(selected.filter((item) => item !== id))} className="inline-flex items-center gap-1 rounded-md bg-accent/15 px-2 py-0.5 text-xs text-amber-200" aria-label={`Remove ${names.get(id) ?? id}`}>
            {names.get(id) ?? id.slice(-8)} <X className="h-3 w-3" />
          </button>
        ))}
        {selected.length === 0 && <span className="text-xs text-fg-muted">{t('packages.noneSelected')}</span>}
      </div>
      <Field label={t('packages.addChannels')} placeholder={t('common.search')} value={text} onChange={(e) => setText(e.target.value)} />
      <ul className="max-h-60 space-y-1 overflow-y-auto">
        {results.data?.items
          .filter((channel) => !selected.includes(channel.id))
          .map((channel) => (
            <li key={channel.id}>
              <button type="button" onClick={() => setSelected([...selected, channel.id])} className="w-full rounded-lg px-3 py-1.5 text-left text-sm hover:bg-line/10">
                + {channel.name} <span className="text-xs text-fg-subtle">{channel.activeGrants ? '' : t('packages.noRightsYet')}</span>
              </button>
            </li>
          ))}
      </ul>
      <ErrorNote error={save.error} />
      <div className="flex justify-end gap-2">
        <Button onClick={onClose}>{t('common.cancel')}</Button>
        <Button tone="primary" busy={save.isPending} onClick={() => save.mutate(selected)}>
          {t('packages.requestApproval')}
        </Button>
      </div>
    </>
  );
}
