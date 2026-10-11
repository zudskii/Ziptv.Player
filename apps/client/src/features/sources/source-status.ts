import type { HealthState, SourceDto, SourceSyncStage, SourceType } from '@ziptv/contracts';

import { formatAgo } from '../../lib/time';

export const SOURCE_TYPE_LABELS: Record<SourceType, string> = {
  m3u_url: 'M3U URL',
  m3u_file: 'M3U file',
  xtream: 'Xtream Codes',
};

/** Onboarding / sync progress steps, in order. */
export const SYNC_STAGES: { stage: SourceSyncStage; label: string }[] = [
  { stage: 'connecting', label: 'Connecting…' },
  { stage: 'parsing', label: 'Parsing channels…' },
  { stage: 'matching_epg', label: 'Matching EPG…' },
  { stage: 'building_library', label: 'Building your library…' },
];

export const SYNC_INTERVALS = [
  { hours: 1, label: 'Every hour' },
  { hours: 3, label: 'Every 3 hours' },
  { hours: 6, label: 'Every 6 hours' },
  { hours: 12, label: 'Every 12 hours' },
  { hours: 24, label: 'Daily' },
  { hours: 72, label: 'Every 3 days' },
  { hours: 168, label: 'Weekly' },
];

export const HEALTH_LABELS: Record<HealthState, { label: string; tone: 'success' | 'warning' | 'danger' | 'neutral' }> = {
  online: { label: 'Online', tone: 'success' },
  slow: { label: 'Slow', tone: 'warning' },
  unstable: { label: 'Unstable', tone: 'warning' },
  offline: { label: 'Offline', tone: 'danger' },
  unknown: { label: 'Not checked', tone: 'neutral' },
};

export function stageIndex(stage: SourceSyncStage | null): number {
  return stage ? SYNC_STAGES.findIndex((item) => item.stage === stage) : -1;
}

/** One-line status for a source card ("Synced 4 min ago · next in 6 h"). */
export function describeSync(source: SourceDto, now = Date.now()): string {
  const { sync } = source;
  if (sync.status === 'queued') return 'Waiting to sync…';
  if (sync.status === 'running') return SYNC_STAGES[stageIndex(sync.stage)]?.label ?? 'Syncing…';
  if (source.type === 'm3u_file') return `Imported ${formatAgo(sync.lastSuccessAt, now)}`;
  const last = sync.lastSuccessAt ? `Synced ${formatAgo(sync.lastSuccessAt, now)}` : 'Never synced';
  return sync.status === 'failed' ? `Last attempt failed · ${last.toLowerCase()}` : last;
}

export function describeLibrary(source: SourceDto): string {
  const { live, movies, series } = source.stats;
  const parts = [
    live > 0 ? `${live.toLocaleString()} channels` : null,
    movies > 0 ? `${movies.toLocaleString()} movies` : null,
    series > 0 ? `${series.toLocaleString()} series` : null,
  ].filter(Boolean);
  return parts.length ? parts.join(' · ') : source.revision > 0 ? 'Empty' : 'Not synced yet';
}
