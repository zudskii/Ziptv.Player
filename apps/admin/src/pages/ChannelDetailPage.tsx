import type { CategoryDto, ChangeRequestedDto, ChangeRequestPageDto, EpgCoverageDto, FeedDto, MasterChannelDetailDto, OperatorGuideChannelDto, RightsGrantDto } from '@ziptv/contracts';
import { useQuery } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, Ban, CalendarClock, Plus, Trash2 } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router';
import { toast } from 'sonner';

import { Badge, Button, ConfirmDialog, DataTable, Dialog, ErrorNote, Field, KeyValues, PageHeader, Section, SelectField, Spinner } from '../components/ui';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { dateInput, formatDate, fromDateInput } from '../lib/format';
import { useAction } from '../lib/mutation';
import { statusLabel, t, tx } from '../i18n';

const DEVICE_CLASSES = ['web', 'mobile', 'tv', 'stb'] as const;
const MODELS = ['subscription', 'fast', 'b2b'] as const;

/** 9.2 — one master channel: metadata, logo, feeds (primary/backups), rights, EPG mapping. */
export function ChannelDetailPage() {
  const { channelId = '' } = useParams();
  const { can } = useAuth();
  const channel = useQuery({ queryKey: ['channel', channelId], queryFn: () => api<MasterChannelDetailDto>(`/channels/${channelId}`) });
  const categories = useQuery({ queryKey: ['categories'], queryFn: () => api<CategoryDto[]>('/categories') });
  const pendingGrants = useQuery({ queryKey: ['change-requests', 'channel', channelId], queryFn: () => api<ChangeRequestPageDto>(`/change-requests?status=pending&kind=rights.grant&targetId=${channelId}`), enabled: can('rights:read') });
  const [editing, setEditing] = useState(false);
  const [granting, setGranting] = useState(false);
  const [revoking, setRevoking] = useState<RightsGrantDto | null>(null);
  const [removing, setRemoving] = useState<FeedDto | null>(null);
  const invalidate = [['channel', channelId], ['channels']];

  const updateFeed = useAction(({ id, patch }: { id: string; patch: Record<string, unknown> }) => api(`/feeds/${id}`, { method: 'PATCH', body: patch }), { success: t('channeldetail.feedUpdated'), invalidate });
  const deleteFeed = useAction((id: string) => api(`/feeds/${id}`, { method: 'DELETE' }), { inlineErrors: true, success: t('channeldetail.feedRemoved'), invalidate, onSuccess: () => setRemoving(null) });
  const revoke = useAction((id: string) => api<RightsGrantDto>(`/grants/${id}/revoke`, { method: 'POST' }), {
    inlineErrors: true,
    success: t('channeldetail.rightsRevoked'),
    invalidate: [...invalidate, ['change-requests']],
    onSuccess: () => setRevoking(null),
  });

  if (channel.isPending) return <Spinner />;
  if (channel.error) return <ErrorNote error={channel.error} />;
  const data = channel.data;
  const feeds = [...data.feeds].sort((a, b) => a.priority - b.priority);
  const move = (index: number, step: -1 | 1) => {
    const other = feeds[index + step];
    const feed = feeds[index];
    if (!other || !feed) return;
    // Swap priorities (lower = tried first).
    updateFeed.mutate({ id: feed.id, patch: { priority: other.priority } });
    updateFeed.mutate({ id: other.id, patch: { priority: feed.priority } });
  };

  return (
    <>
      <Link to="/channels" className="text-sm text-fg-muted hover:text-fg">
        {t('channeldetail.back')}
      </Link>
      <PageHeader
        title={data.name}
        description={t('catalog.slugUpdated', { slug: data.slug, date: formatDate(data.updatedAt) })}
        actions={
          <>
            {can('monitoring:read') && (
              <Link to={`/monitoring?channelId=${data.id}`}>
                <Button>{t('channeldetail.failoverHealth')}</Button>
              </Link>
            )}
            {can('catalog:write') && (
              <Button tone="primary" onClick={() => setEditing(true)}>
                {t('common.edit')}
              </Button>
            )}
          </>
        }
      />
      <div className="mb-8 flex flex-wrap items-start gap-6">
        {data.logo ? <img src={data.logo} alt="" className="h-20 w-32 rounded-lg bg-line/10 object-contain p-2" onError={(event) => (event.currentTarget.style.visibility = 'hidden')} /> : <div className="flex h-20 w-32 items-center justify-center rounded-lg bg-line/10 text-xs text-fg-subtle">{t('channeldetail.noLogo')}</div>}
        <div className="min-w-0 flex-1">
          <KeyValues
            rows={[
              [t('common.status'), <Badge key="s" tone={data.status === 'active' ? 'ok' : 'neutral'}>{statusLabel(data.status)}</Badge>],
              [t('common.category'), categories.data?.find((category) => category.id === data.categoryId)?.name ?? '—'],
              [t('channeldetail.originCountry'), data.originCountry ?? '—'],
              [t('channeldetail.languages'), data.languages.join(', ') || '—'],
              [t('channeldetail.globalId'), data.globalUid ?? '—'],
              [t('channeldetail.aliases'), data.aliases.map((alias) => `${alias.key} (${alias.kind})`).join(', ') || '—'],
              [t('common.lineups'), data.lineups.map((lineup) => `${lineup.slug} #${lineup.number}`).join(', ') || '—'],
            ]}
          />
        </div>
      </div>

      <Section title={t('common.feeds')} description={t('channeldetail.feedsHint')}>
        <DataTable
          label={t('common.feeds')}
          rows={feeds}
          rowKey={(row) => row.id}
          empty={t('channeldetail.noFeeds')}
          columns={[
            { header: '#', cell: (row) => feeds.indexOf(row) + 1, className: 'w-10 tabular-nums' },
            { header: t('common.provider'), cell: (row) => <div><p className="font-medium">{row.providerName}</p><p className="text-xs text-fg-muted">{row.streamName}</p></div> },
            { header: t('common.status'), cell: (row) => (row.status === t('channeldetail.disabled') ? <Badge>{t('channeldetail.disabled')}</Badge> : row.playable ? <Badge tone="ok">{t('channeldetail.playable')}</Badge> : <Badge tone="warn">{t('channeldetail.notPlayable')}</Badge>) },
            {
              header: t('common.order'),
              cell: (row) => {
                const index = feeds.indexOf(row);
                return can('catalog:write') ? (
                  <div className="flex gap-1">
                    <Button aria-label={t('catalog.moveUp', { name: row.providerName })} disabled={index === 0} onClick={() => move(index, -1)}>
                      <ArrowUp className="h-4 w-4" />
                    </Button>
                    <Button aria-label={t('catalog.moveDown', { name: row.providerName })} disabled={index === feeds.length - 1} onClick={() => move(index, 1)}>
                      <ArrowDown className="h-4 w-4" />
                    </Button>
                    <Button onClick={() => updateFeed.mutate({ id: row.id, patch: { status: row.status === 'active' ? t('channeldetail.disabled') : 'active' } })}>{row.status === 'active' ? t('channeldetail.disable') : t('channeldetail.enable')}</Button>
                    <Button tone="danger" aria-label={t('catalog.removeFeed', { name: row.providerName })} onClick={() => setRemoving(row)}>
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                ) : null;
              },
            },
          ]}
        />
      </Section>

      <Section
        title={t('common.rights')}
        description={t('channeldetail.rightsHint')}
        actions={
          can('rights:write') ? (
            <Button tone="primary" onClick={() => setGranting(true)}>
              <Plus className="h-4 w-4" aria-hidden /> {t('channeldetail.requestGrant')}
            </Button>
          ) : undefined
        }
      >
        {pendingGrants.data && pendingGrants.data.items.length > 0 && (
          <ul className="mb-3 space-y-1 text-sm">
            {pendingGrants.data.items.map((request) => (
              <li key={request.id} className="rounded-lg border border-accent/30 bg-accent/10 px-3 py-2 text-amber-200">
                {tx('catalog.waitingApproval', { summary: request.summary, link: (chunks) => <Link to="/approvals" className="underline">{chunks}</Link> })}
              </li>
            ))}
          </ul>
        )}
        <DataTable
          label={t('channeldetail.grants')}
          rows={data.grants}
          rowKey={(row) => row.id}
          empty={t('channeldetail.noRights')}
          columns={[
            { header: t('common.territory'), cell: (row) => (row.territory === '*' ? t('channeldetail.worldwide') : row.territory) },
            { header: t('common.devices'), cell: (row) => row.deviceClasses.join(', ') },
            { header: t('common.model'), cell: (row) => row.businessModels.join(', ') },
            { header: t('common.window'), cell: (row) => t('catalog.windowRange', { from: formatDate(row.startAt), to: row.endAt ? formatDate(row.endAt) : t('catalog.openEnded') }), className: 'whitespace-nowrap' },
            { header: t('common.catchup'), cell: (row) => (row.catchupDays > 0 ? t('catalog.days', { n: row.catchupDays }) : '—'), className: 'tabular-nums' },
            { header: t('feed.quality'), cell: (row) => (row.maxQuality ? t(`feed.qualities.${row.maxQuality}`) : t('feed.unlimited')) },
            { header: t('common.contract'), cell: (row) => <div><code className="text-xs">{row.contractRef}</code>{row.origin === 'feed' && <p className="mt-0.5"><Badge tone="neutral">{t('feed.fromFeed')}</Badge></p>}</div> },
            { header: t('common.status'), cell: (row) => <Badge tone={row.status === 'active' ? 'ok' : 'neutral'}>{statusLabel(row.status)}</Badge> },
            {
              header: '',
              cell: (row) =>
                // Feed grants follow the provider's signed feed (the next sync would bring them back).
                can('rights:write') && row.status === 'active' && row.origin === 'manual' ? (
                  <Button tone="danger" onClick={() => setRevoking(row)}>
                    <Ban className="h-4 w-4" aria-hidden /> {t('channeldetail.revoke')}
                  </Button>
                ) : null,
            },
          ]}
        />
      </Section>

      <EpgMapping channelId={data.id} channelName={data.name} />

      <EditChannelDialog open={editing} channel={data} categories={categories.data ?? []} onClose={() => setEditing(false)} />
      <GrantDialog open={granting} channelId={data.id} onClose={() => setGranting(false)} />
      <ConfirmDialog
        open={revoking !== null}
        title={t('channeldetail.revokeTitle')}
        description={<p>{t('channeldetail.revokeHint')}</p>}
        confirmLabel={t('channeldetail.revokeNow')}
        tone="danger"
        busy={revoke.isPending}
        error={revoke.error}
        onConfirm={() => revoking && revoke.mutate(revoking.id)}
        onClose={() => setRevoking(null)}
      />
      <ConfirmDialog
        open={removing !== null}
        title={t('channeldetail.removeFeedTitle')}
        description={<p>{t('channeldetail.removeFeedHint')}</p>}
        confirmLabel={t('channeldetail.removeFeed')}
        tone="danger"
        busy={deleteFeed.isPending}
        error={deleteFeed.error}
        onConfirm={() => removing && deleteFeed.mutate(removing.id)}
        onClose={() => setRemoving(null)}
      />
    </>
  );
}

