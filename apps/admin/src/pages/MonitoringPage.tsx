import type { ChannelFailoverDto, FeedHealthDto, FeedHealthPageDto, FeedHealthState, IncidentDto, IncidentPageDto, ProbeResultDto } from '@ziptv/contracts';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { History, Pin, PinOff, Radar, Wrench } from 'lucide-react';
import { useState } from 'react';
import { useSearchParams } from 'react-router';

import { Badge, Button, ConfirmDialog, DataTable, Dialog, ErrorNote, PageHeader, Pager, Spinner, Tabs } from '../components/ui';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { relative } from '../lib/format';
import { useAction } from '../lib/mutation';
import { formatTime } from '../lib/nav';

const STATES: FeedHealthState[] = ['HEALTHY', 'UNHEALTHY', 'PROVIDER_OUTAGE', 'GEO_BLOCKED', 'NOT_ENTITLED', 'MAINTENANCE', 'UNKNOWN'];
const PAGE = 50;

export function StateBadge({ state }: { state: FeedHealthState }) {
  const tone = state === 'HEALTHY' ? 'ok' : state === 'UNHEALTHY' || state === 'PROVIDER_OUTAGE' ? 'danger' : state === 'UNKNOWN' || state === 'MAINTENANCE' ? 'neutral' : 'warn';
  return <Badge tone={tone}>{state.replace('_', ' ').toLowerCase()}</Badge>;
}

/** 9.4 — live monitoring: feed health per region, probe history, failover journal, manual switching, incidents. */
export function MonitoringPage() {
  const [params] = useSearchParams();
  const [tab, setTab] = useState<'feeds' | 'incidents'>(params.get('tab') === 'incidents' ? 'incidents' : 'feeds');
  return (
    <>
      <PageHeader title="Live monitoring" description="Feeds are probed from every region; a feed fails only when all regions agree. Failover keeps each channel on a working feed." />
      <Tabs
        label="Monitoring"
        value={tab}
        onChange={setTab}
        items={[
          { value: 'feeds', label: 'Feeds' },
          { value: 'incidents', label: 'Incidents' },
        ]}
      />
      {tab === 'feeds' ? <Feeds channelId={params.get('channelId')} /> : <Incidents />}
    </>
  );
}

function Feeds({ channelId }: { channelId: string | null }) {
  const { can } = useAuth();
  const [status, setStatus] = useState<FeedHealthState | ''>('');
  const [offset, setOffset] = useState(0);
  const [probes, setProbes] = useState<FeedHealthDto | null>(null);
  const [failover, setFailover] = useState<string | null>(channelId);
  const [maintenance, setMaintenance] = useState<FeedHealthDto | null>(null);
  const feeds = useQuery({
    queryKey: ['feeds', status, offset, channelId],
    queryFn: () => api<FeedHealthPageDto>(`/monitoring/feeds?limit=${PAGE}&offset=${offset}${status ? `&status=${status}` : ''}${channelId ? `&channelId=${channelId}` : ''}`),
    placeholderData: keepPreviousData,
    refetchInterval: 15_000,
  });
  const probeNow = useAction((id: string) => api(`/monitoring/feeds/${id}/probe`, { method: 'POST' }), { success: 'Probe queued', invalidate: [['feeds']] });
  const setMaint = useAction(({ id, on, note }: { id: string; on: boolean; note: string }) => api(`/monitoring/feeds/${id}/maintenance`, { method: 'POST', body: { on, ...(note ? { note } : {}) } }), {
    inlineErrors: true,
    success: 'Maintenance updated',
    invalidate: [['feeds']],
    onSuccess: () => setMaintenance(null),
  });
  const operate = can('monitoring:operate');
  return (
    <>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <select
          aria-label="Health"
          className="field w-auto"
          value={status}
          onChange={(e) => {
            setStatus(e.target.value as FeedHealthState | '');
            setOffset(0);
          }}
        >
          <option value="">All states</option>
          {STATES.map((state) => (
            <option key={state} value={state}>
              {state.replace('_', ' ').toLowerCase()}
            </option>
          ))}
        </select>
        {feeds.data && <span className="text-xs text-fg-muted">Regions: {feeds.data.regions.join(', ')}</span>}
      </div>
      <ErrorNote error={feeds.error} />
      <DataTable
        label="Feeds"
        rows={feeds.data?.items ?? []}
        rowKey={(row) => row.feedId}
        empty={feeds.isPending ? 'Loading…' : 'No feeds.'}
        columns={[
          {
            header: 'Channel / provider',
            cell: (row) => (
              <div>
                <button type="button" className="font-medium text-amber-200 hover:underline" onClick={() => setFailover(row.channelId)}>
                  {row.channelName}
                </button>
                <p className="text-xs text-fg-muted">
                  {row.providerName} · priority {row.priority}
                  {row.feedStatus === 'disabled' ? ' · disabled' : ''}
                </p>
              </div>
            ),
          },
          { header: 'Health', cell: (row) => <div><StateBadge state={row.status} /><p className="mt-1 text-xs text-fg-muted">since {relative(row.since)}</p></div> },
          {
            header: 'Regions',
            cell: (row) => (
              <ul className="space-y-0.5 text-xs">
                {row.regions.map((region) => (
                  <li key={region.region} title={region.lastError ?? undefined}>
                    <span className="font-mono">{region.region}</span> {region.state.toLowerCase()} · {region.lastOutcome ?? '—'} · {relative(region.lastProbeAt)}
                  </li>
                ))}
                {row.missingRegions.map((region) => (
                  <li key={region} className="text-amber-300">
                    <span className="font-mono">{region}</span> no probes yet
                  </li>
                ))}
              </ul>
            ),
          },
          {
            header: '',
            cell: (row) => (
              <div className="flex flex-wrap justify-end gap-1">
                <Button aria-label={`Probe history of ${row.channelName} via ${row.providerName}`} onClick={() => setProbes(row)}>
                  <History className="h-4 w-4" />
                </Button>
                {operate && (
                  <>
                    <Button aria-label={`Probe ${row.channelName} via ${row.providerName} now`} onClick={() => probeNow.mutate(row.feedId)}>
                      <Radar className="h-4 w-4" />
                    </Button>
                    <Button aria-label={`Maintenance for ${row.channelName} via ${row.providerName}`} onClick={() => setMaintenance(row)}>
                      <Wrench className="h-4 w-4" />
                    </Button>
                  </>
                )}
              </div>
            ),
          },
        ]}
      />
      {feeds.data && <Pager offset={offset} limit={PAGE} total={feeds.data.total} onChange={setOffset} />}
      <ProbeHistory feed={probes} onClose={() => setProbes(null)} />
      {failover && <FailoverDialog channelId={failover} onClose={() => setFailover(null)} />}
      <ConfirmDialog
        open={maintenance !== null}
        title={maintenance?.maintenance ? 'End maintenance?' : 'Put the feed in maintenance?'}
        description={<p>{maintenance?.maintenance ? 'The feed is probed and used again.' : 'The feed is skipped by failover and its incidents are muted until maintenance ends.'}</p>}
        confirmLabel={maintenance?.maintenance ? 'End maintenance' : 'Start maintenance'}
        note={maintenance?.maintenance ? undefined : { label: 'Note (optional)' }}
        busy={setMaint.isPending}
        error={setMaint.error}
        onConfirm={(note) => maintenance && setMaint.mutate({ id: maintenance.feedId, on: !maintenance.maintenance, note })}
        onClose={() => setMaintenance(null)}
      />
    </>
  );
}

