import type { CategoryDto, DuplicateGroupDto, LineupDto, MasterChannelDetailDto, MasterChannelPageDto, MasterChannelStatsDto, ProviderStreamPageDto, ProviderDto } from '@ziptv/contracts';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { GitMerge, Plus, Search } from 'lucide-react';
import { useDeferredValue, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router';

import { Badge, Button, ConfirmDialog, DataTable, Dialog, ErrorNote, Field, PageHeader, Pager, SelectField, Tabs } from '../components/ui';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useAction } from '../lib/mutation';
import { formatTime } from '../lib/nav';

type Tab = 'channels' | 'review' | 'duplicates' | 'categories' | 'lineups';
const PAGE = 50;

/** 9.2 — the master catalog: channels, the review queue of provider streams, duplicates, categories. */
export function ChannelsPage() {
  const [tab, setTab] = useState<Tab>('channels');
  return (
    <>
      <PageHeader title="Channels" description="One master channel per real channel; provider streams are its feeds (primary first, backups after)." />
      <Tabs
        label="Catalog"
        value={tab}
        onChange={setTab}
        items={[
          { value: 'channels', label: 'Channels' },
          { value: 'review', label: 'Review queue' },
          { value: 'duplicates', label: 'Duplicates' },
          { value: 'categories', label: 'Categories' },
          { value: 'lineups', label: 'Lineups' },
        ]}
      />
      {tab === 'channels' && <ChannelList />}
      {tab === 'review' && <ReviewQueue />}
      {tab === 'duplicates' && <Duplicates />}
      {tab === 'categories' && <Categories />}
      {tab === 'lineups' && <Lineups />}
    </>
  );
}

export function HealthBadge({ health }: { health: MasterChannelStatsDto['health'] }) {
  if (!health) return <Badge>No feed</Badge>;
  const tone = health === 'HEALTHY' ? 'ok' : health === 'UNHEALTHY' || health === 'PROVIDER_OUTAGE' ? 'danger' : health === 'UNKNOWN' || health === 'MAINTENANCE' ? 'neutral' : 'warn';
  return <Badge tone={tone}>{health.replace('_', ' ').toLowerCase()}</Badge>;
}

function ChannelList() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const [text, setText] = useState('');
  const q = useDeferredValue(text.trim());
  const [status, setStatus] = useState('');
  const [offset, setOffset] = useState(0);
  const [creating, setCreating] = useState(false);
  const channels = useQuery({
    queryKey: ['channels', q, status, offset],
    queryFn: () => api<MasterChannelPageDto>(`/channels?limit=${PAGE}&offset=${offset}${q ? `&q=${encodeURIComponent(q)}` : ''}${status ? `&status=${status}` : ''}`),
    placeholderData: keepPreviousData,
  });
  return (
    <>
      <div className="mb-4 flex flex-wrap items-end gap-3">
        <label className="relative block w-full max-w-sm">
          <span className="sr-only">Search channels</span>
          <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-fg-subtle" aria-hidden />
          <input
            className="field pl-9"
            placeholder="Search channels"
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setOffset(0);
            }}
          />
        </label>
        <select
          aria-label="Status"
          className="field w-auto"
          value={status}
          onChange={(e) => {
            setStatus(e.target.value);
            setOffset(0);
          }}
        >
          <option value="">All statuses</option>
          <option value="active">Active</option>
          <option value="hidden">Hidden</option>
        </select>
        {can('catalog:write') && (
          <Button tone="primary" className="ml-auto" onClick={() => setCreating(true)}>
            <Plus className="h-4 w-4" aria-hidden /> New channel
          </Button>
        )}
      </div>
      <ErrorNote error={channels.error} />
      <DataTable
        label="Channels"
        rows={channels.data?.items ?? []}
        rowKey={(row) => row.id}
        empty={channels.isPending ? 'Loading…' : 'No channels match.'}
        columns={[
          {
            header: 'Channel',
            cell: (row) => (
              <div className="flex items-center gap-3">
                {row.logo ? <img src={row.logo} alt="" className="h-8 w-12 rounded bg-line/10 object-contain" loading="lazy" onError={(event) => (event.currentTarget.style.visibility = 'hidden')} /> : <span className="h-8 w-12 rounded bg-line/10" aria-hidden />}
                <Link to={`/channels/${row.id}`} className="font-medium text-amber-200 hover:underline">
                  {row.name}
                </Link>
              </div>
            ),
          },
          { header: 'Status', cell: (row) => <Badge tone={row.status === 'active' ? 'ok' : 'neutral'}>{row.status}</Badge> },
          { header: 'Feeds', cell: (row) => `${row.playableFeeds} / ${row.feeds}`, className: 'tabular-nums' },
          { header: 'Rights', cell: (row) => (row.activeGrants ? row.activeGrants : <Badge tone="warn">none</Badge>), className: 'tabular-nums' },
          { header: 'Health', cell: (row) => <HealthBadge health={row.health} /> },
          { header: 'Country', cell: (row) => row.originCountry ?? '—' },
        ]}
      />
      {channels.data && <Pager offset={offset} limit={PAGE} total={channels.data.total} onChange={setOffset} />}
      <CreateChannelDialog open={creating} onClose={() => setCreating(false)} onCreated={(channel) => navigate(`/channels/${channel.id}`)} />
    </>
  );
}