function EditChannelDialog({ open, channel, categories, onClose }: { open: boolean; channel: MasterChannelDetailDto; categories: CategoryDto[]; onClose: () => void }) {
  const update = useAction((body: Record<string, unknown>) => api<MasterChannelDetailDto>(`/channels/${channel.id}`, { method: 'PATCH', body }), { inlineErrors: true, success: t('channeldetail.saved'), invalidate: [['channel', channel.id], ['channels'], ['duplicates']], onSuccess: onClose });
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const value = (key: string) => String(form.get(key) ?? '').trim();
    update.mutate({
      name: value('name'),
      originCountry: value('country') ? value('country').toUpperCase() : null,
      categoryId: value('category') || null,
      logo: value('logo') || null,
      globalUid: value('globalUid') || null,
      languages: value('languages') ? value('languages').split(/[,\s]+/).filter(Boolean).map((code) => code.toLowerCase()) : [],
      status: value('status'),
      aliases: value('aliases') ? value('aliases').split(',').map((alias) => alias.trim()).filter(Boolean) : [],
    });
  };
  return (
    <Dialog open={open} title={t('catalog.editNamed', { name: channel.name })} onClose={onClose}>
      <form className="space-y-4" onSubmit={submit}>
        <Field label={t('common.name')} name="name" defaultValue={channel.name} required maxLength={120} />
        <Field label={t('channeldetail.logo')} name="logo" type="url" defaultValue={channel.logo ?? ''} placeholder="https://…" />
        <SelectField label={t('common.category')} name="category" defaultValue={channel.categoryId ?? ''}>
          <option value="">—</option>
          {categories.map((category) => (
            <option key={category.id} value={category.id}>
              {category.name}
            </option>
          ))}
        </SelectField>
        <Field label={t('channeldetail.originCountry')} name="country" defaultValue={channel.originCountry ?? ''} maxLength={2} />
        <Field label={t('channeldetail.languages')} name="languages" defaultValue={channel.languages.join(', ')} hint={t('channeldetail.languagesHint')} />
        <Field label={t('channeldetail.globalIdTvg')} name="globalUid" defaultValue={channel.globalUid ?? ''} />
        <Field label={t('channeldetail.extraNames')} name="aliases" defaultValue={channel.aliases.filter((alias) => alias.kind === 'manual').map((alias) => alias.key).join(', ')} hint={t('channeldetail.extraNamesHint')} />
        <SelectField label={t('common.status')} name="status" defaultValue={channel.status}>
          <option value="active">{t('common.activeCap')}</option>
          <option value="hidden">{t('channeldetail.hiddenOption')}</option>
        </SelectField>
        <ErrorNote error={update.error} />
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button tone="primary" type="submit" busy={update.isPending}>
            {t('common.save')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function GrantDialog({ open, channelId, onClose }: { open: boolean; channelId: string; onClose: () => void }) {
  const [devices, setDevices] = useState<string[]>(['web']);
  const [models, setModels] = useState<string[]>(['subscription']);
  const request = useAction((body: Record<string, unknown>) => api<ChangeRequestedDto | RightsGrantDto>(`/channels/${channelId}/grants`, { method: 'POST', body }), {
    inlineErrors: true,
    invalidate: [['channel', channelId], ['change-requests']],
    onSuccess: (result) => {
      toast.success('changeRequest' in result ? t('channeldetail.sentForApproval') : t('channeldetail.granted'));
      onClose();
    },
  });
  const toggle = (list: string[], value: string) => (list.includes(value) ? list.filter((item) => item !== value) : [...list, value]);
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const value = (key: string) => String(form.get(key) ?? '').trim();
    request.mutate({ territory: value('territory').toUpperCase() || '*', deviceClasses: devices, businessModels: models, startAt: fromDateInput(value('start')) ?? new Date().toISOString(), endAt: fromDateInput(value('end')), contractRef: value('contract'), catchupDays: Number(value('catchup') || 0), maxQuality: value('quality') || null });
  };
  return (
    <Dialog open={open} title={t('channeldetail.requestTitle')} onClose={onClose}>
      <form className="space-y-4" onSubmit={submit}>
        <Field label={t('common.territory')} name="territory" placeholder={t('channeldetail.territoryHint')} maxLength={2} defaultValue="GE" />
        <fieldset className="space-y-1">
          <legend className="text-sm text-fg-muted">{t('common.devices')}</legend>
          <div className="flex flex-wrap gap-3 text-sm">
            {DEVICE_CLASSES.map((device) => (
              <label key={device} className="flex items-center gap-1.5">
                <input type="checkbox" checked={devices.includes(device)} onChange={() => setDevices(toggle(devices, device))} /> {device}
              </label>
            ))}
          </div>
        </fieldset>
        <fieldset className="space-y-1">
          <legend className="text-sm text-fg-muted">{t('channeldetail.businessModels')}</legend>
          <div className="flex flex-wrap gap-3 text-sm">
            {MODELS.map((model) => (
              <label key={model} className="flex items-center gap-1.5">
                <input type="checkbox" checked={models.includes(model)} onChange={() => setModels(toggle(models, model))} /> {model}
              </label>
            ))}
          </div>
        </fieldset>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t('channeldetail.from')} name="start" type="date" defaultValue={dateInput(new Date().toISOString())} required />
          <Field label={t('channeldetail.until')} name="end" type="date" />
        </div>
        <Field label={t('channeldetail.catchupDays')} name="catchup" type="number" min={0} max={30} defaultValue="0" />
        <SelectField label={t('feed.qualityLimit')} name="quality" defaultValue="">
          <option value="">{t('feed.unlimited')}</option>
          <option value="sd">{t('feed.qualities.sd')}</option>
          <option value="hd">{t('feed.qualities.hd')}</option>
          <option value="fhd">{t('feed.qualities.fhd')}</option>
          <option value="uhd">{t('feed.qualities.uhd')}</option>
        </SelectField>
        <Field label={t('channeldetail.contractRef')} name="contract" required maxLength={200} />
        <ErrorNote error={request.error} />
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button tone="primary" type="submit" busy={request.isPending} disabled={devices.length === 0 || models.length === 0}>
            {t('common.request')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

/** EPG of this channel: the guide channel it is mapped to (automatic or manual). */
function EpgMapping({ channelId, channelName }: { channelId: string; channelName: string }) {
  const { can } = useAuth();
  const coverage = useQuery({ queryKey: ['epg-coverage'], queryFn: () => api<EpgCoverageDto>('/epg/coverage') });
  const [choosing, setChoosing] = useState(false);
  const [search, setSearch] = useState(channelName);
  const candidates = useQuery({ queryKey: ['guide-channels', search], queryFn: () => api<OperatorGuideChannelDto[]>(`/epg/guide-channels?q=${encodeURIComponent(search)}`), enabled: choosing && search.trim().length > 0 });
  const set = useAction((body: { guideId: string; epgChannelId: string }) => api(`/channels/${channelId}/epg`, { method: 'POST', body }), { success: t('channeldetail.mappingSaved'), invalidate: [['epg-coverage']], onSuccess: () => setChoosing(false) });
  const clear = useAction(() => api(`/channels/${channelId}/epg`, { method: 'DELETE' }), { success: t('channeldetail.backToAuto'), invalidate: [['epg-coverage']] });
  const row = coverage.data?.channels.find((item) => item.channelId === channelId);
  return (
    <Section
      title={t('channeldetail.programmeGuide')}
      actions={
        can('catalog:write') ? (
          <>
            <Button onClick={() => setChoosing(true)}>
              <CalendarClock className="h-4 w-4" aria-hidden /> {t('channeldetail.mapManually')}
            </Button>
            {row?.mapping?.method === 'manual' && <Button onClick={() => clear.mutate(undefined)}>{t('channeldetail.useAuto')}</Button>}
          </>
        ) : undefined
      }
    >
      {row ? (
        <KeyValues
          rows={[
            [t('common.coverage'), <Badge key="c" tone={row.status === 'ok' ? 'ok' : row.status === 'unmapped' || row.status === 'no_data' ? 'danger' : 'warn'}>{row.status.replace('_', ' ')}</Badge>],
            [t('channeldetail.guideChannel'), row.mapping ? `${row.mapping.epgChannelId} in ${row.mapping.guideName} (${row.mapping.method})` : t('channeldetail.notMapped')],
            [t('channeldetail.next24'), row.programmes24h],
            [t('channeldetail.scheduleEnds'), row.scheduleEndsAt ? formatDate(row.scheduleEndsAt) : '—'],
          ]}
        />
      ) : (
        <p className="text-sm text-fg-muted">{coverage.isPending ? t('common.loading') : t('channeldetail.noGuideInfo')}</p>
      )}
      <Dialog open={choosing} title={t('channeldetail.mapTitle')} onClose={() => setChoosing(false)}>
        <Field label={t('channeldetail.searchGuides')} value={search} onChange={(e) => setSearch(e.target.value)} />
        <ul className="max-h-72 space-y-1 overflow-y-auto">
          {candidates.data?.map((candidate) => (
            <li key={`${candidate.guideId}:${candidate.id}`}>
              <button type="button" onClick={() => set.mutate({ guideId: candidate.guideId, epgChannelId: candidate.id })} className="w-full rounded-lg px-3 py-2 text-left text-sm hover:bg-line/10">
                <span className="font-mono">{candidate.id}</span> <span className="text-fg-muted">{candidate.names.join(' / ')}</span>
              </button>
            </li>
          ))}
          {candidates.data?.length === 0 && <li className="px-3 py-2 text-sm text-fg-muted">{t('channeldetail.noGuideMatch')}</li>}
        </ul>
      </Dialog>
    </Section>
  );
}