function ProbeHistory({ feed, onClose }: { feed: FeedHealthDto | null; onClose: () => void }) {
  const probes = useQuery({ queryKey: ['probes', feed?.feedId], queryFn: () => api<ProbeResultDto[]>(`/monitoring/feeds/${feed!.feedId}/probes?limit=50`), enabled: feed !== null });
  return (
    <Dialog open={feed !== null} title={feed ? `Probes — ${feed.channelName} via ${feed.providerName}` : 'Probes'} onClose={onClose}>
      {probes.isPending ? (
        <Spinner />
      ) : (
        <ul className="max-h-96 space-y-1 overflow-y-auto text-xs">
          {probes.data?.map((probe, index) => (
            <li key={index} className="flex flex-wrap gap-x-3 rounded bg-sunken px-2 py-1">
              <span className="font-mono">{formatTime(probe.probedAt)}</span>
              <span>{probe.region}</span>
              <span>{probe.kind}</span>
              <span className={probe.outcome === 'ok' || probe.outcome === 'degraded' ? 'text-green-300' : 'text-red-300'}>{probe.outcome}</span>
              {probe.ttfbMs !== null && <span>{probe.ttfbMs} ms</span>}
              {probe.error && <span className="w-full text-fg-muted">{probe.error}</span>}
            </li>
          ))}
          {probes.data?.length === 0 && <li className="text-fg-muted">No probes yet.</li>}
        </ul>
      )}
    </Dialog>
  );
}