function CreateChannelDialog({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (channel: MasterChannelDetailDto) => void }) {
  const categories = useQuery({ queryKey: ['categories'], queryFn: () => api<CategoryDto[]>('/categories'), enabled: open });
  const create = useAction((body: Record<string, unknown>) => api<MasterChannelDetailDto>('/channels', { method: 'POST', body }), { inlineErrors: true, success: 'Channel created', invalidate: [['channels']], onSuccess: onCreated });
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const value = (key: string) => String(form.get(key) ?? '').trim();
    create.mutate({
      name: value('name'),
      ...(value('country') ? { originCountry: value('country').toUpperCase() } : {}),
      ...(value('category') ? { categoryId: value('category') } : {}),
      ...(value('globalUid') ? { globalUid: value('globalUid') } : {}),
      ...(value('logo') ? { logo: value('logo') } : {}),
    });
  };
  return (
    <Dialog open={open} title="New channel" onClose={onClose}>
      <form className="space-y-4" onSubmit={submit}>
        <Field label="Name" name="name" required maxLength={120} />
        <Field label="Origin country" name="country" placeholder="GE" maxLength={2} />
        <SelectField label="Category" name="category" defaultValue="">
          <option value="">—</option>
          {categories.data?.map((category) => (
            <option key={category.id} value={category.id}>
              {category.name}
            </option>
          ))}
        </SelectField>
        <Field label="Global id (tvg-id)" name="globalUid" hint="Provider streams with this tvg-id are matched to the channel automatically." />
        <Field label="Logo URL" name="logo" type="url" placeholder="https://…" />
        <ErrorNote error={create.error} />
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button tone="primary" type="submit" busy={create.isPending}>
            Create
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function ReviewQueue() {
  const { can } = useAuth();
  const [providerId, setProviderId] = useState('');
  const [offset, setOffset] = useState(0);
  const providers = useQuery({ queryKey: ['providers'], queryFn: () => api<ProviderDto[]>('/providers'), enabled: can('providers:read') });
  const streams = useQuery({
    queryKey: ['streams', providerId, offset],
    queryFn: () => api<ProviderStreamPageDto>(`/streams?status=pending&limit=${PAGE}&offset=${offset}${providerId ? `&providerId=${providerId}` : ''}`),
    placeholderData: keepPreviousData,
  });
  const review = useAction(({ id, body }: { id: string; body: Record<string, unknown> }) => api(`/streams/${id}/review`, { method: 'POST', body }), { success: 'Stream reviewed', invalidate: [['streams'], ['channels']] });
  const writable = can('catalog:write');
  return (
    <>
      <p className="mb-4 text-sm text-fg-muted">Streams no alias matched. Match one to an existing channel (it becomes a feed), create a channel from it, or ignore it.</p>
      {providers.data && (
        <select aria-label="Provider" className="field mb-4 w-auto" value={providerId} onChange={(e) => setProviderId(e.target.value)}>
          <option value="">All providers</option>
          {providers.data.map((provider) => (
            <option key={provider.id} value={provider.id}>
              {provider.name}
            </option>
          ))}
        </select>
      )}
      <ErrorNote error={streams.error} />
      <DataTable
        label="Pending streams"
        rows={streams.data?.items ?? []}
        rowKey={(row) => row.id}
        empty={streams.isPending ? 'Loading…' : 'The review queue is empty.'}
        columns={[
          { header: 'Stream', cell: (row) => <div><p className="font-medium">{row.name}</p><p className="text-xs text-fg-muted">{[row.tvgId, ...row.groups].filter(Boolean).join(' · ') || '—'}</p></div> },
          { header: 'Seen', cell: (row) => formatTime(row.firstSeenAt), className: 'whitespace-nowrap' },
          {
            header: 'Decision',
            cell: (row) =>
              writable ? (
                <div className="flex flex-wrap gap-2">
                  {row.suggestion && (
                    <Button onClick={() => review.mutate({ id: row.id, body: { action: 'match', channelId: row.suggestion!.id } })}>
                      Match “{row.suggestion.name}”
                    </Button>
                  )}
                  <Button onClick={() => review.mutate({ id: row.id, body: { action: 'create' } })}>Create channel</Button>
                  <Button onClick={() => review.mutate({ id: row.id, body: { action: 'ignore' } })}>Ignore</Button>
                </div>
              ) : (
                row.suggestion ? `Suggests ${row.suggestion.name}` : '—'
              ),
          },
        ]}
      />
      {streams.data && <Pager offset={offset} limit={PAGE} total={streams.data.total} onChange={setOffset} />}
    </>
  );
}

function Duplicates() {
  const { can } = useAuth();
  const groups = useQuery({ queryKey: ['duplicates'], queryFn: () => api<DuplicateGroupDto[]>('/channels/duplicates') });
  const [merge, setMerge] = useState<{ into: { id: string; name: string }; from: { id: string; name: string } } | null>(null);
  const run = useAction(({ into, from }: { into: string; from: string }) => api(`/channels/${into}/merge`, { method: 'POST', body: { fromChannelId: from } }), { inlineErrors: true, success: 'Channels merged', invalidate: [['duplicates'], ['channels']], onSuccess: () => setMerge(null) });
  return (
    <>
      <p className="mb-4 text-sm text-fg-muted">Channels whose names are the same once quality tags (HD, FHD, 4K…) and spacing are ignored. Merging moves feeds, rights, aliases and lineups into the channel you keep.</p>
      <ErrorNote error={groups.error} />
      {groups.data?.length === 0 && <p className="card p-6 text-sm text-fg-muted">No likely duplicates.</p>}
      <ul className="space-y-3">
        {groups.data?.map((group) => (
          <li key={group.key} className="card p-4">
            <p className="mb-2 text-xs uppercase tracking-wide text-fg-subtle">Same name: {group.key}</p>
            <ul className="space-y-2">
              {group.channels.map((channel, index) => (
                <li key={channel.id} className="flex flex-wrap items-center gap-3 text-sm">
                  <Link to={`/channels/${channel.id}`} className="font-medium text-amber-200 hover:underline">
                    {channel.name}
                  </Link>
                  <Badge>{channel.feeds} feeds</Badge>
                  <Badge tone={channel.status === 'active' ? 'ok' : 'neutral'}>{channel.status}</Badge>
                  {can('catalog:write') && index > 0 && (
                    <Button className="ml-auto" onClick={() => setMerge({ into: group.channels[0]!, from: channel })}>
                      <GitMerge className="h-4 w-4" aria-hidden /> Merge into “{group.channels[0]!.name}”
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
      <ConfirmDialog
        open={merge !== null}
        title="Merge channels?"
        description={merge && <p>“{merge.from.name}” disappears; its feeds, rights, aliases and lineup numbers move to “{merge.into.name}”. This cannot be undone.</p>}
        confirmLabel="Merge"
        tone="danger"
        busy={run.isPending}
        error={run.error}
        onConfirm={() => merge && run.mutate({ into: merge.into.id, from: merge.from.id })}
        onClose={() => setMerge(null)}
      />
    </>
  );
}

function Categories() {
  const { can } = useAuth();
  const categories = useQuery({ queryKey: ['categories'], queryFn: () => api<CategoryDto[]>('/categories') });
  const [name, setName] = useState('');
  const create = useAction((value: string) => api<CategoryDto>('/categories', { method: 'POST', body: { name: value } }), { success: 'Category added', invalidate: [['categories']], onSuccess: () => setName('') });
  return (
    <>
      {can('catalog:write') && (
        <form
          className="mb-4 flex max-w-md gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (name.trim()) create.mutate(name.trim());
          }}
        >
          <input className="field" aria-label="New category" placeholder="New category" value={name} onChange={(e) => setName(e.target.value)} maxLength={120} />
          <Button tone="primary" type="submit" busy={create.isPending}>
            Add
          </Button>
        </form>
      )}
      <DataTable label="Categories" rows={categories.data ?? []} rowKey={(row) => row.id} empty="No categories yet." columns={[{ header: 'Name', cell: (row) => row.name }, { header: 'Slug', cell: (row) => <code className="text-xs">{row.slug}</code> }]} />
    </>
  );
}

function Lineups() {
  const lineups = useQuery({ queryKey: ['lineups'], queryFn: () => api<LineupDto[]>('/lineups') });
  return (
    <DataTable
      label="Lineups"
      rows={lineups.data ?? []}
      rowKey={(row) => row.id}
      empty="No lineups yet."
      columns={[
        { header: 'Lineup', cell: (row) => row.name },
        { header: 'Country', cell: (row) => row.country },
        { header: 'Status', cell: (row) => <Badge tone={row.status === 'active' ? 'ok' : 'neutral'}>{row.status}</Badge> },
        { header: 'Channels', cell: (row) => row.channels, className: 'tabular-nums' },
      ]}
    />
  );
}
