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

  const updateFeed = useAction(({ id, patch }: { id: string; patch: Record<string, unknown> }) => api(`/feeds/${id}`, { method: 'PATCH', body: patch }), { success: 'Feed updated', invalidate });
  const deleteFeed = useAction((id: string) => api(`/feeds/${id}`, { method: 'DELETE' }), { inlineErrors: true, success: 'Feed removed', invalidate, onSuccess: () => setRemoving(null) });
  const revoke = useAction((id: string) => api<RightsGrantDto>(`/grants/${id}/revoke`, { method: 'POST' }), {
    inlineErrors: true,
    success: 'Rights revoked — viewings stopped; a second person reviews it in Approvals',
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
        ← Channels
      </Link>
      <PageHeader
        title={data.name}
        description={`/${data.slug} · updated ${formatDate(data.updatedAt)}`}
        actions={
          <>
            {can('monitoring:read') && (
              <Link to={`/monitoring?channelId=${data.id}`}>
                <Button>Failover &amp; health</Button>
              </Link>
            )}
            {can('catalog:write') && (
              <Button tone="primary" onClick={() => setEditing(true)}>
                Edit
              </Button>
            )}
          </>
        }
      />
      <div className="mb-8 flex flex-wrap items-start gap-6">
        {data.logo ? <img src={data.logo} alt="" className="h-20 w-32 rounded-lg bg-line/10 object-contain p-2" onError={(event) => (event.currentTarget.style.visibility = 'hidden')} /> : <div className="flex h-20 w-32 items-center justify-center rounded-lg bg-line/10 text-xs text-fg-subtle">No logo</div>}
        <div className="min-w-0 flex-1">
          <KeyValues
            rows={[
              ['Status', <Badge key="s" tone={data.status === 'active' ? 'ok' : 'neutral'}>{data.status}</Badge>],
              ['Category', categories.data?.find((category) => category.id === data.categoryId)?.name ?? '—'],
              ['Origin country', data.originCountry ?? '—'],
              ['Languages', data.languages.join(', ') || '—'],
              ['Global id', data.globalUid ?? '—'],
              ['Aliases', data.aliases.map((alias) => `${alias.key} (${alias.kind})`).join(', ') || '—'],
              ['Lineups', data.lineups.map((lineup) => `${lineup.slug} #${lineup.number}`).join(', ') || '—'],
            ]}
          />
        </div>
      </div>

      <Section title="Feeds" description="Tried in this order; failover switches to the next healthy one. Disabled feeds are never used.">
        <DataTable
          label="Feeds"
          rows={feeds}
          rowKey={(row) => row.id}
          empty="No feeds yet — match a provider stream in the review queue."
          columns={[
            { header: '#', cell: (row) => feeds.indexOf(row) + 1, className: 'w-10 tabular-nums' },
            { header: 'Provider', cell: (row) => <div><p className="font-medium">{row.providerName}</p><p className="text-xs text-fg-muted">{row.streamName}</p></div> },
            { header: 'Status', cell: (row) => (row.status === 'disabled' ? <Badge>disabled</Badge> : row.playable ? <Badge tone="ok">playable</Badge> : <Badge tone="warn">not playable</Badge>) },
            {
              header: 'Order',
              cell: (row) => {
                const index = feeds.indexOf(row);
                return can('catalog:write') ? (
                  <div className="flex gap-1">
                    <Button aria-label={`Move ${row.providerName} up`} disabled={index === 0} onClick={() => move(index, -1)}>
                      <ArrowUp className="h-4 w-4" />
                    </Button>
                    <Button aria-label={`Move ${row.providerName} down`} disabled={index === feeds.length - 1} onClick={() => move(index, 1)}>
                      <ArrowDown className="h-4 w-4" />
                    </Button>
                    <Button onClick={() => updateFeed.mutate({ id: row.id, patch: { status: row.status === 'active' ? 'disabled' : 'active' } })}>{row.status === 'active' ? 'Disable' : 'Enable'}</Button>
                    <Button tone="danger" aria-label={`Remove ${row.providerName} feed`} onClick={() => setRemoving(row)}>
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
        title="Rights"
        description="Where, on which devices and under which business model the channel may be shown. New grants need a second person's approval; a revocation applies at once."
        actions={
          can('rights:write') ? (
            <Button tone="primary" onClick={() => setGranting(true)}>
              <Plus className="h-4 w-4" aria-hidden /> Request grant
            </Button>
          ) : undefined
        }
      >
        {pendingGrants.data && pendingGrants.data.items.length > 0 && (
          <ul className="mb-3 space-y-1 text-sm">
            {pendingGrants.data.items.map((request) => (
              <li key={request.id} className="rounded-lg border border-accent/30 bg-accent/10 px-3 py-2 text-amber-200">
                Waiting for approval: {request.summary} — <Link to="/approvals" className="underline">Approvals</Link>
              </li>
            ))}
          </ul>
        )}
        <DataTable
          label="Rights grants"
          rows={data.grants}
          rowKey={(row) => row.id}
          empty="No rights: the channel is not shown to anyone."
          columns={[
            { header: 'Territory', cell: (row) => (row.territory === '*' ? 'Worldwide' : row.territory) },
            { header: 'Devices', cell: (row) => row.deviceClasses.join(', ') },
            { header: 'Model', cell: (row) => row.businessModels.join(', ') },
            { header: 'Window', cell: (row) => `${formatDate(row.startAt)} → ${row.endAt ? formatDate(row.endAt) : 'open-ended'}`, className: 'whitespace-nowrap' },
            { header: 'Contract', cell: (row) => <code className="text-xs">{row.contractRef}</code> },
            { header: 'Status', cell: (row) => <Badge tone={row.status === 'active' ? 'ok' : 'neutral'}>{row.status}</Badge> },
            {
              header: '',
              cell: (row) =>
                can('rights:write') && row.status === 'active' ? (
                  <Button tone="danger" onClick={() => setRevoking(row)}>
                    <Ban className="h-4 w-4" aria-hidden /> Revoke
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
        title="Revoke these rights now?"
        description={<p>Viewings that depend on them stop immediately. A second person reviews the revocation afterwards.</p>}
        confirmLabel="Revoke now"
        tone="danger"
        busy={revoke.isPending}
        error={revoke.error}
        onConfirm={() => revoking && revoke.mutate(revoking.id)}
        onClose={() => setRevoking(null)}
      />
      <ConfirmDialog
        open={removing !== null}
        title="Remove this feed?"
        description={<p>The provider stream goes back to the review queue.</p>}
        confirmLabel="Remove feed"
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
  const update = useAction((body: Record<string, unknown>) => api<MasterChannelDetailDto>(`/channels/${channel.id}`, { method: 'PATCH', body }), { inlineErrors: true, success: 'Channel saved', invalidate: [['channel', channel.id], ['channels'], ['duplicates']], onSuccess: onClose });
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
    <Dialog open={open} title={`Edit ${channel.name}`} onClose={onClose}>
      <form className="space-y-4" onSubmit={submit}>
        <Field label="Name" name="name" defaultValue={channel.name} required maxLength={120} />
        <Field label="Logo URL" name="logo" type="url" defaultValue={channel.logo ?? ''} placeholder="https://…" />
        <SelectField label="Category" name="category" defaultValue={channel.categoryId ?? ''}>
          <option value="">—</option>
          {categories.map((category) => (
            <option key={category.id} value={category.id}>
              {category.name}
            </option>
          ))}
        </SelectField>
        <Field label="Origin country" name="country" defaultValue={channel.originCountry ?? ''} maxLength={2} />
        <Field label="Languages" name="languages" defaultValue={channel.languages.join(', ')} hint="ISO 639 codes, e.g. ka, en" />
        <Field label="Global id (tvg-id)" name="globalUid" defaultValue={channel.globalUid ?? ''} />
        <Field label="Extra names (aliases)" name="aliases" defaultValue={channel.aliases.filter((alias) => alias.kind === 'manual').map((alias) => alias.key).join(', ')} hint="Comma-separated; streams with these names match this channel." />
        <SelectField label="Status" name="status" defaultValue={channel.status}>
          <option value="active">Active</option>
          <option value="hidden">Hidden (not listed to viewers)</option>
        </SelectField>
        <ErrorNote error={update.error} />
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button tone="primary" type="submit" busy={update.isPending}>
            Save
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
      toast.success('changeRequest' in result ? 'Sent for approval — a second person must approve it' : 'Rights granted');
      onClose();
    },
  });
  const toggle = (list: string[], value: string) => (list.includes(value) ? list.filter((item) => item !== value) : [...list, value]);
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const value = (key: string) => String(form.get(key) ?? '').trim();
    request.mutate({ territory: value('territory').toUpperCase() || '*', deviceClasses: devices, businessModels: models, startAt: fromDateInput(value('start')) ?? new Date().toISOString(), endAt: fromDateInput(value('end')), contractRef: value('contract') });
  };
  return (
    <Dialog open={open} title="Request a rights grant" onClose={onClose}>
      <form className="space-y-4" onSubmit={submit}>
        <Field label="Territory" name="territory" placeholder="GE, or * for worldwide" maxLength={2} defaultValue="GE" />
        <fieldset className="space-y-1">
          <legend className="text-sm text-fg-muted">Devices</legend>
          <div className="flex flex-wrap gap-3 text-sm">
            {DEVICE_CLASSES.map((device) => (
              <label key={device} className="flex items-center gap-1.5">
                <input type="checkbox" checked={devices.includes(device)} onChange={() => setDevices(toggle(devices, device))} /> {device}
              </label>
            ))}
          </div>
        </fieldset>
        <fieldset className="space-y-1">
          <legend className="text-sm text-fg-muted">Business models</legend>
          <div className="flex flex-wrap gap-3 text-sm">
            {MODELS.map((model) => (
              <label key={model} className="flex items-center gap-1.5">
                <input type="checkbox" checked={models.includes(model)} onChange={() => setModels(toggle(models, model))} /> {model}
              </label>
            ))}
          </div>
        </fieldset>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="From" name="start" type="date" defaultValue={dateInput(new Date().toISOString())} required />
          <Field label="Until (optional)" name="end" type="date" />
        </div>
        <Field label="Contract reference" name="contract" required maxLength={200} />
        <ErrorNote error={request.error} />
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button tone="primary" type="submit" busy={request.isPending} disabled={devices.length === 0 || models.length === 0}>
            Request
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
  const set = useAction((body: { guideId: string; epgChannelId: string }) => api(`/channels/${channelId}/epg`, { method: 'POST', body }), { success: 'EPG mapping saved — programmes arrive with the guide’s next sync', invalidate: [['epg-coverage']], onSuccess: () => setChoosing(false) });
  const clear = useAction(() => api(`/channels/${channelId}/epg`, { method: 'DELETE' }), { success: 'Back to automatic matching', invalidate: [['epg-coverage']] });
  const row = coverage.data?.channels.find((item) => item.channelId === channelId);
  return (
    <Section
      title="Programme guide"
      actions={
        can('catalog:write') ? (
          <>
            <Button onClick={() => setChoosing(true)}>
              <CalendarClock className="h-4 w-4" aria-hidden /> Map manually
            </Button>
            {row?.mapping?.method === 'manual' && <Button onClick={() => clear.mutate(undefined)}>Use automatic</Button>}
          </>
        ) : undefined
      }
    >
      {row ? (
        <KeyValues
          rows={[
            ['Coverage', <Badge key="c" tone={row.status === 'ok' ? 'ok' : row.status === 'unmapped' || row.status === 'no_data' ? 'danger' : 'warn'}>{row.status.replace('_', ' ')}</Badge>],
            ['Guide channel', row.mapping ? `${row.mapping.epgChannelId} in ${row.mapping.guideName} (${row.mapping.method})` : 'Not mapped'],
            ['Programmes in the next 24 h', row.programmes24h],
            ['Schedule ends', row.scheduleEndsAt ? formatDate(row.scheduleEndsAt) : '—'],
          ]}
        />
      ) : (
        <p className="text-sm text-fg-muted">{coverage.isPending ? 'Loading…' : 'No guide information.'}</p>
      )}
      <Dialog open={choosing} title="Map to a guide channel" onClose={() => setChoosing(false)}>
        <Field label="Search the guides" value={search} onChange={(e) => setSearch(e.target.value)} />
        <ul className="max-h-72 space-y-1 overflow-y-auto">
          {candidates.data?.map((candidate) => (
            <li key={`${candidate.guideId}:${candidate.id}`}>
              <button type="button" onClick={() => set.mutate({ guideId: candidate.guideId, epgChannelId: candidate.id })} className="w-full rounded-lg px-3 py-2 text-left text-sm hover:bg-line/10">
                <span className="font-mono">{candidate.id}</span> <span className="text-fg-muted">{candidate.names.join(' / ')}</span>
              </button>
            </li>
          ))}
          {candidates.data?.length === 0 && <li className="px-3 py-2 text-sm text-fg-muted">No guide channel matches.</li>}
        </ul>
      </Dialog>
    </Section>
  );
}
