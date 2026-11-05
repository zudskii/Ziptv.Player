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
import { statusLabel, t } from '../i18n';

const COVERAGE: { status: EpgCoverageStatus; readonly label: string; tone: 'ok' | 'warn' | 'danger' | 'neutral' }[] = (
  [
    ['ok', 'ok'],
    ['ends_soon', 'warn'],
    ['gaps', 'warn'],
    ['no_data', 'danger'],
    ['unmapped', 'danger'],
  ] as const
).map(([status, tone]) => ({
  status,
  tone,
  get label() {
    return t(`catalog.coverage.${status}`);
  },
}));

/** 9.7 — programme guides of the operator catalog: guides, coverage, missing schedules, mapping. */
export function EpgPage() {
  const { can } = useAuth();
  const guides = useQuery({ queryKey: ['epg-guides'], queryFn: () => api<OperatorGuideDto[]>('/epg/guides'), refetchInterval: 15_000 });
  const coverage = useQuery({ queryKey: ['epg-coverage'], queryFn: () => api<EpgCoverageDto>('/epg/coverage'), refetchInterval: 60_000 });
  const [adding, setAdding] = useState(false);
  const [deleting, setDeleting] = useState<OperatorGuideDto | null>(null);
  const [filter, setFilter] = useState<EpgCoverageStatus | ''>('');
  const invalidate = [['epg-guides'], ['epg-coverage']];
  const sync = useAction((id: string) => api(`/epg/guides/${id}/sync`, { method: 'POST' }), { success: t('epg.syncQueued'), invalidate });
  const update = useAction(({ id, patch }: { id: string; patch: Record<string, unknown> }) => api(`/epg/guides/${id}`, { method: 'PATCH', body: patch }), { success: t('epg.updated'), invalidate });
  const remove = useAction((id: string) => api(`/epg/guides/${id}`, { method: 'DELETE' }), { inlineErrors: true, success: t('epg.removed'), invalidate, onSuccess: () => setDeleting(null) });
  const writable = can('catalog:write');
  const rows = (coverage.data?.channels ?? []).filter((row) => !filter || row.status === filter);
  return (
    <>
      <PageHeader
        title={t('epg.title')}
        description={t('epg.intro')}
        actions={
          writable ? (
            <Button tone="primary" onClick={() => setAdding(true)}>
              <Plus className="h-4 w-4" aria-hidden /> {t('epg.add')}
            </Button>
          ) : undefined
        }
      />
      <Section title={t('epg.guides')}>
        <ErrorNote error={guides.error} />
        <DataTable
          label={t('epg.guides')}
          rows={guides.data ?? []}
          rowKey={(row) => row.id}
          empty={guides.isPending ? t('common.loading') : t('epg.none')}
          columns={[
            { header: t('common.guide'), cell: (row) => <div><p className="font-medium">{row.name}</p><p className="text-xs text-fg-muted">{t('catalog.priorityHost', { host: row.host, priority: row.priority })}</p></div> },
            { header: t('common.status'), cell: (row) => <Badge tone={row.status === 'active' ? 'ok' : 'neutral'}>{statusLabel(row.status)}</Badge> },
            {
              header: t('common.sync'),
              cell: (row) => (
                <div>
                  <Badge tone={row.sync.status === 'failed' ? 'danger' : row.sync.status === 'idle' ? 'ok' : 'warn'}>{statusLabel(row.sync.status)}</Badge>
                  <p className="mt-1 text-xs text-fg-muted">{row.sync.error ?? (row.sync.lastSuccessAt ? t('catalog.okAgo', { when: relative(row.sync.lastSuccessAt) }) : t('providers.neverSynced'))}</p>
                </div>
              ),
            },
            { header: t('epg.content'), cell: (row) => <div className="text-xs"><p>{t('catalog.contentStats', { channels: row.stats.channels, programmes: row.stats.programmes })}</p><p className="text-fg-muted">{t('catalog.until', { date: formatDate(row.stats.to) })}</p></div> },
            { header: t('common.mapped'), cell: (row) => row.mappedChannels, className: 'tabular-nums' },
            {
              header: '',
              cell: (row) =>
                writable ? (
                  <div className="flex justify-end gap-1">
                    <Button aria-label={t('catalog.syncNamed', { name: row.name })} onClick={() => sync.mutate(row.id)}>
                      <RefreshCw className="h-4 w-4" />
                    </Button>
                    <Button aria-label={t(row.status === 'active' ? 'catalog.pauseNamed' : 'catalog.activateNamed', { name: row.name })} onClick={() => update.mutate({ id: row.id, patch: { status: row.status === 'active' ? 'paused' : 'active' } })}>
                      {row.status === 'active' ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
                    </Button>
                    <Button tone="danger" aria-label={t('catalog.removeNamed', { name: row.name })} onClick={() => setDeleting(row)}>
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                ) : null,
            },
          ]}
        />
      </Section>

      <Section title={t('common.coverage')} description={t('epg.coverageHint')}>
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
          label={t('epg.channelCoverage')}
          rows={rows}
          rowKey={(row) => row.channelId}
          empty={coverage.isPending ? t('common.loading') : t('epg.noChannels')}
          columns={[
            { header: t('common.channel'), cell: (row) => <Link to={`/channels/${row.channelId}`} className="font-medium text-amber-200 hover:underline">{row.name}</Link> },
            { header: t('common.coverage'), cell: (row) => <Badge tone={COVERAGE.find((item) => item.status === row.status)!.tone}>{COVERAGE.find((item) => item.status === row.status)!.label}</Badge> },
            { header: t('epg.guideChannel'), cell: (row) => (row.mapping ? <span className="text-xs"><span className="font-mono">{row.mapping.epgChannelId}</span> · {row.mapping.guideName} · {row.mapping.method}</span> : '—') },
            { header: t('epg.next24'), cell: (row) => `${row.programmes24h} programmes${row.gapMinutes24h ? ` · ${row.gapMinutes24h} min gap` : ''}` },
            { header: t('epg.scheduleEnds'), cell: (row) => (row.scheduleEndsAt ? relative(row.scheduleEndsAt) : '—') },
          ]}
        />
      </Section>
      <AddGuideDialog open={adding} onClose={() => setAdding(false)} />
      <ConfirmDialog
        open={deleting !== null}
        title={t('catalog.removeTitle', { name: deleting?.name ?? t('catalog.guideWord') })}
        description={<p>{t('epg.removeHint')}</p>}
        confirmLabel={t('common.remove')}
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
  const add = useAction((body: Record<string, unknown>) => api('/epg/guides', { method: 'POST', body }), { inlineErrors: true, success: t('epg.added'), invalidate: [['epg-guides']], onSuccess: onClose });
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    add.mutate({ name: String(form.get('name')).trim(), url: String(form.get('url')).trim(), priority: Number(form.get('priority') || 100) });
  };
  return (
    <Dialog open={open} title={t('epg.add')} onClose={onClose}>
      <form className="space-y-4" onSubmit={submit} autoComplete="off">
        <Field label={t('common.name')} name="name" required maxLength={100} />
        <Field label={t('epg.url')} name="url" type="url" required hint={t('epg.urlHint')} />
        <Field label={t('common.priority')} name="priority" type="number" min="0" max="1000" defaultValue={100} hint={t('epg.priorityHint')} />
        <ErrorNote error={add.error} />
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button tone="primary" type="submit" busy={add.isPending}>
            {t('common.add')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
