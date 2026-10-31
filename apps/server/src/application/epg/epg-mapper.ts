import type { GuideSourceDto, ProgrammeDto } from '@ziptv/contracts';

import { hashKey } from '../../domain/catalog/content-key.js';
import { isCatchupAvailable } from '../../domain/epg/epg.js';
import type { GuideRecord, ProgrammeRecord } from '../ports/epg-repository.js';
import type { MediaUrls } from '../ports/media-urls.js';

/**
 * Guide artwork: https icons may load directly (auto delivery); http icons always go through the
 * image proxy (mixed content); with proxy delivery every icon does, so no provider host leaks.
 */
export function epgIconUrl(icon: string | null, media: Pick<MediaUrls, 'imageProxyPath'>, proxyAll = false): string | null {
  if (!icon || !/^https?:\/\//i.test(icon)) return null;
  return !proxyAll && icon.startsWith('https:') ? icon : media.imageProxyPath(icon);
}

export function toProgrammeDto(programme: ProgrammeRecord, context: { catchupDays: number | null; now: Date; media: MediaUrls; shiftMs?: number; proxyAll?: boolean }): ProgrammeDto {
  const shift = context.shiftMs ?? 0;
  const start = new Date(programme.start.getTime() + shift);
  const stop = new Date(programme.stop.getTime() + shift);
  return {
    id: hashKey(`${programme.channelId}|${programme.start.getTime()}`),
    title: programme.title,
    subtitle: programme.subtitle,
    description: programme.description,
    start: start.toISOString(),
    end: stop.toISOString(),
    categories: programme.categories,
    icon: epgIconUrl(programme.icon, context.media, context.proxyAll),
    episode: programme.episode,
    rating: programme.rating,
    catchup: isCatchupAvailable({ start, stop }, context.catchupDays, context.now),
  };
}

export function toGuideSourceDto(guide: GuideRecord): GuideSourceDto {
  const iso = (date: Date | null) => (date ? date.toISOString() : null);
  return {
    id: guide.id,
    name: guide.name,
    origin: guide.origin,
    host: guide.host,
    sourceIds: guide.sourceIds,
    sync: {
      status: guide.sync.status,
      lastAttemptAt: iso(guide.sync.lastAttemptAt),
      lastSuccessAt: iso(guide.sync.lastSuccessAt),
      nextSyncAt: iso(guide.sync.nextSyncAt),
      error: guide.sync.error,
    },
    stats: {
      channels: guide.stats.channels,
      keptChannels: guide.stats.keptChannels,
      programmes: guide.stats.programmes,
      from: iso(guide.stats.from),
      to: iso(guide.stats.to),
    },
    createdAt: guide.createdAt.toISOString(),
  };
}

/** Guides a source uses, best first: the ones its playlist/provider announced, then manual ones. */
export function orderGuides(guides: GuideRecord[]): GuideRecord[] {
  return [...guides].sort((a, b) => {
    const rank = (guide: GuideRecord) => (guide.origin === 'manual' ? 1 : 0);
    return rank(a) - rank(b) || a.createdAt.getTime() - b.createdAt.getTime();
  });
}
