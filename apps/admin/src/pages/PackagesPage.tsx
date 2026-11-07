import type { ChangeRequestedDto, ChangeRequestPageDto, MasterChannelPageDto, PackageDetailDto, PackageDto, PromoCodeDto, ProviderPackageOptionDto, RegionalPriceDto } from '@ziptv/contracts';
import { useQuery } from '@tanstack/react-query';
import { Plus, Trash2, X } from 'lucide-react';
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

const QUALITIES = ['sd', 'hd', 'fhd', 'uhd'] as const;
const VOD_MODES = ['included', 'package', 'none'] as const;
const statusTone = (status: PackageDto['status']) => (status === 'active' ? 'ok' : status === 'draft' ? 'warn' : 'neutral');
const qualityLabel = (quality: PackageDto['maxQuality']) => (quality ? t(`feed.qualities.${quality}`) : t('plans.asLicensed'));
const catchupLabel = (days: number | null) => (days === null ? t('plans.asLicensed') : days === 0 ? t('plans.noCatchup') : t('pkg.days', { count: days }));

/**
 * 9.6 / 17 — plans (what is sold): channels, VOD mode, quality, catch-up, prices per country,
 * versions; and promo codes. Every change is approved by a second person.
 */
export function PackagesPage() {
  const { can } = useAuth();
  const packages = useQuery({ queryKey: ['packages'], queryFn: () => api<PackageDto[]>('/packages') });
  const pending = useQuery({ queryKey: ['change-requests', 'packages'], queryFn: () => api<ChangeRequestPageDto>('/change-requests?status=pending&kind=package.create') });
  const [creating, setCreating] = useState(false);
  // Older versions live on for their holders; the list shows the plans (their latest version).
  const current = (packages.data ?? []).filter((pkg) => pkg.supersededBy === null);
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
        rows={current}
        rowKey={(row) => row.id}
        empty={packages.isPending ? t('common.loading') : t('packages.none')}
        columns={[
          {
            header: t('common.package'),
            cell: (row) => (
              <span className="flex items-center gap-2">
                <Link to={`/packages/${row.id}`} className="font-medium text-amber-200 hover:underline">
                  {row.name}
                </Link>
                {row.version > 1 && <Badge>{t('plans.versionShort', { version: row.version })}</Badge>}
              </span>
            ),
          },
          { header: t('common.status'), cell: (row) => <Badge tone={statusTone(row.status)}>{statusLabel(row.status)}</Badge> },
          { header: t('common.price'), cell: (row) => t('pkg.pricePer', { price: money({ currency: row.currency, amountMinor: row.priceMinor }), period: t(`pkg.period.${row.billingPeriod}`) }), className: 'whitespace-nowrap' },
          { header: t('plans.vod'), cell: (row) => t(`plans.vodMode.${row.vodMode}`) },
          { header: t('plans.qualityCatchup'), cell: (row) => `${qualityLabel(row.maxQuality)} · ${catchupLabel(row.catchupDays)}` },
          { header: t('packages.limits'), cell: (row) => t('pkg.limits', { streams: row.maxStreams, devices: row.maxDevices }) },
          { header: t('common.channels'), cell: (row) => row.channels, className: 'tabular-nums' },
          { header: t('plans.holders'), cell: (row) => row.holders, className: 'tabular-nums' },
        ]}
      />
      <PromoSection plans={current} />
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
  const vendorPackages = useQuery({ queryKey: ['provider-packages'], queryFn: () => api<ProviderPackageOptionDto[]>('/provider-packages') });
  const [editing, setEditing] = useState(false);
  const [channelEditing, setChannelEditing] = useState(false);
  if (pkg.isPending) return <Spinner />;
  if (pkg.error) return <ErrorNote error={pkg.error} />;
  const data = pkg.data;
  const names = new Map(channels.data?.items.map((channel) => [channel.id, channel.name]));
  const vendorNames = new Map(vendorPackages.data?.map((option) => [option.id, `${option.providerName} · ${option.name}`]));
  const open = requests.data?.items.find((request) => request.status === 'pending');
  const newer = data.supersededBy ? data.versions[0] : undefined;
  return (
    <>
      <Link to="/packages" className="text-sm text-fg-muted hover:text-fg">
        {t('packages.back')}
      </Link>
      <PageHeader
        title={`${data.name} · ${t('plans.versionShort', { version: data.version })}`}
        description={t('pkg.slugCreated', { slug: data.slug, date: formatDate(data.createdAt) })}
        actions={
          can('billing:write') && !open && !data.supersededBy ? (
            <>
              <Button onClick={() => setChannelEditing(true)}>{t('packages.changeChannels')}</Button>
              <Button tone="primary" onClick={() => setEditing(true)}>
                {t('packages.changeTerms')}
              </Button>
            </>
          ) : undefined
        }
      />
      {newer && (
        <p className="mb-4 rounded-lg border border-line/15 bg-line/5 px-3 py-2 text-sm text-fg-muted">
          {tx('plans.superseded', { holders: data.holders, version: newer.version, link: (chunks) => <Link className="text-amber-200 underline" to={`/packages/${newer.id}`}>{chunks}</Link> })}
        </p>
      )}
      {open && (
        <p className="mb-4 rounded-lg border border-accent/30 bg-accent/10 px-3 py-2 text-sm text-amber-200">
          {tx('pkg.waitingRequested', { summary: open.summary, name: open.requestedBy.name, link: (chunks) => <Link className="underline" to="/approvals">{chunks}</Link> })}
        </p>
      )}
      <Section title={t('packages.terms')} description={t('plans.versionHint')}>
        <KeyValues
          rows={[
            [t('common.status'), <Badge key="s" tone={statusTone(data.status)}>{statusLabel(data.status)}</Badge>],
            [t('common.price'), t('pkg.pricePer', { price: money({ currency: data.currency, amountMinor: data.priceMinor }), period: t(`pkg.period.${data.billingPeriod}`) })],
            [t('plans.regionalPrices'), data.prices.length ? data.prices.map((price) => `${price.country} ${money({ currency: price.currency, amountMinor: price.priceMinor })}`).join(' · ') : t('plans.basePriceEverywhere')],
            [t('packages.freeTrial'), data.trialDays ? t('pkg.days', { count: data.trialDays }) : t('common.noneLower')],
            [t('plans.vod'), data.vodMode === 'package' ? `${t('plans.vodMode.package')}: ${data.vodPackages.map((id) => vendorNames.get(id) ?? id.slice(-8)).join(', ')}` : t(`plans.vodMode.${data.vodMode}`)],
            [t('plans.quality'), qualityLabel(data.maxQuality)],
            [t('plans.catchup'), catchupLabel(data.catchupDays)],
            [t('packages.simultaneous'), data.maxStreams],
            [t('common.devices'), data.maxDevices],
            [t('packages.businessModel'), data.businessModel],
            [t('plans.holders'), data.holders],
            [t('common.description'), data.description || '—'],
          ]}
        />
      </Section>
      {data.versions.length > 1 && (
        <Section title={t('plans.versions')}>
          <DataTable
            label={t('plans.versions')}
            rows={data.versions}
            rowKey={(row) => row.id}
            columns={[
              { header: t('plans.version'), cell: (row) => (row.id === data.id ? <strong>{t('plans.versionShort', { version: row.version })}</strong> : <Link className="text-amber-200 hover:underline" to={`/packages/${row.id}`}>{t('plans.versionShort', { version: row.version })}</Link>) },
              { header: t('common.status'), cell: (row) => <Badge tone={statusTone(row.status)}>{statusLabel(row.status)}</Badge> },
              { header: t('common.price'), cell: (row) => money({ currency: row.currency, amountMinor: row.priceMinor }) },
              { header: t('plans.holders'), cell: (row) => row.holders, className: 'tabular-nums' },
              { header: t('plans.createdAt'), cell: (row) => formatDate(row.createdAt) },
            ]}
          />
        </Section>
      )}
      <Section title={t('pkg.channelsCount', { count: data.channelIds.length })} description={t('plans.channelsShared')}>
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
  return (
    <Dialog open={open} title={pkg ? t('pkg.changeNamed', { name: pkg.name }) : t('packages.new')} onClose={onClose}>
      {/* Mounted per opening: starts from the package's current terms. */}
      {open && <PackageForm pkg={pkg} onClose={onClose} />}
    </Dialog>
  );
}

function PackageForm({ pkg, onClose }: { pkg?: PackageDetailDto; onClose: () => void }) {
  const vendorPackages = useQuery({ queryKey: ['provider-packages'], queryFn: () => api<ProviderPackageOptionDto[]>('/provider-packages') });
  const [vodMode, setVodMode] = useState<PackageDto['vodMode']>(pkg?.vodMode ?? 'none');
  const [selectedVendor, setSelectedVendor] = useState<string[]>(pkg?.vodPackages ?? []);
  const [prices, setPrices] = useState<RegionalPriceDto[]>(pkg?.prices ?? []);
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
    const quality = value('quality');
    const catchup = value('catchup');
    const body: Record<string, unknown> = {
      name: value('name'),
      description: value('description'),
      priceMinor: Math.round(Number(value('price')) * 100),
      currency: value('currency').toUpperCase(),
      billingPeriod: value('period'),
      trialDays: Number(value('trial') || 0),
      maxStreams: Number(value('streams')),
      maxDevices: Number(value('devices')),
      vodMode,
      vodPackages: vodMode === 'package' ? selectedVendor : [],
      maxQuality: quality ? quality : null,
      catchupDays: catchup === '' ? null : Number(catchup),
      prices: prices.filter((price) => price.country.trim()).map((price) => ({ country: price.country.trim().toUpperCase(), currency: price.currency.trim().toUpperCase(), priceMinor: price.priceMinor })),
    };
    if (pkg) {
      body.status = value('status');
      // Only what changed: the request summary (and the approver) see exactly that.
      const current: Record<string, unknown> = {
        name: pkg.name,
        description: pkg.description,
        priceMinor: pkg.priceMinor,
        currency: pkg.currency,
        billingPeriod: pkg.billingPeriod,
        trialDays: pkg.trialDays,
        maxStreams: pkg.maxStreams,
        maxDevices: pkg.maxDevices,
        status: pkg.status,
        vodMode: pkg.vodMode,
        maxQuality: pkg.maxQuality,
        catchupDays: pkg.catchupDays,
      };
      for (const key of Object.keys(current)) if (body[key] === current[key]) delete body[key];
      if (JSON.stringify([...(body.vodPackages as string[])].sort()) === JSON.stringify([...pkg.vodPackages].sort())) delete body.vodPackages;
      if (JSON.stringify(body.prices) === JSON.stringify(pkg.prices)) delete body.prices;
      if (Object.keys(body).length === 0) return onClose();
    }
    save.mutate(body);
  };
  const setPrice = (index: number, patch: Partial<RegionalPriceDto>) => setPrices(prices.map((price, i) => (i === index ? { ...price, ...patch } : price)));
  return (
    <form className="space-y-4" onSubmit={submit}>
      <Field label={t('common.name')} name="name" defaultValue={pkg?.name} required maxLength={100} />
      <TextArea label={t('common.description')} name="description" defaultValue={pkg?.description} maxLength={1000} />
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label={t('plans.basePrice')} name="price" type="number" step="0.01" min="0" required defaultValue={pkg ? pkg.priceMinor / 100 : ''} />
        <Field label={t('common.currency')} name="currency" maxLength={3} required defaultValue={pkg?.currency ?? 'GEL'} />
        <SelectField label={t('packages.per')} name="period" defaultValue={pkg?.billingPeriod ?? 'month'}>
          <option value="month">{t('packages.month')}</option>
          <option value="year">{t('packages.year')}</option>
        </SelectField>
      </div>
      <fieldset className="space-y-2 rounded-lg border border-line/10 p-3">
        <legend className="px-1 text-xs font-medium text-fg-muted">{t('plans.regionalPrices')}</legend>
        {prices.map((price, index) => (
          <div key={index} className="grid grid-cols-[1fr_1fr_1fr_auto] items-end gap-2">
            <Field label={t('plans.country')} value={price.country} maxLength={2} required onChange={(event) => setPrice(index, { country: event.target.value.toUpperCase() })} />
            <Field label={t('common.currency')} value={price.currency} maxLength={3} required onChange={(event) => setPrice(index, { currency: event.target.value.toUpperCase() })} />
            <Field label={t('common.price')} type="number" step="0.01" min="0" required value={price.priceMinor / 100} onChange={(event) => setPrice(index, { priceMinor: Math.round(Number(event.target.value) * 100) })} />
            <Button aria-label={t('plans.removePrice')} onClick={() => setPrices(prices.filter((_, i) => i !== index))}>
              <Trash2 className="h-4 w-4" aria-hidden />
            </Button>
          </div>
        ))}
        <Button onClick={() => setPrices([...prices, { country: '', currency: 'EUR', priceMinor: 0 }])}>
          <Plus className="h-4 w-4" aria-hidden /> {t('plans.addPrice')}
        </Button>
        <p className="text-xs text-fg-subtle">{t('plans.regionalHint')}</p>
      </fieldset>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label={t('packages.trialDays')} name="trial" type="number" min="0" max="90" defaultValue={pkg?.trialDays ?? 0} />
        <Field label={t('common.streams')} name="streams" type="number" min="1" max="20" required defaultValue={pkg?.maxStreams ?? 1} />
        <Field label={t('common.devices')} name="devices" type="number" min="1" max="50" required defaultValue={pkg?.maxDevices ?? 3} />
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        <SelectField label={t('plans.vod')} name="vodMode" value={vodMode} onChange={(event) => setVodMode(event.target.value as PackageDto['vodMode'])}>
          {VOD_MODES.map((mode) => (
            <option key={mode} value={mode}>
              {t(`plans.vodMode.${mode}`)}
            </option>
          ))}
        </SelectField>
        <SelectField label={t('plans.quality')} name="quality" defaultValue={pkg?.maxQuality ?? ''}>
          <option value="">{t('plans.asLicensed')}</option>
          {QUALITIES.map((quality) => (
            <option key={quality} value={quality}>
              {t(`feed.qualities.${quality}`)}
            </option>
          ))}
        </SelectField>
        <Field label={t('plans.catchupDaysField')} name="catchup" type="number" min="0" max="30" placeholder={t('plans.asLicensed')} defaultValue={pkg?.catchupDays ?? ''} />
      </div>
      {vodMode === 'package' && (
        <fieldset className="space-y-1 rounded-lg border border-line/10 p-3">
          <legend className="px-1 text-xs font-medium text-fg-muted">{t('plans.vendorPackages')}</legend>
          {(vendorPackages.data ?? []).map((option) => (
            <label key={option.id} className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={selectedVendor.includes(option.id)} onChange={(event) => setSelectedVendor(event.target.checked ? [...selectedVendor, option.id] : selectedVendor.filter((id) => id !== option.id))} />
              {t('plans.vendorOption', { provider: option.providerName, name: option.name, count: option.items })}
              {option.status === 'gone' && <Badge tone="warn">{statusLabel('gone')}</Badge>}
            </label>
          ))}
          {vendorPackages.data?.length === 0 && <p className="text-xs text-fg-muted">{t('plans.noVendorPackages')}</p>}
        </fieldset>
      )}
      <p className="text-xs text-fg-subtle">{t('plans.limitsHint')}</p>
      {pkg && (
        <SelectField label={t('common.status')} name="status" defaultValue={pkg.status}>
          <option value="draft">{t('packages.draftOption')}</option>
          <option value="active">{t('packages.activeOption')}</option>
          <option value="retired">{t('packages.retiredOption')}</option>
        </SelectField>
      )}
      <p className="text-xs text-fg-subtle">{pkg && pkg.holders > 0 ? t('plans.versionWarning', { count: pkg.holders }) : t('packages.priceHint')}</p>
      <ErrorNote error={save.error} />
      <div className="flex justify-end gap-2">
        <Button onClick={onClose}>{t('common.cancel')}</Button>
        <Button tone="primary" type="submit" busy={save.isPending}>
          {t('packages.requestApproval')}
        </Button>
      </div>
    </form>
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
          <button key={id} type="button" onClick={() => setSelected(selected.filter((item) => item !== id))} className="inline-flex items-center gap-1 rounded-md bg-accent/15 px-2 py-0.5 text-xs text-amber-200" aria-label={t('plans.removeChannel', { name: names.get(id) ?? id })}>
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

// --- promo codes ------------------------------------------------------------------------------------

function PromoSection({ plans }: { plans: PackageDto[] }) {
  const { can } = useAuth();
  const promos = useQuery({ queryKey: ['promo-codes'], queryFn: () => api<PromoCodeDto[]>('/promo-codes') });
  const pending = useQuery({ queryKey: ['change-requests', 'promos'], queryFn: () => api<ChangeRequestPageDto>('/change-requests?status=pending&kind=promo.create') });
  const [creating, setCreating] = useState(false);
  const stop = useAction((id: string) => api<PromoCodeDto>(`/promo-codes/${id}`, { method: 'PATCH', body: { active: false } }), { success: t('promos.stopped'), invalidate: [['promo-codes']] });
  const planNames = new Map(plans.map((plan) => [plan.familyId, plan.name]));
  return (
    <Section
      title={t('promos.title')}
      description={t('promos.intro')}
      actions={
        can('billing:write') ? (
          <Button onClick={() => setCreating(true)}>
            <Plus className="h-4 w-4" aria-hidden /> {t('promos.new')}
          </Button>
        ) : undefined
      }
    >
      {pending.data && pending.data.items.length > 0 && (
        <ul className="mb-3 space-y-1 text-sm">
          {pending.data.items.map((request) => (
            <li key={request.id} className="rounded-lg border border-accent/30 bg-accent/10 px-3 py-2 text-amber-200">
              {tx('pkg.waitingApproval', { summary: request.summary, link: (chunks) => <Link className="underline" to="/approvals">{chunks}</Link> })}
            </li>
          ))}
        </ul>
      )}
      <ErrorNote error={promos.error} />
      <DataTable
        label={t('promos.title')}
        rows={promos.data ?? []}
        rowKey={(row) => row.id}
        empty={promos.isPending ? t('common.loading') : t('promos.none')}
        columns={[
          { header: t('promos.code'), cell: (row) => <code className="text-xs">{row.code}</code> },
          { header: t('promos.discount'), cell: (row) => (row.kind === 'percent' ? t('promos.percentOff', { value: row.value }) : t('promos.amountOff', { amount: money({ currency: row.currency ?? 'GEL', amountMinor: row.value }) })) },
          { header: t('promos.plans'), cell: (row) => (row.families.length ? row.families.map((family) => planNames.get(family) ?? family.slice(-8)).join(', ') : t('promos.allPlans')) },
          { header: t('promos.uses'), cell: (row) => (row.maxRedemptions ? t('promos.usesOf', { used: row.redemptions, max: row.maxRedemptions }) : row.redemptions), className: 'tabular-nums' },
          { header: t('promos.valid'), cell: (row) => `${formatDate(row.startsAt)} → ${row.endsAt ? formatDate(row.endsAt) : '∞'}`, className: 'whitespace-nowrap' },
          { header: t('common.status'), cell: (row) => <Badge tone={row.active ? 'ok' : 'neutral'}>{row.active ? t('promos.active') : t('promos.inactive')}</Badge> },
          {
            header: '',
            cell: (row) =>
              can('billing:write') && row.active ? (
                <Button busy={stop.isPending && stop.variables === row.id} onClick={() => stop.mutate(row.id)}>
                  {t('promos.stop')}
                </Button>
              ) : null,
          },
        ]}
      />
      <Dialog open={creating} title={t('promos.new')} onClose={() => setCreating(false)}>
        {creating && <PromoForm plans={plans} onClose={() => setCreating(false)} />}
      </Dialog>
    </Section>
  );
}

function PromoForm({ plans, onClose }: { plans: PackageDto[]; onClose: () => void }) {
  const [kind, setKind] = useState<PromoCodeDto['kind']>('percent');
  const [families, setFamilies] = useState<string[]>([]);
  const save = useAction((body: Record<string, unknown>) => api<ChangeRequestedDto | PromoCodeDto>('/promo-codes', { method: 'POST', body }), {
    inlineErrors: true,
    invalidate: [['promo-codes'], ['change-requests']],
    onSuccess: (result) => {
      sentForApproval(result, t('promos.created'));
      onClose();
    },
  });
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const value = (key: string) => String(form.get(key) ?? '').trim();
    const ends = value('ends');
    save.mutate({
      code: value('code').toUpperCase(),
      kind,
      value: kind === 'percent' ? Number(value('value')) : Math.round(Number(value('value')) * 100),
      ...(kind === 'amount' ? { currency: value('currency').toUpperCase() } : {}),
      families,
      maxRedemptions: value('max') ? Number(value('max')) : null,
      endsAt: ends ? new Date(`${ends}T23:59:59`).toISOString() : null,
      note: value('note'),
    });
  };
  return (
    <form className="space-y-4" onSubmit={submit}>
      <Field label={t('promos.code')} name="code" required minLength={3} maxLength={32} pattern="[A-Za-z0-9_\-]+" />
      <div className="grid gap-3 sm:grid-cols-3">
        <SelectField label={t('promos.discount')} name="kind" value={kind} onChange={(event) => setKind(event.target.value as PromoCodeDto['kind'])}>
          <option value="percent">{t('promos.percent')}</option>
          <option value="amount">{t('promos.amount')}</option>
        </SelectField>
        <Field label={kind === 'percent' ? t('promos.percentValue') : t('promos.amountValue')} name="value" type="number" required min={kind === 'percent' ? 1 : 0.01} max={kind === 'percent' ? 100 : undefined} step={kind === 'percent' ? 1 : 0.01} />
        {kind === 'amount' && <Field label={t('common.currency')} name="currency" maxLength={3} required defaultValue="GEL" />}
      </div>
      <fieldset className="space-y-1 rounded-lg border border-line/10 p-3">
        <legend className="px-1 text-xs font-medium text-fg-muted">{t('promos.plans')}</legend>
        {plans.map((plan) => (
          <label key={plan.familyId} className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={families.includes(plan.familyId)} onChange={(event) => setFamilies(event.target.checked ? [...families, plan.familyId] : families.filter((id) => id !== plan.familyId))} />
            {plan.name}
          </label>
        ))}
        <p className="text-xs text-fg-subtle">{t('promos.plansHint')}</p>
      </fieldset>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={t('promos.maxRedemptions')} name="max" type="number" min="1" placeholder="∞" />
        <Field label={t('promos.endsAt')} name="ends" type="date" />
      </div>
      <Field label={t('common.notes')} name="note" maxLength={500} />
      <p className="text-xs text-fg-subtle">{t('promos.firstPaymentHint')}</p>
      <ErrorNote error={save.error} />
      <div className="flex justify-end gap-2">
        <Button onClick={onClose}>{t('common.cancel')}</Button>
        <Button tone="primary" type="submit" busy={save.isPending}>
          {t('packages.requestApproval')}
        </Button>
      </div>
    </form>
  );
}
