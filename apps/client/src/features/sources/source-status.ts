import type { HealthState, SourceDto, SourceSyncStage, SourceType } from '@ziptv/contracts';

import { i18n, t } from '../../i18n';
import { formatAgo } from '../../lib/time';

/** Labels are read when shown, so they follow the current language. */
const lazy = <T extends object>(make: () => T): T => new Proxy({} as T, { get: (_, key) => make()[key as keyof T], ownKeys: () => Reflect.ownKeys(make()), getOwnPropertyDescriptor: (_, key) => ({ enumerable: true, configurable: true, value: make()[key as keyof T] }) });

export const SOURCE_TYPE_LABELS: Record<SourceType, string> = lazy(() => ({
  m3u_url: t('sources.type.m3u_url'),
  m3u_file: t('sources.type.m3u_file'),
  xtream: t('sources.type.xtream'),
}));

/** Onboarding / sync progress steps, in order. */
const STAGES: readonly SourceSyncStage[] = ['connecting', 'parsing', 'matching_epg', 'building_library'];
export const SYNC_STAGES: { readonly stage: SourceSyncStage; readonly label: string }[] = STAGES.map((stage) => ({
  stage,
  get label() {
    return t(`sources.stage.${stage}`);
  },
}));

const INTERVAL_HOURS = [1, 3, 6, 12, 24, 72, 168] as const;
export const SYNC_INTERVALS: { readonly hours: number; readonly label: string }[] = INTERVAL_HOURS.map((hours) => ({
  hours,
  get label() {
    return t(`sources.interval.h${hours}`);
  },
}));

const HEALTH_TONES: Record<HealthState, 'success' | 'warning' | 'danger' | 'neutral'> = { online: 'success', slow: 'warning', unstable: 'warning', offline: 'danger', unknown: 'neutral' };
export const HEALTH_LABELS: Record<HealthState, { label: string; tone: 'success' | 'warning' | 'danger' | 'neutral' }> = lazy(() =>
  Object.fromEntries((Object.keys(HEALTH_TONES) as HealthState[]).map((state) => [state, { label: t(`sources.health.${state}`), tone: HEALTH_TONES[state] }])) as Record<HealthState, { label: string; tone: 'success' | 'warning' | 'danger' | 'neutral' }>,
);

export function stageIndex(stage: SourceSyncStage | null): number {
  return stage ? SYNC_STAGES.findIndex((item) => item.stage === stage) : -1;
}

/** One-line status for a source card ("Synced 4 min ago · next in 6 h"). */
export function describeSync(source: SourceDto, now = Date.now()): string {
  const { sync } = source;
  if (sync.status === 'queued') return t('sources.sync.waiting');
  if (sync.status === 'running') return SYNC_STAGES[stageIndex(sync.stage)]?.label ?? t('sources.sync.syncing');
  if (source.type === 'm3u_file') return t('sources.sync.imported', { when: formatAgo(sync.lastSuccessAt, now) });
  if (sync.status === 'failed') return sync.lastSuccessAt ? t('sources.sync.failedSynced', { when: formatAgo(sync.lastSuccessAt, now) }) : t('sources.sync.failedNever');
  return sync.lastSuccessAt ? t('sources.sync.synced', { when: formatAgo(sync.lastSuccessAt, now) }) : t('sources.sync.never');
}

export function describeLibrary(source: SourceDto): string {
  const { live, movies, series } = source.stats;
  const parts = [
    live > 0 ? t('sources.library.channels', { count: live }) : null,
    movies > 0 ? t('sources.library.movies', { count: movies }) : null,
    series > 0 ? t('sources.library.series', { count: series }) : null,
  ].filter(Boolean);
  return parts.length ? parts.join(' · ') : source.revision > 0 ? t('sources.library.empty') : t('sources.library.notSynced');
}

/** For number formatting next to labels. */
export const formatCount = (value: number) => value.toLocaleString(i18n.locale);
