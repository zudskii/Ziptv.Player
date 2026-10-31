import type { HistoryItemDto, HistoryPageDto, ProgressContentType, ProgressItemDto } from '@ziptv/contracts';

import { HISTORY_MIN_SECS, remainingSecs } from '../../domain/viewer/progress.js';
import { directArtwork, type ArtworkUrls } from '../catalog/artwork.js';
import { AppError } from '../errors.js';
import type { Viewer } from '../identity/viewer.js';
import type { Cache } from '../ports/cache.js';
import type { HistoryRecord, HistoryRepository, ProgressRecord, ProgressRepository } from '../ports/user-state-repository.js';
import { invalidateHome } from './cache-keys.js';

const MAX_PAGE = 100;

/** Continue Watching and Watch History reads/maintenance (writes come from playback events). */
export class WatchStateService {
  constructor(
    private readonly deps: {
      progress: ProgressRepository;
      history: HistoryRepository;
      cache: Cache;
      artwork?: ArtworkUrls;
    },
  ) {}

  private get artwork(): ArtworkUrls {
    return this.deps.artwork ?? directArtwork;
  }

  async continueWatching(viewer: Viewer, limit = 20): Promise<ProgressItemDto[]> {
    return (await this.deps.progress.listRecent(viewer.profileId, Math.min(limit, MAX_PAGE))).map((record) => this.toProgressDto(record));
  }

  async removeProgress(viewer: Viewer, ref: { contentType: ProgressContentType; sourceId: string; key: string; seriesKey?: string | undefined }): Promise<void> {
    await this.deps.progress.remove({ profileId: viewer.profileId, sourceId: ref.sourceId, contentType: ref.contentType, seriesKey: ref.contentType === 'episode' ? (ref.seriesKey ?? '') : '', key: ref.key });
    invalidateHome(this.deps.cache, viewer.profileId);
  }

  async history(viewer: Viewer, query: { cursor?: string | undefined; limit: number }): Promise<HistoryPageDto> {
    const limit = Math.min(Math.max(query.limit, 1), MAX_PAGE);
    const before = query.cursor ? decodeCursor(query.cursor) : undefined;
    const rows = await this.deps.history.page(viewer.profileId, { limit: limit + 1, minSecs: HISTORY_MIN_SECS, ...(before ? { before } : {}) });
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      items: page.map((row) => this.toHistoryDto(row)),
      nextCursor: rows.length > limit && last ? encodeCursor(last) : null,
    };
  }

  async recentlyWatched(viewer: Viewer, limit: number): Promise<HistoryItemDto[]> {
    return (await this.deps.history.recentDistinct(viewer.profileId, limit, HISTORY_MIN_SECS)).map((row) => this.toHistoryDto(row));
  }

  async removeHistory(viewer: Viewer, id: string): Promise<void> {
    if (!(await this.deps.history.remove(id, viewer.profileId))) throw AppError.notFound('History entry');
    invalidateHome(this.deps.cache, viewer.profileId);
  }

  async clearHistory(viewer: Viewer): Promise<void> {
    await this.deps.history.clear(viewer.profileId);
    invalidateHome(this.deps.cache, viewer.profileId);
  }

  toProgressDto(record: ProgressRecord): ProgressItemDto {
    return {
      contentType: record.contentType,
      sourceId: record.sourceId,
      key: record.key,
      seriesKey: record.contentType === 'episode' ? record.seriesKey : null,
      season: record.season,
      episode: record.episode,
      title: record.title,
      seriesTitle: record.seriesTitle,
      image: this.artwork.url(record.image),
      position: Math.round(record.position),
      duration: Math.round(record.duration),
      completed: record.completed,
      remainingSecs: remainingSecs(record.position, record.duration),
      updatedAt: record.updatedAt.toISOString(),
    };
  }

  toHistoryDto(row: HistoryRecord): HistoryItemDto {
    return {
      id: row.id,
      contentType: row.contentType,
      sourceId: row.sourceId,
      key: row.key,
      seriesKey: row.seriesKey,
      title: row.title,
      subtitle: row.subtitle,
      image: this.artwork.url(row.image),
      startedAt: row.startedAt.toISOString(),
      watchedAt: row.watchedAt.toISOString(),
      watchedSecs: Math.round(row.watchedSecs),
      programmeStart: row.programmeStart?.toISOString() ?? null,
      programmeEnd: row.programmeEnd?.toISOString() ?? null,
    };
  }
}

function encodeCursor(row: HistoryRecord): string {
  return Buffer.from(`${row.watchedAt.toISOString()}|${row.id}`).toString('base64url');
}

function decodeCursor(cursor: string): { watchedAt: Date; id: string } {
  const [at, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
  const watchedAt = new Date(at ?? '');
  if (!id || Number.isNaN(watchedAt.getTime()) || !/^[0-9a-f-]{36}$/i.test(id)) throw AppError.validation('Invalid cursor.');
  return { watchedAt, id };
}
