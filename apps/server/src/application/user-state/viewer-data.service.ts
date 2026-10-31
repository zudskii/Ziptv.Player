import type { ClearableData, ImportLocalStateDto, ImportLocalStateRequest, StorageUsageDto } from '@ziptv/contracts';

import { newEntityId } from '../../domain/shared/ids.js';
import { HISTORY_MIN_SECS } from '../../domain/viewer/progress.js';
import type { EpgService } from '../epg/epg.service.js';
import { isHiddenForViewer, type Viewer } from '../identity/viewer.js';
import type { Cache } from '../ports/cache.js';
import type { CatalogRepository } from '../ports/catalog-repository.js';
import type { Clock } from '../ports/clock.js';
import type { SourceRepository } from '../ports/source-repository.js';
import type { HistoryRepository, ListRepository, ProgressRepository } from '../ports/user-state-repository.js';
import { sourceCachePrefix } from '../sources/source-sync.pipeline.js';
import { invalidateHome } from './cache-keys.js';
import { MAX_LIST_ITEMS } from './my-list.service.js';
import { usableSources } from './viewer-sources.js';

const MAX_IMPORT_KEYS = 500;

/** Settings → Data & Storage: usage, clearing, and the one-time import of per-browser state. */
export class ViewerDataService {
  constructor(
    private readonly deps: {
      sources: SourceRepository;
      catalog: CatalogRepository;
      list: ListRepository;
      progress: ProgressRepository;
      history: HistoryRepository;
      epg: Pick<EpgService, 'listGuides'>;
      cache: Cache;
      clock: Clock;
    },
  ) {}

  async usage(viewer: Viewer): Promise<StorageUsageDto> {
    const [sources, guides, myList, progress, history] = await Promise.all([
      this.deps.sources.listByOwner(viewer.userId),
      this.deps.epg.listGuides(viewer.userId),
      this.deps.list.count(viewer.profileId),
      this.deps.progress.count(viewer.profileId),
      this.deps.history.count(viewer.profileId, HISTORY_MIN_SECS),
    ]);
    const sum = (pick: (stats: (typeof sources)[number]['stats']) => number) => sources.reduce((total, source) => total + pick(source.stats), 0);
    return {
      sources: sources.length,
      liveChannels: sum((stats) => stats.live),
      movies: sum((stats) => stats.movies),
      series: sum((stats) => stats.series),
      guides: guides.length,
      programmes: guides.reduce((total, guide) => total + guide.stats.programmes, 0),
      myList,
      progress,
      history,
    };
  }

  async clear(viewer: Viewer, kind: ClearableData): Promise<void> {
    switch (kind) {
      case 'history':
        await this.deps.history.clear(viewer.profileId);
        break;
      case 'progress':
        await this.deps.progress.clear(viewer.profileId);
        break;
      case 'my_list':
        await this.deps.list.clear(viewer.profileId);
        break;
      case 'cache':
        // Server-side derived caches of the account's sources (lists, now/next, images).
        for (const source of await this.deps.sources.listByOwner(viewer.userId)) this.deps.cache.deleteByPrefix(sourceCachePrefix(source.id));
        break;
    }
    invalidateHome(this.deps.cache, viewer.profileId);
  }

  /**
   * Favourites / recent channels kept by older clients in the browser (source id → channel
   * keys). Only keys that exist in the viewer's current catalog are imported; repeated imports
   * are harmless (My List is idempotent; recents are only added when history is empty).
   */
  async importLocal(viewer: Viewer, input: ImportLocalStateRequest): Promise<ImportLocalStateDto> {
    const { byId } = await usableSources(this.deps.sources, viewer);
    let favorites = 0;
    let recents = 0;
    const now = this.deps.clock.now();
    const historyEmpty = (await this.deps.history.count(viewer.profileId, 0)) === 0;
    // My List's own cap applies to imports too.
    let budget = Math.min(MAX_IMPORT_KEYS, Math.max(0, MAX_LIST_ITEMS - (await this.deps.list.count(viewer.profileId))));
    for (const [sourceId, keys] of Object.entries(input.favorites)) {
      const source = byId.get(sourceId);
      if (!source || budget <= 0) continue;
      const wanted = [...new Set(keys)].slice(0, budget);
      budget -= wanted.length;
      for (const channel of await this.deps.catalog.findLiveMany({ sourceId, revision: source.revision }, wanted)) {
        if (isHiddenForViewer(viewer, channel)) continue;
        await this.deps.list.add({ profileId: viewer.profileId, sourceId, type: 'channel', key: channel.key, title: channel.name, subtitle: channel.groups[0] ?? null, image: channel.logo });
        favorites++;
      }
    }
    if (historyEmpty) {
      for (const [sourceId, keys] of Object.entries(input.recents)) {
        const source = byId.get(sourceId);
        if (!source || budget <= 0) continue;
        const wanted = [...new Set(keys)].slice(0, Math.min(budget, 30));
        budget -= wanted.length;
        const channels = new Map((await this.deps.catalog.findLiveMany({ sourceId, revision: source.revision }, wanted)).map((channel) => [channel.key, channel]));
        // Most recent first: give each an earlier time so the original order is kept.
        for (const [index, key] of wanted.entries()) {
          const channel = channels.get(key);
          if (!channel || isHiddenForViewer(viewer, channel)) continue;
          await this.deps.history.start(
            {
              id: newEntityId(now.getTime() - index * 60_000),
              profileId: viewer.profileId,
              sourceId,
              contentType: 'channel',
              key,
              seriesKey: null,
              season: null,
              episode: null,
              title: channel.name,
              subtitle: channel.groups[0] ?? null,
              seriesTitle: null,
              image: channel.logo,
              programmeStart: null,
              programmeEnd: null,
            },
            new Date(now.getTime() - index * 60_000),
            HISTORY_MIN_SECS,
          );
          recents++;
        }
      }
    }
    invalidateHome(this.deps.cache, viewer.profileId);
    return { favorites, recents };
  }
}
