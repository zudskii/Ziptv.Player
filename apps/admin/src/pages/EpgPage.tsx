import type { EpgCoverageDto, EpgCoverageStatus, OperatorGuideDto } from '@ziptv/contracts';
import { useQuery } from '@tanstack/react-query';
import { Pause, Play, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Link } from 'react-router';

import { Badge, Button, ConfirmDialog, DataTable, Dialog, ErrorNote, Field, PageHeader, Section, Stat } from '../components/ui';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { formatDate, relative } from '../lib/format';
import { useAction } from '../lib/mutation';

const COVERAGE: { status: EpgCoverageStatus; label: string; tone: 'ok' | 'warn' | 'danger' | 'neutral' }[] = [
  { status: 'ok', label: 'Covered', tone: 'ok' },
  { status: 'ends_soon', label: 'Ends within 12 h', tone: 'warn' },
  { status: 'gaps', label: 'Gaps over 1 h', tone: 'warn' },
  { status: 'no_data', label: 'Mapped, no schedule', tone: 'danger' },
  { status: 'unmapped', label: 'No guide channel', tone: 'danger' },
];

/** 9.7 — programme guides of the operator catalog: guides, coverage, missing schedules, mapping. */
export function EpgPage() {
  const { can } = useAuth();
  const guides = useQuery({ queryKey: ['epg-guides'], queryFn: () => api<OperatorGuideDto[]>('/epg/guides'), refetchInterval: 15_000 });
  const coverage = useQuery({ queryKey: ['epg-coverage'], queryFn: () => api<EpgCoverageDto>('/epg/coverage'), refetchInterval: 60_000 });
  const [adding, setAdding] = useState(false);
  const [deleting, setDeleting] = useState<OperatorGuideDto | null>(null);
  const [filter, setFilter] = useState<EpgCoverageStatus | ''>('');
  const invalidate = [['epg-guides'], ['epg-coverage']];
  const sync = useAction((id: string) => api(`/epg/guides/${id}/sync`, { method: 'POST' }), { success: 'Sync queued', invalidate });
  const update = useAction(({ id, patch }: { id: string; patch: Record<string, unknown> }) => api(`/epg/guides/${id}`, { method: 'PATCH', body: patch }), { success: 'Guide updated', invalidate });
  const remove = useAction((id: string) => api(`/epg/guides/${id}`, { method: 'DELETE' }), { inlineErrors: true, success: 'Guide removed', invalidate, onSuccess: () => setDeleting(null) });
  const writable = can('catalog:write');
  const rows = (coverage.data?.channels ?? []).filter((row) => !filter || row.status === filter);
  return (
    <>
      <PageHeader
        title="EPG"
        description="Licensed XMLTV guides for the operator channels. Channels are matched to guide channels by tvg-id or name; map by hand where that fails."
        actions={
          writable ? (
            <Button tone="primary" onClick={() => setAdding(true)}>
              <Plus className="h-4 w-4" aria-hidden /> Add guide
            </Button>
          ) : undefined
        }
      />
      <Section title="Guides">
        <ErrorNote error={guides.error} />
        <DataTable
          label="Guides"
          rows={guides.data ?? []}
          rowKey={(row) => row.id}
          empty={guides.isPending ? 'Loading…' : 'No guides yet.'}
          columns={[
            { header: 'Guide', cell: (row) => <div><p className="font-medium">{row.name}</p><p className="text-xs text-fg-muted">{row.host} · priority {row.priority}</p></div> },
            { header: 'Status', cell: (row) => <Badge tone={row.status === 'active' ? 'ok' : 'neutral'}>{row.status}</Badge> },
            {
              header: 'Sync',
              cell: (row) => (
                <div>
                  <Badge tone={row.sync.status === 'failed' ? 'danger' : row.sync.status === 'idle' ? 'ok' : 'warn'}>{row.sync.status}</Badge>
                  <p className="mt-1 text-xs text-fg-muted">{row.sync.error ?? (row.sync.lastSuccessAt ? `ok ${relative(row.sync.lastSuccessAt)}` : 'never synced')}</p>
                </div>
              ),
            },
            { header: 'Content', cell: (row) => <div className="text-xs"><p>{row.stats.channels} channels · {row.stats.programmes} programmes kept</p><p className="text-fg-muted">until {formatDate(row.stats.to)}</p></div> },
            { header: 'Mapped', cell: (row) => row.mappedChannels, className: 'tabular-nums' },
            {
              header: '',
              cell: (row) =>
                writable ? (
                  <div className="flex justify-end gap-1">
                    <Button aria-label={`Sync ${row.name}`} onClick={() => sync.mutate(row.id)}>
                      <RefreshCw className="h-4 w-4" />
                    </Button>
                    <Button aria-label={row.status === 'active' ? `Pause ${row.name}` : `Activate ${row.name}`} onClick={() => update.mutate({ id: row.id, patch: { status: row.status === 'active' ? 'paused' : 'active' } })}>
                      {row.status === 'active' ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
                    </Button>
                    <Button tone="danger" aria-label={`Remove ${row.name}`} onClick={() => setDeleting(row)}>
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                ) : null,
            },
          ]}
        />
      </Section>

      <Section title="Coverage" description="Active channels and their schedule for the next 24 hours.">
        {coverage.data && (
          <div className="mb-4 grid gap-3 sm:grid-cols-3 lg:grid-cols-5">
            {COVERAGE.map((item) => (
              <button key={item.status} type="button" className="text-left" onClick={() => setFilter(filter === item.status ? '' : item.status)} aria-pressed={filter === item.status}>
                <Stat label={item.label} value={coverage.data.summary[item.status]} tone={item.tone === 'danger' && coverage.data.summary[item.status] > 0 ? 'danger' : item.tone === 'warn' && coverage.data.summary[item.status] > 0 ? 'warn' : undefined} />
              </button>
            ))}
          </div>
        )}
        <ErrorNote error={coverage.error} />
        <DataTable
          label="Channel coverage"
          rows={rows}
          rowKey={(row) => row.channelId}
          empty={coverage.isPending ? 'Loading…' : 'No channels.'}
          columns={[
            { header: 'Channel', cell: (row) => <Link to={`/channels/${row.channelId}`} className="font-medium text-amber-200 hover:underline">{row.name}</Link> },
            { header: 'Coverage', cell: (row) => <Badge tone={COVERAGE.find((item) => item.status === row.status)!.tone}>{COVERAGE.find((item) => item.status === row.status)!.label}</Badge> },
            { header: 'Guide channel', cell: (row) => (row.mapping ? <span className="text-xs"><span className="font-mono">{row.mapping.epgChannelId}</span> · {row.mapping.guideName} · {row.mapping.method}</span> : '—') },
            { header: 'Next 24 h', cell: (row) => `${row.programmes24h} programmes${row.gapMinutes24h ? ` · ${row.gapMinutes24h} min gap` : ''}` },
            { header: 'Schedule ends', cell: (row) => (row.scheduleEndsAt ? relative(row.scheduleEndsAt) : '—') },
          ]}
        />
      </Section>
      <AddGuideDialog open={adding} onClose={() => setAdding(false)} />
      <ConfirmDialog
        open={deleting !== null}
        title={`Remove ${deleting?.name ?? 'guide'}?`}
        description={<p>Its schedules disappear; channels it served are matched against the remaining guides.</p>}
        confirmLabel="Remove"
        tone="danger"
        busy={remove.isPending}
        error={remove.error}
        onConfirm={() => deleting && remove.mutate(deleting.id)}
        onClose={() => setDeleting(null)}
      />
    </>
  );
}

function AddGuideDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const add = useAction((body: Record<string, unknown>) => api('/epg/guides', { method: 'POST', body }), { inlineErrors: true, success: 'Guide added — the first sync starts now', invalidate: [['epg-guides']], onSuccess: onClose });
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    add.mutate({ name: String(form.get('name')).trim(), url: String(form.get('url')).trim(), priority: Number(form.get('priority') || 100) });
  };
  return (
    <Dialog open={open} title="Add guide" onClose={onClose}>
      <form className="space-y-4" onSubmit={submit} autoComplete="off">
        <Field label="Name" name="name" required maxLength={100} />
        <Field label="XMLTV URL" name="url" type="url" required hint="Stored encrypted; only the host is shown afterwards. gzip is fine." />
        <Field label="Priority" name="priority" type="number" min="0" max="1000" defaultValue={100} hint="Lower wins when two guides list the same channel." />
        <ErrorNote error={add.error} />
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button tone="primary" type="submit" busy={add.isPending}>
            Add
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
