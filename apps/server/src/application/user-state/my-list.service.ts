import type { ListItemDto, ListItemType, ListStateDto } from '@ziptv/contracts';

import { directArtwork, type ArtworkUrls } from '../catalog/artwork.js';
import { AppError } from '../errors.js';
import { isHiddenForViewer, type Viewer } from '../identity/viewer.js';
import type { Cache } from '../ports/cache.js';
import type { CatalogRepository, SourceRevisionRef } from '../ports/catalog-repository.js';
import type { SourceRepository } from '../ports/source-repository.js';
import type { ListItemRecord, ListRepository } from '../ports/user-state-repository.js';
import { invalidateHome } from './cache-keys.js';
import { groupBy, usableSources } from './viewer-sources.js';

export const MAX_LIST_ITEMS = 1_000;

interface CatalogItem {
  title: string;
  subtitle: string | null;
  image: string | null;
  adult: boolean;
}

/**
 * My List: channels, movies and series per profile. Items keep a title/image snapshot so an
 * item that vanished from its source on the last sync still shows (as unavailable) instead of
 * silently disappearing from the list.
 */
export class MyListService {
  constructor(
    private readonly deps: {
      list: ListRepository;
      sources: SourceRepository;
      catalog: CatalogRepository;
      cache: Cache;
      artwork?: ArtworkUrls;
    },
  ) {}

  private get artwork(): ArtworkUrls {
    return this.deps.artwork ?? directArtwork;
  }

  async list(viewer: Viewer, limit = MAX_LIST_ITEMS): Promise<ListStateDto> {
    const records = await this.deps.list.list(viewer.profileId, limit);
    const { byId } = await usableSources(this.deps.sources, viewer);
    const current = new Map<string, CatalogItem>();
    for (const [sourceId, items] of groupBy(records, (record) => record.sourceId)) {
      const source = byId.get(sourceId);
      if (!source) continue;
      const found = await this.lookup({ sourceId, revision: source.revision }, items);
      for (const [id, item] of found) current.set(id, item);
    }
    const items: ListItemDto[] = [];
    for (const record of records) {
      const item = current.get(itemId(record));
      if (item && isHiddenForViewer(viewer, item)) continue;
      items.push({
        type: record.type,
        sourceId: record.sourceId,
        key: record.key,
        title: item?.title ?? record.title,
        image: this.artwork.url(item?.image ?? record.image),
        subtitle: item?.subtitle ?? record.subtitle,
        addedAt: record.addedAt.toISOString(),
        available: Boolean(item),
      });
    }
    return { items };
  }

  async add(viewer: Viewer, input: { type: ListItemType; sourceId: string; key: string }): Promise<ListItemDto> {
    const { byId } = await usableSources(this.deps.sources, viewer);
    const source = byId.get(input.sourceId);
    if (!source) throw AppError.notFound('Source');
    const found = (await this.lookup({ sourceId: source.id, revision: source.revision }, [input])).get(itemId(input));
    if (!found || isHiddenForViewer(viewer, found)) throw AppError.notFound(input.type === 'channel' ? 'Channel' : input.type === 'movie' ? 'Movie' : 'Series');
    if ((await this.deps.list.count(viewer.profileId)) >= MAX_LIST_ITEMS) {
      throw new AppError('CONFLICT', 409, `My List can hold up to ${MAX_LIST_ITEMS} items.`);
    }
    const record = await this.deps.list.add({ profileId: viewer.profileId, sourceId: source.id, type: input.type, key: input.key, title: found.title, subtitle: found.subtitle, image: found.image });
    invalidateHome(this.deps.cache, viewer.profileId);
    return {
      type: record.type,
      sourceId: record.sourceId,
      key: record.key,
      title: record.title,
      image: this.artwork.url(record.image),
      subtitle: record.subtitle,
      addedAt: record.addedAt.toISOString(),
      available: true,
    };
  }

  async remove(viewer: Viewer, input: { type: ListItemType; sourceId: string; key: string }): Promise<void> {
    await this.deps.list.remove(viewer.profileId, input.sourceId, input.type, input.key);
    invalidateHome(this.deps.cache, viewer.profileId);
  }

  keys(viewer: Viewer, sourceId: string, type: ListItemType): Promise<Set<string>> {
    return this.deps.list.keys(viewer.profileId, sourceId, type);
  }

  private async lookup(ref: SourceRevisionRef, items: Pick<ListItemRecord, 'type' | 'key'>[]): Promise<Map<string, CatalogItem>> {
    const keysOf = (type: ListItemType) => items.filter((item) => item.type === type).map((item) => item.key);
    const [channels, movies, series] = await Promise.all([
      this.deps.catalog.findLiveMany(ref, keysOf('channel')),
      this.deps.catalog.findMoviesMany(ref, keysOf('movie')),
      this.deps.catalog.findSeriesMany(ref, keysOf('series')),
    ]);
    const result = new Map<string, CatalogItem>();
    for (const channel of channels) {
      result.set(`${ref.sourceId}|channel|${channel.key}`, { title: channel.name, subtitle: channel.groups[0] ?? null, image: channel.logo, adult: channel.adult });
    }
    for (const movie of movies) {
      result.set(`${ref.sourceId}|movie|${movie.key}`, { title: movie.name, subtitle: movie.year ? String(movie.year) : (movie.groups[0] ?? null), image: movie.poster, adult: movie.adult });
    }
    for (const item of series) {
      result.set(`${ref.sourceId}|series|${item.key}`, { title: item.name, subtitle: item.year ? String(item.year) : (item.groups[0] ?? null), image: item.cover, adult: item.adult });
    }
    return result;
  }
}

function itemId(item: { sourceId: string; type: ListItemType; key: string }): string {
  return `${item.sourceId}|${item.type}|${item.key}`;
}