function FailoverDialog({ channelId, onClose }: { channelId: string; onClose: () => void }) {
  const { can } = useAuth();
  const failover = useQuery({ queryKey: ['failover', channelId], queryFn: () => api<ChannelFailoverDto>(`/monitoring/channels/${channelId}/failover`), refetchInterval: 15_000 });
  const pin = useAction((feedId: string) => api(`/monitoring/channels/${channelId}/failover/pin`, { method: 'POST', body: { feedId } }), { success: 'Feed pinned: automatic failover is off for this channel', invalidate: [['failover', channelId], ['feeds']] });
  const unpin = useAction(() => api(`/monitoring/channels/${channelId}/failover/pin`, { method: 'DELETE' }), { success: 'Back to automatic failover', invalidate: [['failover', channelId], ['feeds']] });
  const data = failover.data;
  return (
    <Dialog open title={data ? `Failover — ${data.channelName}` : 'Failover'} onClose={onClose}>
      {!data ? (
        <Spinner />
      ) : (
        <div className="space-y-4">
          <p className="text-sm">
            Mode: <Badge tone={data.mode === 'pinned' ? 'warn' : 'ok'}>{data.mode}</Badge>
            {data.pin && <span className="ml-2 text-xs text-fg-muted">pinned by {data.pin.by ?? '—'}{data.pin.until ? ` until ${formatTime(data.pin.until)}` : ''}</span>}
            {data.mode === 'pinned' && can('monitoring:operate') && (
              <Button className="ml-3" onClick={() => unpin.mutate(undefined)}>
                <PinOff className="h-4 w-4" aria-hidden /> Unpin
              </Button>
            )}
          </p>
          <ul className="space-y-1 text-sm" aria-label="Feeds of the channel">
            {data.feeds.map((feed) => (
              <li key={feed.id} className="flex items-center gap-2 rounded bg-sunken px-2 py-1">
                <span className="w-6 text-xs text-fg-subtle">#{feed.priority}</span>
                <StateBadge state={feed.health} />
                {feed.active && <Badge tone="accent">on air</Badge>}
                <span className="flex-1 truncate font-mono text-xs">{feed.id.slice(-8)}</span>
                {can('monitoring:operate') && !feed.active && (
                  <Button onClick={() => pin.mutate(feed.id)}>
                    <Pin className="h-4 w-4" aria-hidden /> Switch &amp; pin
                  </Button>
                )}
              </li>
            ))}
          </ul>
          <div>
            <p className="mb-1 text-xs uppercase tracking-wide text-fg-subtle">Journal</p>
            <ul className="max-h-56 space-y-1 overflow-y-auto text-xs">
              {data.events.map((event, index) => (
                <li key={index} className="rounded bg-sunken px-2 py-1">
                  <span className="font-mono">{formatTime(event.occurredAt)}</span> · {event.reason} · {event.fromFeedId?.slice(-8) ?? '—'} → {event.toFeedId?.slice(-8) ?? '—'} · {event.actorEmail ?? 'automatic'}
                </li>
              ))}
              {data.events.length === 0 && <li className="text-fg-muted">No switches yet.</li>}
            </ul>
          </div>
        </div>
      )}
    </Dialog>
  );
}

export function Incidents({ compact = false }: { compact?: boolean }) {
  const { can } = useAuth();
  const [status, setStatus] = useState<'live' | 'resolved' | ''>('live');
  const [offset, setOffset] = useState(0);
  const incidents = useQuery({
    queryKey: ['incidents', status, offset],
    queryFn: () => api<IncidentPageDto>(`/monitoring/incidents?limit=${PAGE}&offset=${offset}${status ? `&status=${status}` : ''}`),
    placeholderData: keepPreviousData,
    refetchInterval: 15_000,
  });
  const act = useAction(({ incident, action }: { incident: IncidentDto; action: 'acknowledge' | 'resolve' }) => api(`/monitoring/incidents/${incident.id}/${action}`, { method: 'POST' }), { success: 'Incident updated', invalidate: [['incidents'], ['overview']] });
  return (
    <>
      {!compact && (
        <select
          aria-label="Incident status"
          className="field mb-4 w-auto"
          value={status}
          onChange={(e) => {
            setStatus(e.target.value as typeof status);
            setOffset(0);
          }}
        >
          <option value="live">Open and acknowledged</option>
          <option value="resolved">Resolved</option>
          <option value="">All</option>
        </select>
      )}
      <ErrorNote error={incidents.error} />
      <DataTable
        label="Incidents"
        rows={incidents.data?.items ?? []}
        rowKey={(row) => row.id}
        empty={incidents.isPending ? 'Loading…' : 'No incidents.'}
        columns={[
          { header: 'Incident', cell: (row) => <div><p className="font-medium">{row.title}</p><p className="text-xs text-fg-muted">{row.kind.replace('_', ' ')} · {row.targetType}</p></div> },
          { header: 'Severity', cell: (row) => <Badge tone={row.severity === 'critical' ? 'danger' : 'warn'}>{row.severity}</Badge> },
          { header: 'Status', cell: (row) => <Badge tone={row.status === 'resolved' ? 'ok' : row.status === 'acknowledged' ? 'neutral' : 'danger'}>{row.status}</Badge> },
          { header: 'Opened', cell: (row) => <span title={formatTime(row.openedAt)}>{relative(row.openedAt)}</span>, className: 'whitespace-nowrap' },
          {
            header: '',
            cell: (row) =>
              can('monitoring:operate') && row.status !== 'resolved' ? (
                <div className="flex justify-end gap-1">
                  {row.status === 'open' && <Button onClick={() => act.mutate({ incident: row, action: 'acknowledge' })}>Acknowledge</Button>}
                  <Button onClick={() => act.mutate({ incident: row, action: 'resolve' })}>Resolve</Button>
                </div>
              ) : null,
          },
        ]}
      />
      {incidents.data && !compact && <Pager offset={offset} limit={PAGE} total={incidents.data.total} onChange={setOffset} />}
    </>
  );
}
